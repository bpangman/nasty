"use strict";
/*
 * v0.25 UI-flow suite - the acceptance-bar Playwright tests the item 1-9 batch didn't get
 * dedicated coverage for anywhere else (chaos_v15/reconnect_storm/test_freeze_recovery/
 * test_recalibration all updated their EXISTING helpers for protocol 5 + lobby-ready; the wire
 * suites - protocol_checklist/test_v16_features/test_seat_gate/smoke_* - prove the server side.
 * Nothing anywhere drove these behaviors through the REAL DOM). Usage:
 *   node test_v025_ui_flows.js node     (server/server.js)
 *   node test_v025_ui_flows.js deno     (server/cloud/server.ts)
 *
 * Scenarios:
 *  A. Invitee flow: rules popup shows BEFORE seat selection, dismissing it reveals the seat
 *     list, claiming a seat + tapping "Ready up" (real button clicks) locks the guest's seat
 *     and lights up the host's Start button (item 1).
 *  B. Host picks a table speed via the real speed-picker UI before the room exists; a guest who
 *     never touches a speed control joins already running at the host's chosen pace (item 2).
 *  C. Blake's exact regression: two humans quit (via Pause/Save's "Save & leave" - still the
 *     one consequence-free way to step away, see v0.27's Scenario G below for the topbar button
 *     itself), one relaunches (fresh page, same profile) to the MENU (not auto-rejoined), taps
 *     the saved-game tile, gets the rejoin lobby since the other human isn't back, converts them
 *     to a CPU via the Easy/Tricky/Nasty picker, resumes, and plays on solo (items 6+7).
 *  D. Counterpart: if the other human never actually left (still connected), tapping the tile
 *     goes STRAIGHT to the live board - no rejoin lobby ever appears (items 6+7).
 *  E. Pause/Save opens the single-screen options sheet directly (no separate PAUSED screen
 *     first) with the exact "Have a computer take over my seat" wording (items 4+9).
 *  F. A disconnected player's name renders red (not just dimmed) and the online rules text
 *     explains it in plain language (item 5).
 *  G. v0.27: the topbar button (Quit, was "Menu" through v0.26) asks for confirmation before
 *     surrendering an unfinished game; Cancel resumes with zero changes, confirming lands on the
 *     menu. (Deeper surrender/loss-recording coverage lives in test_surrender.js - this scenario
 *     just proves the topbar button's own dialog behavior, kept here since it replaces the old
 *     "instant, no dialog" item 9 assertion this file used to make.)
 */
const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const KIND = process.argv[2] || "node";
const USE_DENO = KIND === "deno";
// TWO private servers, not one: server.js/server.ts cap host-room-creates at 5/min/IP (see
// HOST_RATE_LIMIT, proven by protocol_checklist.js's own rate-limit check) - this suite creates
// a fresh room in every one of its 6 scenarios, all from the same test-runner IP, well within a
// single minute. Splitting across two servers keeps each one's count at 3, safely under the cap,
// instead of the 6th create silently landing on a rate-limit error every promise here already
// now rejects on cleanly (see hostRoom()) rather than hanging.
const PORT = 23200 + Math.floor(Math.random() * 500);
const PORT2 = PORT + 1;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-v025ui-${KIND}-`));

function log(...a) { console.log("[v025ui]", new Date().toISOString(), ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port) {
  // Per-port scratch subdir - this suite runs TWO server instances at once (see the PORT/PORT2
  // comment above), and both the Deno KV file and the Node rooms-dir/leaderboard files must
  // never be shared between them (a shared KV path throws "database is locked" the instant a
  // second process opens it - the exact failure this fix addresses).
  const portScratch = path.join(SCRATCH, String(port));
  fs.mkdirSync(portScratch, { recursive: true });
  let child;
  if (USE_DENO) {
    child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
      cwd: "/Users/jarvis/nasty-game/server/cloud",
      env: Object.assign({}, process.env, { NASTY_PORT: String(port), NASTY_KV_PATH: path.join(portScratch, "v025ui.kv"), NASTY_ADMIN_TOKEN: "v025ui-admin-token" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    child = spawn(process.execPath, ["server.js"], {
      cwd: "/Users/jarvis/nasty-game/server",
      env: Object.assign({}, process.env, {
        NASTY_PORT: String(port), NASTY_ROOMS_DIR: portScratch,
        NASTY_ADMIN_TOKEN_FILE: path.join(portScratch, "admin-token.txt"),
        NASTY_LEADERBOARD_FILE: path.join(portScratch, "leaderboard.json"),
        NASTY_LEADERBOARD_EPOCH_FILE: path.join(portScratch, "leaderboard-epoch.json"),
        NASTY_SOLO_IDS_FILE: path.join(portScratch, "solo-ids.json"),
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
    try { const r = await fetch(`http://localhost:${port}/health`); if (r.ok) return; } catch (e) {}
    await sleep(400);
  }
  throw new Error("server never became healthy");
}

