"use strict";
/*
 * v0.37 permanent regression suite (2026-07-26) - Blake's three reports.
 *
 * Usage:
 *   node test_ui_v037_2026_07_26.js            (parts A-D, Node relay)
 *   node test_ui_v037_2026_07_26.js deno       (parts A-C against server/cloud/server.ts)
 *   NASTY_INDEX=/some/other/index.html node test_ui_v037_2026_07_26.js
 *       - points every page at a DIFFERENT copy of the app. This exists so the fix can be
 *         proven the only way that means anything: run this same file against the PRE-FIX
 *         index.html and watch parts A, B and C fail. A test that cannot fail proves nothing.
 *
 * Never touches production. Every online part spawns its own private relay on a random high
 * port with its own scratch directory, exactly like the other suites in this folder.
 *
 * ---------------------------------------------------------------------------------------
 * PART A - item 1: accepting an invite while a LOCAL game is on screen must reach the lobby.
 *   Blake: "I had been playing a separate local game (was on a different app though, but it was
 *   still open) and when I accepted my friends invite it brought me to the nasty app again but
 *   never loaded the lobby. It even had the box pop up that said the online rules were different
 *   but never showed me the available players."
 *   Root cause: v0.33's § OVERLAY LAYER hand-off. showOnlineRulesOnce/maybeShowOnlineRules opened
 *   the one-time online-rules popup with backIf:()=>$('game').classList.contains('hidden'), i.e.
 *   "hand the lobby back only if NO board is on screen". Blake had a local board on screen, so
 *   the lobby was never handed back and he was stranded. v0.37 asks NET.started instead - the
 *   ONLINE room's own lifecycle - and parks the local game (saving it first) the moment the room
 *   is really joined.
 *
 * PART B - item 1's safety net: there is ALWAYS a way out.
 *   Closing the last overlay must never leave a blank or unreachable screen, and a lobby with
 *   nothing on screen must repair itself (ensureScreenReachable, § OVERLAY LAYER).
 *
 * PART C - item 2: a join that never starts leaves nothing behind.
 *   Blake: "There should also be an option if you accept an invite but then the game never
 *   starts, it shouldn't save the game - because then it still wouldn't let me join since it had
 *   already glitched out and I had to 'concede' the game."
 *   The 'joined'/'created' cases used to call saveLastRoom(code,false) immediately. That record
 *   paints the menu's "Resume - online game" tile, whose only removal path asks you to CONCEDE.
 *   Now only a genuinely STARTED game writes it - and a reconnect into a real game still does.
 *
 * PART D - item 3: selection badges stay near their peg, on BOTH board sizes.
 *   Blake: "Regardless of 4 player or 6 player, stop moving the selection badges above the pegs
 *   if they overlap with something on the board... this should only be a slight adjustment not
 *   half the board away from the peg."
 *   Hard cap: MAX_BADGE_SHIFT = 3 x holeR = 39 board px (4P) / 31.5 (6P). No server needed.
 */

const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
require("./test_ui_v036_welcome_bypass.js").patch(chromium);

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const KIND = process.argv[2] === "deno" ? "deno" : "node";
const USE_DENO = KIND === "deno";
const INDEX = process.env.NASTY_INDEX || "/Users/jarvis/nasty-game/index.html";
const SHOTDIR = process.env.NASTY_SHOTDIR || "/tmp/nasty-v037-shots";
const PORT = 25300 + Math.floor(Math.random() * 500);
const PORT2 = PORT + 1;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-v037-${KIND}-`));
fs.mkdirSync(SHOTDIR, { recursive: true });

function log(...a) { console.log("[v037]", new Date().toISOString(), ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------- private relay ------------------------------- */
function startServer(port) {
  const portScratch = path.join(SCRATCH, String(port));
  fs.mkdirSync(portScratch, { recursive: true });
  let child;
  if (USE_DENO) {
    child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
      cwd: "/Users/jarvis/nasty-game/server/cloud",
      env: Object.assign({}, process.env, { NASTY_PORT: String(port), NASTY_KV_PATH: path.join(portScratch, "v037.kv"), NASTY_ADMIN_TOKEN: "v037-admin-token" }),
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

/* ------------------------------- page helpers ------------------------------- */
async function newPage(ctx, wsPort, viewport) {
  const page = await ctx.newPage();
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push(String(e)));
  if (viewport) await page.setViewportSize(viewport);
  await page.goto(`file://${INDEX}?ws=${encodeURIComponent(`ws://127.0.0.1:${wsPort}`)}`);
  await page.waitForFunction(() => typeof window.NET === "object");
  // A returning player: the one-time speed picker has been answered on this device already.
  // Same fixture every other online suite in this folder uses.
  await page.evaluate(() => { try { localStorage.setItem("nasty-speed-chosen", "1"); } catch (e) {} });
  await installTileReader(page);
  return page;
}
/* The menu's saved-game tiles, read straight off the rendered page. SAVED_GAMES is a `let` at
   script scope in index.html, so it is deliberately NOT on window - reading the DOM is both the
   only way and the honest way, since these tiles are exactly what Blake taps. */
