"use strict";
/*
 * v0.26 permanent regression suite for the "frozen update bubble follows you to the menu" bug
 * (recurring issue, Blake's report). Root cause (see HANDOFF.md v0.26 + the comments on
 * turnPrompt()/leaveOnlineToMenu()/performMoveInner() in index.html): leaving to the menu
 * (leaveOnlineToMenu()/doLeaveGame()) never bumped NETGEN, the generation counter every other
 * reconnect/replay transition in this file already uses to invalidate a stale async chain - so
 * an in-flight runOnlineTurnLoop iteration or a performMoveInner animation continuation (a CPU
 * kick/swap resolving) could resume AFTER the menu screen was already showing and clearToasts()
 * had already run, write a fresh turnPrompt()/toast() into #toasts, and then sit there FOREVER
 * because NET was already torn down - nothing was ever going to clear it again.
 *
 * The fix has two layers (both exercised here, deliberately, not just the DOM symptom):
 *   1. NETGEN++ now happens on every leave-to-menu path (leaveOnlineToMenu, doLeaveGame's
 *      offline branch, btnWinMenu) - the root architectural fix, closes the loophole at its
 *      source for every myGen-gated chain in the file, not just #toasts writers.
 *   2. turnPrompt() (and handleAwayStatus()) additionally hard-refuse to touch #toasts unless
 *      the game screen is genuinely showing - a backstop for the one specific gap (a kick/swap
 *      toast() call inside performMoveInner with no myGen re-check immediately before it) where
 *      bumping NETGEN alone wasn't sufficient, PLUS insurance against any future regression.
 *
 * Usage:
 *   node test_menu_bubble_race.js node     (server/server.js)
 *   node test_menu_bubble_race.js deno     (server/cloud/server.ts)
 *
 * Three soak scenarios, all against ONE real online room kept alive across many leave/rejoin
 * cycles (never re-hosting - avoids the 5/min/IP host-create rate limiter entirely):
 *  A. General race (60 reps): real 1-human + 3-CPU (diff 'hard', kick-hungry) FFA table at Turbo
 *     table speed, continuously driven. At a randomized point (0-600ms) mid-play, tap the real
 *     Menu button, settle, assert #toasts is completely empty and the menu/game screens are in
 *     the right state, then rejoin via the real saved-game tile and keep playing.
 *  B. Kick-specific race (30 reps): a real hook on window.applyServerAction detects the exact
 *     window a KICK's animation chain is in flight (server-decided, not fabricated), then races
 *     a randomized-delay Menu tap against it - directly targeting the performMoveInner gap.
 *  C. Away-ladder message race (40 reps): a synthetic 'awayStatus' message dispatched through the
 *     real window.handleNetMessage entry point in the exact same synchronous tick immediately
 *     after a real Menu tap completes - faithfully reproducing "a message already in flight when
 *     Menu was pressed, delivered a beat later" per actual browser task-queue ordering.
 */
const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const KIND = process.argv[2] || "node";
const USE_DENO = KIND === "deno";
const PORT = 24100 + Math.floor(Math.random() * 500);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-menububble-${KIND}-`));

function log(...a) { console.log("[menububble]", new Date().toISOString(), ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; } else { FAIL++; log("FAIL", label); } if (cond && process.env.NASTY_TEST_VERBOSE) log("OK  ", label); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (lo, hi) => lo + Math.random() * (hi - lo);

function startServer(port) {
  let child;
  if (USE_DENO) {
    child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
      cwd: "/Users/jarvis/nasty-game/server/cloud",
      env: Object.assign({}, process.env, { NASTY_PORT: String(port), NASTY_KV_PATH: path.join(SCRATCH, "menububble.kv"), NASTY_ADMIN_TOKEN: "menububble-admin-token" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    child = spawn(process.execPath, ["server.js"], {
      cwd: "/Users/jarvis/nasty-game/server",
      env: Object.assign({}, process.env, {
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
    try { const r = await fetch(`http://localhost:${port}/health`); if (r.ok) return; } catch (e) {}
    await sleep(400);
  }
  throw new Error("server never became healthy");
}