async function newPage(ctx, wsPort) {
  const page = await ctx.newPage();
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push(String(e)));
  await page.goto(`file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent(`ws://127.0.0.1:${wsPort}`)}`);
  await page.waitForFunction(() => typeof window.NET === "object");
  // Every context in this suite has already "seen" the one-time speed picker on a prior device
  // (Blake's family has played before) - the flows under test are about the ONLINE lobby/rules/
  // rejoin machinery, not the offline first-run speed gate.
  await page.evaluate(() => { try { localStorage.setItem("nasty-speed-chosen", "1"); } catch (e) {} });
  return page;
}
async function hostRoom(page, seatMeta, n, tableSpeed) {
  // Reject (never just hang) on a server-side "error" reply too - e.g. the 5/min/IP host-create
  // rate limiter (see server.js/server.ts HOST_RATE_LIMIT) - so a rate-limit hit anywhere in
  // this suite surfaces as a clear failure instead of a silent, permanent wait.
  return page.evaluate(({ seatMeta, n, tableSpeed }) => {
    CFG.n = n; CFG.teams = false; CFG.seatMeta[n] = seatMeta;
    return new Promise((resolve, reject) => {
      const orig = window.handleNetMessage;
      window.handleNetMessage = function (m) {
        orig(m);
        if (m.type === "created") { window.handleNetMessage = orig; resolve(m.code); }
        else if (m.type === "error") { window.handleNetMessage = orig; reject(new Error("host create failed: " + m.message)); }
      };
      window.hostCreateRoom(tableSpeed);
    });
  }, { seatMeta, n, tableSpeed });
}
async function tryDriveMove(page, seat) {
  return page.evaluate((seat) => {
    if (!window.G || window.G.over || window.G.paused) return false;
    if (window.NET.mySeat !== seat || window.G.turn !== seat) return false;
    const moves = window.legalMoves(seat);
    if (!moves.length) return false;
    window.commitMove(seat, moves[Math.floor(Math.random() * moves.length)], null);
    return true;
  }, seat).catch(() => false);
}
async function driveSeveralTurns(page, seat, ms) {
  const t0 = Date.now();
  let moved = 0;
  while (Date.now() - t0 < ms) {
    if (await tryDriveMove(page, seat)) moved++;
    await sleep(150);
  }
  return moved;
}