async function installTileReader(page) {
  await page.evaluate(() => {
    window.__v037Tiles = () => {
      const rows = ["btnSavedGame", "btnSavedGame2", "btnSavedGame3"];
      const details = ["savedGameDetail", "savedGameDetail2", "savedGameDetail3"];
      const shown = [];
      rows.forEach((id, i) => {
        const r = document.getElementById(id);
        if (r && !r.classList.contains("hidden")) shown.push({ i, text: (document.getElementById(details[i]) || {}).textContent || "" });
      });
      return {
        lastRoom: localStorage.getItem("nasty-last-room"),
        tiles: shown.length,
        text: shown.map((s) => s.text.replace(/\s+/g, " ").trim()).join(" | "),
        online: (shown.find((s) => /online/i.test(s.text)) || { i: -1 }).i,
      };
    };
  });
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
// Start a REAL local (offline) game on this page and leave its board on screen - the exact
// situation Blake was in when the invite arrived.
async function startLocalGame(page, n) {
  await page.evaluate((n) => {
    CFG.n = n; CFG.teams = false;
    CFG.seatMeta[n] = Array.from({ length: n }, (_, i) => ({ name: i === 0 ? "Blake" : "CPU" + i, type: i === 0 ? "human" : "cpu", diff: "easy" }));
    window.startOfflineGameGate(window.startGame);
  }, n);
  await page.waitForFunction(() => window.G && window.G.n && !document.getElementById("game").classList.contains("hidden"), { timeout: 20000 });
  // Answer the speed picker if it appeared, so nothing is sitting on top of the board.
  await page.evaluate(() => { const sp = document.getElementById("speedPickerOverlay"); if (sp) sp.classList.add("hidden"); });
  await sleep(150);
}

/* ===========================================================================================
 * PART A - accepting an invite while a local game is on screen
 * =========================================================================================== */
async function partA(browser) {
  log("--- Part A: item 1 - invite accepted while a LOCAL game is on screen ---");
  const ctxH = await browser.newContext({ reducedMotion: "reduce" });
  const ctxG = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 390, height: 844 } });
  const host = await newPage(ctxH, PORT);
  const guest = await newPage(ctxG, PORT);

  const seatMeta = [
    { name: "Host", type: "human", diff: "medium" }, { name: "Blake", type: "human", diff: "medium" },
    { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
  ];
  const code = await hostRoom(host, seatMeta, 4);
  await host.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });

  // 1. Blake is mid local game. Board on screen, real game object, real save slot.
  await startLocalGame(guest, 4);
  const before = await guest.evaluate(() => ({
    gameUp: !document.getElementById("game").classList.contains("hidden"),
    gameId: window.G && window.G.gameId,
    slot: window.SAVE_SLOT,
  }));
  check(before.gameUp === true, "A1 a local game really is on screen before the invite arrives");
  await guest.screenshot({ path: path.join(SHOTDIR, "A_local_game_before_invite.png") });

  // 2. The invite arrives while the app is already running - the EXACT warm Universal-Link path
  //    the iPhone app takes when Blake taps his friend's link (handleIncomingJoinLink, cold=false).
  await guest.evaluate((code) => window.handleIncomingJoinLink(`https://play.nastyboardgame.com/join/${code}`, false), code);
  await guest.waitForFunction(() => !document.getElementById("joinOverlay").classList.contains("hidden"), { timeout: 8000 });
  await guest.evaluate(() => { document.getElementById("joinNameInput").value = "Blake"; });
  await guest.evaluate(() => document.getElementById("btnJoinNameNext").click());
  await guest.waitForFunction(() => window.NET && window.NET.lobby != null, { timeout: 10000 });

  // 3. The online-rules popup is up, exactly as Blake described ("the box pop up that said the
  //    online rules were different").
  const rulesUp = await guest.evaluate(() => !document.getElementById("onlineRulesOverlay").classList.contains("hidden"));
  check(rulesUp, "A2 the one-time online-rules popup appears (Blake saw this part too)");
  await guest.screenshot({ path: path.join(SHOTDIR, "A_rules_popup.png") });

  // 4. THE BUG. Dismiss it. The lobby must come back.
  await guest.evaluate(() => document.getElementById("btnOnlineRulesOk").click());
  await sleep(400);
  const after = await guest.evaluate(() => {
    const jo = document.getElementById("joinOverlay");
    const seatStep = document.getElementById("joinSeatStep");
    const rows = [...document.querySelectorAll("#joinSeatList .lobbySeat")];
    const openRow = rows.find((r) => r.classList.contains("open"));
    const rect = openRow ? openRow.getBoundingClientRect() : null;
    return {
      lobbyVisible: !jo.classList.contains("hidden"),
      seatStepVisible: !seatStep.classList.contains("hidden"),
      seatRows: rows.length,
      openRows: rows.filter((r) => r.classList.contains("open")).length,
      openRowH: rect ? rect.height : 0,
      // the row a thumb would actually land on must BE the seat row, not something over it
      hitIsSeatRow: rect ? !!(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) || {}).closest
        && !!document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2).closest("#joinSeatList") : false,
      gameUp: !document.getElementById("game").classList.contains("hidden"),
      menuUp: !document.getElementById("menu").classList.contains("hidden"),
      netStarted: !!window.NET.started,
    };
  });
  check(after.lobbyVisible, "A3 THE FIX: the lobby is back on screen after dismissing the rules popup");
  check(after.seatStepVisible, "A4 the seat step is the step showing");
  check(after.seatRows >= 4 && after.openRows >= 1, `A5 the available players are listed and at least one seat is open (${after.seatRows} seats, ${after.openRows} open)`);
  check(after.hitIsSeatRow, "A6 an open seat row is the thing a thumb actually hits - nothing is covering it");
  check(after.netStarted === false, "A7 NET.started is false - the online game genuinely has not started yet");
  await guest.screenshot({ path: path.join(SHOTDIR, "A_lobby_after_rules.png") });

  // 5. The local game was PARKED, not destroyed: board put away, menu behind the lobby, and the
  //    save still holds it.
  check(after.gameUp === false, "A8 the local board was put away (no live local game under the lobby)");
  check(after.menuUp === true, "A9 the menu is what sits behind the lobby now");
  const parked = await guest.evaluate((gid) => {
    for (const k of [1, 2]) {
      try {
        const s = JSON.parse(localStorage.getItem("nasty-save-offline-" + k) || "null");
        if (s && s.G && s.G.gameId === gid) return { found: true, slot: k, over: !!s.G.over };
      } catch (e) {}
    }
    return { found: false };
  }, before.gameId);
  check(parked.found === true, `A10 the local game was SAVED, not thrown away (found in slot ${parked.slot})`);

  // 6. The lobby is genuinely usable: claim a seat and ready up with real clicks.
  const claimed = await guest.evaluate(() => {
    const openRow = [...document.querySelectorAll("#joinSeatList .lobbySeat")].find((r) => r.classList.contains("open"));
    if (!openRow) return false;
    openRow.click();
    return true;
  });
  check(claimed, "A11 an open seat can actually be tapped");
  await guest.waitForFunction(() => !document.getElementById("btnJoinReady").classList.contains("hidden"), { timeout: 8000 }).catch(() => {});
  const readyLive = await guest.evaluate(() => {
    const b = document.getElementById("btnJoinReady");
    const r = b.getBoundingClientRect();
    return { shown: !b.classList.contains("hidden"), enabled: !b.disabled, h: r.height };
  });
  check(readyLive.shown && readyLive.enabled && readyLive.h >= 44, `A12 Ready up is live and a real tap target (${readyLive.h.toFixed(1)}px tall)`);

  check(guest.__errors.length === 0, `A13 no page errors on the invitee (${guest.__errors.join(" | ")})`);
  await ctxH.close(); await ctxG.close();
}