async function newPage(browser, wsPort) {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push(String(e)));
  await page.goto(`file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent(`ws://127.0.0.1:${wsPort}`)}`);
  await page.waitForFunction(() => typeof window.NET === "object");
  await page.evaluate(() => { try { localStorage.setItem("nasty-speed-chosen", "1"); } catch (e) {} });
  return page;
}
async function hostRoom(page, seatMeta, n, tableSpeed) {
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
async function claimSeat(page, seatIndex, name) { await page.evaluate(({ seatIndex, name }) => window.netSend({ type: "claimSeat", seatIndex, name }), { seatIndex, name }); }
async function startGameOnline(hostPage) {
  await hostPage.evaluate(() => {
    const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click();
    const o = document.getElementById("onlineRulesOverlay"); if (o) o.classList.add("hidden");
  }).catch(() => {});
  await hostPage.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION, willSeat: true }));
  await hostPage.waitForFunction(() => window.G != null, { timeout: 15000 });
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
// The exact assertion the whole suite hangs on: after landing on the menu, #toasts must be
// completely empty - no turnPrompt bubble, no stray toast, nothing - and the screens must be in
// the right state (menu showing, game hidden). This is the literal DOM shape of Blake's report.
async function assertCleanMenu(page, label) {
  const state = await page.evaluate(() => ({
    menuHidden: document.getElementById("menu").classList.contains("hidden"),
    gameHidden: document.getElementById("game").classList.contains("hidden"),
    toastsChildCount: document.getElementById("toasts").children.length,
    toastsText: document.getElementById("toasts").textContent,
  }));
  check(!state.menuHidden, `${label}: menu screen is showing`);
  check(state.gameHidden, `${label}: game screen is hidden`);
  check(state.toastsChildCount === 0, `${label}: #toasts is completely empty (found ${state.toastsChildCount}: "${state.toastsText}")`);
  return state.toastsChildCount === 0 && !state.menuHidden && state.gameHidden;
}
// v0.27: the topbar button (was "Menu" through v0.26) now SURRENDERS the game once confirmed -
// a one-time, room-PERMANENT action (the seat converts to a CPU and its playerId is locked out
// of that room for good), which would break this suite's whole premise of looping leave/rejoin
// against the SAME persistent room 130 times (the second rep's rejoin would fail forever).
// This soak's actual subject is the NETGEN-bump-on-leave fix inside leaveOnlineToMenu()/
// doLeaveGame() (see HANDOFF.md v0.26) - reachable via ANY deliberate-leave path, not
// specifically the topbar button - so it now drives the still-consequence-free "Pause/Save ->
// Save & leave" path instead (doLeaveGame(true) -> leaveOnlineToMenu(null,true), the exact same
// NETGEN bump and #toasts-clearing transition under test), which keeps the room resumable
// indefinitely. The dedicated surrender confirm/cancel/record behavior itself is covered by
// server/tests/test_surrender.js, not this file.
async function tapMenu(page) {
  await page.evaluate(() => {
    const p = document.getElementById("btnPause"); if (p) p.click();
    const s = document.getElementById("btnLeaveSave"); if (s) s.click();
  });
}
async function rejoinSavedGame(page) {
  await page.evaluate(() => { const b = document.getElementById("savedGameMain"); if (b) b.click(); });
  await page.waitForFunction(() => window.G != null && !document.getElementById("game").classList.contains("hidden"), { timeout: 15000 });
}