async function main() {
  const child = startServer(PORT);
  const child2 = startServer(PORT2);
  await Promise.all([waitHealthy(PORT), waitHealthy(PORT2)]);
  const browser = await chromium.launch();

  /* ===================================================================================
   * Scenario A: invitee rules-then-seat-then-ready flow, driven through the real UI.
   * =================================================================================== */
  log("--- Scenario A: invitee rules -> seat -> ready, real UI clicks ---");
  {
    const ctxH = await browser.newContext({ reducedMotion: "reduce" });
    const ctxG = await browser.newContext({ reducedMotion: "reduce" });
    const host = await newPage(ctxH, PORT);
    const guest = await newPage(ctxG, PORT);

    const seatMeta = [
      { name: "Host", type: "human", diff: "medium" }, { name: "Guest1", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
    ];
    const code = await hostRoom(host, seatMeta, 4);
    // Host also gets the one-time rules popup on room creation - dismiss it before the guest's.
    await host.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });

    // Guest: real click path - Online play -> Join a game -> code -> name -> Continue.
    await guest.evaluate(() => document.getElementById("btnOnline").click());
    await guest.evaluate(() => document.getElementById("btnJoinGame").click());
    await guest.evaluate((code) => { document.getElementById("joinCodeInput").value = code; }, code);
    await guest.evaluate(() => document.getElementById("btnJoinCodeNext").click());
    await guest.evaluate(() => { document.getElementById("joinNameInput").value = "Guest1"; });
    await guest.evaluate(() => document.getElementById("btnJoinNameNext").click());
    await guest.waitForFunction(() => window.NET && window.NET.lobby != null, { timeout: 8000 });

    // The rules popup must be showing NOW, on top of the (already-rendered) seat step -
    // that's the "rules before seat selection" contract (item 1).
    const rulesUpFirst = await guest.evaluate(() => ({
      rulesHidden: document.getElementById("onlineRulesOverlay").classList.contains("hidden"),
      seatStepHidden: document.getElementById("joinSeatStep").classList.contains("hidden"),
    }));
    check(rulesUpFirst.rulesHidden === false, "A: guest sees the online-rules popup on first reaching the seat step");
    check(rulesUpFirst.seatStepHidden === false, "A: the seat step is already rendered underneath (rules sits ON TOP, not blocking earlier)");

    // Dismiss the rules popup - a real button click, exactly like a real player.
    await guest.evaluate(() => document.getElementById("btnOnlineRulesOk").click());
    const rulesGone = await guest.evaluate(() => document.getElementById("onlineRulesOverlay").classList.contains("hidden"));
    check(rulesGone, "A: rules popup dismissed by the real Got it button");

    // Claim an open seat by clicking the actual rendered row (seat 1, since seat 0 is host).
    const claimed = await guest.evaluate(() => {
      const rows = [...document.querySelectorAll("#joinSeatList .lobbySeat")];
      const openRow = rows.find((r) => r.classList.contains("open"));
      if (!openRow) return false;
      openRow.click();
      return true;
    });
    check(claimed, "A: guest claimed an open seat via a real row click");
    await guest.waitForFunction(() => {
      const btn = document.getElementById("btnJoinReady");
      return btn && !btn.classList.contains("hidden");
    }, { timeout: 5000 });

    // Tap "Ready up" - a real click on the actual button.
    await guest.evaluate(() => document.getElementById("btnJoinReady").click());
    await host.waitForFunction(() => {
      const btn = document.getElementById("btnRoomStart");
      return btn && !btn.disabled;
    }, { timeout: 5000 });
    const hostSeesReady = await host.evaluate(() => {
      const rows = [...document.querySelectorAll("#roomSeatList .lobbySeat")];
      return rows.some((r) => r.textContent.includes("Ready"));
    });
    check(hostSeesReady, "A: the host's room screen shows the guest's seat as Ready");
    const startEnabled = await host.evaluate(() => !document.getElementById("btnRoomStart").disabled);
    check(startEnabled, "A: Start lit up on the host's screen once the only guest readied up");

    // Host starts for real, via the real Start button.
    await host.evaluate(() => document.getElementById("btnRoomStart").click());
    await Promise.all([host, guest].map((p) => p.waitForFunction(() => window.G != null, { timeout: 10000 })));
    check(true, "A: real Start click dealt the game for both real UI-driven clients");
    check((host.__errors || []).length === 0 && (guest.__errors || []).length === 0, "A: zero page errors through the whole invitee flow");

    await ctxH.close(); await ctxG.close();
  }

  /* ===================================================================================
   * Scenario B: host picks the table speed via the real UI; a guest who never touches a
   * speed control joins already running at the host's chosen pace.
   * =================================================================================== */
  log("--- Scenario B: host speed picker seeds a guest's table speed ---");
  {
    const ctxH = await browser.newContext({ reducedMotion: "reduce" });
    const ctxG = await browser.newContext({ reducedMotion: "reduce" });
    const host = await newPage(ctxH, PORT);
    const guest = await newPage(ctxG, PORT);

    // Real click path: Online play -> Host a game -> speed picker -> "Fast" (1.7, NOT the
    // 0.6 offline default) -> hostCreateRoom() fires with that value. NET.tableSpeed itself
    // isn't set until the actual deal (applyServerAction's 'start' case / bootGameFromSnapshot -
    // see index.html, § NET) - the room's chosen speed only becomes observable client-side once
    // the game is genuinely dealt, so this scenario plays the room out to a real deal before
    // checking either side's NET.tableSpeed.
    await host.evaluate(() => document.getElementById("btnOnline").click());
    await host.evaluate(() => document.getElementById("btnHostGame").click());
    await host.waitForFunction(() => !document.getElementById("hostSpeedOverlay").classList.contains("hidden"), { timeout: 5000 });
    const code = await host.evaluate(() => {
      CFG.n = 4; CFG.teams = false;
      CFG.seatMeta[4] = [
        { name: "Host", type: "human", diff: "medium" }, { name: "Guest1", type: "human", diff: "medium" },
        { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
      ];
      return new Promise((resolve, reject) => {
        const orig = window.handleNetMessage;
        window.handleNetMessage = function (m) {
          orig(m);
          if (m.type === "created") { window.handleNetMessage = orig; resolve(m.code); }
          else if (m.type === "error") { window.handleNetMessage = orig; reject(new Error("host create failed: " + m.message)); }
        };
        // Click the real "Fast" button (SPEED_OPTS[2] = [1.7,'Fast']) rather than calling
        // hostCreateRoom() directly - this IS the behavior under test.
        const btns = [...document.querySelectorAll("#hostSpeedBtns button")];
        const fastBtn = btns.find((b) => b.textContent.startsWith("Fast"));
        if (!fastBtn) { reject(new Error("Fast speed button not found in #hostSpeedBtns")); return; }
        fastBtn.click();
      });
    });
    await host.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });

    // Guest joins normally - never touches any speed control at all - then both ready up and
    // the host starts for real, so the deal actually happens.
    await guest.evaluate((code) => new Promise((resolve) => {
      window.connectWs().then(() => {
        const orig = window.handleNetMessage;
        window.handleNetMessage = function (m) { orig(m); if (m.type === "joined") { window.handleNetMessage = orig; resolve(); } };
        window.netSend({ type: "join", protocolVersion: PROTOCOL_VERSION, code, name: "Guest1" });
      });
    }), code);
    await guest.evaluate(() => window.netSend({ type: "claimSeat", seatIndex: 1, name: "Guest1" }));
    await guest.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
    await guest.evaluate(() => window.netSend({ type: "readyUp", willSeat: true }));
    await sleep(400);
    await host.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION, willSeat: true }));
    await Promise.all([host, guest].map((p) => p.waitForFunction(() => window.G != null, { timeout: 10000 })));

    const hostSpeed = await host.evaluate(() => window.NET.tableSpeed);
    check(hostSpeed === 1.7, `B: host's dealt game runs at tableSpeed 1.7 from the real speed-picker click (got ${hostSpeed})`);
    const guestSpeed = await guest.evaluate(() => window.NET.tableSpeed);
    check(guestSpeed === 1.7, `B: guest's NET.tableSpeed seeded to the host's 1.7 choice without ever picking a speed itself (got ${guestSpeed})`);

    await ctxH.close(); await ctxG.close();
  }

  /* ===================================================================================
   * Scenario C: Blake's exact regression. Two humans quit; one relaunches to the MENU (not
   * auto-rejoined); taps the saved-game tile; the other human isn't back, so the rejoin
   * lobby opens; converts them to a CPU via the difficulty picker; resumes; plays solo.
   * =================================================================================== */
  log("--- Scenario C: Blake's regression - quit both, relaunch, rejoin lobby, CPU takeover, solo play ---");
  {
    const ctxH = await browser.newContext({ reducedMotion: "reduce" });
    const ctxG = await browser.newContext({ reducedMotion: "reduce" });
    let host = await newPage(ctxH, PORT);
    let guest = await newPage(ctxG, PORT);
    const seatMeta = [
      { name: "Host", type: "human", diff: "medium" }, { name: "Guest1", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
    ];
    const code = await hostRoom(host, seatMeta, 4);
    await host.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
    await guest.evaluate((code) => new Promise((resolve) => {
      window.connectWs().then(() => {
        const orig = window.handleNetMessage;
        window.handleNetMessage = function (m) { orig(m); if (m.type === "joined") { window.handleNetMessage = orig; resolve(); } };
        window.netSend({ type: "join", protocolVersion: PROTOCOL_VERSION, code, name: "Guest1" });
      });
    }), code);
    await guest.evaluate(() => window.netSend({ type: "claimSeat", seatIndex: 1, name: "Guest1" }));
    await guest.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
    await guest.evaluate(() => window.netSend({ type: "readyUp", willSeat: true }));
    await sleep(400);
    await host.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION, willSeat: true }));
    await Promise.all([host, guest].map((p) => p.waitForFunction(() => window.G != null, { timeout: 10000 })));
    // Real progress before anyone leaves.
    await driveSeveralTurns(host, 0, 1500);
    await driveSeveralTurns(guest, 1, 1500);

    // BOTH humans quit: Pause/Save -> "Save & leave" (still the one consequence-free way to step
    // away and keep the game resumable - v0.27 turned the topbar button itself into a surrender,
    // which would permanently convert these seats to CPUs and defeat this whole scenario's
    // premise of coming BACK to the same room - see Scenario G below for that button's own
    // coverage), then the app itself is killed (the page closes) - the honest shape of "quit the
    // app," not just backgrounding.
    await host.evaluate(() => { document.getElementById("btnPause").click(); document.getElementById("btnLeaveSave").click(); });
    await guest.evaluate(() => { document.getElementById("btnPause").click(); document.getElementById("btnLeaveSave").click(); });
    await host.close(); await guest.close();

    // ONE relaunches: a fresh page in the SAME browser context (localStorage/IndexedDB survive
    // an app relaunch; the JS runtime does not) - no ?join= param, exactly a cold app launch.
    host = await ctxH.newPage();
    host.__errors = []; host.on("pageerror", (e) => host.__errors.push(String(e)));
    await host.goto(`file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent(`ws://127.0.0.1:${PORT}`)}`);
    await host.waitForFunction(() => typeof window.NET === "object");

    const landedOnMenu = await host.evaluate(() => ({
      menuHidden: document.getElementById("menu").classList.contains("hidden"),
      gameHidden: document.getElementById("game").classList.contains("hidden"),
      online: window.NET.online,
    }));
    check(landedOnMenu.menuHidden === false && landedOnMenu.gameHidden === true && landedOnMenu.online !== true,
      "C: relaunching lands on the MENU, not auto-rejoined into the game (v0.25 items 6+7)");

    const tileVisible = await host.evaluate(() => !document.getElementById("btnSavedGame").classList.contains("hidden"));
    check(tileVisible, "C: the saved-game tile is showing for the online room");
    const tileText = await host.evaluate(() => document.getElementById("savedGameDetail").textContent);
    check(new RegExp(code).test(tileText), `C: the tile identifies the right room (got "${tileText}")`);

    // Tap the tile - a real click, exactly what Blake did.
    await host.evaluate(() => document.getElementById("savedGameMain").click());
    await host.waitForFunction(() => window.NET && window.NET.online === true, { timeout: 8000 });
    await host.waitForFunction(() => window.NET.reunionOpen === true, { timeout: 10000 });
    check(true, "C: since Guest1 never came back, tapping the tile opened the REJOIN LOBBY (not the live board)");
    const reunionRowText = await host.evaluate(() => document.getElementById("reunionSeats").textContent);
    check(/Guest1/.test(reunionRowText) && /Not back yet/.test(reunionRowText), "C: the rejoin lobby lists Guest1 as not back yet");

    // Convert Guest1's seat to a CPU via the real Easy/Tricky/Nasty picker.
    const openedPicker = await host.evaluate(() => {
      const btns = [...document.querySelectorAll("#reunionSeats button")];
      const cpuBtn = btns.find((b) => b.textContent === "Have a computer take over");
      if (!cpuBtn) return false;
      cpuBtn.click();
      return true;
    });
    check(openedPicker, "C: opened the difficulty picker via the real 'Have a computer take over' button");
    const pickedTricky = await host.evaluate(() => {
      const btns = [...document.querySelectorAll("#reunionSeats button")];
      const trickyBtn = btns.find((b) => b.textContent === "Tricky");
      if (!trickyBtn) return false;
      trickyBtn.click();
      return true;
    });
    check(pickedTricky, "C: picked Tricky via a real button click (takeOverSeat sent)");
    // 2026-07-23 (item 2): converting Guest1's seat removes them from humanSeatList() entirely -
    // the host is now the ONLY human seat, and still has to tap "I'm ready" themselves (readying
    // up IS the resume trigger now, not a separate "every seat covered, tap Resume" step).
    await host.waitForFunction(() => {
      const btn = document.getElementById("btnReunionResume");
      return btn && !btn.classList.contains("hidden");
    }, { timeout: 5000 });
    const readyBtnText = await host.evaluate(() => document.getElementById("btnReunionResume").textContent);
    check(/ready/i.test(readyBtnText), `C: the ready-up button reads "I'm ready" now that Guest1 is converted (got "${readyBtnText}")`);

    // Tap "I'm ready" - a real click. The server auto-resumes the instant the (now sole) human
    // seat has readied up.
    await host.evaluate(() => document.getElementById("btnReunionResume").click());
    await host.waitForFunction(() => window.NET.reunionOpen !== true, { timeout: 5000 });
    const seatConverted = await host.evaluate(() => window.G.seats[1].type);
    check(seatConverted === "cpu", "C: Guest1's seat plays as a real CPU now (server-side seat conversion took effect)");

    // Play on solo - only the host (seat 0) is human; the rest of the table (seats 1-3) should
    // keep advancing on its own with no human input required.
    const seqBefore = await host.evaluate(() => window.G.actionSeq);
    const moved = await driveSeveralTurns(host, 0, 4000);
    await sleep(1500);
    const seqAfter = await host.evaluate(() => window.G ? window.G.actionSeq : -1);
    check(seqAfter > seqBefore || moved > 0, `C: the game genuinely plays on solo after the CPU takeover (actionSeq ${seqBefore} -> ${seqAfter}, moved=${moved})`);
    check(!(host.__errors || []).length, "C: zero page errors through the whole regression scenario");

    await ctxH.close(); await ctxG.close();
  }

  /* ===================================================================================
   * Scenario D (rewritten 2026-07-23 for item 2): counterpart to C - even when the other human
   * never actually left, tapping the tile now ALWAYS opens the ready-up lobby (the old "everyone
   * already looks connected -> skip straight to the board" shortcut is exactly what Blake
   * reported and is gone). BOTH the returning player and the player who never left must tap
   * "I'm ready" - the still-connected Guest1 gets the SAME lobby live via 'reunionStatus'. Once
   * both have readied, play resumes automatically with no separate "Resume" tap.
   * =================================================================================== */
  log("--- Scenario D: even when the other human never left, the tile tap opens the ready-up lobby for both ---");
  {
    const ctxH = await browser.newContext({ reducedMotion: "reduce" });
    const ctxG = await browser.newContext({ reducedMotion: "reduce" });
    let host = await newPage(ctxH, PORT2);
    const guest = await newPage(ctxG, PORT2);
    const seatMeta = [
      { name: "Host", type: "human", diff: "medium" }, { name: "Guest1", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
    ];
    const code = await hostRoom(host, seatMeta, 4);
    await host.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
    await guest.evaluate((code) => new Promise((resolve) => {
      window.connectWs().then(() => {
        const orig = window.handleNetMessage;
        window.handleNetMessage = function (m) { orig(m); if (m.type === "joined") { window.handleNetMessage = orig; resolve(); } };
        window.netSend({ type: "join", protocolVersion: PROTOCOL_VERSION, code, name: "Guest1" });
      });
    }), code);
    await guest.evaluate(() => window.netSend({ type: "claimSeat", seatIndex: 1, name: "Guest1" }));
    await guest.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
    await guest.evaluate(() => window.netSend({ type: "readyUp", willSeat: true }));
    await sleep(400);
    await host.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION, willSeat: true }));
    await Promise.all([host, guest].map((p) => p.waitForFunction(() => window.G != null, { timeout: 10000 })));

    // Only the HOST quits - via Pause/Save -> "Save & leave" (see Scenario C's comment above for
    // why this suite no longer uses the now-surrendering topbar button). Guest1's page stays
    // open and connected the entire time - the "everyone else is already back" shape (they never
    // left in the first place).
    await host.evaluate(() => { document.getElementById("btnPause").click(); document.getElementById("btnLeaveSave").click(); });
    await host.close();
    await sleep(500); // let the server's presence broadcast for the host's disconnect land

    host = await ctxH.newPage();
    host.__errors = []; host.on("pageerror", (e) => host.__errors.push(String(e)));
    await host.goto(`file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent(`ws://127.0.0.1:${PORT2}`)}`);
    await host.waitForFunction(() => typeof window.NET === "object");
    await host.waitForFunction(() => document.getElementById("btnSavedGame") && !document.getElementById("btnSavedGame").classList.contains("hidden"), { timeout: 5000 });

    await host.evaluate(() => document.getElementById("savedGameMain").click());
    await host.waitForFunction(() => window.G != null, { timeout: 8000 });
    await host.waitForFunction(() => window.NET.reunionOpen === true, { timeout: 8000 });
    check(true, "D: even with Guest1 already back, tapping the tile opens the ready-up lobby (the old auto-skip is gone)");

    // Guest1 - who never left - gets the SAME lobby live, via the 'reunionStatus' broadcast.
    await guest.waitForFunction(() => window.NET.reunionOpen === true, { timeout: 5000 });
    check(true, "D: Guest1 (who never left) also sees the SAME ready-up lobby, not just the returning host");
    const guestRow = await guest.evaluate(() => document.getElementById("reunionSeats").textContent);
    check(/Host/.test(guestRow) && /Not.*ready|ready/i.test(guestRow), "D: Guest1's own lobby view lists the host, not yet ready");

    // Neither has readied yet - the table must stay paused, no auto-resume from presence alone.
    await sleep(500);
    const stillPaused = await host.evaluate(() => window.G && window.G.paused === true);
    check(stillPaused, "D: the table stays paused - presence alone is NOT enough to resume anymore");

    // Both tap "I'm ready" - real clicks.
    await host.evaluate(() => document.getElementById("btnReunionResume").click());
    await sleep(300);
    const stillPausedAfterOne = await guest.evaluate(() => window.G && window.G.paused === true);
    check(stillPausedAfterOne, "D: still paused after only ONE of the two humans has readied up");
    await guest.evaluate(() => document.getElementById("btnReunionResume").click());

    // Once BOTH have readied, the server resumes automatically - no manual "Resume" tap at all.
    await host.waitForFunction(() => window.NET.reunionOpen !== true, { timeout: 5000 });
    await guest.waitForFunction(() => window.NET.reunionOpen !== true, { timeout: 5000 });
    const bothUnpaused = await Promise.all([host, guest].map((p) => p.evaluate(() => window.G && window.G.paused === false)));
    check(bothUnpaused.every(Boolean), "D: once both readied up, play resumed automatically for both - no manual Resume tap");

    const onBoard = await host.evaluate(() => !document.getElementById("game").classList.contains("hidden"));
    check(onBoard, "D: the host is on the live board after readying up");
    check(!(host.__errors || []).length && !(guest.__errors || []).length, "D: zero page errors on either side");

    await ctxH.close(); await ctxG.close();
  }

  /* ===================================================================================
   * Scenario E: Pause/Save opens the single-screen options sheet directly, with the exact
   * "Have a computer take over my seat" wording (items 4+9).
   * =================================================================================== */
  log("--- Scenario E: single-screen pause sheet wording ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await newPage(ctx, PORT2);
    const seatMeta = [
      { name: "Host", type: "human", diff: "medium" }, { name: "C1", type: "cpu", diff: "easy" },
      { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    await hostRoom(page, seatMeta, 4);
    await page.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
    await page.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION, willSeat: true }));
    await page.waitForFunction(() => window.G != null, { timeout: 10000 });

    await page.evaluate(() => document.getElementById("btnPause").click());
    // requestPause() for an ONLINE game sends 'pauseToggle' and waits for the server's own
    // 'paused' broadcast to actually flip G.paused (not a local synchronous write) - give that
    // real round trip a moment before reading state, even on localhost.
    await page.waitForFunction(() => window.G && window.G.paused === true, { timeout: 3000 });
    const sheetState = await page.evaluate(() => ({
      leaveConfirmHidden: document.getElementById("leaveConfirmOverlay").classList.contains("hidden"),
      leaveForGoodText: document.getElementById("btnLeaveForGood").textContent,
      paused: window.G.paused,
    }));
    check(sheetState.leaveConfirmHidden === false, "E: Pause/Save opens the options sheet directly (single screen)");
    check(sheetState.leaveForGoodText === "Have a computer take over my seat", `E: exact wording preserved (got "${sheetState.leaveForGoodText}")`);
    check(sheetState.paused === true, "E: the table is genuinely paused while the sheet is up");

    await page.evaluate(() => document.getElementById("btnLeaveCancel").click());
    await page.waitForFunction(() => window.G && window.G.paused === false, { timeout: 3000 });
    const afterCancel = await page.evaluate(() => ({
      hidden: document.getElementById("leaveConfirmOverlay").classList.contains("hidden"),
      paused: window.G.paused,
    }));
    check(afterCancel.hidden, "E: Cancel closes the sheet");
    check(afterCancel.paused === false, "E: cancelling a sheet-initiated pause resumes the table (never left stuck paused)");

    await ctx.close();
  }

  /* ===================================================================================
   * Scenario F: a disconnected player's name renders red, and the rules text explains it.
   * =================================================================================== */
  log("--- Scenario F: red offline names + the rules text that explains them ---");
  {
    const ctxH = await browser.newContext({ reducedMotion: "reduce" });
    const ctxG = await browser.newContext({ reducedMotion: "reduce" });
    const host = await newPage(ctxH, PORT2);
    let guest = await newPage(ctxG, PORT2);
    const seatMeta = [
      { name: "Host", type: "human", diff: "medium" }, { name: "Guest1", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
    ];
    const code = await hostRoom(host, seatMeta, 4);
    const rulesText = await host.evaluate(() => document.getElementById("onlineRulesOverlay").textContent);
    check(/When a player's name turns red, they are offline/.test(rulesText), "F: the online rules explain the red-name convention in plain language");
    check(!/[—–]/.test(rulesText), "F: the rules text has no em/en dashes");
    await host.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });

    await guest.evaluate((code) => new Promise((resolve) => {
      window.connectWs().then(() => {
        const orig = window.handleNetMessage;
        window.handleNetMessage = function (m) { orig(m); if (m.type === "joined") { window.handleNetMessage = orig; resolve(); } };
        window.netSend({ type: "join", protocolVersion: PROTOCOL_VERSION, code, name: "Guest1" });
      });
    }), code);
    await guest.evaluate(() => window.netSend({ type: "claimSeat", seatIndex: 1, name: "Guest1" }));
    await guest.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
    await guest.evaluate(() => window.netSend({ type: "readyUp", willSeat: true }));
    await sleep(400);
    await host.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION, willSeat: true }));
    await Promise.all([host, guest].map((p) => p.waitForFunction(() => window.G != null, { timeout: 10000 })));

    // Guest1 goes offline (socket dies without a deliberate leave - a dropped connection).
    await guest.close();
    await host.waitForFunction(() => {
      const el = document.getElementById("plaque-1");
      return el && el.classList.contains("away");
    }, { timeout: 8000 });
    const plaqueColor = await host.evaluate(() => getComputedStyle(document.querySelector("#plaque-1 .nm")).color);
    check(/255, 84, 73|ff5449/i.test(plaqueColor.replace(/\s/g, "")) || plaqueColor === "rgb(255, 84, 73)",
      `F: the disconnected player's name plate renders in the red (#ff5449) color (got "${plaqueColor}")`);

    check(!(host.__errors || []).length, "F: zero page errors while a seatmate goes offline");
    await ctxH.close(); await ctxG.close();
  }

  /* ===================================================================================
   * Scenario G (v0.27): the topbar button (Quit, was "Menu" through v0.26) asks for
   * confirmation before surrendering - Cancel resumes with zero changes, confirming lands on
   * the menu. Deeper loss-recording/offline/pass-and-play/trash-delete/slot-replace coverage
   * lives in test_surrender.js; this scenario only proves the topbar button's own dialog shape,
   * replacing this file's old v0.25 "instant, no dialog" assertion for item 9.
   * =================================================================================== */
  log("--- Scenario G: topbar Quit button shows a surrender confirm, Cancel is a no-op ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await newPage(ctx, PORT);
    const seatMeta = [
      { name: "Host", type: "human", diff: "medium" }, { name: "C1", type: "cpu", diff: "easy" },
      { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    await hostRoom(page, seatMeta, 4);
    await page.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
    await page.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION, willSeat: true }));
    await page.waitForFunction(() => window.G != null, { timeout: 10000 });

    await page.evaluate(() => document.getElementById("btnMenu").click());
    const afterTap = await page.evaluate(() => ({
      surrenderHidden: document.getElementById("surrenderConfirmOverlay").classList.contains("hidden"),
      leaveConfirmHidden: document.getElementById("leaveConfirmOverlay").classList.contains("hidden"),
      pauseHidden: document.getElementById("pauseOverlay").classList.contains("hidden"),
      menuHidden: document.getElementById("menu").classList.contains("hidden"),
      gameHidden: document.getElementById("game").classList.contains("hidden"),
    }));
    check(!afterTap.surrenderHidden, "G: tapping Quit shows the surrender confirm overlay");
    check(afterTap.leaveConfirmHidden && afterTap.pauseHidden, "G: the OTHER sheet/pause overlays stay hidden - this is a separate dialog");
    check(afterTap.menuHidden && !afterTap.gameHidden, "G: the game is still showing - Quit alone does NOT leave until confirmed");

    // Cancel: everything stays exactly as it was.
    await page.evaluate(() => document.getElementById("btnSurrenderCancel").click());
    const afterCancel = await page.evaluate(() => ({
      surrenderHidden: document.getElementById("surrenderConfirmOverlay").classList.contains("hidden"),
      gameHidden: document.getElementById("game").classList.contains("hidden"),
      gOver: window.G ? window.G.over : "no-G",
    }));
    check(afterCancel.surrenderHidden, "G: Cancel closes the surrender confirm");
    check(!afterCancel.gameHidden && afterCancel.gOver === false, "G: Cancel leaves the game running, untouched");

    // Confirm: lands on the menu (the full loss-recording assertions live in test_surrender.js).
    await page.evaluate(() => { document.getElementById("btnMenu").click(); document.getElementById("btnSurrenderConfirm").click(); });
    await page.waitForFunction(() => !document.getElementById("menu").classList.contains("hidden"), { timeout: 5000 });
    const afterConfirm = await page.evaluate(() => ({
      menuHidden: document.getElementById("menu").classList.contains("hidden"),
      gameHidden: document.getElementById("game").classList.contains("hidden"),
    }));
    check(!afterConfirm.menuHidden && afterConfirm.gameHidden, "G: confirming the surrender lands on the menu");
    check(!(page.__errors || []).length, "G: zero page errors on the Quit/surrender path");

    await ctx.close();
  }

  await browser.close();
  child.kill("SIGKILL");
  child2.kill("SIGKILL");
  console.log(`\n[${KIND}] ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}
// Belt-and-suspenders: this suite drives real UI flows across 6 scenarios and multiple rooms -
// if any single step ever hangs (a bug in this file, a stuck browser, or a server-side surprise
// like the 5/min/IP host-create rate limit this session's Scenario B/F bug actually tripped),
// the whole verification bar should fail LOUDLY within a couple of minutes, never hang forever.
const WATCHDOG_MS = 150000;
const watchdog = setTimeout(() => {
  console.error(`[v025ui] WATCHDOG: suite did not finish within ${WATCHDOG_MS}ms - forcing exit`);
  process.exit(1);
}, WATCHDOG_MS);
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => clearTimeout(watchdog));