/* ===========================================================================================
 * PART B - the safety net: there is always a way out
 * =========================================================================================== */
async function partB(browser) {
  log("--- Part B: item 1 safety net - never a blank or unreachable screen ---");
  const ctxH = await browser.newContext({ reducedMotion: "reduce" });
  const ctxG = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 390, height: 844 } });
  const host = await newPage(ctxH, PORT2);
  const guest = await newPage(ctxG, PORT2);
  const seatMeta = [
    { name: "Host", type: "human", diff: "medium" }, { name: "Blake", type: "human", diff: "medium" },
    { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
  ];
  const code = await hostRoom(host, seatMeta, 4);
  await host.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });

  await guest.evaluate((code) => window.handleIncomingJoinLink(`https://play.nastyboardgame.com/join/${code}`, false), code);
  await guest.waitForFunction(() => !document.getElementById("joinOverlay").classList.contains("hidden"), { timeout: 8000 });
  await guest.evaluate(() => { document.getElementById("joinNameInput").value = "Blake"; });
  await guest.evaluate(() => document.getElementById("btnJoinNameNext").click());
  await guest.waitForFunction(() => window.NET && window.NET.lobby != null, { timeout: 10000 });
  await guest.evaluate(() => document.getElementById("btnOnlineRulesOk").click());
  await sleep(300);

  // B1: simulate ANY future code path stranding the player - rip every full-screen page away by
  // hand (a raw classList.add, bypassing closeOverlay entirely). The lobby must repair itself.
  await guest.evaluate(() => {
    document.querySelectorAll(".overlay").forEach((o) => o.classList.add("hidden"));
  });
  await sleep(400);
  const repaired = await guest.evaluate(() => ({
    lobbyBack: !document.getElementById("joinOverlay").classList.contains("hidden"),
    anyVisible: [...document.querySelectorAll(".overlay:not(.hidden)")].map((o) => o.id),
  }));
  check(repaired.lobbyBack, `B1 a stranded lobby repairs itself within a frame (visible now: ${repaired.anyVisible.join(",") || "none"})`);

  // B2: the never-two-full-screen-pages invariant is not broken by the repair.
  check(repaired.anyVisible.filter((id) => id !== "reclaimReqOverlay").length === 1,
    `B2 exactly one full-screen page is up after the repair (${repaired.anyVisible.join(",")})`);

  // B3: total blank - no overlay, no board, no menu. The menu must come back.
  await guest.evaluate(() => {
    window.NET.online = false;                 // not a lobby any more, just a blank app
    document.querySelectorAll(".overlay").forEach((o) => o.classList.add("hidden"));
    document.getElementById("menu").classList.add("hidden");
    document.getElementById("game").classList.add("hidden");
  });
  await sleep(400);
  const unblanked = await guest.evaluate(() => ({
    menuUp: !document.getElementById("menu").classList.contains("hidden"),
    menuBtns: [...document.querySelectorAll("#menu button")].filter((b) => b.offsetParent !== null).length,
  }));
  check(unblanked.menuUp, "B3 a totally blank screen comes back to the menu on its own");
  check(unblanked.menuBtns > 0, `B3b the menu that comes back is interactive (${unblanked.menuBtns} visible buttons)`);
  await guest.screenshot({ path: path.join(SHOTDIR, "B_recovered_menu.png") });

  // B4: Cancel on the join SEAT step is a real way out of a joined lobby - no concede needed.
  const ctxG2 = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 390, height: 844 } });
  const guest2 = await newPage(ctxG2, PORT2);
  await guest2.evaluate((code) => window.handleIncomingJoinLink(`https://play.nastyboardgame.com/join/${code}`, false), code);
  await guest2.waitForFunction(() => !document.getElementById("joinOverlay").classList.contains("hidden"), { timeout: 8000 });
  await guest2.evaluate(() => { document.getElementById("joinNameInput").value = "Blake2"; });
  await guest2.evaluate(() => document.getElementById("btnJoinNameNext").click());
  await guest2.waitForFunction(() => window.NET && window.NET.lobby != null, { timeout: 10000 });
  await guest2.evaluate(() => document.getElementById("btnOnlineRulesOk").click());
  await sleep(200);
  await guest2.evaluate(() => document.getElementById("btnJoinClose").click());
  await sleep(500);
  const out = await guest2.evaluate(() => ({
    menuUp: !document.getElementById("menu").classList.contains("hidden"),
    online: !!window.NET.online,
    overlays: [...document.querySelectorAll(".overlay:not(.hidden)")].map((o) => o.id),
  }));
  check(out.menuUp && !out.online, `B4 Cancel from a joined lobby lands on the menu and leaves the room (online=${out.online})`);
  check(out.overlays.length === 0, `B4b nothing is left floating (${out.overlays.join(",") || "none"})`);

  check(guest.__errors.length === 0 && guest2.__errors.length === 0,
    `B5 no page errors (${[...guest.__errors, ...guest2.__errors].join(" | ")})`);
  await ctxH.close(); await ctxG.close(); await ctxG2.close();
}

