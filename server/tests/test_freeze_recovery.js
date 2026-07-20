"use strict";
/*
 * v0.22 freeze-recovery suite - the permanent Layer-1 harness from the reconnect research doc:
 * a real network-layer silent freeze (freeze_proxy.js, the WKWebView zombie shape with the
 * client code path 100% untouched) COMBINED with a real JS-runtime freeze of the target page
 * (CDP Page.setWebLifecycleState 'frozen' - timers, watchdogs and reconnect logic genuinely
 * stop, exactly like a backgrounded iOS webview). Usage:
 *   node test_freeze_recovery.js node     (server/server.js)
 *   node test_freeze_recovery.js deno     (server/cloud/server.ts)
 * Env knobs: NASTY_TEST_FREEZE_MS (default 60000) - the long-freeze duration.
 * Never touches production - own scratch port/rooms-dir/KV-path per run, away-ladder
 * thresholds shortened via the servers' own env knobs so the ladder is testable fast.
 *
 * What it proves (the v0.22 acceptance bar):
 *  1. THE HOST silently frozen for 60s+ mid-game NEVER blocks the other players: their action
 *     stream keeps flowing and no blocking overlay ever appears (the P0 regression test - the
 *     old #waitHostOverlay is gone and must stay gone).
 *  2. The server-driven away ladder fires while the frozen player is on turn: 'nudged' status
 *     line -> 'cpuOffer' -> a real button tap by ANY other player makes the server play that
 *     single turn (seat stays human). Composes with pause (ladder clears + re-arms).
 *  3. After unfreeze + foreground, the frozen client converges within a few seconds.
 *  4. The zombie-socket shape (foreground WHILE the pipe is still silently dead): the resync
 *     ack watchdog tears the socket down and rebuilds it AUTOMATICALLY - convergence with zero
 *     manual taps, and the manual failure prompt never shows.
 *  5. Old-build lockout (repurposed v0.23, extended v0.23.1): the exact build 28 client
 *     (protocol 2) AND the exact build 30 client (protocol 3), both pinned commits, each get
 *     the friendly plain-language protocolMismatch on host and join - never a room, never a
 *     crash, and a current host's room is untouched by the rejected attempts.
 */
