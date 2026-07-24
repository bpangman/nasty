"use strict";
/*
 * Blake's item 14 ("2026-07-23 list", implemented 2026-07-24): "can you set it up so I can
 * choose to play a team game online as well?"
 *
 * Investigation finding (see HANDOFF.md for the full writeup): `teams` already rode the `host`
 * message and `room.lobby.teams` before this session touched anything - the server already
 * paired seats via the same partnerOf()/sameTeam() § ENGINE code the offline path uses. The gap
 * was entirely client-side: CFG.n/CFG.teams (the SAME values the offline setup panel sets) fed
 * hostCreateRoom() with zero visibility or deliberate control at the moment of actually hosting,
 * and neither the host's room screen nor the guest's join-seat screen ever displayed team
 * pairings even though NET.lobby.teams/n/seats already carried everything needed to show them.
 *
 * This suite proves the FIX end to end through the REAL UI (not mocked): the host can
 * deliberately choose Teams (4P and 6P) from the hostSpeedOverlay screen with a live pairing
 * preview before the room even exists; the created room + both the host's room screen and the
 * guest's join-seat screen correctly show the mode and partner pairings using real chosen
 * names; the game actually starts in team mode with the correct pairing; a default/untouched
 * host flow still produces an ordinary FFA room (no regression); and a reunion opened mid-game
 * shows the team pairing note without disturbing anything.
 *
 * Usage: node test_online_teams.js node     (server/server.js)
 *        node test_online_teams.js deno     (server/cloud/server.ts)
 *
 * Never touches prod - a single private server instance, random port, scratch
 * NASTY_ROOMS_DIR/NASTY_KV_PATH, throwaway admin token - same discipline as every other suite.
 */
