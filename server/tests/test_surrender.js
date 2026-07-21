"use strict";
/*
 * v0.27 permanent regression suite for SURRENDER - Blake's ask ("replace the Menu button with a
 * Quit button that warns it counts as a loss on the leaderboard"), extended by a same-session
 * scope correction to cover every action that PERMANENTLY ends an unfinished game:
 *   - the topbar Quit button (was "Menu" through v0.26)
 *   - "Leave without saving" (Pause/Save sheet)
 *   - "Have a computer take over my seat" (Pause/Save sheet, online only)
 *   - the saved-tile trash delete (offline slot or a remembered online room)
 *   - the slotReplaceOverlay chooser discarding a slot when starting a new offline game with
 *     both save spots full
 * ONLY "Save & leave"/"Return to Game" and Cancel stay completely consequence-free.
 *
 * v0.27.1 adds two things, covered by the NOFAULT-* scenarios below:
 *   - display text renamed "surrender"->"concede" throughout (internal identifiers, function
 *     names, and the {type:'surrender'} wire message are UNCHANGED - see the wording checks
 *     updated from /surrender/i to /concede/i in the OFFLINE-5/6 and ONLINE-6 scenarios above).
 *   - § NO-FAULT EXIT: once ANY human has surrendered in a still-unfinished ONLINE game, every
 *     OTHER human's own subsequent departure from that SAME game (via any of the four
 *     surrender-flagged paths) is free - no loss recorded, because the competitive game they
 *     agreed to play was already altered by someone else's concession first.
 *
 * See index.html's recordOfflineSurrenderLoss()/doSurrenderCurrentGame()/surrenderOnlineTile()/
 * openSurrenderConfirm()/refreshTileConfirmWording() and server.js/server.ts's "surrender" case
 * (HANDOFF.md v0.27 and v0.27.1 have the full design writeups).
 *
 * Usage:
 *   node test_surrender.js node     (server/server.js)
 *   node test_surrender.js deno     (server/cloud/server.ts)
 */
const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const KIND = process.argv[2] || "node";
const USE_DENO = KIND === "deno";
// Four private servers (same reasoning as test_v025_ui_flows.js): server.js/server.ts cap
// host-room-creates at 5/min/IP - this suite creates several online rooms across its scenarios,
// split across server instances to stay safely under that cap on any one of them. PORT3/PORT4
// (v0.27.1) are dedicated to the new NOFAULT-* scenarios below, kept separate from PORT/PORT2's
// existing ONLINE-* budget rather than risking a shared rolling 60s window.
const PORT = 23700 + Math.floor(Math.random() * 500);
const PORT2 = PORT + 1;
const PORT3 = PORT + 2;
const PORT4 = PORT + 3;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-surrender-${KIND}-`));

function log(...a) { console.log("[surrender]", new Date().toISOString(), ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port) {
  const portScratch = path.join(SCRATCH, String(port));
  fs.mkdirSync(portScratch, { recursive: true });
  let child;
  if (USE_DENO) {
    child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
      cwd: "/Users/jarvis/nasty-game/server/cloud",
      env: Object.assign({}, process.env, { NASTY_PORT: String(port), NASTY_KV_PATH: path.join(portScratch, "surrender.kv"), NASTY_ADMIN_TOKEN: "surrender-admin-token" }),
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
  // Skip the one-time offline speed picker - not what any of these scenarios are testing.
  await page.evaluate(() => { try { localStorage.setItem("nasty-speed-chosen", "1"); } catch (e) {} });
  return page;
}

/* ---- offline helpers ---- */
async function startOffline(page, { n, teams, seatMeta }) {
  await page.evaluate(({ n, teams, seatMeta }) => {
    CFG.n = n; CFG.teams = teams; CFG.seatMeta[n] = seatMeta;
    window.startGame();
  }, { n, teams, seatMeta });
  await page.waitForFunction(() => window.G != null && !document.getElementById("game").classList.contains("hidden"), { timeout: 8000 });
}
async function startOfflineViaGate(page, { n, teams, seatMeta }) {
  // Goes through startOfflineGameGate() (the real "both slots full?" gate), unlike
  // startOffline() above which calls startGame() directly - needed for the slot-replace scenario.
  await page.evaluate(({ n, teams, seatMeta }) => {
    CFG.n = n; CFG.teams = teams; CFG.seatMeta[n] = seatMeta;
    window.startOfflineGameGate(window.startGame);
  }, { n, teams, seatMeta });
}
async function readStats(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("nasty-stats") || "{}"));
}
async function saveAndReturnToMenu(page) {
  await page.evaluate(() => { document.getElementById("btnPause").click(); document.getElementById("btnLeaveSave").click(); });
  await page.waitForFunction(() => !document.getElementById("menu").classList.contains("hidden"), { timeout: 5000 });
}
async function quitConfirm(page) {
  await page.evaluate(() => { document.getElementById("btnMenu").click(); document.getElementById("btnSurrenderConfirm").click(); });
}
async function quitCancel(page) {
  await page.evaluate(() => { document.getElementById("btnMenu").click(); document.getElementById("btnSurrenderCancel").click(); });
}
async function sheetDiscardConfirm(page) {
  await page.evaluate(() => { document.getElementById("btnPause").click(); document.getElementById("btnLeaveDiscard").click(); document.getElementById("btnSurrenderConfirm").click(); });
}
/* ---- online helpers ---- */
async function hostRoomWith(page, seatMeta, n, teams, tableSpeed) {
  return page.evaluate(({ seatMeta, n, teams, tableSpeed }) => {
    CFG.n = n; CFG.teams = teams; CFG.seatMeta[n] = seatMeta;
    return new Promise((resolve, reject) => {
      const orig = window.handleNetMessage;
      window.handleNetMessage = function (m) {
        orig(m);
        if (m.type === "created") { window.handleNetMessage = orig; resolve(m.code); }
        else if (m.type === "error") { window.handleNetMessage = orig; reject(new Error("host create failed: " + m.message)); }
      };
      window.hostCreateRoom(tableSpeed);
    });
  }, { seatMeta, n, teams, tableSpeed });
}
async function joinGuest(guest, code, name, seatIndex) {
  await guest.evaluate(({ code, name }) => new Promise((resolve) => {
    window.connectWs().then(() => {
      const orig = window.handleNetMessage;
      window.handleNetMessage = function (m) { orig(m); if (m.type === "joined") { window.handleNetMessage = orig; resolve(); } };
      window.netSend({ type: "join", protocolVersion: PROTOCOL_VERSION, code, name });
    });
  }), { code, name });
  await guest.evaluate(({ seatIndex, name }) => window.netSend({ type: "claimSeat", seatIndex, name }), { seatIndex, name });
  await guest.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
  await guest.evaluate(() => window.netSend({ type: "readyUp", willSeat: true }));
  await sleep(400);
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
async function pollLeaderboard(port, predicate, timeoutMs) {
  const t0 = Date.now();
  let lb = {};
  while (Date.now() - t0 < timeoutMs) {
    lb = await (await fetch(`http://localhost:${port}/leaderboard`)).json();
    if (predicate(lb)) return lb;
    await sleep(300);
  }
  return lb;
}
/* v0.27.1 § NO-FAULT EXIT test helper - hosts a room with however many human seats seatMeta
   declares (seat 0 is always the host), joins every OTHER human seat as its own guest page, and
   starts the game. Returns {code, host, pages, ctxHost, guestCtxs} where pages[0] is the host
   and pages[1..] are the guests IN SEAT ORDER - so pages[1] is always the 2nd human seat, etc.
   Caller is responsible for closing ctxHost + every guestCtxs entry when done. */