/* ===========================================================================================
 * PART C - item 2: a lobby you never played leaves nothing behind
 * =========================================================================================== */
async function partC(browser) {
  log("--- Part C: item 2 - an abandoned lobby leaves no record, a started game still does ---");
  const ctxH = await browser.newContext({ reducedMotion: "reduce" });
  const ctxG = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 390, height: 844 } });
  const host = await newPage(ctxH, PORT);
  const guest = await newPage(ctxG, PORT);
  const seatMeta = [
    { name: "Host", type: "human", diff: "medium" }, { name: "Blake", type: "human", diff: "medium" },
    { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
  ];
  const code = await hostRoom(host, seatMeta, 4);
  await host.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });

  // C1: the HOST opened a room and has not started it. No last-room record yet.
  const hostRec = await host.evaluate(() => localStorage.getItem("nasty-last-room"));
  check(hostRec === null, `C1 opening a room writes no saved-game record until it starts (got ${hostRec})`);

  // C2: a GUEST joins that lobby. Still nothing.
  await guest.evaluate((code) => window.handleIncomingJoinLink(`https://play.nastyboardgame.com/join/${code}`, false), code);
  await guest.waitForFunction(() => !document.getElementById("joinOverlay").classList.contains("hidden"), { timeout: 8000 });
  await guest.evaluate(() => { document.getElementById("joinNameInput").value = "Blake"; });
  await guest.evaluate(() => document.getElementById("btnJoinNameNext").click());
  await guest.waitForFunction(() => window.NET && window.NET.lobby != null, { timeout: 10000 });
  await guest.evaluate(() => document.getElementById("btnOnlineRulesOk").click());
  await sleep(300);
  const joinedRec = await guest.evaluate(() => localStorage.getItem("nasty-last-room"));
  check(joinedRec === null, `C2 joining a lobby writes no saved-game record either (got ${joinedRec})`);

  // C3: the guest walks away without the game ever starting, then relaunches. The menu must be
  // clean - no "Resume - online game" tile, so nothing to concede.
  await guest.evaluate(() => document.getElementById("btnJoinClose").click());
  await sleep(300);
  await guest.reload();
  await guest.waitForFunction(() => typeof window.NET === "object");
  await installTileReader(guest);
  await sleep(500);
  // Read the RENDERED tiles, not any script variable - what Blake sees is the whole point, and
  // the online tile is the one whose detail line says "online" (updateMenuResumeButtons).
  const menuState = await guest.evaluate(() => window.__v037Tiles());
  check(menuState.lastRoom === null, "C3 after abandoning the lobby there is still no record");
  check(menuState.online === -1, `C3b the menu offers no online saved game to concede (tiles: ${menuState.text || "none"})`);
  await guest.screenshot({ path: path.join(SHOTDIR, "C_clean_menu.png") });

  /* C4: and joining again works straight away - no concede, no block.
     Two shapes are both correct here and the app picks between them by itself: this device
     still holds a per-room rejoin session (that survives on purpose - it is what gets you back
     into your seat), so the link is taken as a REJOIN and lands straight in the lobby; without
     one it would show the code/name steps. Accept either, then assert what actually matters -
     no overwrite warning, no error, and a usable lobby at the end of it. */
  await guest.evaluate((code) => window.handleIncomingJoinLink(`https://play.nastyboardgame.com/join/${code}`, false), code);
  await guest.waitForFunction(() => (window.NET && window.NET.lobby != null)
    || !document.getElementById("joinNameStep").classList.contains("hidden"), { timeout: 12000 });
  const rejoinBlocked = await guest.evaluate(() => ({
    overwriteWarn: !document.getElementById("overwriteWarnOverlay").classList.contains("hidden"),
    err: document.getElementById("joinErr").textContent.trim(),
    straightToLobby: !!(window.NET && window.NET.lobby),
  }));
  check(!rejoinBlocked.overwriteWarn && !rejoinBlocked.err,
    `C4 a second join goes straight through - no warning, no error (warn=${rejoinBlocked.overwriteWarn}, err="${rejoinBlocked.err}", straight to lobby=${rejoinBlocked.straightToLobby})`);
  if (!rejoinBlocked.straightToLobby) {
    await guest.evaluate(() => { document.getElementById("joinNameInput").value = "Blake"; });
    await guest.evaluate(() => document.getElementById("btnJoinNameNext").click());
    await guest.waitForFunction(() => window.NET && window.NET.lobby != null, { timeout: 12000 });
  }
  await guest.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b && !b.closest(".overlay").classList.contains("hidden")) b.click(); });
  await sleep(400);
  const lobbyUsable = await guest.evaluate(() => ({
    lobbyVisible: !document.getElementById("joinOverlay").classList.contains("hidden"),
    seats: document.querySelectorAll("#joinSeatList .lobbySeat").length,
  }));
  check(lobbyUsable.lobbyVisible && lobbyUsable.seats >= 4,
    `C4b the lobby is on screen and usable on the second try, with no concede anywhere (${lobbyUsable.seats} seats)`);

  // C5: now actually START the game. The record must appear, marked started - this is the
  // behaviour reconnect depends on and it must not have been weakened.
  await guest.evaluate(() => {
    const openRow = [...document.querySelectorAll("#joinSeatList .lobbySeat")].find((r) => r.classList.contains("open"));
    if (openRow) openRow.click();
  });
  await sleep(400);
  await guest.evaluate(() => { const b = document.getElementById("btnJoinReady"); if (b && !b.classList.contains("hidden")) b.click(); });
  await sleep(600);
  await host.evaluate(() => document.getElementById("btnRoomStart").click());
  await guest.waitForFunction(() => window.G && !document.getElementById("game").classList.contains("hidden"), { timeout: 20000 });
  await sleep(600);
  const startedRec = await guest.evaluate(() => {
    const raw = localStorage.getItem("nasty-last-room");
    return { raw, parsed: raw ? JSON.parse(raw) : null, started: !!window.NET.started, session: !!localStorage.getItem("nasty-net-" + window.NET.code) };
  });
  check(startedRec.parsed && startedRec.parsed.code === code.toUpperCase() && startedRec.parsed.wasStarted === true,
    `C5 a genuinely STARTED game writes the record, marked started (${startedRec.raw})`);
  check(startedRec.started === true, "C5b NET.started flips true when the board comes up");
  check(startedRec.session === true, "C5c the per-room rejoin session is still stored (this is what a reconnect uses)");

  // C6: and the reconnect that record exists for still works - relaunch, tap the tile, land back
  // in the same game.
  await guest.reload();
  await guest.waitForFunction(() => typeof window.NET === "object");
  await installTileReader(guest);
  await sleep(600);
  const relaunched = await guest.evaluate(() => window.__v037Tiles());
  check(relaunched.online >= 0, `C6 the online saved-game tile is on the menu after a relaunch (tiles: ${relaunched.text || "none"})`);
  await guest.evaluate((i) => document.getElementById(["savedGameMain", "savedGameMain2", "savedGameMain3"][i]).click(), Math.max(0, relaunched.online));
  await guest.waitForFunction(() => window.G && window.NET.started, { timeout: 30000 }).catch(() => {});
  const backIn = await guest.evaluate(() => ({ started: !!window.NET.started, haveG: !!window.G, code: window.NET.code }));
  check(backIn.started && backIn.haveG && backIn.code === code.toUpperCase(),
    `C6b the reconnect lands back in the same running game (started=${backIn.started}, code=${backIn.code})`);

  check(guest.__errors.length === 0, `C7 no page errors (${guest.__errors.join(" | ")})`);
  await ctxH.close(); await ctxG.close();
}