const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const KIND = process.argv[2] || "node";
const USE_DENO = KIND === "deno";
const PORT = 24100 + Math.floor(Math.random() * 400);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-onlineteams-${KIND}-`));

function log(...a) { console.log("[onlineteams]", new Date().toISOString(), ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port) {
  if (USE_DENO) {
    return spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
      cwd: "/Users/jarvis/nasty-game/server/cloud",
      env: Object.assign({}, process.env, { NASTY_PORT: String(port), NASTY_KV_PATH: path.join(SCRATCH, "onlineteams.kv"), NASTY_ADMIN_TOKEN: "onlineteams-admin-token" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return spawn(process.execPath, ["server.js"], {
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
  await page.evaluate(() => { try { localStorage.setItem("nasty-speed-chosen", "1"); } catch (e) {} });
  return page;
}

// Real click path: Online play -> Host a game -> hostSpeedOverlay appears. Does NOT touch
// CFG.n/CFG.teams directly except to seed CFG.seatMeta[n] with real names first - choosing the
// player count/game type happens via REAL button clicks (pickHostMode below), since that IS the
// behavior under test.
async function openHostSetup(page, seatMetaByN) {
  await page.evaluate((seatMetaByN) => {
    Object.keys(seatMetaByN).forEach((n) => { CFG.seatMeta[n] = seatMetaByN[n]; });
  }, seatMetaByN);
  await page.evaluate(() => document.getElementById("btnOnline").click());
  await page.evaluate(() => document.getElementById("btnHostGame").click());
  await page.waitForFunction(() => !document.getElementById("hostSpeedOverlay").classList.contains("hidden"), { timeout: 5000 });
}
async function pickHostMode(page, n, teams) {
  await page.evaluate((n) => document.getElementById(n === 6 ? "hostP6" : "hostP4").click(), n);
  await page.evaluate((teams) => document.getElementById(teams ? "hostTeams" : "hostFFA").click(), teams);
}
async function readHostSetupUi(page) {
  return page.evaluate(() => ({
    p4On: document.getElementById("hostP4").classList.contains("on"),
    p6On: document.getElementById("hostP6").classList.contains("on"),
    ffaOn: document.getElementById("hostFFA").classList.contains("on"),
    teamsOn: document.getElementById("hostTeams").classList.contains("on"),
    teamNote: document.getElementById("hostTeamNote").textContent,
  }));
}
// Picks a real speed button (by visible label substring) - this is the same tap that actually
// fires hostCreateRoom() (see openHostSpeedOverlay(), index.html) - rejects cleanly on a
// server-side "error" reply (e.g. the host-create rate limit) instead of hanging forever.
async function pickSpeedAndAwaitCreated(page, speedSubstr) {
  return page.evaluate((speedSubstr) => new Promise((resolve, reject) => {
    const orig = window.handleNetMessage;
    window.handleNetMessage = function (m) {
      orig(m);
      if (m.type === "created") { window.handleNetMessage = orig; resolve(m.code); }
      else if (m.type === "error") { window.handleNetMessage = orig; reject(new Error("host create failed: " + m.message)); }
    };
    const btns = [...document.querySelectorAll("#hostSpeedBtns button")];
    const btn = btns.find((b) => b.textContent.startsWith(speedSubstr));
    if (!btn) { reject(new Error(`"${speedSubstr}" speed button not found`)); return; }
    btn.click();
  }), speedSubstr);
}
async function dismissOnlineRules(page) {
  await page.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
}
async function joinAsGuest(page, code, name) {
  await page.evaluate(() => document.getElementById("btnOnline").click());
  await page.evaluate(() => document.getElementById("btnJoinGame").click());
  await page.evaluate((code) => { document.getElementById("joinCodeInput").value = code; }, code);
  await page.evaluate(() => document.getElementById("btnJoinCodeNext").click());
  await page.evaluate((name) => { document.getElementById("joinNameInput").value = name; }, name);
  await page.evaluate(() => document.getElementById("btnJoinNameNext").click());
  await page.waitForFunction(() => window.NET && window.NET.lobby != null, { timeout: 8000 });
}
async function readJoinSeatUi(page) {
  return page.evaluate(() => ({
    modeNote: document.getElementById("joinModeNote").textContent,
    teamNote: document.getElementById("joinTeamNote").textContent,
  }));
}
async function readRoomUi(page) {
  return page.evaluate(() => ({
    modeNote: document.getElementById("roomModeNote").textContent,
    teamNote: document.getElementById("roomTeamNote").textContent,
  }));
}

async function main() {
  const child = startServer(PORT);
  child.stderr.on("data", (d) => { const s = String(d); if (!s.includes("Listening")) process.stderr.write("[server-err] " + s); });
  await waitHealthy(PORT);
  const browser = await chromium.launch();

  /* ===================================================================================
   * Scenario A - 4P Teams, host + guest, fully through the real UI: toggle it on, see the
   * live pairing preview, host and guest both see the mode/pairing on their own lobby screens,
   * game starts in team mode with the correct pairing.
   * =================================================================================== */
  log("--- Scenario A: 4P Teams, host deliberately chooses it, real UI end to end ---");
  {
    const ctxH = await browser.newContext({ reducedMotion: "reduce" });
    const ctxG = await browser.newContext({ reducedMotion: "reduce" });
    const host = await newPage(ctxH, PORT);
    const guest = await newPage(ctxG, PORT);

    const seatMeta4 = [
      { name: "Ann", type: "human", diff: "medium" }, { name: "Bo", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
    ];
    await openHostSetup(host, { 4: seatMeta4 });

    // Default state on a fresh page load is 4 players / Everyone for themselves (v0.9 item 5's
    // "never inherit stale state" rule) - confirmed here since this screen must never show a
    // stale/wrong selection before the host has touched anything.
    let ui = await readHostSetupUi(host);
    check(ui.p4On && ui.ffaOn && !ui.p6On && !ui.teamsOn, `A: hostSpeedOverlay opens reflecting the real default (4 players, FFA) - got ${JSON.stringify(ui)}`);
    check(ui.teamNote === "", "A: no pairing preview shown while FFA is selected");

    await pickHostMode(host, 4, true);
    ui = await readHostSetupUi(host);
    check(ui.teamsOn && !ui.ffaOn && ui.p4On, `A: tapping Teams activates it (and stays at 4 players) - got ${JSON.stringify(ui)}`);
    check(ui.teamNote === "Partners sit across: Ann + C1  ·  Bo + C2",
      `A: live pairing preview shows the REAL seat names, correct pairing (seat i with seat i+2) - got "${ui.teamNote}"`);

    const code = await pickSpeedAndAwaitCreated(host, "Fast");
    await dismissOnlineRules(host);
    const hostLobbyTeams = await host.evaluate(() => window.NET.lobby.teams);
    check(hostLobbyTeams === true, "A: the created room's lobby.teams is true - the host message really carried the deliberate choice");

    let roomUi = await readRoomUi(host);
    check(roomUi.modeNote === "4 players · Teams", `A: host's room screen shows the plain-language mode line - got "${roomUi.modeNote}"`);
    check(roomUi.teamNote === "Partners sit across: Ann + C1  ·  Bo + C2", `A: host's room screen shows the real partner pairing - got "${roomUi.teamNote}"`);

    await joinAsGuest(guest, code, "Bo");
    let joinUi = await readJoinSeatUi(guest);
    check(joinUi.modeNote === "4 players · Teams", `A: guest's join-seat screen ALSO shows the mode before even claiming a seat - got "${joinUi.modeNote}"`);
    check(joinUi.teamNote === "Partners sit across: Ann + C1  ·  Bo + C2", `A: guest sees the same real pairing text - got "${joinUi.teamNote}"`);
    await dismissOnlineRules(guest);

    const claimed = await guest.evaluate(() => {
      const rows = [...document.querySelectorAll("#joinSeatList .lobbySeat")];
      const row = rows.find((r) => r.textContent.includes("Bo") && r.classList.contains("open"));
      if (!row) return false;
      row.click();
      return true;
    });
    check(claimed, "A: guest claimed the Bo seat via a real row click");
    await guest.waitForFunction(() => { const b = document.getElementById("btnJoinReady"); return b && !b.classList.contains("hidden"); }, { timeout: 5000 });
    await guest.evaluate(() => document.getElementById("btnJoinReady").click());
    await host.waitForFunction(() => !document.getElementById("btnRoomStart").disabled, { timeout: 5000 });

    roomUi = await readRoomUi(host);
    check(roomUi.teamNote === "Partners sit across: Ann + C1  ·  Bo + C2", "A: room screen's pairing note still correct once the guest has claimed/readied");

    await host.evaluate(() => document.getElementById("btnRoomStart").click());
    await Promise.all([host, guest].map((p) => p.waitForFunction(() => window.G != null, { timeout: 10000 })));

    const hostG = await host.evaluate(() => ({ n: window.G.n, teams: window.G.teams, p0: partnerOf(0), p1: partnerOf(1) }));
    const guestG = await guest.evaluate(() => ({ n: window.G.n, teams: window.G.teams, p0: partnerOf(0), p1: partnerOf(1) }));
    check(hostG.n === 4 && hostG.teams === true && hostG.p0 === 2 && hostG.p1 === 3, `A: the dealt game is genuinely in team mode with the correct pairing on the HOST - got ${JSON.stringify(hostG)}`);
    check(guestG.n === 4 && guestG.teams === true && guestG.p0 === 2 && guestG.p1 === 3, `A: ...and identically on the GUEST (deterministic lockstep) - got ${JSON.stringify(guestG)}`);
    check((host.__errors || []).length === 0 && (guest.__errors || []).length === 0, "A: zero page errors through the whole real-UI teams flow");

    /* =================================================================================
     * Scenario D (piggybacked on A's already-running teams game) - opening a reunion mid-game
     * shows the team pairing note, and the game is still correctly in team mode afterward. The
     * underlying reunion MECHANICS (gate opens, resumes once everyone readies, survives a
     * server restart) are already proven mode-agnostically by test_reunion_readyup.js - this
     * only adds the team-aware DISPLAY on top, in a genuinely-live teams game.
     * =============================================================================== */
    log("--- Scenario D: reunion mid-teams-game shows the pairing note ---");
    await guest.evaluate(() => { window.NET.reunionOpen = false; window.netSend({ type: "requestReunion" }); });
    await guest.waitForFunction(() => !document.getElementById("reunionOverlay").classList.contains("hidden"), { timeout: 5000 });
    const reunionNote = await guest.evaluate(() => document.getElementById("reunionTeamNote").textContent);
    check(reunionNote === "Playing as teams - partners: Ann + C1  ·  Bo + C2", `D: reunion overlay shows the team pairing note mid-game - got "${reunionNote}"`);
    const stillTeams = await guest.evaluate(() => window.G.teams === true && window.G.n === 4);
    check(stillTeams, "D: G.teams/n are untouched by opening a reunion mid-game");
    // Ready up (both, since requestReunion pauses/opens the gate for everyone connected too)
    // to leave the table in a clean, resumed state rather than stuck paused.
    await guest.evaluate(() => document.getElementById("btnReunionResume").click());
    await host.waitForFunction(() => !document.getElementById("reunionOverlay").classList.contains("hidden"), { timeout: 5000 }).catch(() => {});
    const hostReunionVisible = await host.evaluate(() => !document.getElementById("reunionOverlay").classList.contains("hidden"));
    if (hostReunionVisible) await host.evaluate(() => document.getElementById("btnReunionResume").click());

    await ctxH.close(); await ctxG.close();
  }

  /* ===================================================================================
   * Scenario B - regression: an UNTOUCHED host flow (nobody taps Teams) still produces a plain
   * FFA room, exactly as before this session.
   * =================================================================================== */
  log("--- Scenario B: default/untouched host flow is still FFA (no regression) ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await newPage(ctx, PORT);
    const seatMeta4 = [
      { name: "Solo", type: "human", diff: "medium" }, { name: "C1", type: "cpu", diff: "easy" },
      { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    await openHostSetup(page, { 4: seatMeta4 });
    const ui = await readHostSetupUi(page);
    check(!ui.teamsOn && ui.ffaOn, "B: opening the screen without touching anything still shows FFA selected");
    await pickSpeedAndAwaitCreated(page, "Normal");
    await dismissOnlineRules(page);
    const lobbyTeams = await page.evaluate(() => window.NET.lobby.teams);
    check(lobbyTeams === false, "B: an untouched host flow still creates a plain FFA room - no regression");
    check((page.__errors || []).length === 0, "B: zero page errors");
    await ctx.close();
  }

  /* ===================================================================================
   * Scenario C - 6P Teams: the SAME mechanism extends to 6 players (3 pairs), not hardcoded to
   * 4-player 2v2 only. Host-only (5 CPUs) - just proving setup/pairing/deal, not a full game.
   * =================================================================================== */
  log("--- Scenario C: 6P Teams (3 partner pairs) ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await newPage(ctx, PORT);
    const seatMeta6 = [
      { name: "Uno", type: "human", diff: "medium" }, { name: "Cpu1", type: "cpu", diff: "easy" },
      { name: "Cpu2", type: "cpu", diff: "easy" }, { name: "Cpu3", type: "cpu", diff: "easy" },
      { name: "Cpu4", type: "cpu", diff: "easy" }, { name: "Cpu5", type: "cpu", diff: "easy" },
    ];
    await openHostSetup(page, { 6: seatMeta6 });
    await pickHostMode(page, 6, true);
    const ui = await readHostSetupUi(page);
    check(ui.p6On && ui.teamsOn, `C: 6 players + Teams both selectable together - got ${JSON.stringify(ui)}`);
    check(ui.teamNote === "Partners sit across: Uno + Cpu3  ·  Cpu1 + Cpu4  ·  Cpu2 + Cpu5",
      `C: 6P pairing preview shows all THREE pairs (seat i with seat i+3) - got "${ui.teamNote}"`);
    await pickSpeedAndAwaitCreated(page, "Normal");
    await dismissOnlineRules(page);
    // Solo-host start: no guests to ready up, Start should already be enabled.
    await page.waitForFunction(() => !document.getElementById("btnRoomStart").disabled, { timeout: 5000 });
    await page.evaluate(() => document.getElementById("btnRoomStart").click());
    await page.waitForFunction(() => window.G != null, { timeout: 10000 });
    const g = await page.evaluate(() => ({ n: window.G.n, teams: window.G.teams, p0: partnerOf(0), p1: partnerOf(1), p2: partnerOf(2) }));
    check(g.n === 6 && g.teams === true && g.p0 === 3 && g.p1 === 4 && g.p2 === 5, `C: 6P online game genuinely deals in team mode with the correct 3-pair layout - got ${JSON.stringify(g)}`);
    check((page.__errors || []).length === 0, "C: zero page errors");
    await ctx.close();
  }

  await browser.close();
  child.kill("SIGTERM");
  await sleep(400);
  log(`\n${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

const WATCHDOG_MS = 150000;
const watchdog = setTimeout(() => {
  console.error(`[onlineteams] WATCHDOG: suite did not finish within ${WATCHDOG_MS}ms - forcing exit`);
  process.exit(1);
}, WATCHDOG_MS);
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => clearTimeout(watchdog));