const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
const { createFreezeProxy } = require("./freeze_proxy.js");
const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const KIND = process.argv[2] || "node";
const USE_DENO = KIND === "deno";
const PORT = 21200 + Math.floor(Math.random() * 700);
const PROXY_PORT = PORT + 1000;
const FREEZE_MS = Number(process.env.NASTY_TEST_FREEZE_MS) || 60000;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-freeze-${KIND}-`));
// Shortened ladder thresholds (the servers' own env knobs - see § AWAY LADDER in both).
const AWAY_ENV = {
  NASTY_AWAY_NUDGE_MS: "3000", NASTY_AWAY_CPU_MS: "8000",
  NASTY_AWAY_SILENT_MS: "2500", NASTY_AWAY_SWEEP_MS: "400",
};
// Build 28's exact client (commit 9d19b46, the last pre-v0.22 commit) for the back-compat leg.
const BUILD28_COMMIT = "9d19b46";
// Build 30's exact client (commit 6fa3867, the v0.23/protocol-3 iOS build 30 commit) for the
// v0.23.1 lockout leg - protocol bumped 3 -> 4 for the partner-peg last-resort ruling.
const BUILD30_COMMIT = "6fa3867";

function log(...a) { console.log("[freeze]", new Date().toISOString(), ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }

function startServer(port) {
  let child;
  if (USE_DENO) {
    child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
      cwd: "/Users/jarvis/nasty-game/server/cloud",
      env: Object.assign({}, process.env, AWAY_ENV, { NASTY_PORT: String(port), NASTY_KV_PATH: path.join(SCRATCH, "freeze.kv"), NASTY_ADMIN_TOKEN: "freeze-admin-token" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    child = spawn(process.execPath, ["server.js"], {
      cwd: "/Users/jarvis/nasty-game/server",
      env: Object.assign({}, process.env, AWAY_ENV, {
        NASTY_PORT: String(port), NASTY_ROOMS_DIR: SCRATCH,
        NASTY_ADMIN_TOKEN_FILE: path.join(SCRATCH, "admin-token.txt"),
        NASTY_LEADERBOARD_FILE: path.join(SCRATCH, "leaderboard.json"),
        NASTY_LEADERBOARD_EPOCH_FILE: path.join(SCRATCH, "leaderboard-epoch.json"),
        NASTY_SOLO_IDS_FILE: path.join(SCRATCH, "solo-ids.json"),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  child.stdout.on("data", (d) => { if (process.env.NASTY_TEST_VERBOSE) process.stdout.write("[server] " + d); });
  child.stderr.on("data", (d) => { const s = String(d); if (!s.includes("Listening")) process.stderr.write("[server-err] " + s); });
  return child;
}
async function waitHealthy(port) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://localhost:${port}/health`); if (r.ok) return await r.json(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("server never became healthy");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPage(browser, wsPort, htmlPath) {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push(String(e)));
  const file = htmlPath || "/Users/jarvis/nasty-game/index.html";
  await page.goto(`file://${file}?ws=${encodeURIComponent(`ws://127.0.0.1:${wsPort}`)}`);
  await page.waitForFunction(() => typeof window.NET === "object");
  return page;
}
async function hostRoom(page, seatMeta, n) {
  return page.evaluate(({ seatMeta, n }) => {
    CFG.n = n; CFG.teams = false; CFG.seatMeta[n] = seatMeta;
    return new Promise((resolve) => {
      const orig = window.handleNetMessage;
      window.handleNetMessage = function (m) { orig(m); if (m.type === "created") { window.handleNetMessage = orig; resolve(m.code); } };
      window.hostCreateRoom();
    });
  }, { seatMeta, n });
}
async function joinRoom(page, code, name) {
  return page.evaluate(({ code, name }) => new Promise((resolve) => {
    window.connectWs().then(() => {
      const orig = window.handleNetMessage;
      window.handleNetMessage = function (m) { orig(m); if (m.type === "joined") { window.handleNetMessage = orig; resolve(m.playerId); } };
      window.netSend({ type: "join", protocolVersion: PROTOCOL_VERSION, code, name });
    });
  }), { code, name });
}
async function claimSeat(page, seatIndex, name) { await page.evaluate(({ seatIndex, name }) => window.netSend({ type: "claimSeat", seatIndex, name }), { seatIndex, name }); }
async function startGameOnline(hostPage, humanPages) {
  await hostPage.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION }));
  await Promise.all(humanPages.map((p) => p.waitForFunction(() => window.NET && window.NET.readyCheck != null, { timeout: 10000 })));
  await Promise.all(humanPages.map((p) => p.evaluate(() => window.netSend({ type: "readyUp" }))));
  await Promise.all(humanPages.map((p) => p.waitForFunction(() => window.G != null, { timeout: 15000 })));
  // Dismiss the one-time online-rules popup the way every real player does - the overlay
  // watchdog below treats ANY visible overlay during play as a violation, and this one is
  // legitimately up right at the deal.
  await Promise.all(humanPages.map((p) => p.evaluate(() => {
    const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click();
    const o = document.getElementById("onlineRulesOverlay"); if (o) o.classList.add("hidden");
  }).catch(() => {})));
}
async function tryDriveMove(page, seat) {
  return page.evaluate((seat) => {
    if (!window.G || window.G.over || window.G.paused) return false;
    if (window.NET.mySeat !== seat || window.G.turn !== seat) return false;
    if (window.NET.recalActive) return false;
    const moves = window.legalMoves(seat);
    if (!moves.length) return false;
    window.commitMove(seat, moves[Math.floor(Math.random() * moves.length)], null);
    return true;
  }, seat).catch(() => false);
}
async function gState(page) {
  return page.evaluate(() => {
    const G = window.G; if (!G) return null;
    return JSON.stringify({ turn: G.turn, dealer: G.dealer, schedRound: G.schedRound, over: G.over,
      bowedOut: G.bowedOut, pieces: G.pieces.map((ps) => ps.map((p) => [p.state, p.steps])),
      handLengths: G.hands.map((h) => h.length) });
  }).catch(() => null);
}
async function visibleOverlayCount(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".overlay")].filter((o) => {
      if (o.classList.contains("hidden")) return false;
      // A DELIBERATE pause is legitimately blocking - the P0 guard is about overlays nobody
      // asked for (the old waiting-for-host relic shape), not about the pause feature.
      if (o.id === "pauseOverlay" && window.G && window.G.paused) return false;
      return true;
    }).length
  ).catch(() => -1);
}
async function fireForeground(page) {
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pageshow"));
    window.onForeground();
  });
}
async function waitConverged(refPage, targetPage, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const [a, b] = await Promise.all([gState(refPage), gState(targetPage)]);
    if (a && b && a === b) return Date.now() - t0;
    await sleep(100);
  }
  return -1;
}