/* ===========================================================================================
 * PART D - item 3: badge displacement cap, 4P and 6P, no server needed
 * =========================================================================================== */
// Board-space cap, mirrored from buildBubblePlan()'s MAX_BADGE_SHIFT = 3 x holeR.
const CAP = { 4: 3 * 13, 6: 3 * 10.5 };

async function freshBoard(page, n) {
  /* Clean slate every time. This helper is reused on the SAME page, and a previous board left
     two footprints that would otherwise derail the next one: an offline save in a slot, and the
     "held" pending start the app writes when the one-time speed picker has not been answered
     (which makes the very next load skip the menu entirely and re-enter that game - #btnStart
     is then genuinely not on screen). Both are cleared, and the speed question is marked
     answered, so every measurement below starts from the same, boring, returning-player state. */
  await page.goto(`file://${INDEX}`);
  await page.evaluate(() => {
    try {
      localStorage.setItem("nasty-speed-chosen", "1");
      localStorage.removeItem("nasty-pending-offline-start");
      localStorage.removeItem("nasty-save-offline-1");
      localStorage.removeItem("nasty-save-offline-2");
      localStorage.removeItem("nasty-last-room");
    } catch (e) {}
  });
  await page.goto(`file://${INDEX}`);
  await page.waitForSelector("#btnStart");
  if (n === 6) await page.click("#p6");
  await page.click("#btnStart");
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 25000 });
  await page.evaluate(() => { const sp = document.getElementById("speedPickerOverlay"); if (sp) sp.classList.add("hidden"); });
  await sleep(120);
}