async function setupOnlineHumans(browser, port, seatMeta, n, teams) {
  const humanSeats = seatMeta.map((s, i) => (s.type === "human" ? i : -1)).filter((i) => i >= 0);
  const ctxHost = await browser.newContext({ reducedMotion: "reduce" });
  const host = await newPage(ctxHost, port);
  const code = await hostRoomWith(host, seatMeta, n, teams);
  await host.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
  const pages = [host];
  const guestCtxs = [];
  for (let k = 1; k < humanSeats.length; k++) {
    const seatIndex = humanSeats[k];
    const gctx = await browser.newContext({ reducedMotion: "reduce" });
    const gpage = await newPage(gctx, port);
    await joinGuest(gpage, code, seatMeta[seatIndex].name, seatIndex);
    guestCtxs.push(gctx);
    pages.push(gpage);
  }
  await host.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION, willSeat: true }));
  await Promise.all(pages.map((p) => p.waitForFunction(() => window.G != null, { timeout: 10000 })));
  await driveSeveralTurns(host, 0, 600);
  return { code, host, pages, ctxHost, guestCtxs };
}
/* v0.27.1 § NO-FAULT EXIT: shared body for the four NOFAULT-quit/discard/takeover/trash
   scenarios below - two humans (A=host, B=guest, seat order [A,B,cpu,cpu]), A concedes first
   (the normal, first-surrenderer loss), then B departs via ONE of the four surrender-flagged
   paths and must (a) SEE the no-fault wording in their own confirm dialog BEFORE committing and
   (b) end up with ZERO leaderboard entry of any kind - a true stat-wise no-op, not a disguised
   win/draw. leaveKind is one of 'quit' | 'discard' | 'takeover' | 'trash'. */