async function main() {
  const server = startServer(PORT);
  await waitHealthy(PORT);
  const browser = await chromium.launch();

  // One real 4-seat FFA room, kept alive (never re-hosted) across all three scenarios below.
  // Seat 0 is "human" but driven entirely by script (tryDriveMove) so the whole table plays
  // continuously and unattended; seats 1-3 are CPU at diff 'hard' ("Nasty" in the UI - scored,
  // kick-hungry, per § AI) specifically to keep kicks frequent for scenario B. Turbo table
  // speed keeps each iteration's settle/animation windows short so ~130 total reps finish fast.
  const seatMeta = [
    { name: "Tester", type: "human", diff: "medium" },
    { name: "CPU1", type: "cpu", diff: "hard" },
    { name: "CPU2", type: "cpu", diff: "hard" },
    { name: "CPU3", type: "cpu", diff: "hard" },
  ];
  const page = await newPage(browser, PORT);
  const code = await hostRoom(page, seatMeta, 4, 2.6);   // 2.6 = the real Turbo entry in SPEED_OPTS
  await claimSeat(page, 0, "Tester");
  await sleep(300);
  await startGameOnline(page);
  log("game started, room", code);

  // Background driver: keeps seat 0 (our scripted "human") moving whenever it's genuinely our
  // turn. Runs for the ENTIRE test, including while sitting on the menu between reps - it's a
  // harmless no-op there (NET.mySeat resets to -1 on leave), exactly as leaveOnlineToMenu()
  // intends, and this is itself part of what's under test.
  let driving = true;
  const driver = (async () => { while (driving) { await tryDriveMove(page, 0); await sleep(120); } })();

  // ===========================================================================================
  // Scenario A: general race - randomized-timing Menu taps against ordinary continuous play.
  // ===========================================================================================
  const N_A = 60;
  log(`--- Scenario A: ${N_A} randomized-timing Menu taps during ordinary CPU/human play ---`);
  for (let i = 0; i < N_A; i++) {
    await sleep(rnd(50, 600));
    await tapMenu(page);
    await sleep(rnd(250, 450));   // settle window for any resumed animation chain to (mis)fire
    await assertCleanMenu(page, `A[${i}]`);
    await rejoinSavedGame(page);
    await sleep(80);
  }
  log(`Scenario A done: ${PASS} pass / ${FAIL} fail so far`);

  // Scenario B needs the table to itself - stop the background driver so a genuinely-live
  // server action can never interleave with the engineered move below.
  driving = false; await driver;

  // ===========================================================================================
  // Scenario B: kick-specific race. A real, natural kick is too rare to reliably hit within a
  // short soak window (measured directly: a live 'hard'-diff 4P table produced ZERO kicks in
  // 45s of continuous real play - kicks need pieces already out of base, which early hands
  // mostly aren't) - so this engineers the exact scenario instead of gambling on luck, exactly
  // as the task brief invites ("engineer messages in flight"). It calls the REAL
  // performMoveInner() (via window.performMove(), the same function every genuine online/
  // offline move goes through) with a hand-built move object whose `kick` field points at a
  // piece placed directly on the track - not a fake code path, the authentic animation/toast
  // pipeline, just with luck removed from whether a kick happens. Since this briefly diverges
  // the client's local G from the server's copy, every rep immediately rejoins afterward
  // (bootGameFromSnapshot pulls a fresh authoritative snapshot), so nothing here can leave the
  // shared soak game corrupted for longer than one rep.
  const N_B = 30;
  log(`--- Scenario B: ${N_B} reps racing a Menu tap against an engineered in-flight kick animation ---`);
  for (let i = 0; i < N_B; i++) {
    await page.evaluate(() => {
      const owner = 0, victim = 1;
      if (!window.G.hands[owner].length) window.G.hands[owner] = [{ r: "5", s: "♠", id: 900000 }];
      window.G.pieces[victim][0] = { state: "track", steps: 10 };
      window.G.pieces[owner][0] = { state: "track", steps: 5 };
      const m = { ci: 0, type: "move", owner, pi: 0, to: 10, kick: { seat: victim, pi: 0 } };
      window.__testMovePromise = window.performMove(owner, m, null);   // NOT awaited - left in flight on purpose
    });
    await sleep(rnd(0, 180));   // land somewhere inside the kick's real (turbo-shortened) animation/toast window
    await tapMenu(page);
    await sleep(rnd(250, 450));
    await assertCleanMenu(page, `B[${i}]`);
    await page.evaluate(() => window.__testMovePromise).catch(() => {});   // let it fully settle before rejoining
    await rejoinSavedGame(page);
    await sleep(80);
  }
  log(`Scenario B done: ${PASS} pass / ${FAIL} fail so far`);

  // ===========================================================================================
  // Scenario C: away-ladder message race - a synthetic 'awayStatus' dispatched through the REAL
  // window.handleNetMessage entry point in the same synchronous tick right after a real leave
  // tap completes, reproducing "a message already in flight, delivered a beat after the leave"
  // per actual browser task-queue ordering (the click handler always runs to completion first).
  // ===========================================================================================
  const N_C = 40;
  log(`--- Scenario C: ${N_C} reps racing a synthetic awayStatus message against the leave tap ---`);
  for (let i = 0; i < N_C; i++) {
    await sleep(rnd(30, 300));
    await page.evaluate(() => {
      // v0.27: Pause/Save -> Save & leave (see tapMenu()'s own comment above for why this suite
      // no longer uses the now-surrendering topbar button) - still runs
      // doLeaveGame()->leaveOnlineToMenu() to completion, synchronously, same as before.
      const p = document.getElementById("btnPause"); if (p) p.click();
      document.getElementById("btnLeaveSave").click();
      window.handleNetMessage({ type: "awayStatus", stage: Math.random() < 0.5 ? "nudged" : "cpuOffer", seat: 1, name: "CPU1" });
    });
    await sleep(rnd(150, 300));
    await assertCleanMenu(page, `C[${i}]`);
    await rejoinSavedGame(page);
    await sleep(80);
  }
  log(`Scenario C done: ${PASS} pass / ${FAIL} fail so far`);

  driving = false; await driver;
  check((page.__errors || []).length === 0, `zero page errors across all ${N_A + N_B + N_C} reps (errors: ${JSON.stringify(page.__errors)})`);

  await browser.close();
  server.kill();
  fs.rmSync(SCRATCH, { recursive: true, force: true });

  log(`RESULT: ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL > 0 ? 1 : 0);
}

// Hard ceiling so a future timing regression (or a bad edit to this file) fails loudly within a
// couple of minutes instead of hanging a CI run forever - same pattern as test_v025_ui_flows.js's
// own WATCHDOG_MS, after this suite's own draft got stuck in an earlier iteration (an unbounded
// "keep waiting for a real kick to happen" loop, before Scenario B was rewritten to engineer the
// kick deterministically instead of waiting on luck).
const WATCHDOG_MS = 180000;
const watchdog = setTimeout(() => {
  console.error(`[menububble] WATCHDOG: suite did not finish within ${WATCHDOG_MS}ms - forcing exit`);
  process.exit(1);
}, WATCHDOG_MS);
main().catch((e) => { console.error("[menububble] FATAL:", e); process.exit(1); }).finally(() => clearTimeout(watchdog));