// Measure one board state: put `pieces` (list of {s,pi,steps}) on the track, show their badges,
// and read back every badge's own displacement, size, and pairwise gaps.
async function measure(page, pieces) {
  return page.evaluate((pieces) => {
    pieces.forEach((p) => { window.G.pieces[p.s][p.pi] = { state: "track", steps: p.steps }; });
    window.showBubbles(pieces.map((p) => ({ s: p.s, pi: p.pi })), "");
    const els = [...document.querySelectorAll("#bubbleLayer .teeBubble")];
    const boardScale = (() => { const bs = document.getElementById("boardScale"); const w = bs.getBoundingClientRect().width; return w > 0 ? w / 1000 : 1; })();
    // Older builds (before v0.37) do not tag a badge with the peg it belongs to, so there is
    // nothing to measure against - report that plainly instead of throwing.
    if (els.some((e) => e.dataset.s == null)) return { unmeasurable: true, count: els.length };
    const per = els.map((e) => {
      const s = +e.dataset.s, pi = +e.dataset.pi;
      const r = e.getBoundingClientRect();
      const peg = window.teePos(s, pi);
      // Rendered (screen) centre of the peg, so the "is this badge near its peg" number can also
      // be reported in the units a thumb actually experiences.
      const layer = document.getElementById("bubbleLayer").getBoundingClientRect();
      return {
        s, pi,
        shift: parseFloat(e.dataset.shift || "0"),          // board px, the enforced quantity
        side: e.classList.contains("sideL") ? "L" : e.classList.contains("sideR") ? "R" : "",
        w: r.width, h: r.height,
        cx: r.left + r.width / 2, cy: r.top + r.height / 2,
        pegX: layer.left + peg.x * boardScale, pegY: layer.top + peg.y * boardScale,
      };
    });
    let minGap = Infinity, overlaps = 0;
    for (let i = 0; i < per.length; i++) for (let j = i + 1; j < per.length; j++) {
      const a = per[i], b = per[j];
      const d = Math.hypot(a.cx - b.cx, a.cy - b.cy) - (a.w + b.w) / 2;
      minGap = Math.min(minGap, d);
      if (d < -2) overlaps++;
    }
    const bubD = els.length ? parseFloat(getComputedStyle(els[0]).getPropertyValue("--bubD")) : 0;
    return { per, minGap: per.length > 1 ? minGap : null, overlaps, boardScale, count: els.length, bubD };
  }, pieces);
}