async function nofaultTwoHumanScenario(browser, port, leaveKind, aName, bName) {
  const seatMeta = [
    { name: aName, type: "human", diff: "medium" }, { name: bName, type: "human", diff: "medium" },
    { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
  ];
  const { host, pages, ctxHost, guestCtxs } = await setupOnlineHumans(browser, port, seatMeta, 4, false);
  const guest = pages[1];

  await quitConfirm(host);
  await host.waitForFunction(() => !document.getElementById("menu").classList.contains("hidden"), { timeout: 8000 });
  const lbA = await pollLeaderboard(port, (b) => !!b[aName], 5000);
  check(lbA[aName] && lbA[aName].hg4s === 1 && !lbA[aName].hw4s,
    `NOFAULT-${leaveKind}: A's own concede still records the normal first-surrenderer loss (got ${JSON.stringify(lbA[aName])})`);

  // The live 'surrenderOccurred' broadcast should reach B (still at the table) before B decides
  // to leave - proves this isn't just a silent server-side skip discovered after the fact.
  await guest.waitForFunction(() => window.NET && window.NET.anySurrenderOccurred === true, { timeout: 5000 });

  if (leaveKind === "trash") {
    // Save & leave first (safe, no stat) to create the remembered tile, then trash it from the
    // menu - refreshTileConfirmWording()/peekOnlineRoomNoFault() rewrite the panel's wording
    // live BEFORE the player can tap the delete/confirm button.
    await saveAndReturnToMenu(guest);
    await guest.evaluate(() => document.getElementById("savedGameTrash").click());
    await guest.waitForFunction(() => /already left/i.test(document.getElementById("savedGameConfirm").textContent), { timeout: 6000 });
    const wording = await guest.evaluate(() => ({ text: document.getElementById("savedGameConfirm").textContent, btn: document.getElementById("savedGameDelete").textContent }));
    check(/already left/i.test(wording.text) && /without it counting as a loss/i.test(wording.text) && wording.btn === "Leave",
      `NOFAULT-trash: the trash-delete confirm panel shows the no-fault wording before committing (got ${JSON.stringify(wording)})`);
    await guest.evaluate(() => document.getElementById("savedGameDelete").click());
    await sleep(700);
  } else {
    const wording = await guest.evaluate((kind) => {
      if (kind === "quit") { document.getElementById("btnMenu").click(); }
      else if (kind === "discard") { document.getElementById("btnPause").click(); document.getElementById("btnLeaveDiscard").click(); }
      else if (kind === "takeover") { document.getElementById("btnPause").click(); document.getElementById("btnLeaveForGood").click(); }
      return {
        heading: document.getElementById("surrenderConfirmHeading").textContent,
        text: document.getElementById("surrenderConfirmText").textContent,
        btn: document.getElementById("btnSurrenderConfirm").textContent,
      };
    }, leaveKind);
    check(wording.heading === "LEAVE GAME?" && /already left/i.test(wording.text) && /without it counting as a loss/i.test(wording.text) && wording.btn === "Leave",
      `NOFAULT-${leaveKind}: B's confirm shows the no-fault wording before committing (got ${JSON.stringify(wording)})`);
    await guest.evaluate(() => document.getElementById("btnSurrenderConfirm").click());
    await guest.waitForFunction(() => !document.getElementById("menu").classList.contains("hidden"), { timeout: 8000 });
  }
  await sleep(800);
  const lbAfterB = await (await fetch(`http://localhost:${port}/leaderboard`)).json();
  check(!lbAfterB[bName], `NOFAULT-${leaveKind}: B's own departure recorded NO leaderboard entry at all - true no-op (got ${JSON.stringify(lbAfterB[bName])})`);

  await ctxHost.close();
  for (const c of guestCtxs) await c.close();
}

async function main() {
  const child = startServer(PORT);
  const child2 = startServer(PORT2);
  const child3 = startServer(PORT3);
  const child4 = startServer(PORT4);
  await Promise.all([waitHealthy(PORT), waitHealthy(PORT2), waitHealthy(PORT3), waitHealthy(PORT4)]);
  const browser = await chromium.launch();

  /* =================================================================================
   * OFFLINE-1: topbar Quit, confirmed - solo game, exactly one hg4s, no hw/pts, no save left.
   * ================================================================================= */
  log("--- OFFLINE-1: solo Quit confirmed records exactly one loss ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await newPage(ctx, PORT);
    const seatMeta = [
      { name: "SoloSurrender", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    await startOffline(page, { n: 4, teams: false, seatMeta });
    await quitConfirm(page);
    await page.waitForFunction(() => !document.getElementById("menu").classList.contains("hidden"), { timeout: 5000 });
    const stats = await readStats(page);
    check(stats.SoloSurrender && stats.SoloSurrender.hg4s === 1, "OFFLINE-1: recorded exactly hg4s=1");
    check(!stats.SoloSurrender.hw4s, "OFFLINE-1: no win recorded");
    check(!stats.SoloSurrender.hptsS, "OFFLINE-1: no points recorded");
    const savesLeft = await page.evaluate(() => [1, 2].map((k) => localStorage.getItem("nasty-save-offline-" + k)));
    check(savesLeft.every((s) => !s), "OFFLINE-1: no offline save left behind after surrendering");
    check(!(page.__errors || []).length, "OFFLINE-1: zero page errors");
    await ctx.close();
  }

  /* =================================================================================
   * OFFLINE-2: topbar Quit, Cancel - zero changes of any kind.
   * ================================================================================= */
  log("--- OFFLINE-2: solo Quit, Cancel is a complete no-op ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await newPage(ctx, PORT);
    const seatMeta = [
      { name: "SoloCancel", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    await startOffline(page, { n: 4, teams: false, seatMeta });
    await quitCancel(page);
    const state = await page.evaluate(() => ({
      gameHidden: document.getElementById("game").classList.contains("hidden"),
      over: window.G.over,
      surrenderHidden: document.getElementById("surrenderConfirmOverlay").classList.contains("hidden"),
    }));
    check(!state.gameHidden && !state.over, "OFFLINE-2: Cancel leaves the game running");
    check(state.surrenderHidden, "OFFLINE-2: Cancel closes the confirm dialog");
    const stats = await readStats(page);
    check(!stats.SoloCancel, "OFFLINE-2: Cancel recorded no stats at all");
    await ctx.close();
  }

  /* =================================================================================
   * OFFLINE-3: pass-and-play (2 humans, one device) - EACH human seat gets its own loss.
   * ================================================================================= */
  log("--- OFFLINE-3: pass-and-play Quit charges every human seat ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await newPage(ctx, PORT);
    const seatMeta = [
      { name: "PnpA", type: "human", diff: "medium" }, { name: "PnpB", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
    ];
    await startOffline(page, { n: 4, teams: false, seatMeta });
    await quitConfirm(page);
    await page.waitForFunction(() => !document.getElementById("menu").classList.contains("hidden"), { timeout: 5000 });
    const stats = await readStats(page);
    check(stats.PnpA && stats.PnpA.hg4s === 1 && !stats.PnpA.hw4s, "OFFLINE-3: human seat A charged its own loss");
    check(stats.PnpB && stats.PnpB.hg4s === 1 && !stats.PnpB.hw4s, "OFFLINE-3: human seat B charged its own loss too");
    await ctx.close();
  }

  /* =================================================================================
   * OFFLINE-4: "Leave without saving" (Pause/Save sheet) now ALSO surrenders.
   * ================================================================================= */
  log("--- OFFLINE-4: sheet's 'Leave without saving' now surrenders too ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await newPage(ctx, PORT);
    const seatMeta = [
      { name: "DiscardSurrender", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    await startOffline(page, { n: 4, teams: false, seatMeta });
    await page.evaluate(() => { document.getElementById("btnPause").click(); document.getElementById("btnLeaveDiscard").click(); });
    const shown = await page.evaluate(() => !document.getElementById("surrenderConfirmOverlay").classList.contains("hidden"));
    check(shown, "OFFLINE-4: 'Leave without saving' opens the surrender confirm instead of acting instantly");
    await page.evaluate(() => document.getElementById("btnSurrenderConfirm").click());
    await page.waitForFunction(() => !document.getElementById("menu").classList.contains("hidden"), { timeout: 5000 });
    const stats = await readStats(page);
    check(stats.DiscardSurrender && stats.DiscardSurrender.hg4s === 1, "OFFLINE-4: confirming records the loss");

    // ... and Cancel on THIS path is still a true no-op, releasing the sheet-started pause.
    const ctx2 = await browser.newContext({ reducedMotion: "reduce" });
    const page2 = await newPage(ctx2, PORT);
    const seatMeta2 = [
      { name: "DiscardCancel", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    await startOffline(page2, { n: 4, teams: false, seatMeta: seatMeta2 });
    await page2.evaluate(() => { document.getElementById("btnPause").click(); document.getElementById("btnLeaveDiscard").click(); document.getElementById("btnSurrenderCancel").click(); });
    const state2 = await page2.evaluate(() => ({ gameHidden: document.getElementById("game").classList.contains("hidden"), paused: window.G.paused }));
    check(!state2.gameHidden && state2.paused === false, "OFFLINE-4: cancelling 'Leave without saving' resumes the table (never stuck paused)");
    const stats2 = await readStats(page2);
    check(!stats2.DiscardCancel, "OFFLINE-4: cancelling recorded nothing");
    await ctx.close(); await ctx2.close();
  }

  /* =================================================================================
   * OFFLINE-5: trash-delete on a saved offline tile - confirm records the loss, Cancel doesn't.
   * ================================================================================= */
  log("--- OFFLINE-5: trash-delete on an offline saved tile ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await newPage(ctx, PORT);
    const seatMeta = [
      { name: "TrashOffline", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    await startOffline(page, { n: 4, teams: false, seatMeta });
    await saveAndReturnToMenu(page);   // safe save - the tile now exists on the menu
    const tileVisible = await page.evaluate(() => !document.getElementById("btnSavedGame").classList.contains("hidden"));
    check(tileVisible, "OFFLINE-5: the saved tile is showing after Save & leave");

    // Cancel first - tile and stats both untouched.
    await page.evaluate(() => { document.getElementById("savedGameTrash").click(); document.getElementById("savedGameCancel").click(); });
    const afterCancel = await page.evaluate(() => !!localStorage.getItem("nasty-save-offline-1"));
    check(afterCancel, "OFFLINE-5: Cancel on the trash confirm leaves the save intact");
    check(!(await readStats(page)).TrashOffline, "OFFLINE-5: Cancel recorded no stats");

    // Now actually delete it.
    const confirmText = await page.evaluate(() => { document.getElementById("savedGameTrash").click(); return document.getElementById("savedGameConfirm").textContent; });
    check(/concede/i.test(confirmText) && /loss on the leaderboard/i.test(confirmText), `OFFLINE-5: trash confirm wording mentions concede/loss (got "${confirmText}")`);
    await page.evaluate(() => document.getElementById("savedGameDelete").click());
    const gone = await page.evaluate(() => !localStorage.getItem("nasty-save-offline-1") && !localStorage.getItem("nasty-save-offline-2"));
    check(gone, "OFFLINE-5: confirming the delete actually removes the save");
    const stats = await readStats(page);
    check(stats.TrashOffline && stats.TrashOffline.hg4s === 1 && !stats.TrashOffline.hw4s, "OFFLINE-5: deleting the tile recorded exactly one loss");
    await ctx.close();
  }

  /* =================================================================================
   * OFFLINE-6: slot-replace chooser - wording now warns, discarding a slot records its loss.
   * ================================================================================= */
  log("--- OFFLINE-6: slotReplaceOverlay warns + records a loss for the discarded slot ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await newPage(ctx, PORT);
    const mk = (name) => [{ name, type: "human", diff: "medium" }, { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" }];

    await startOffline(page, { n: 4, teams: false, seatMeta: mk("SlotOneHuman") });
    await saveAndReturnToMenu(page);   // fills slot 1
    await startOfflineViaGate(page, { n: 4, teams: false, seatMeta: mk("SlotTwoHuman") });
    await page.waitForFunction(() => window.G != null, { timeout: 5000 });
    await saveAndReturnToMenu(page);   // fills slot 2 (both slots now full)

    await startOfflineViaGate(page, { n: 4, teams: false, seatMeta: mk("SlotThreeHuman") });
    const overlayShown = await page.waitForFunction(() => !document.getElementById("slotReplaceOverlay").classList.contains("hidden"), { timeout: 5000 }).then(() => true).catch(() => false);
    check(overlayShown, "OFFLINE-6: both slots full triggers the replace chooser");
    const wording = await page.evaluate(() => document.querySelector("#slotReplaceOverlay p").textContent);
    check(/conceding/i.test(wording) && /loss on the leaderboard/i.test(wording), `OFFLINE-6: chooser wording mentions conceding/loss (got "${wording}")`);

    // Cancel: neither slot touched, no stats.
    await page.evaluate(() => document.getElementById("btnReplaceCancel").click());
    const afterCancelStats = await readStats(page);
    check(!afterCancelStats.SlotOneHuman && !afterCancelStats.SlotTwoHuman, "OFFLINE-6: Cancel recorded no loss for either slot");
    const bothSlotsStill = await page.evaluate(() => [1, 2].every((k) => !!localStorage.getItem("nasty-save-offline-" + k)));
    check(bothSlotsStill, "OFFLINE-6: Cancel kept both saves intact");

    // Now really replace slot 1.
    await startOfflineViaGate(page, { n: 4, teams: false, seatMeta: mk("SlotThreeHuman") });
    await page.waitForFunction(() => !document.getElementById("slotReplaceOverlay").classList.contains("hidden"), { timeout: 5000 });
    await page.evaluate(() => document.getElementById("btnReplaceSlot1").click());
    await page.waitForFunction(() => window.G != null && window.G.seats.some((s) => s.name === "SlotThreeHuman"), { timeout: 5000 });
    const statsAfterReplace = await readStats(page);
    check(statsAfterReplace.SlotOneHuman && statsAfterReplace.SlotOneHuman.hg4s === 1, "OFFLINE-6: discarding slot 1 recorded its human as a loss");
    check(!statsAfterReplace.SlotTwoHuman, "OFFLINE-6: slot 2 (left alone) recorded nothing");
    await ctx.close();
  }

  /* =================================================================================
   * WIN: a genuinely finished game (G.over) never shows any surrender dialog - the topbar
   * button's own G.over guard, checked directly (this is the client-side gate every surrender
   * entry point relies on; recordWin()'s own path is unchanged and untested here on purpose).
   * ================================================================================= */
  log("--- WIN: G.over blocks the Quit/surrender dialog entirely ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await newPage(ctx, PORT);
    const seatMeta = [
      { name: "WinCheck", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    await startOffline(page, { n: 4, teams: false, seatMeta });
    await page.evaluate(() => { window.G.over = true; window.G.winners = [0]; });
    await page.evaluate(() => document.getElementById("btnMenu").click());
    const stillHidden = await page.evaluate(() => document.getElementById("surrenderConfirmOverlay").classList.contains("hidden"));
    check(stillHidden, "WIN: tapping Quit on a G.over game shows no surrender dialog");
    await ctx.close();
  }

  /* =================================================================================
   * ONLINE-1: topbar Quit online - only the surrendering seat is recorded/converted; the OTHER
   * player's own game continues completely untouched.
   * ================================================================================= */
  log("--- ONLINE-1: online Quit charges only the local seat, other player unaffected ---");
  {
    const ctxH = await browser.newContext({ reducedMotion: "reduce" });
    const ctxG = await browser.newContext({ reducedMotion: "reduce" });
    const host = await newPage(ctxH, PORT);
    const guest = await newPage(ctxG, PORT);
    const seatMeta = [
      { name: "QuitHost1", type: "human", diff: "medium" }, { name: "QuitGuest1", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
    ];
    const code = await hostRoomWith(host, seatMeta, 4, false);
    await host.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
    await joinGuest(guest, code, "QuitGuest1", 1);
    await host.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION, willSeat: true }));
    await Promise.all([host, guest].map((p) => p.waitForFunction(() => window.G != null, { timeout: 10000 })));
    await driveSeveralTurns(host, 0, 1000);

    await quitConfirm(host);
    await host.waitForFunction(() => !document.getElementById("menu").classList.contains("hidden"), { timeout: 8000 });
    await guest.waitForFunction(() => window.G && window.G.seats[0].type === "cpu", { timeout: 8000 });

    const lb = await pollLeaderboard(PORT, (b) => !!b.QuitHost1, 5000);
    check(lb.QuitHost1 && lb.QuitHost1.hg4s === 1 && !lb.QuitHost1.hw4s && !lb.QuitHost1.hptsS,
      `ONLINE-1: host surrender recorded exactly one loss, no win/points (got ${JSON.stringify(lb.QuitHost1)})`);
    check(!lb.QuitGuest1, "ONLINE-1: the OTHER player is completely untouched on the leaderboard");
    const guestState = await guest.evaluate(() => ({ over: window.G.over, seat0: window.G.seats[0].type }));
    check(!guestState.over && guestState.seat0 === "cpu", "ONLINE-1: guest's own game continues; host's seat is now a CPU");
    await driveSeveralTurns(guest, 1, 2000);
    check(!(host.__errors || []).length && !(guest.__errors || []).length, "ONLINE-1: zero page errors");
    await ctxH.close(); await ctxG.close();
  }

  /* =================================================================================
   * ONLINE-2: topbar Quit, Cancel - server-side no-op, game continues normally.
   * ================================================================================= */
  log("--- ONLINE-2: online Quit, Cancel records nothing server-side ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await newPage(ctx, PORT);
    const seatMeta = [
      { name: "CancelHst", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    await hostRoomWith(page, seatMeta, 4, false);
    await page.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
    await page.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION, willSeat: true }));
    await page.waitForFunction(() => window.G != null, { timeout: 10000 });
    await quitCancel(page);
    await sleep(800);
    const lb = await (await fetch(`http://localhost:${PORT}/leaderboard`)).json();
    check(!lb.CancelHst, "ONLINE-2: Cancel recorded nothing on the server leaderboard");
    const state = await page.evaluate(() => ({ over: window.G.over, seat0: window.G.seats[0].type, gameHidden: document.getElementById("game").classList.contains("hidden") }));
    check(!state.over && state.seat0 === "human" && !state.gameHidden, "ONLINE-2: Cancel leaves the seat human and the game running");
    await ctx.close();
  }

  /* =================================================================================
   * ONLINE-3: teams - only the surrendering player's own seat is charged; the PARTNER is
   * completely untouched (no leaderboard entry for the partner's name at all).
   * ================================================================================= */
  log("--- ONLINE-3: teams surrender charges only the surrendering seat, not the partner ---");
  {
    const ctxH = await browser.newContext({ reducedMotion: "reduce" });
    const ctxG = await browser.newContext({ reducedMotion: "reduce" });
    const host = await newPage(ctxH, PORT);
    const guest = await newPage(ctxG, PORT);
    // 4P teams: partnerOf(seat) = (seat + n/2) % n, so seat0's partner is seat2.
    const seatMeta = [
      { name: "TeamSelf", type: "human", diff: "medium" }, { name: "C1", type: "cpu", diff: "easy" },
      { name: "TeamPartn", type: "human", diff: "medium" }, { name: "C2", type: "cpu", diff: "easy" },
    ];
    const code = await hostRoomWith(host, seatMeta, 4, true);
    await host.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
    await joinGuest(guest, code, "TeamPartn", 2);
    await host.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION, willSeat: true }));
    await Promise.all([host, guest].map((p) => p.waitForFunction(() => window.G != null, { timeout: 10000 })));
    await driveSeveralTurns(host, 0, 800);

    await quitConfirm(host);
    await host.waitForFunction(() => !document.getElementById("menu").classList.contains("hidden"), { timeout: 8000 });
    const lb = await pollLeaderboard(PORT, (b) => !!b.TeamSelf, 5000);
    check(lb.TeamSelf && lb.TeamSelf.hg4t === 1 && !lb.TeamSelf.hw4t && !lb.TeamSelf.hptsT,
      `ONLINE-3: surrendering seat recorded exactly one team loss (got ${JSON.stringify(lb.TeamSelf)})`);
    check(!lb.TeamPartn, "ONLINE-3: the PARTNER is completely untouched - no entry at all");
    await ctxH.close(); await ctxG.close();
  }

  /* =================================================================================
   * ONLINE-4: "Have a computer take over my seat" (sheet) now ALSO surrenders.
   * ================================================================================= */
  log("--- ONLINE-4: sheet's 'Have a computer take over my seat' now surrenders too ---");
  {
    const ctxH = await browser.newContext({ reducedMotion: "reduce" });
    const ctxG = await browser.newContext({ reducedMotion: "reduce" });
    const host = await newPage(ctxH, PORT2);
    const guest = await newPage(ctxG, PORT2);
    const seatMeta = [
      { name: "TakeOverH", type: "human", diff: "medium" }, { name: "TakeOverG", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
    ];
    const code = await hostRoomWith(host, seatMeta, 4, false);
    await host.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
    await joinGuest(guest, code, "TakeOverG", 1);
    await host.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION, willSeat: true }));
    await Promise.all([host, guest].map((p) => p.waitForFunction(() => window.G != null, { timeout: 10000 })));
    await driveSeveralTurns(host, 0, 800);

    const shown = await host.evaluate(() => {
      document.getElementById("btnPause").click();
      document.getElementById("btnLeaveForGood").click();
      return !document.getElementById("surrenderConfirmOverlay").classList.contains("hidden");
    });
    check(shown, "ONLINE-4: 'Have a computer take over my seat' opens the surrender confirm first");
    await host.evaluate(() => document.getElementById("btnSurrenderConfirm").click());
    await host.waitForFunction(() => !document.getElementById("menu").classList.contains("hidden"), { timeout: 8000 });
    await guest.waitForFunction(() => window.G && window.G.seats[0].type === "cpu", { timeout: 8000 });
    const lb = await pollLeaderboard(PORT2, (b) => !!b.TakeOverH, 5000);
    check(lb.TakeOverH && lb.TakeOverH.hg4s === 1 && !lb.TakeOverH.hw4s, "ONLINE-4: recorded exactly one loss for the seat that took the CPU handoff");
    check(!lb.TakeOverG, "ONLINE-4: the other player is untouched");
    await ctxH.close(); await ctxG.close();
  }

  /* =================================================================================
   * ONLINE-5: "Leave without saving" (sheet, online) now ALSO surrenders.
   * ================================================================================= */
  log("--- ONLINE-5: sheet's 'Leave without saving' (online) now surrenders too ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await newPage(ctx, PORT2);
    const seatMeta = [
      { name: "DiscardH1", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    await hostRoomWith(page, seatMeta, 4, false);
    await page.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
    await page.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION, willSeat: true }));
    await page.waitForFunction(() => window.G != null, { timeout: 10000 });
    await sheetDiscardConfirm(page);
    await page.waitForFunction(() => !document.getElementById("menu").classList.contains("hidden"), { timeout: 8000 });
    const lb = await pollLeaderboard(PORT2, (b) => !!b.DiscardH1, 5000);
    check(lb.DiscardH1 && lb.DiscardH1.hg4s === 1 && !lb.DiscardH1.hw4s, "ONLINE-5: 'Leave without saving' online recorded exactly one loss");
    await ctx.close();
  }

  /* =================================================================================
   * ONLINE-6: trash-delete on a REMEMBERED ONLINE tile - the server records the loss even
   * though the device isn't currently connected to that room.
   * ================================================================================= */
  log("--- ONLINE-6: trash-delete on a remembered online tile ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await newPage(ctx, PORT2);
    const seatMeta = [
      { name: "TrashOnH1", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    await hostRoomWith(page, seatMeta, 4, false);
    await page.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
    await page.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION, willSeat: true }));
    await page.waitForFunction(() => window.G != null, { timeout: 10000 });
    await saveAndReturnToMenu(page);   // Save & leave - the tile now sits on the menu, room still alive server-side
    const tileVisible = await page.evaluate(() => !document.getElementById("btnSavedGame").classList.contains("hidden"));
    check(tileVisible, "ONLINE-6: the remembered online tile is showing after Save & leave");

    const confirmText = await page.evaluate(() => { document.getElementById("savedGameTrash").click(); return document.getElementById("savedGameConfirm").textContent; });
    check(/concede/i.test(confirmText) && /loss on the leaderboard/i.test(confirmText), `ONLINE-6: trash confirm wording mentions concede/loss (got "${confirmText}")`);
    await page.evaluate(() => document.getElementById("savedGameDelete").click());
    const tileGone = await page.evaluate(() => document.getElementById("btnSavedGame").classList.contains("hidden"));
    check(tileGone, "ONLINE-6: the tile disappears immediately from this device's own view");

    const lb = await pollLeaderboard(PORT2, (b) => !!b.TrashOnH1, 8000);
    check(lb.TrashOnH1 && lb.TrashOnH1.hg4s === 1 && !lb.TrashOnH1.hw4s,
      `ONLINE-6: the server eventually recorded the loss for the deleted online tile (got ${JSON.stringify(lb.TrashOnH1)})`);
    await ctx.close();
  }

  /* =================================================================================
   * ONLINE-7: "Save & leave" remains the one truly consequence-free online path - no
   * leaderboard write, and the seat stays HUMAN (not converted to a CPU) server-side.
   * ================================================================================= */
  log("--- ONLINE-7: 'Save & leave' (online) stays completely consequence-free ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await newPage(ctx, PORT);
    const seatMeta = [
      { name: "SafeSaveH", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    const code = await hostRoomWith(page, seatMeta, 4, false);
    await page.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
    await page.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION, willSeat: true }));
    await page.waitForFunction(() => window.G != null, { timeout: 10000 });
    await saveAndReturnToMenu(page);
    await sleep(600);
    const lb = await (await fetch(`http://localhost:${PORT}/leaderboard`)).json();
    check(!lb.SafeSaveH, "ONLINE-7: Save & leave recorded nothing on the leaderboard");

    // Rejoin the SAME room directly (bypassing the reunion lobby, since nobody else was ever
    // missing) and confirm the seat is still human - "Save & leave" never hands it to a CPU.
    await page.evaluate((code) => { const saved = JSON.parse(localStorage.getItem("nasty-net-" + code)); window.NET.wantConnection = true; window.NET.code = code; window.NET.playerId = saved.playerId; window.NET.token = saved.token;
      window.connectWs().then(() => window.netSend({ type: "rejoin", code, playerId: saved.playerId, token: saved.token, protocolVersion: PROTOCOL_VERSION })); }, code);
    await page.waitForFunction(() => window.G != null, { timeout: 8000 });
    const seatType = await page.evaluate(() => window.G.seats[0].type);
    check(seatType === "human", "ONLINE-7: the seat is still human after a Save & leave + rejoin (never converted)");
    await ctx.close();
  }

  /* =================================================================================
   * NOFAULT-quit / NOFAULT-discard / NOFAULT-takeover / NOFAULT-trash: v0.27.1 § NO-FAULT EXIT.
   * Once A has conceded a still-unfinished ONLINE game, B's own subsequent departure from that
   * SAME game - via any of the four surrender-flagged paths - is free: the no-fault wording
   * shows BEFORE B commits, and B ends up with zero leaderboard entry at all.
   * ================================================================================= */
  log("--- NOFAULT-quit: after A concedes (Quit), B's own Quit is a free no-fault exit ---");
  await nofaultTwoHumanScenario(browser, PORT3, "quit", "NoFaultQA", "NoFaultQB");

  log("--- NOFAULT-discard: after A concedes, B's 'Leave without saving' is a free no-fault exit ---");
  await nofaultTwoHumanScenario(browser, PORT3, "discard", "NoFaultDA", "NoFaultDB");

  log("--- NOFAULT-takeover: after A concedes, B's 'Have a computer take over' is a free no-fault exit ---");
  await nofaultTwoHumanScenario(browser, PORT3, "takeover", "NoFaultTA", "NoFaultTB");

  log("--- NOFAULT-trash: after A concedes, B trash-deleting their remembered tile is a free no-fault exit ---");
  await nofaultTwoHumanScenario(browser, PORT4, "trash", "NoFaultXA", "NoFaultXB");

  /* =================================================================================
   * NOFAULT-3: 3+ humans - after the FIRST concedes, BOTH remaining humans get free exits, one
   * after another, in the SAME game - the flag is a simple sticky boolean, not "who's already
   * left" bookkeeping, so a THIRD departure needs no extra logic beyond re-checking it.
   * ================================================================================= */
  log("--- NOFAULT-3: 3+ humans - after the first concedes, every other human gets a free exit ---");
  {
    const seatMeta = [
      { name: "NoFault3A", type: "human", diff: "medium" }, { name: "NoFault3B", type: "human", diff: "medium" },
      { name: "NoFault3C", type: "human", diff: "medium" }, { name: "C1", type: "cpu", diff: "easy" },
    ];
    const { host, pages, ctxHost, guestCtxs } = await setupOnlineHumans(browser, PORT3, seatMeta, 4, false);
    const [, guestB, guestC] = pages;

    await quitConfirm(host);
    await host.waitForFunction(() => !document.getElementById("menu").classList.contains("hidden"), { timeout: 8000 });
    const lbA = await pollLeaderboard(PORT3, (b) => !!b.NoFault3A, 5000);
    check(lbA.NoFault3A && lbA.NoFault3A.hg4s === 1, "NOFAULT-3: A's own concede still records the normal loss");
    await guestB.waitForFunction(() => window.NET && window.NET.anySurrenderOccurred === true, { timeout: 5000 });
    await guestC.waitForFunction(() => window.NET && window.NET.anySurrenderOccurred === true, { timeout: 5000 });

    await quitConfirm(guestB);
    await guestB.waitForFunction(() => !document.getElementById("menu").classList.contains("hidden"), { timeout: 8000 });
    await sleep(600);
    let lb = await (await fetch(`http://localhost:${PORT3}/leaderboard`)).json();
    check(!lb.NoFault3B, "NOFAULT-3: B (2nd departure from this game) recorded no leaderboard entry at all");

    await quitConfirm(guestC);
    await guestC.waitForFunction(() => !document.getElementById("menu").classList.contains("hidden"), { timeout: 8000 });
    await sleep(600);
    lb = await (await fetch(`http://localhost:${PORT3}/leaderboard`)).json();
    check(!lb.NoFault3C, "NOFAULT-3: C (3rd departure from this game) ALSO recorded no leaderboard entry at all - no extra logic needed");

    await ctxHost.close();
    for (const c of guestCtxs) await c.close();
  }

  /* =================================================================================
   * NOFAULT-4: the no-fault flag is scoped to ONE game instance and never leaks across games.
   * This server design has no "rematch in place" mechanic (every online game is its own room,
   * see actuallyStartGame()'s comment) - so the strongest honest proof available is that a
   * BRAND-NEW room/game, even reusing a name that already conceded in an EARLIER, unrelated
   * game, starts with anySurrenderOccurred=false (both makeRoom()'s default and
   * actuallyStartGame()'s reset are exercised live over the wire here, not just read from
   * source). See HANDOFF.md v0.27.1 for the full reasoning.
   * ================================================================================= */
  log("--- NOFAULT-4: the no-fault flag never leaks into a brand-new room/game ---");
  {
    const seatMeta = [
      { name: "NoFault4A", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await newPage(ctx, PORT4);
    await hostRoomWith(page, seatMeta, 4, false);
    await page.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
    await page.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION, willSeat: true }));
    await page.waitForFunction(() => window.G != null, { timeout: 10000 });
    const flag = await page.evaluate(() => window.NET.anySurrenderOccurred);
    check(flag === false, "NOFAULT-4: a brand-new room/game starts with anySurrenderOccurred=false, confirmed live over the wire");
    const heading = await page.evaluate(() => {
      document.getElementById("btnMenu").click();
      const h = document.getElementById("surrenderConfirmHeading").textContent;
      document.getElementById("btnSurrenderCancel").click();
      return h;
    });
    check(heading === "CONCEDE?", `NOFAULT-4: a fresh game's own concede dialog shows the normal (not no-fault) wording (got "${heading}")`);
    await ctx.close();
  }

  /* =================================================================================
   * RETURN-TO-GAME: v0.27.1 - Blake's ask that Pause/Save's sheet have an explicit, prominent
   * "Return to Game" way back in, not just "Cancel" buried in a list of ways to leave. Verifies
   * it closes the sheet, unpauses, continues the SAME game with zero stat consequence.
   * ================================================================================= */
  log("--- RETURN-TO-GAME: the sheet's primary button plainly resumes play, no stat consequence ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await newPage(ctx, PORT4);
    const seatMeta = [
      { name: "ReturnToGameH", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    await startOffline(page, { n: 4, teams: false, seatMeta });
    const before = await page.evaluate(() => {
      document.getElementById("btnPause").click();
      return {
        sheetShown: !document.getElementById("leaveConfirmOverlay").classList.contains("hidden"),
        firstBtnId: document.querySelector("#leaveConfirmOverlay .bigBtns .btn").id,
        firstBtnText: document.querySelector("#leaveConfirmOverlay .bigBtns .btn").textContent,
        firstBtnIsPrimary: document.querySelector("#leaveConfirmOverlay .bigBtns .btn").classList.contains("primary"),
        paused: window.G.paused,
      };
    });
    check(before.sheetShown, "RETURN-TO-GAME: Pause/Save opens the sheet");
    check(before.paused === true, "RETURN-TO-GAME: the game is paused while the sheet is up");
    check(before.firstBtnId === "btnLeaveCancel" && /Return to Game/i.test(before.firstBtnText) && before.firstBtnIsPrimary,
      `RETURN-TO-GAME: the FIRST, primary-styled button plainly reads "Return to Game" (got id=${before.firstBtnId} text="${before.firstBtnText}" primary=${before.firstBtnIsPrimary})`);
    await page.evaluate(() => document.getElementById("btnLeaveCancel").click());
    const after = await page.evaluate(() => ({
      sheetHidden: document.getElementById("leaveConfirmOverlay").classList.contains("hidden"),
      paused: window.G.paused,
      gameHidden: document.getElementById("game").classList.contains("hidden"),
    }));
    check(after.sheetHidden, "RETURN-TO-GAME: tapping it closes the sheet");
    check(after.paused === false && !after.gameHidden, "RETURN-TO-GAME: the SAME game continues, unpaused");
    check(!(await readStats(page)).ReturnToGameH, "RETURN-TO-GAME: zero stat consequence of any kind");
    await ctx.close();
  }

  /* =================================================================================
   * OVERFLOW: Blake's report - "the surrender badge takes up the entire screen (and then
   * some)". Every confirm-style overlay must stay fully within the viewport across the
   * project's standard phone matrix (its own .confirmCard scrolls internally if content is
   * ever taller than that) - checked here for the two worst-case, Blake-named dialogs
   * (leaveConfirmOverlay ONLINE with all 6 buttons showing, and surrenderConfirmOverlay) across
   * the full matrix, plus a spot check at the narrowest size (320x568) for slotReplaceOverlay
   * and overwriteWarnOverlay. pauseOverlay got the identical .confirmCard treatment but isn't
   * exercised here - it's the shortest of the five (sign + one line + one button), not
   * realistically at risk, and not easily reachable single-human in this harness (it's the
   * OTHER players' view of someone else's pause, see index.html's updatePauseUI()).
   * ================================================================================= */
  log("--- OVERFLOW: confirm-style overlays never spill past the viewport, phone matrix ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await newPage(ctx, PORT4);
    const seatMeta = [
      { name: "OverflowH", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    await hostRoomWith(page, seatMeta, 4, false);
    await page.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
    await page.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION, willSeat: true }));
    await page.waitForFunction(() => window.G != null, { timeout: 10000 });

    const sizes = [[320, 568], [375, 667], [390, 844], [414, 896], [430, 932]];
    for (const [w, h] of sizes) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(() => document.getElementById("btnPause").click());
      await page.waitForFunction(() => window.G && window.G.paused === true, { timeout: 5000 });
      let rect = await page.evaluate(() => document.querySelector("#leaveConfirmOverlay .confirmCard").getBoundingClientRect());
      check(rect.top >= 0 && rect.bottom <= h, `OVERFLOW: leaveConfirmOverlay (online, 6 buttons) fits within ${w}x${h} (top=${rect.top.toFixed(1)}, bottom=${rect.bottom.toFixed(1)})`);
      await page.evaluate(() => document.getElementById("btnLeaveDiscard").click());
      rect = await page.evaluate(() => document.querySelector("#surrenderConfirmOverlay .confirmCard").getBoundingClientRect());
      check(rect.top >= 0 && rect.bottom <= h, `OVERFLOW: surrenderConfirmOverlay fits within ${w}x${h} (top=${rect.top.toFixed(1)}, bottom=${rect.bottom.toFixed(1)})`);
      await page.evaluate(() => document.getElementById("btnSurrenderCancel").click());
      await page.evaluate(() => document.getElementById("btnLeaveCancel").click());   // Return to Game - back to the board, unpaused
      await page.waitForFunction(() => window.G && window.G.paused === false, { timeout: 5000 });
    }
    await ctx.close();
  }
  log("--- OVERFLOW (spot check, 320x568): slotReplaceOverlay + overwriteWarnOverlay ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await newPage(ctx, PORT4);
    await page.setViewportSize({ width: 320, height: 568 });
    const mk = (name) => [{ name, type: "human", diff: "medium" }, { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" }];
    await startOffline(page, { n: 4, teams: false, seatMeta: mk("OverflowSlotA") });
    await saveAndReturnToMenu(page);
    await startOfflineViaGate(page, { n: 4, teams: false, seatMeta: mk("OverflowSlotB") });
    await page.waitForFunction(() => window.G != null, { timeout: 5000 });
    await saveAndReturnToMenu(page);
    await startOfflineViaGate(page, { n: 4, teams: false, seatMeta: mk("OverflowSlotC") });
    await page.waitForFunction(() => !document.getElementById("slotReplaceOverlay").classList.contains("hidden"), { timeout: 5000 });
    let rect = await page.evaluate(() => document.querySelector("#slotReplaceOverlay .confirmCard").getBoundingClientRect());
    check(rect.top >= 0 && rect.bottom <= 568, `OVERFLOW: slotReplaceOverlay fits within 320x568 (top=${rect.top.toFixed(1)}, bottom=${rect.bottom.toFixed(1)})`);
    await page.evaluate(() => document.getElementById("btnReplaceCancel").click());

    const shown = await page.evaluate(() => {
      localStorage.setItem("nasty-last-room", JSON.stringify({ code: "FAKE", wasStarted: true, ts: Date.now() }));
      localStorage.setItem("nasty-net-FAKE", JSON.stringify({ playerId: 1, token: "tok" }));
      window.confirmOverwriteThenRun(() => {});
      return !document.getElementById("overwriteWarnOverlay").classList.contains("hidden");
    });
    check(shown, "OVERFLOW: overwriteWarnOverlay reachable for the fit check");
    rect = await page.evaluate(() => document.querySelector("#overwriteWarnOverlay .confirmCard").getBoundingClientRect());
    check(rect.top >= 0 && rect.bottom <= 568, `OVERFLOW: overwriteWarnOverlay fits within 320x568 (top=${rect.top.toFixed(1)}, bottom=${rect.bottom.toFixed(1)})`);
    await ctx.close();
  }

  await browser.close();
  child.kill("SIGTERM");
  child2.kill("SIGTERM");
  child3.kill("SIGTERM");
  child4.kill("SIGTERM");
  await sleep(300);   // let all four servers actually exit before cleanup - avoids an ENOTEMPTY race
  // if a debounced persist write lands mid-rmSync (this is scratch-dir cleanup only, never
  // load-bearing for the test result itself, so a couple of retries is enough belt-and-suspenders).
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); break; }
    catch (e) { await sleep(200); }
  }
  console.log(`\n[${KIND}] ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}
const WATCHDOG_MS = 180000;
const watchdog = setTimeout(() => {
  console.error(`[surrender] WATCHDOG: suite did not finish within ${WATCHDOG_MS}ms - forcing exit`);
  process.exit(1);
}, WATCHDOG_MS);
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => clearTimeout(watchdog));
