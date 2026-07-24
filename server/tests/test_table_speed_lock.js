"use strict";
/*
 * 2026-07-23 (Blake's items 3 & 4) - "Make the game speed be a part of the saved game and
 * don't ever let anyone online be at a different speed than another human" (item 3), and "as
 * the inviter... I should also be able to change the game speed for everyone at any point...
 * whether it be at the start of a new game or when playing the game later in the day" (item 4).
 *
 * INVESTIGATION NOTE (for HANDOFF.md, recorded here too): this session could NOT reproduce
 * either of these as broken. room.tableSpeed already rides every persisted room snapshot
 * (roomToDisk/roomFromDisk, server.js; a plain RoomMeta field in KV, server.ts) and every
 * `sync`/`reclaimed` reply (gameSnapshotFields); "setTableSpeed" already checks
 * `playerId === room.hostPlayerId` with no time-since-start restriction, so the host has always
 * been able to change it "at any point," not just before inviting. Direct reproduction (this
 * session's scratch harness, both a plain reconnect and a real server-restart-then-reconnect,
 * on BOTH servers) always converged both players on the SAME persisted tableSpeed, with the
 * host able to change it again afterward and the guest correctly refused. This suite locks that
 * CONFIRMED-WORKING contract down permanently so a future regression is caught immediately, and
 * covers the one real, confirmed contributor to Blake's confusion this session DID find: the
 * offline one-time speed picker interjecting mid-reconnect fallback (fixed separately, see
 * openJoinOverlay()'s skipSpeedGate and test_reconnect_retry.js Scenario B) - a Playwright
 * section here proves that fix from the ANGLE of "two humans' own local USER_SPEED preferences
 * never leak into the shared online pace," end to end.
 *
 * Usage:
 *   node test_table_speed_lock.js node     (server/server.js)
 *   node test_table_speed_lock.js deno     (server/cloud/server.ts)
 */
const WebSocket = require("/Users/jarvis/nasty-game/server/node_modules/ws");
const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const KIND = process.argv[2] || "node";
const USE_DENO = KIND === "deno";
const PORT = 24900 + Math.floor(Math.random() * 500);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-speedlock-${KIND}-`));

function log(...a) { console.log("[speedlock]", new Date().toISOString(), ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port, scratch) {
  let child;
  if (USE_DENO) {
    child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
      cwd: "/Users/jarvis/nasty-game/server/cloud",
      env: Object.assign({}, process.env, { NASTY_PORT: String(port), NASTY_KV_PATH: path.join(scratch, "speed.kv"), NASTY_ADMIN_TOKEN: "speed-admin-token" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    child = spawn(process.execPath, ["server.js"], {
      cwd: "/Users/jarvis/nasty-game/server",
      env: Object.assign({}, process.env, {
        NASTY_PORT: String(port), NASTY_ROOMS_DIR: scratch,
        NASTY_ADMIN_TOKEN_FILE: path.join(scratch, "admin-token.txt"),
        NASTY_LEADERBOARD_FILE: path.join(scratch, "leaderboard.json"),
        NASTY_LEADERBOARD_EPOCH_FILE: path.join(scratch, "leaderboard-epoch.json"),
        NASTY_SOLO_IDS_FILE: path.join(scratch, "solo-ids.json"),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  child.stderr.on("data", (d) => { if (process.env.NASTY_TEST_VERBOSE) process.stderr.write("[server-err] " + d); });
  return child;
}
async function waitHealthy(port) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://localhost:${port}/health`); if (r.ok) return; } catch (e) {}
    await sleep(400);
  }
  throw new Error("server never became healthy");
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.msgs = [];
    ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); ws.msgs.push({ t: Date.now(), m }); });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
const sendJ = (ws, obj) => ws.send(JSON.stringify(obj));
function waitMsg(ws, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const seen = ws.msgs.find((e) => predicate(e.m));
    if (seen) { resolve(seen); return; }
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = ws.msgs.find((e) => predicate(e.m));
      if (hit) { clearInterval(iv); resolve(hit); return; }
      if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error("timeout waiting for message")); }
    }, 50);
  });
}