async function partD(browser) {
  log("--- Part D: item 3 - selection badges stay near their peg, 4P and 6P ---");
  // 320x568 is the smallest phone in the matrix and therefore the most crowded board in board
  // space (the smaller the screen, the bigger a 46px badge is relative to the board).
  for (const vp of [{ w: 320, h: 568 }, { w: 390, h: 844 }]) {
    for (const n of [4, 6]) {
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      page.on("pageerror", (e) => log("[pageerror]", String(e)));
      await freshBoard(page, n);
      const cap = CAP[n];

      // D-a: the everyday crowded case Blake described - several of one seat's pegs bunched up
      // on consecutive track holes, all pickable at once.
      const runs = [
        { label: "two adjacent holes", pieces: [{ s: 0, pi: 0, steps: 5 }, { s: 0, pi: 1, steps: 6 }] },
        { label: "three adjacent holes", pieces: [{ s: 0, pi: 0, steps: 5 }, { s: 0, pi: 1, steps: 6 }, { s: 0, pi: 2, steps: 7 }] },
        { label: "four adjacent holes", pieces: [{ s: 0, pi: 0, steps: 4 }, { s: 0, pi: 1, steps: 5 }, { s: 0, pi: 2, steps: 6 }, { s: 0, pi: 3, steps: 7 }] },
        { label: "around a corner", pieces: [{ s: 0, pi: 0, steps: 9 }, { s: 0, pi: 1, steps: 10 }, { s: 0, pi: 2, steps: 11 }] },
        { label: "spread across the board", pieces: [{ s: 0, pi: 0, steps: 2 }, { s: 0, pi: 1, steps: 14 }, { s: 0, pi: 2, steps: 26 }, { s: 0, pi: 3, steps: 38 }] },
      ];
      for (const r of runs) {
        const m = await measure(page, r.pieces);
        if (m.unmeasurable) {
          check(false, `D ${vp.w}x${vp.h} ${n}P "${r.label}": badges carry no peg tag - this build predates the v0.37 displacement cap, nothing to measure`);
          continue;
        }
        const maxShift = Math.max(...m.per.map((p) => p.shift));
        const worst = m.per.reduce((a, p) => (p.shift > a.shift ? p : a), m.per[0]);
        const screenShift = maxShift * m.boardScale;
        check(m.count === r.pieces.length, `D ${vp.w}x${vp.h} ${n}P "${r.label}": every badge rendered (${m.count}/${r.pieces.length})`);
        check(maxShift <= cap + 0.01,
          `D ${vp.w}x${vp.h} ${n}P "${r.label}": biggest badge shift ${maxShift.toFixed(1)} board px, cap ${cap} (${screenShift.toFixed(1)} rendered px; worst = seat ${worst.s} peg ${worst.pi}${worst.side ? " side" + worst.side : ""})`);
        /* Size + separation. showBubbles() negotiates the badge size: it tries the comfortable
           46px-rendered size first and, only if the plan STILL has a real overlap, shrinks and
           retries, down to a hard floor of the historical 84 board-px size (the size that
           shipped before 2026-07-25). So there are two honest outcomes and this asserts the
           right one for each:
             - it found room at a comfortable size  -> zero overlap AND 44px+ badges, no excuses.
             - it fell back to the floor            -> the board is genuinely impossible (several
               of one seat's pegs on consecutive holes, all legal for the same card). Assert it
               is never SMALLER than the historical size, which is the pre-existing contract
               (test_ui_polish_2026_07_25.js part D3) and is unchanged by v0.37. Measured on the
               same fixtures before this session, for the record: 4P "around a corner" was
               already 23.5px with -3.5px of overlap at 320x568, and 6P "four adjacent" was
               already 22.6px with -4.7px. v0.37 leaves those sizes the same and makes the
               overlap smaller, while cutting the distance-from-peg from 129-217 board px to
               inside the cap. */
        const smallest = Math.min(...m.per.map((p) => Math.min(p.w, p.h)));
        const fellBack = m.bubD <= 84.5;
        if (!fellBack) {
          check(m.overlaps === 0,
            `D ${vp.w}x${vp.h} ${n}P "${r.label}": no badge sits on another badge (closest gap ${m.minGap === null ? "n/a" : m.minGap.toFixed(1) + "px"})`);
          check(smallest >= 44,
            `D ${vp.w}x${vp.h} ${n}P "${r.label}": smallest badge is ${smallest.toFixed(1)}px - at or above the 44px tap floor`);
        } else {
          check(m.bubD >= 84 - 0.5,
            `D ${vp.w}x${vp.h} ${n}P "${r.label}": genuinely impossible board - falls back to the historical 84 board-px size and never below (--bubD ${m.bubD.toFixed(1)}, ${smallest.toFixed(1)} rendered px, closest gap ${m.minGap.toFixed(1)}px) - same as before v0.37`);
        }
      }

      // D-b: a badge must NOT move just because ordinary board art or a peg that is not part of
      // this decision happens to be underneath it. That is the v0.23 behaviour Blake reversed.
      const lone = await page.evaluate(() => {
        window.G.pieces[0][0] = { state: "track", steps: 5 };
        window.showBubbles([{ s: 0, pi: 0 }], "");
        const a = document.querySelector("#bubbleLayer .teeBubble");
        const solo = { top: parseFloat(a.style.top), left: parseFloat(a.style.left), shift: parseFloat(a.dataset.shift) };
        // Crowd the board around it with OTHER seats' pegs - none of them pickable.
        for (let s = 1; s < window.G.n; s++) for (let pi = 0; pi < 5; pi++)
          window.G.pieces[s][pi] = { state: "track", steps: (4 + pi) % 12 + s * 12 };
        window.showBubbles([{ s: 0, pi: 0 }], "");
        const b = document.querySelector("#bubbleLayer .teeBubble");
        const crowded = { top: parseFloat(b.style.top), left: parseFloat(b.style.left), shift: parseFloat(b.dataset.shift) };
        return { solo, crowded };
      });
      check(lone.solo.top === lone.crowded.top && lone.solo.left === lone.crowded.left && lone.crowded.shift === 0,
        `D ${vp.w}x${vp.h} ${n}P: a lone badge does NOT move for other pegs or board art (${lone.solo.left},${lone.solo.top} -> ${lone.crowded.left},${lone.crowded.top})`);

      // D-c: the side variants are still what a crowded pair uses - Blake explicitly kept them.
      await freshBoard(page, n);
      const sides = await page.evaluate(() => {
        window.G.pieces[0][0] = { state: "track", steps: 5 };
        window.G.pieces[0][1] = { state: "track", steps: 6 };
        window.showBubbles([{ s: 0, pi: 0 }, { s: 0, pi: 1 }], "");
        return [...document.querySelectorAll("#bubbleLayer .teeBubble")]
          .filter((e) => e.classList.contains("sideL") || e.classList.contains("sideR")).length;
      });
      check(sides >= 1, `D ${vp.w}x${vp.h} ${n}P: a crowded pair still uses the sideways badge that points at its peg (${sides} of 2)`);

      if (vp.w === 320) {
        await page.evaluate(() => {
          window.G.pieces[0][0] = { state: "track", steps: 5 };
          window.G.pieces[0][1] = { state: "track", steps: 6 };
          window.G.pieces[0][2] = { state: "track", steps: 7 };
          window.showBubbles([{ s: 0, pi: 0 }, { s: 0, pi: 1 }, { s: 0, pi: 2 }], "");
        });
        await page.screenshot({ path: path.join(SHOTDIR, `D_badges_320_${n}p.png`) });
      }
      await ctx.close();
    }
  }

  // D-d: the STABLE (base) formation Blake asked for earlier is untouched by all of this.
  for (const n of [4, 6]) {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 568 }, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await freshBoard(page, n);
    const st = await page.evaluate(() => {
      window.showBubbles([0, 1, 2, 3, 4].map((pi) => ({ s: 0, pi })), "");
      const els = [...document.querySelectorAll("#bubbleLayer .teeBubble")];
      const xs = els.map((e) => parseFloat(e.style.left));
      const bc = window.LAY.base[0][0];
      return { count: els.length, cols: [...new Set(xs.map((x) => Math.round(x)))].length, symmetric: Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - bc.x) < 2 };
    });
    check(st.count === 5, `D-stable ${n}P: all five stable badges still render`);
    check(st.symmetric, `D-stable ${n}P: the stable formation is still symmetrical about the stable centre`);
    await ctx.close();
  }
}

/* ------------------------------------ main ------------------------------------ */
async function main() {
  log(`index under test: ${INDEX}`);
  const child = startServer(PORT);
  const child2 = startServer(PORT2);
  await Promise.all([waitHealthy(PORT), waitHealthy(PORT2)]);
  const browser = await chromium.launch();
  const only = process.env.NASTY_V037_ONLY;
  try {
    if (!only || only.includes("A")) await partA(browser);
    if (!only || only.includes("B")) await partB(browser);
    if (!only || only.includes("C")) await partC(browser);
    if (!only || only.includes("D")) await partD(browser);
  } finally {
    await browser.close();
    child.kill(); child2.kill();
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
  }
  log(`RESULT ${PASS} passed, ${FAIL} failed`);
  log(`screenshots: ${SHOTDIR}`);
  process.exit(FAIL ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