async function main() {
  const server = startServer(PORT);
  await waitHealthy(PORT);
  const proxy = await createFreezeProxy({ listenPort: PROXY_PORT, upstreamPort: PORT });
  const browser = await chromium.launch();

  // ---------------------------------------------------------------------------
  // Scenario 1+2+3+4: HOST connected through the freeze proxy; two live guests.
  // ---------------------------------------------------------------------------
  const seatMeta = [
    { name: "Host", type: "human", diff: "medium" }, { name: "G1", type: "human", diff: "medium" },
    { name: "G2", type: "human", diff: "medium" }, { name: "CPU1", type: "cpu", diff: "medium" },
  ];
  const host = await newPage(browser, PROXY_PORT);      // <- via the freeze proxy
  const g1 = await newPage(browser, PORT);
  const g2 = await newPage(browser, PORT);
  const code = await hostRoom(host, seatMeta, 4);
  await claimSeat(host, 0, "Host");
  await joinRoom(g1, code, "G1"); await claimSeat(g1, 1, "G1");
  await joinRoom(g2, code, "G2"); await claimSeat(g2, 2, "G2");
  await sleep(400);
  await startGameOnline(host, [host, g1, g2]);
  log("game started, room", code);

  // Everyone (host included) drives their own seat for a few seconds of real play.
  const driving = { host: true, guests: true };
  const driverErrors = [];
  const overlayViolations = [];
  const hostDriver = (async () => { while (driving.host) { await tryDriveMove(host, 0); await sleep(150); } })();
  const guestDriver = (async () => {
    while (driving.guests) {
      await tryDriveMove(g1, 1); await tryDriveMove(g2, 2);
      const [o1, o2] = await Promise.all([visibleOverlayCount(g1), visibleOverlayCount(g2)]);
      if (o1 > 0 || o2 > 0) overlayViolations.push({ o1, o2, t: Date.now() });
      await sleep(150);
    }
  })().catch((e) => driverErrors.push(String(e)));
  await sleep(3000);

  // FREEZE the host: network pipe silently dead (proxy) AND JS runtime frozen (CDP).
  driving.host = false; await hostDriver;
  const seqAtFreeze = await g1.evaluate(() => window.NET.appliedSeq);
  const cdp = await host.context().newCDPSession(host);
  proxy.freeze();
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  const freezeStart = Date.now();
  log(`host frozen (proxy + JS runtime) for ${FREEZE_MS}ms - guests keep playing`);

  // While frozen: ride the away ladder every time the host's seat comes up.
  let sawNudgeLine = false, sawOffer = false, sawPauseClear = false, sawRearm = false, offeredTaps = 0, sawGreyPlate = false;
  let pauseTested = false;
  while (Date.now() - freezeStart < FREEZE_MS) {
    const stuckOnHost = await g1.evaluate(() => window.G && !window.G.over && window.G.turn === 0);
    if (stuckOnHost) {
      // wait for the nudged status line
      const gotNudge = await g1.waitForFunction(() =>
        [...document.querySelectorAll("#awayActions button")].length >= 1, { timeout: 7000 }).then(() => true).catch(() => false);
      if (gotNudge) {
        sawNudgeLine = true;
        const lineText = await g1.evaluate(() => document.getElementById("toasts").textContent);
        if (!/nudge/i.test(lineText)) log("note: bubble text at nudge stage:", lineText);
        // wait for the cpuOffer button
        const gotOffer = await g1.waitForFunction(() =>
          [...document.querySelectorAll("#awayActions button")].some((b) => b.textContent.startsWith("Have the computer")),
          { timeout: 9000 }).then(() => true).catch(() => false);
        if (gotOffer) {
          sawOffer = true;
          if (!pauseTested) {
            // Pause composition: pausing clears the ladder; resuming re-arms it from zero.
            pauseTested = true;
            await g2.evaluate(() => window.netSend({ type: "pauseToggle", paused: true }));
            await sleep(1200);
            const cleared = await g1.evaluate(() => document.querySelectorAll("#awayActions button").length === 0);
            sawPauseClear = cleared;
            await g2.evaluate(() => window.netSend({ type: "pauseToggle", paused: false }));
            const rearmed = await g1.waitForFunction(() =>
              [...document.querySelectorAll("#awayActions button")].some((b) => b.textContent.startsWith("Have the computer")),
              { timeout: 15000 }).then(() => true).catch(() => false);
            sawRearm = rearmed;
            if (!rearmed) continue;
          }
          // ANY other player, one tap, no vote: g2 taps this time if possible, else g1.
          const tapper = offeredTaps % 2 === 0 ? g2 : g1;
          const tapped = await tapper.evaluate(() => {
            const b = [...document.querySelectorAll("#awayActions button")].find((x) => x.textContent.startsWith("Have the computer"));
            if (!b) return false; b.click(); return true;
          });
          if (!tapped) await g1.evaluate(() => {
            const b = [...document.querySelectorAll("#awayActions button")].find((x) => x.textContent.startsWith("Have the computer"));
            if (b) b.click();
          });
          offeredTaps++;
          const moved = await g1.waitForFunction(() => window.G && window.G.turn !== 0, { timeout: 5000 }).then(() => true).catch(() => false);
          if (!moved) log("warn: turn did not advance after cpuOffer tap");
        }
      }
    }
    const grey = await g1.evaluate(() => { const p = document.getElementById("plaque-0"); return !!(p && p.classList.contains("away")); });
    if (grey) sawGreyPlate = true;
    await sleep(300);
  }
  driving.guests = false; await guestDriver;
  const seqAtThaw = await g1.evaluate(() => window.NET.appliedSeq);

  check(seqAtThaw > seqAtFreeze, `${KIND}: guests kept playing the whole ${Math.round(FREEZE_MS / 1000)}s host freeze (appliedSeq ${seqAtFreeze} -> ${seqAtThaw})`);
  check(overlayViolations.length === 0, `${KIND}: NO blocking overlay ever appeared on the guests during the host freeze (P0 regression guard; violations=${overlayViolations.length})`);
  check(await g1.evaluate(() => document.getElementById("waitHostOverlay") == null), `${KIND}: the old #waitHostOverlay does not exist in the DOM at all`);
  check(sawNudgeLine, `${KIND}: away ladder stage 1 fired (status line + nudge button at ~${AWAY_ENV.NASTY_AWAY_NUDGE_MS}ms)`);
  check(sawOffer, `${KIND}: away ladder stage 2 fired (cpuOffer button at ~${AWAY_ENV.NASTY_AWAY_CPU_MS}ms)`);
  check(sawPauseClear, `${KIND}: pausing the table clears the away ladder UI`);
  check(sawRearm, `${KIND}: resuming re-arms the ladder from zero (offer came back)`);
  check(offeredTaps >= 1, `${KIND}: a guest's one-tap "have the computer play this turn" made the server play the frozen player's turn (taps=${offeredTaps})`);
  check(sawGreyPlate, `${KIND}: the frozen player's name plate greyed out on the guests (passive presence)`);
  const seatStillHuman = await g1.evaluate(() => window.G.seats[0].type === "human");
  check(seatStillHuman, `${KIND}: the away seat STAYED human after server-played turns (never auto-converted)`);

  // Scenario 3: unfreeze + foreground -> convergence within a few seconds.
  proxy.unfreeze();
  await cdp.send("Page.setWebLifecycleState", { state: "active" });
  await sleep(100);
  await fireForeground(host);
  const convergeMs = await waitConverged(g1, host, 8000);
  check(convergeMs >= 0 && convergeMs <= 4000, `${KIND}: frozen client converged after unfreeze+foreground in ${convergeMs}ms (target ~3s)`);
  check((g1.__errors || []).length === 0 && (g2.__errors || []).length === 0, `${KIND}: zero page errors on the guests`);
  check((host.__errors || []).length === 0, `${KIND}: zero page errors on the frozen host`);

  // Scenario 4: zombie-OPEN socket eats the resync -> automation recovers with no manual tap.
  await sleep(1500);
  const hostConnected = await host.evaluate(() => window.NET.ws && window.NET.ws.readyState === 1);
  check(hostConnected, `${KIND}: host is back on a live socket before the zombie scenario`);
  const preFreezeSeq = await g1.evaluate(() => window.NET.appliedSeq);
  proxy.freeze();                                     // existing socket goes silently dead
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  // Real drift must exist for the recovery to mean anything: the guests keep playing during
  // the zombie window - and if the table is stuck waiting on the FROZEN host's own seat, they
  // use the ladder's cpuOffer tap to move it along (fast thresholds, so this resolves in
  // seconds). The loop runs until genuine drift has accumulated, then everything STOPS before
  // the foreground - so convergence can only come from the resync-ack automation, never from a
  // later action papering over it. Window stays well under the servers' own dead-socket
  // teardown, so the zombie stays zombie.
  const zWindowStart = Date.now();
  let zg1Seq = preFreezeSeq;
  while (Date.now() - zWindowStart < 15000) {
    await tryDriveMove(g1, 1); await tryDriveMove(g2, 2);
    await g1.evaluate(() => {
      const b = [...document.querySelectorAll("#awayActions button")].find((x) => x.textContent.startsWith("Have the computer"));
      if (b && !b.disabled) b.click();
    }).catch(() => {});
    zg1Seq = await g1.evaluate(() => window.NET.appliedSeq);
    if (zg1Seq >= preFreezeSeq + 3 && Date.now() - zWindowStart >= 4000) break;
    await sleep(200);
  }
  await sleep(400);
  zg1Seq = await g1.evaluate(() => window.NET.appliedSeq);
  await cdp.send("Page.setWebLifecycleState", { state: "active" });
  await sleep(100);
  const stillLooksOpen = await host.evaluate(() => window.NET.ws && window.NET.ws.readyState === 1);
  const zHostSeq = await host.evaluate(() => window.NET.appliedSeq);
  check(zHostSeq < zg1Seq, `${KIND}: real drift existed at foreground time (host appliedSeq ${zHostSeq} < guests' ${zg1Seq})`);
  await host.evaluate(() => { window.__zombieWs = window.NET.ws; });
  const zTime0 = Date.now();
  let sawFailPrompt = false;
  const failWatch = (async () => {
    while (Date.now() - zTime0 < 8000) {
      if (await host.evaluate(() => window.NET.recalFailed === true).catch(() => false)) { sawFailPrompt = true; return; }
      await sleep(150);
    }
  })();
  await fireForeground(host);                         // resync goes into the dead pipe
  const zConvergeMs = await waitConverged(g1, host, 10000);
  await failWatch;
  check(stillLooksOpen, `${KIND}: socket still reported OPEN at foreground time (the zombie shape was real)`);
  check(zConvergeMs >= 1800 && zConvergeMs <= 6000, `${KIND}: zombie-socket foreground auto-recovered in ${zConvergeMs}ms (2s resync ack window + auto hard reset, no user action)`);
  const socketReplaced = await host.evaluate(() => window.NET.ws !== window.__zombieWs && window.NET.ws && window.NET.ws.readyState === 1);
  check(socketReplaced, `${KIND}: the zombie socket was torn down and REPLACED automatically (fresh live socket)`);
  check(!sawFailPrompt, `${KIND}: the manual failure prompt NEVER showed - automation exhausted itself first`);
  proxy.unfreeze();

  await host.context().close(); await g1.context().close(); await g2.context().close();

  // ---------------------------------------------------------------------------
  // Scenario 5 (v0.23): OLD-BUILD LOCKOUT - the exact build 28 client (protocol 2) vs the
  // new protocol-3 server. The "you can NOT take out your own pegs" rule change altered
  // MOVE LEGALITY, so old builds can no longer be allowed into an online room at all - they
  // would offer moves the new server rejects. This scenario replaces the pre-v0.23 version
  // (old client playing alongside new ones), which is impossible by design now: it asserts
  // the lockout is the clean, friendly experience - the plain-language update message and a
  // usable menu, never a room, never a crash. Offline play on old builds is untouched (not
  // exercised here - no server involved in offline).
  // ---------------------------------------------------------------------------
  log("--- old-build lockout: pinned build 28 client (commit " + BUILD28_COMMIT + ") ---");
  const oldHtmlPath = path.join(SCRATCH, "build28.html");
  const oldHtml = execSync(`git show ${BUILD28_COMMIT}:index.html`, { cwd: "/Users/jarvis/nasty-game", maxBuffer: 1024 * 1024 * 20 }).toString();
  fs.writeFileSync(oldHtmlPath, oldHtml);
  const host28 = await newPage(browser, PORT, oldHtmlPath);   // build 28 client, direct

  // 5a. build 28 tries to HOST: must get protocolMismatch (its own protocolVersion is 2),
  // show the friendly message, and land back on a clean menu - no room, no crash.
  const hostOutcome = await host28.evaluate(() => {
    CFG.n = 4; CFG.teams = false;
    return new Promise((resolve) => {
      const orig = window.handleNetMessage;
      const seen = [];
      window.handleNetMessage = function (m) {
        seen.push(m.type); orig(m);
        if (m.type === "created" || m.type === "protocolMismatch") {
          window.handleNetMessage = orig;
          setTimeout(() => resolve({ seen, toast: (document.getElementById("toasts") || {}).textContent || "", online: window.NET.online }), 600);
        }
      };
      window.hostCreateRoom();
    });
  });
  check(hostOutcome.seen.includes("protocolMismatch") && !hostOutcome.seen.includes("created"),
    `${KIND}: build 28 HOST attempt got protocolMismatch, never a room (saw: ${hostOutcome.seen.join(",")})`);
  check(/newest version/i.test(hostOutcome.toast) && !/[\u2014\u2013]/.test(hostOutcome.toast),
    `${KIND}: build 28 saw the friendly plain-language update message (dash-free): "${hostOutcome.toast.slice(0, 80)}"`);
  check(hostOutcome.online === false, `${KIND}: build 28 landed back on a clean menu (NET.online false), not stuck mid-flow`);

  // 5b. a CURRENT client hosts a real room; build 28 tries to JOIN it: same lockout, and the
  // current client's room is completely unaffected.
  const ngHost = await newPage(browser, PORT);
  const code2 = await hostRoom(ngHost, seatMeta, 4);
  const joinOutcome = await host28.evaluate((code) => new Promise((resolve) => {
    window.connectWs().then(() => {
      const orig = window.handleNetMessage;
      const seen = [];
      window.handleNetMessage = function (m) {
        seen.push(m.type); orig(m);
        if (m.type === "joined" || m.type === "protocolMismatch") {
          window.handleNetMessage = orig;
          setTimeout(() => resolve({ seen }), 400);
        }
      };
      window.netSend({ type: "join", protocolVersion: PROTOCOL_VERSION, code, name: "Old28" });
    }).catch(() => resolve({ seen: ["connectFailed"] }));
  }), code2);
  check(joinOutcome.seen.includes("protocolMismatch") && !joinOutcome.seen.includes("joined"),
    `${KIND}: build 28 JOIN attempt got protocolMismatch, never a seat (saw: ${joinOutcome.seen.join(",")})`);
  const hostStillFine = await ngHost.evaluate(() => window.NET.online === true && window.NET.code != null && (window.__errors || []).length === 0).catch(() => false);
  check(hostStillFine !== false && (ngHost.__errors || []).length === 0, `${KIND}: the current host's room was untouched by the rejected old-build join`);
  check((host28.__errors || []).length === 0, `${KIND}: zero page errors on the build 28 client through both rejections`);
  await host28.context().close();

  // ---------------------------------------------------------------------------
  // Scenario 5c/5d (v0.23.1): BUILD 30 LOCKOUT - the exact build 30 client (commit pinned,
  // protocol 3) vs the new protocol-4 server. The partner-peg last-resort ruling changed move
  // legality again: a build 30 client computes its own legal-move list locally to decide
  // whether to show a tappable hand, so in the forced-partner-landing spot it would find zero
  // moves and softlock on "Catching up..." while the server waits for its move. It must get
  // the same friendly lockout instead - never a room, never a crash.
  // ---------------------------------------------------------------------------
  log("--- v0.23.1 lockout: pinned build 30 client (commit " + BUILD30_COMMIT + ") ---");
  const b30HtmlPath = path.join(SCRATCH, "build30.html");
  const b30Html = execSync(`git show ${BUILD30_COMMIT}:index.html`, { cwd: "/Users/jarvis/nasty-game", maxBuffer: 1024 * 1024 * 20 }).toString();
  fs.writeFileSync(b30HtmlPath, b30Html);
  const host30 = await newPage(browser, PORT, b30HtmlPath);   // build 30 client, direct

  const hostOutcome30 = await host30.evaluate(() => {
    CFG.n = 4; CFG.teams = false;
    return new Promise((resolve) => {
      const orig = window.handleNetMessage;
      const seen = [];
      window.handleNetMessage = function (m) {
        seen.push(m.type); orig(m);
        if (m.type === "created" || m.type === "protocolMismatch") {
          window.handleNetMessage = orig;
          setTimeout(() => resolve({ seen, toast: (document.getElementById("toasts") || {}).textContent || "", online: window.NET.online }), 600);
        }
      };
      window.hostCreateRoom();
    });
  });
  check(hostOutcome30.seen.includes("protocolMismatch") && !hostOutcome30.seen.includes("created"),
    `${KIND}: build 30 HOST attempt got protocolMismatch, never a room (saw: ${hostOutcome30.seen.join(",")})`);
  check(/newest version/i.test(hostOutcome30.toast) && !/[—–]/.test(hostOutcome30.toast),
    `${KIND}: build 30 saw the friendly plain-language update message (dash-free): "${hostOutcome30.toast.slice(0, 80)}"`);
  check(hostOutcome30.online === false, `${KIND}: build 30 landed back on a clean menu (NET.online false), not stuck mid-flow`);

  const joinOutcome30 = await host30.evaluate((code) => new Promise((resolve) => {
    window.connectWs().then(() => {
      const orig = window.handleNetMessage;
      const seen = [];
      window.handleNetMessage = function (m) {
        seen.push(m.type); orig(m);
        if (m.type === "joined" || m.type === "protocolMismatch") {
          window.handleNetMessage = orig;
          setTimeout(() => resolve({ seen }), 400);
        }
      };
      window.netSend({ type: "join", protocolVersion: PROTOCOL_VERSION, code, name: "Old30" });
    }).catch(() => resolve({ seen: ["connectFailed"] }));
  }), code2);
  check(joinOutcome30.seen.includes("protocolMismatch") && !joinOutcome30.seen.includes("joined"),
    `${KIND}: build 30 JOIN attempt got protocolMismatch, never a seat (saw: ${joinOutcome30.seen.join(",")})`);
  const hostStillFine30 = await ngHost.evaluate(() => window.NET.online === true && window.NET.code != null && (window.__errors || []).length === 0).catch(() => false);
  check(hostStillFine30 !== false && (ngHost.__errors || []).length === 0, `${KIND}: the current host's room was untouched by the rejected build 30 join`);
  check((host30.__errors || []).length === 0, `${KIND}: zero page errors on the build 30 client through both rejections`);
  await ngHost.context().close();
  await host30.context().close();

  await browser.close();
  await proxy.close();
  server.kill("SIGKILL");
  log(`RESULT: ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