async function main() {
  const child = startServer(PORT, SCRATCH);
  await waitHealthy(PORT);

  /* ===================================================================================
   * 1: the host's chosen speed seeds the room, rides the start action, and BOTH players start
   *    at the SAME speed - a guest who never touches a speed control included.
   * =================================================================================== */
  log("--- 1: host's chosen speed is the ONE shared speed from the very first deal ---");
  let code, hostPlayerId, hostToken, guestPlayerId, guestToken;
  {
    const host = await connect(PORT);
    sendJ(host, { type: "host", protocolVersion: 5, name: "Blake", n: 4, teams: false, speed: 1.7, seats: [
      { name: "Blake", type: "human" }, { name: "Friend", type: "human" }, { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
    ] });
    const created = (await waitMsg(host, (m) => m.type === "created")).m;
    code = created.code; hostPlayerId = created.playerId; hostToken = created.token;
    const guest = await connect(PORT);
    sendJ(guest, { type: "join", protocolVersion: 5, code, name: "Friend" });
    const joined = (await waitMsg(guest, (m) => m.type === "joined")).m;
    guestPlayerId = joined.playerId; guestToken = joined.token;
    sendJ(guest, { type: "claimSeat", seatIndex: 1, name: "Friend" });
    await waitMsg(host, (m) => m.type === "lobby");
    sendJ(guest, { type: "readyUp", willSeat: true });
    await sleep(200);
    sendJ(host, { type: "start", protocolVersion: 5, willSeat: true });
    const hostStart = (await waitMsg(host, (m) => m.type === "gameAction" && m.seq === 0)).m;
    const guestStart = (await waitMsg(guest, (m) => m.type === "gameAction" && m.seq === 0)).m;
    check(hostStart.action.tableSpeed === 1.7, `1: the start action itself carries the host's chosen speed (got ${hostStart.action.tableSpeed})`);
    check(guestStart.action.tableSpeed === 1.7, `1: the GUEST's copy of the start action carries the SAME speed, unprompted (got ${guestStart.action.tableSpeed})`);
    host.close(); guest.close();
    await sleep(1200);   // let the debounced persist flush before we start killing/restarting
  }

  /* ===================================================================================
   * 2: "later in the day" - kill the server, restart it on the SAME rooms dir/KV path, and
   *    reconnect BOTH players. Neither one defaults to their own local preference; both get the
   *    exact SAME persisted speed back. Item 3's literal ask.
   * =================================================================================== */
  log("--- 2: tableSpeed survives a real server restart - both players reconnect to the SAME speed ---");
  {
    child.kill("SIGKILL");
    await sleep(300);
    const child2 = startServer(PORT, SCRATCH);
    await waitHealthy(PORT);

    const host = await connect(PORT);
    sendJ(host, { type: "rejoin", protocolVersion: 5, code, playerId: hostPlayerId, token: hostToken });
    const hostSync = (await waitMsg(host, (m) => m.type === "sync")).m;
    const guest = await connect(PORT);
    sendJ(guest, { type: "rejoin", protocolVersion: 5, code, playerId: guestPlayerId, token: guestToken });
    const guestSync = (await waitMsg(guest, (m) => m.type === "sync")).m;
    check(hostSync.tableSpeed === 1.7, `2: the HOST's post-restart sync still shows 1.7 (got ${hostSync.tableSpeed})`);
    check(guestSync.tableSpeed === 1.7, `2: the GUEST's post-restart sync ALSO shows 1.7, not some other default (got ${guestSync.tableSpeed})`);
    check(hostSync.tableSpeed === guestSync.tableSpeed, "2: no two humans in the same online game are ever at a different speed");

    /* =================================================================================
     * 3: item 4 - the host can STILL change the speed at any point, including well after a
     *    restart / "later in the day," and it propagates to the guest immediately.
     * ================================================================================= */
    log("--- 3: the host can change the speed AT ANY TIME, even after a restart ---");
    sendJ(host, { type: "setTableSpeed", speed: 2.6 });
    const hostSpeedMsg = (await waitMsg(host, (m) => m.type === "tableSpeed")).m;
    const guestSpeedMsg = (await waitMsg(guest, (m) => m.type === "tableSpeed")).m;
    check(hostSpeedMsg.speed === 2.6, `3: the host's own change is echoed back to them (got ${hostSpeedMsg.speed})`);
    check(guestSpeedMsg.speed === 2.6, `3: the guest gets the SAME change live, mid-game, no reconnect needed (got ${guestSpeedMsg.speed})`);

    /* =================================================================================
     * 4: item 4's other half - a non-host player can NEVER change the table speed, before or
     *    after a restart, online or off.
     * ================================================================================= */
    log("--- 4: a non-host player's setTableSpeed is silently refused ---");
    const beforeGuestAttempt = guestSpeedMsg.speed;
    sendJ(guest, { type: "setTableSpeed", speed: 0.6 });
    await sleep(400);
    const guestAttemptEcho = guest.msgs.filter((e) => e.m.type === "tableSpeed").length;
    check(guestAttemptEcho === 1, "4: the guest's own setTableSpeed attempt produces NO new tableSpeed broadcast at all (still just the host's one from step 3)");
    const hostStillSees = host.msgs.filter((e) => e.m.type === "tableSpeed").map((e) => e.m.speed);
    check(!hostStillSees.includes(0.6), "4: the guest's attempted speed value never reaches the host's table at all");

    host.close(); guest.close();
    child2.kill("SIGKILL");
  }

  /* ===================================================================================
   * 5 (Playwright, real client): two humans with DIFFERENT local offline speed preferences
   *    (USER_SPEED, localStorage 'nasty-speed') both land on the host's shared online speed -
   *    neither one's own personal preference ever leaks into NET.tableSpeed. This is item 3's
   *    exact framing ("I was on fast but my friend was on normal").
   * =================================================================================== */
  log("--- 5 (Playwright): two different local speed preferences never leak into the shared online speed ---");
  {
    const pwScratch = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-speedlock-pw-${KIND}-`));
    let child3 = startServer(PORT + 1, pwScratch);
    await waitHealthy(PORT + 1);
    const browser = await chromium.launch();
    // Deliberately NOT reducedMotion here (unlike most of this codebase's UI suites) - reduced
    // motion forces SPEED to Math.max(base,6) (see applySpeed(), § UTIL), which would floor
    // every SPEED_OPTS value (0.6-2.6) to the SAME 6 and mask exactly the bug this scenario
    // exists to catch (the real SPEED variable never getting synced to NET.tableSpeed at boot -
    // see bootGameFromNetwork()/bootGameFromSnapshot()'s 2026-07-23 fix comments).
    const ctxH = await browser.newContext({});
    const ctxG = await browser.newContext({});
    let host = await ctxH.newPage();
    const guest = await ctxG.newPage();
    const wsUrl = `ws://127.0.0.1:${PORT + 1}`;
    await host.goto(`file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent(wsUrl)}`);
    await guest.goto(`file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent(wsUrl)}`);
    await host.waitForFunction(() => typeof window.NET === "object");
    await guest.waitForFunction(() => typeof window.NET === "object");
    // The two players' own OFFLINE preferences, deliberately set to DIFFERENT values, exactly
    // like Blake ("I was on fast") and his friend ("was on normal").
    await host.evaluate(() => { localStorage.setItem("nasty-speed-chosen", "1"); localStorage.setItem("nasty-speed", "2.6"); });
    await guest.evaluate(() => { localStorage.setItem("nasty-speed-chosen", "1"); localStorage.setItem("nasty-speed", "0.6"); });

    const code2 = await host.evaluate(() => {
      CFG.n = 4; CFG.teams = false;
      CFG.seatMeta[4] = [
        { name: "Blake", type: "human", diff: "medium" }, { name: "Friend", type: "human", diff: "medium" },
        { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
      ];
      return new Promise((resolve) => {
        const orig = window.handleNetMessage;
        window.handleNetMessage = function (m) { orig(m); if (m.type === "created") { window.handleNetMessage = orig; resolve(m.code); } };
        window.hostCreateRoom(1.7);   // host explicitly picks Fast for the TABLE
      });
    });
    await host.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
    await guest.evaluate((code) => new Promise((resolve) => {
      window.connectWs().then(() => {
        const orig = window.handleNetMessage;
        window.handleNetMessage = function (m) { orig(m); if (m.type === "joined") { window.handleNetMessage = orig; resolve(); } };
        window.netSend({ type: "join", protocolVersion: PROTOCOL_VERSION, code, name: "Friend" });
      });
    }), code2);
    await guest.evaluate(() => window.netSend({ type: "claimSeat", seatIndex: 1, name: "Friend" }));
    await guest.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
    await guest.evaluate(() => window.netSend({ type: "readyUp", willSeat: true }));
    await sleep(300);
    await host.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION, willSeat: true }));
    await Promise.all([host, guest].map((p) => p.waitForFunction(() => window.G != null, { timeout: 10000 })));

    const speeds = await Promise.all([host, guest].map((p) => p.evaluate(() => window.NET.tableSpeed)));
    check(speeds[0] === 1.7 && speeds[1] === 1.7, `5: both land at the host's 1.7 despite their own OPPOSITE local preferences (2.6 vs 0.6) (got ${JSON.stringify(speeds)})`);

    // The Speed button's own LABEL also reads the shared speed, not the local one, for both.
    const labels = await Promise.all([host, guest].map((p) => p.evaluate(() => document.getElementById("btnSpeed").textContent)));
    check(labels.every((l) => /Fast/.test(l)), `5: the topbar Speed button reads "Fast" for BOTH players (got ${JSON.stringify(labels)})`);

    // THE ACTUAL REGRESSION GUARD: the real SPEED variable (§ UTIL) every animation duration in
    // this file is computed from - not just the NET.tableSpeed data field - must also match.
    // This is the exact check that caught the real bug this session (setting NET.tableSpeed
    // alone never applied it; applySpeed() does, and neither boot function called it).
    const rawSpeeds = await Promise.all([host, guest].map((p) => p.evaluate(() => SPEED)));
    check(rawSpeeds[0] === 1.7 && rawSpeeds[1] === 1.7, `5: the REAL animation-pacing SPEED variable is 1.7 for BOTH players, not their own stale local value (got ${JSON.stringify(rawSpeeds)})`);

    /* =================================================================================
     * 5b: the same guard on the RECONNECT path - "later in the day," a fresh page (fresh JS
     *     realm, SPEED starts from that device's OWN local default again) must also land on
     *     the real shared speed, not just the data field.
     * ================================================================================= */
    await host.evaluate(() => { document.getElementById("btnPause").click(); document.getElementById("btnLeaveSave").click(); });
    await host.close();
    await sleep(1200);   // let the debounced persist flush
    child3.kill("SIGKILL");
    await sleep(300);
    child3 = startServer(PORT + 1, pwScratch);
    await waitHealthy(PORT + 1);
    host = await ctxH.newPage();
    await host.goto(`file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent(wsUrl)}`);
    await host.waitForFunction(() => typeof window.NET === "object");
    await host.waitForFunction(() => document.getElementById("btnSavedGame") && !document.getElementById("btnSavedGame").classList.contains("hidden"), { timeout: 5000 });
    const speedBeforeReconnect = await host.evaluate(() => SPEED);
    await host.evaluate(() => document.getElementById("savedGameMain").click());
    await host.waitForFunction(() => window.G != null, { timeout: 8000 });
    await sleep(500);
    const rawSpeedAfterReconnect = await host.evaluate(() => SPEED);
    check(speedBeforeReconnect === 2.6, `5b: sanity - this fresh page's own local default (Turbo, 2.6) is what SPEED starts at before reconnecting (got ${speedBeforeReconnect})`);
    check(rawSpeedAfterReconnect === 1.7, `5b: after reconnecting "later in the day," SPEED is corrected to the table's real 1.7, not left at this device's own stale ${speedBeforeReconnect} (got ${rawSpeedAfterReconnect})`);

    await browser.close();
    child3.kill("SIGKILL");
  }

  console.log(`\n[${KIND}] ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}
const WATCHDOG_MS = 90000;
const watchdog = setTimeout(() => {
  console.error(`[speedlock] WATCHDOG: suite did not finish within ${WATCHDOG_MS}ms - forcing exit`);
  process.exit(1);
}, WATCHDOG_MS);
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => clearTimeout(watchdog));
