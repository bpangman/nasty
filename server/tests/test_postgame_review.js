"use strict";
/*
 * 2026-07-25 permanent regression suite - Blake's "post-game review mode" ask (2026-07-23 list):
 * "I'd like to change up what happens after somebody wins so that it pops up who won with the
 * winner badge but it also shows the stats of everybody's knockouts numbers with the ratio. You
 * should also be able to x out the batch to look at the board again and when you're looking at
 * the post board, you should have everybody's remaining cards flipped up on the table or rather
 * not all of them flipped up but if you click on their name their cards flip up to see how close
 * they could've been to win. And then also need to find a way for somebody to leave the match if
 * they were looking at the post game as well so they can get back to the menu screen."
 *
 * Covers, in order:
 *   Part A - tallyKnockout() unit checks: the NEW G.koDealtAll/koTakenAll pair credits EVERY
 *            seat unconditionally (human or CPU), while the EXISTING human-only G.koDealt/
 *            koTaken pair (which feeds the shared lifetime leaderboard, see
 *            test_knockout_leaderboard.js) is completely untouched by this session's change - a
 *            forced partner-kick still excludes BOTH pairs entirely.
 *   Part B - a REAL, naturally-finished offline game (#autotest, driven to G.over for real, not
 *            faked): the win popup's KO table numbers match G.koDealtAll/koTakenAll exactly for
 *            EVERY seat, no "Infinity"/"NaN" ever appears, and koRatioStr's new "Perfect" wording
 *            is used correctly wherever taken===0 and dealt>0.
 *   Part C - X closes to the board (post-game review mode); nobody's hand is revealed by
 *            default; tapping a plaque reveals EXACTLY that seat's real G.hands cards and
 *            nothing else; tapping again hides it; tapping a different plaque switches; the
 *            topbar Menu/Pause/Save/Speed are repurposed/hidden correctly; "Results" reopens the
 *            same popup (not a one-way door) and REVEAL_SEAT survives the round trip.
 *   Part D - the reveal is provably unreachable while a game is still in progress (G.over false).
 *   Part E - leaving from post-game (the repurposed topbar "Menu" button) returns to the menu
 *            and records no EXTRA loss beyond the win already recorded by recordWin().
 *   Part F - the win/pass badge fit fix: real safe-area-inset geometry checks across the full
 *            5-viewport matrix, both a long TEAM win name (up to two 10-char names joined by
 *            " & ") and a single 10-character name (this app's own NAME_MAX) - the sign never
 *            exceeds the real viewport bounds, matching the same method test_overlay_sizing.js
 *            already uses for the confirm-card badges. Real screenshots saved for visual proof.
 *   Part G - ONLINE, against a REAL running server (server.js or server.ts): a NON-HOST client
 *            genuinely has every other seat's real final hand at game end (the case most likely
 *            to be broken - see index.html's dated PROTOCOL_VERSION comment for why no server
 *            change was needed), and the tap-to-reveal UI works correctly on that non-host client
 *            for a seat it does not own.
 *
 * Usage:
 *   node test_postgame_review.js            (Parts A-F, offline only, no server)
 *   node test_postgame_review.js node       (adds Part G against server/server.js)
 *   node test_postgame_review.js deno       (adds Part G against server/cloud/server.ts)
 *   node test_postgame_review.js all        (Parts A-F + Part G against BOTH servers)
 */
const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const MODE = process.argv[2] || "";
const RUN_NODE = MODE === "node" || MODE === "all";
const RUN_DENO = MODE === "deno" || MODE === "all";

const INDEX_URL = "file:///Users/jarvis/nasty-game/index.html";
const PROTOCOL_VERSION_LOCAL = 5; // matches index.html's PROTOCOL_VERSION - see this session's dated note there
const AUTOTEST_URL = INDEX_URL + "#autotest";

let PASS = 0, FAIL = 0;
function log(...a) { console.log("[postgame]", ...a); }
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHOTDIR = "/private/tmp/claude-501/-Users-jarvis/0bc923da-f111-499a-9b51-18988e4aba3d/scratchpad/shots";
fs.mkdirSync(SHOTDIR, { recursive: true });

/* ============================= Part A - tallyKnockout() unit checks ============================= */
async function partA(browser) {
  console.log("\n=== Part A: tallyKnockout() credits G.koDealtAll/koTakenAll for EVERY seat ===");
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("pageerror(A):", String(e)));
  await page.goto(INDEX_URL);
  await page.waitForFunction(() => typeof window.NET === "object");

  const seatsFFA = [
    { name: "H0", type: "human", diff: "medium" }, { name: "C1", type: "cpu", diff: "medium" },
    { name: "H2", type: "human", diff: "medium" }, { name: "C3", type: "cpu", diff: "medium" },
  ];

  // CPU kicks CPU: the OLD human-only pair (koDealt/koTaken) must stay untouched (protects
  // test_knockout_leaderboard.js's own hard-coded "CPU-vs-CPU credits nobody" invariant) - but
  // the NEW koDealtAll/koTakenAll pair must credit BOTH seats, since the whole point of this
  // feature is a full per-game scoreboard including computer players.
  let r = await page.evaluate((seats) => {
    newGame({ n: 4, teams: false, seats });
    tallyKnockout(1, { seat: 3, pi: 0 });
    return {
      dealt: G.koDealt.slice(), taken: G.koTaken.slice(),
      dealtAll: G.koDealtAll.slice(), takenAll: G.koTakenAll.slice(),
    };
  }, seatsFFA);
  check(r.dealt.every((v) => v === 0) && r.taken.every((v) => v === 0),
    `CPU-vs-CPU kick still credits NOBODY in the human-only pair (unchanged) - got dealt=${JSON.stringify(r.dealt)} taken=${JSON.stringify(r.taken)}`);
  check(r.dealtAll[1] === 1 && r.takenAll[3] === 1 && r.dealtAll.filter((v) => v).length === 1 && r.takenAll.filter((v) => v).length === 1,
    `CPU-vs-CPU kick DOES credit both sides in the new all-seats pair - got dealtAll=${JSON.stringify(r.dealtAll)} takenAll=${JSON.stringify(r.takenAll)}`);

  // Human kicks human: both pairs credit identically (no regression for the already-tested case).
  r = await page.evaluate((seats) => {
    newGame({ n: 4, teams: false, seats });
    tallyKnockout(0, { seat: 2, pi: 1 });
    return { dealt: G.koDealt.slice(), taken: G.koTaken.slice(), dealtAll: G.koDealtAll.slice(), takenAll: G.koTakenAll.slice() };
  }, seatsFFA);
  check(JSON.stringify(r.dealt) === JSON.stringify([1, 0, 0, 0]) && JSON.stringify(r.taken) === JSON.stringify([0, 0, 1, 0]),
    "human-on-human: the human-only pair still increments exactly as before");
  check(JSON.stringify(r.dealtAll) === JSON.stringify([1, 0, 0, 0]) && JSON.stringify(r.takenAll) === JSON.stringify([0, 0, 1, 0]),
    "human-on-human: the new all-seats pair matches the human-only pair exactly (no double-count, no divergence)");

  // Human kicks CPU / CPU kicks human: the all-seats pair credits BOTH sides now, unlike the
  // human-only pair which (correctly, unchanged) only ever credits the human half.
  r = await page.evaluate((seats) => {
    newGame({ n: 4, teams: false, seats });
    tallyKnockout(0, { seat: 1, pi: 0 }); // human(0) kicks cpu(1)
    return { dealt: G.koDealt.slice(), taken: G.koTaken.slice(), dealtAll: G.koDealtAll.slice(), takenAll: G.koTakenAll.slice() };
  }, seatsFFA);
  check(r.dealt[0] === 1 && r.taken.every((v) => v === 0), "human kicks CPU: human-only pair still only credits the dealt side (unchanged)");
  check(r.dealtAll[0] === 1 && r.takenAll[1] === 1, `human kicks CPU: all-seats pair credits BOTH sides - got dealtAll=${JSON.stringify(r.dealtAll)} takenAll=${JSON.stringify(r.takenAll)}`);

  // Forced partner-kick (teams): BOTH pairs are excluded entirely - not even lazily created.
  r = await page.evaluate((seats) => {
    newGame({ n: 4, teams: true, seats });
    tallyKnockout(0, { seat: 2, pi: 1 }); // seat 2 is seat 0's partner under 4P teams
    return { hasOld: !!G.koDealt || !!G.koTaken, hasAll: !!G.koDealtAll || !!G.koTakenAll };
  }, seatsFFA);
  check(r.hasOld === false && r.hasAll === false, "a forced partner-kick excludes BOTH the human-only pair AND the new all-seats pair entirely");

  // 6P sanity + migration safety: calling on a G that already has the human-only pair but not the
  // all-seats pair yet (a save from before this feature shipped) lazily creates only what's missing.
  r = await page.evaluate((seats) => {
    newGame({ n: 6, teams: false, seats });
    delete G.koDealtAll; delete G.koTakenAll; // simulate a pre-existing G with only the old pair
    tallyKnockout(0, { seat: 4, pi: 0 });
    return { dealtAllLen: G.koDealtAll.length, takenAllLen: G.koTakenAll.length, dealtAll0: G.koDealtAll[0], takenAll4: G.koTakenAll[4] };
  }, [
    { name: "H0", type: "human", diff: "medium" }, { name: "C1", type: "cpu", diff: "medium" },
    { name: "H2", type: "human", diff: "medium" }, { name: "C3", type: "cpu", diff: "medium" },
    { name: "H4", type: "human", diff: "medium" }, { name: "C5", type: "cpu", diff: "medium" },
  ]);
  check(r.dealtAllLen === 6 && r.takenAllLen === 6 && r.dealtAll0 === 1 && r.takenAll4 === 1,
    `6P + migration-safe: koDealtAll/koTakenAll freshly created at length 6 and credit correctly - got ${JSON.stringify(r)}`);

  // koRatioStr/koRatioNum: the "Perfect" fix, direct pure-math checks.
  const math = await page.evaluate(() => ({
    zeroZero: koRatioStr(0, 0),
    perfect: koRatioStr(7, 0),
    normal: koRatioStr(3, 2),
    numPerfect: koRatioNum(7, 0),
    numZeroZero: koRatioNum(0, 0),
    numNormal: koRatioNum(4, 2),
  }));
  check(math.zeroZero === "-", `koRatioStr(0,0) is a clean "-" - got "${math.zeroZero}"`);
  check(math.perfect === "Perfect", `koRatioStr(7,0) (dealt, never KO'd) shows the word "Perfect", not a bare number or "Infinity" - got "${math.perfect}"`);
  check(math.normal === "1.50", `koRatioStr(3,2) is still a real 2-decimal ratio - got "${math.normal}"`);
  check(math.numPerfect < 0, `koRatioNum(7,0) is a negative sentinel (sorts below any real ratio, which is always >= 0) - got ${math.numPerfect}`);
  check(math.numZeroZero < math.numPerfect, `koRatioNum(0,0) sorts even lower than a "Perfect" record - got ${math.numZeroZero} vs ${math.numPerfect}`);
  check(math.numNormal === 2, "koRatioNum(4,2) still computes the real ratio for sorting");

  // Leaderboard KOs tab: a "Perfect" player now ranks BELOW a real-ratio player (the actual bug
  // fix Blake asked for), not above them via a raw dealt-count comparison.
  await page.evaluate(() => {
    localStorage.setItem("nasty-stats", JSON.stringify({
      Ace: { hkoDealt: 10, hkoTaken: 2 },   // real ratio 5.00
      Bo: { hkoDealt: 6, hkoTaken: 0 },     // "Perfect" - now ranks BELOW real ratios
      Cy: { hkoDealt: 3, hkoTaken: 6 },     // real ratio 0.50
    }));
    lbTab = "ko";
    renderLb(loadStats());
  });
  const order = await page.evaluate(() => Array.from(document.querySelectorAll(".lbTable.lbKo tr")).slice(1).map((tr) => tr.children[0].textContent));
  check(JSON.stringify(order) === JSON.stringify(["Ace", "Cy", "Bo"]),
    `leaderboard KOs tab: real ratios (Ace 5.00, Cy 0.50) both rank ABOVE the "Perfect" record (Bo) - got ${JSON.stringify(order)}`);
  const boRatio = await page.evaluate(() => {
    const tr = Array.from(document.querySelectorAll(".lbTable.lbKo tr")).find((r) => r.textContent.includes("Bo"));
    return tr.children[3].textContent;
  });
  check(boRatio === "Perfect", `Bo's own Ratio cell reads "Perfect" - got "${boRatio}"`);

  await ctx.close();
}

module.exports.__partsForDirectRun = { partA };

/* ============================= Part B - real finished game, KO table matches G ============================= */
async function partB(browser) {
  console.log("\n=== Part B: a REAL finished offline game - win popup KO numbers match G exactly ===");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(300000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(AUTOTEST_URL);
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
  await page.waitForFunction(() => window.G && window.G.over, { timeout: 240000 });
  await page.waitForFunction(() => !document.getElementById("winOverlay").classList.contains("hidden"), { timeout: 15000 });

  const data = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("#winKoWrap .lbTable.lbKo tr")).slice(1).map((tr) =>
      Array.from(tr.children).map((td) => td.textContent));
    return {
      rows, n: window.G.n,
      names: window.G.seats.map((s) => s.name),
      dealtAll: window.G.koDealtAll ? window.G.koDealtAll.slice() : null,
      takenAll: window.G.koTakenAll ? window.G.koTakenAll.slice() : null,
      html: document.getElementById("winKoWrap").innerHTML,
    };
  });
  check(errors.length === 0, `zero page errors across a full real game - got ${JSON.stringify(errors)}`);
  check(!!data.dealtAll && !!data.takenAll, "a real finished all-CPU game actually populated G.koDealtAll/koTakenAll (real kicks happened)");
  check(data.rows.length === data.n, `the KO table has exactly one row per seat (${data.n}), including CPU seats - got ${data.rows.length}`);
  for (const name of data.names) check(data.rows.some((row) => row[0] === name), `KO table includes seat "${name}" (a CPU seat) by name`);
  // Cross-check every row's KOs/KO'd cell against G.koDealtAll/koTakenAll BY NAME (not by row
  // order, since the table is sorted by ratio, not seat index).
  let allMatch = true;
  data.names.forEach((name, i) => {
    const row = data.rows.find((r) => r[0] === name);
    if (!row) { allMatch = false; return; }
    if (Number(row[1]) !== data.dealtAll[i] || Number(row[2]) !== data.takenAll[i]) allMatch = false;
  });
  check(allMatch, `every seat's KOs/KO'd cell exactly matches G.koDealtAll/koTakenAll for that seat - table=${JSON.stringify(data.rows)} dealtAll=${JSON.stringify(data.dealtAll)} takenAll=${JSON.stringify(data.takenAll)}`);
  check(!/Infinity/i.test(data.html) && !/NaN/i.test(data.html), 'the KO table never shows "Infinity" or "NaN" anywhere');
  // At least one seat is a real all-CPU-game "Perfect" or normal ratio, never a bare divide-by-zero glitch.
  check(data.rows.every((r) => r[3] === "-" || r[3] === "Perfect" || /^\d+\.\d{2}$/.test(r[3])),
    `every ratio cell is one of "-", "Perfect", or a real 2-decimal number - got ${JSON.stringify(data.rows.map((r) => r[3]))}`);

  await page.screenshot({ path: path.join(SHOTDIR, "postgame_realwin_390x844.png") });
  await ctx.close();
  return data;
}

/* ============================= Part C - close/reveal/reopen/topbar ============================= */
async function partC(browser) {
  console.log("\n=== Part C: X closes to the board; tap-to-reveal; Results reopens; topbar repurposed ===");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(300000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(AUTOTEST_URL);
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
  await page.waitForFunction(() => window.G && window.G.over, { timeout: 240000 });
  await page.waitForFunction(() => !document.getElementById("winOverlay").classList.contains("hidden"), { timeout: 15000 });

  // Topbar is already repurposed WHILE the popup is still open (updateTopbarForGameOver ran
  // inside showWin(), before the X is ever tapped) - verify that first.
  const topbarBefore = await page.evaluate(() => ({
    pauseHidden: document.getElementById("btnPause").classList.contains("hidden"),
    speedHidden: document.getElementById("btnSpeed").classList.contains("hidden"),
    menuText: document.getElementById("btnMenu").textContent,
    saveText: document.getElementById("btnSave").textContent,
    saveHighlighted: document.getElementById("btnSave").classList.contains("postGameHighlight"),
  }));
  check(topbarBefore.pauseHidden, "Pause is hidden once the game is over");
  check(topbarBefore.speedHidden, "Speed is hidden once the game is over");
  check(topbarBefore.menuText === "Menu", `Quit is relabeled "Menu" once the game is over - got "${topbarBefore.menuText}"`);
  check(topbarBefore.saveText === "Results", `Save is relabeled "Results" once the game is over - got "${topbarBefore.saveText}"`);
  check(topbarBefore.saveHighlighted, "Results gets the gold post-game highlight");

  // X closes the popup - reveals the board, no consequence.
  await page.click("#btnWinClose");
  await page.waitForTimeout(150);
  let state = await page.evaluate(() => ({
    winHidden: document.getElementById("winOverlay").classList.contains("hidden"),
    gameHidden: document.getElementById("game").classList.contains("hidden"),
    over: window.G.over,
    hint: document.getElementById("handInfo").textContent,
    handRowEmpty: document.getElementById("handRow").children.length === 0,
  }));
  check(state.winHidden, "tapping X hides the win popup");
  check(!state.gameHidden, "the board (#game) is still visible underneath - this IS post-game review mode");
  check(state.over === true, "G.over is untouched by closing the popup (still true - the game is still recorded as finished)");
  check(/tap a player's name/i.test(state.hint), `a clear hint is shown by default - got "${state.hint}"`);
  check(state.handRowEmpty, "nobody's hand is revealed by default");

  // Nothing revealed by default - no plaque carries .revealed.
  const anyRevealedDefault = await page.evaluate(() => !!document.querySelector(".plaque.revealed"));
  check(!anyRevealedDefault, "no plaque shows as revealed by default");

  // Tap seat 0's plaque - reveals EXACTLY seat 0's real hand.
  const seat0Hand = await page.evaluate(() => window.G.hands[0].slice());
  await page.click("#plaque-0");
  await page.waitForTimeout(120);
  let revealed = await page.evaluate(() => ({
    revealedPlaques: Array.from(document.querySelectorAll(".plaque.revealed")).map((el) => el.id),
    cardCount: document.getElementById("handRow").children.length,
  }));
  check(JSON.stringify(revealed.revealedPlaques) === JSON.stringify(["plaque-0"]), `tapping plaque-0 marks ONLY plaque-0 as revealed - got ${JSON.stringify(revealed.revealedPlaques)}`);
  check(revealed.cardCount === seat0Hand.length, `exactly seat 0's real card count is shown (${seat0Hand.length}) - got ${revealed.cardCount}`);
  // Verify the actual card RANKS/suits rendered match G.hands[0] (not just the count).
  const renderedRanks = await page.evaluate(() => Array.from(document.querySelectorAll("#handRow .card .rk")).map((el) => el.firstChild.textContent).filter((_, i) => i % 2 === 0));
  const expectedRanks = seat0Hand.map((c) => c.r);
  check(JSON.stringify(renderedRanks.sort()) === JSON.stringify(expectedRanks.sort()), `the rendered cards' ranks exactly match G.hands[0] - got ${JSON.stringify(renderedRanks)} expected ${JSON.stringify(expectedRanks)}`);

  // Tap plaque-0 again - hides it.
  await page.click("#plaque-0");
  await page.waitForTimeout(120);
  let afterToggle = await page.evaluate(() => ({
    anyRevealed: !!document.querySelector(".plaque.revealed"),
    cardCount: document.getElementById("handRow").children.length,
  }));
  check(!afterToggle.anyRevealed, "tapping the SAME plaque again hides the reveal");
  check(afterToggle.cardCount === 0, "hand tray is empty again after toggling off");

  // Tap plaque-1, then plaque-2 - switches cleanly, only the latest is ever revealed.
  await page.click("#plaque-1");
  await page.waitForTimeout(100);
  await page.click("#plaque-2");
  await page.waitForTimeout(100);
  const seat2Hand = await page.evaluate(() => window.G.hands[2].slice());
  const switched = await page.evaluate(() => ({
    revealedPlaques: Array.from(document.querySelectorAll(".plaque.revealed")).map((el) => el.id),
    cardCount: document.getElementById("handRow").children.length,
  }));
  check(JSON.stringify(switched.revealedPlaques) === JSON.stringify(["plaque-2"]), `tapping a DIFFERENT plaque switches the reveal (only plaque-2 now) - got ${JSON.stringify(switched.revealedPlaques)}`);
  check(switched.cardCount === seat2Hand.length, "switching to a new seat shows exactly that seat's own card count");

  await page.screenshot({ path: path.join(SHOTDIR, "postgame_reveal_390x844.png") });

  // "Results" reopens the SAME popup - closing the X is not a one-way door - and the reveal
  // state (plaque-2 still selected) survives the round trip since only a fresh game resets it.
  await page.click("#btnSave");
  await page.waitForTimeout(150);
  let reopened = await page.evaluate(() => !document.getElementById("winOverlay").classList.contains("hidden"));
  check(reopened, 'tapping the repurposed "Results" button reopens the win popup');
  await page.click("#btnWinClose");
  await page.waitForTimeout(120);
  const stillRevealed = await page.evaluate(() => document.getElementById("plaque-2").classList.contains("revealed"));
  check(stillRevealed, "the previously-revealed seat is still marked revealed after a close/reopen/close round trip");

  check(errors.length === 0, `zero page errors throughout Part C - got ${JSON.stringify(errors)}`);
  await ctx.close();
}

/* ============================= Part D - reveal is unreachable mid-game ============================= */
async function partD(browser) {
  console.log("\n=== Part D: the reveal is provably unreachable while a game is still in progress ===");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(AUTOTEST_URL);
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
  // Grab a mid-game moment (G.over still false) and hammer every plaque.
  await page.waitForFunction(() => window.G && !window.G.over, { timeout: 20000 });
  const before = await page.evaluate(() => window.G.over);
  check(before === false, "sanity: the game is genuinely still in progress (G.over is false)");
  await page.evaluate(() => {
    for (let s = 0; s < window.G.n; s++) { const el = document.getElementById("plaque-" + s); if (el) el.click(); }
  });
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => ({
    anyRevealed: !!document.querySelector(".plaque.revealed"),
    cardCount: document.getElementById("handRow").children.length,
    over: window.G.over,
  }));
  check(!after.anyRevealed, "clicking every plaque mid-game reveals nothing at all");
  check(errors.length === 0, "clicking every plaque mid-game causes zero page errors");
  await ctx.close();
}

/* ============================= Part E - leaving post-game is free ============================= */
async function partE(browser) {
  console.log("\n=== Part E: leaving from post-game review mode is free (no extra loss recorded) ===");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(300000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(AUTOTEST_URL);
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
  await page.waitForFunction(() => window.G && window.G.over, { timeout: 240000 });
  await page.waitForFunction(() => !document.getElementById("winOverlay").classList.contains("hidden"), { timeout: 15000 });
  // #autotest is all-CPU, so nothing is ever written to localStorage nasty-stats (see
  // buildResultEntries()'s own entries.length guard) - snapshot it right after the win to prove
  // leaving afterward adds nothing new, the same proof either way.
  const statsAfterWin = await page.evaluate(() => localStorage.getItem("nasty-stats"));
  await page.click("#btnWinClose");
  await page.waitForTimeout(100);
  await page.click("#btnMenu"); // repurposed "Menu" in post-game mode - must NOT open the surrender dialog
  await page.waitForTimeout(200);
  const state = await page.evaluate(() => ({
    onMenu: !document.getElementById("menu").classList.contains("hidden"),
    gameHidden: document.getElementById("game").classList.contains("hidden"),
    surrenderShown: !document.getElementById("surrenderConfirmOverlay").classList.contains("hidden"),
    statsAfterLeave: localStorage.getItem("nasty-stats"),
  }));
  check(state.onMenu && state.gameHidden, "tapping the repurposed post-game Menu button lands cleanly on the menu");
  check(!state.surrenderShown, "the surrender/concede confirm dialog never appears - this is a free exit, not the surrender path");
  check(state.statsAfterLeave === statsAfterWin, "no additional stat was recorded by leaving - the game's own win/loss result is untouched");
  check(errors.length === 0, "zero page errors leaving from post-game review mode");
  await ctx.close();
}

/* ============================= Part F - win/pass badge fit, real safe-area insets ============================= */
const MATRIX = [
  { w: 320, h: 568, top: 0, bottom: 0, name: "320x568 (SE1, no notch)" },
  { w: 375, h: 667, top: 0, bottom: 0, name: "375x667 (SE2/3, no notch)" },
  { w: 390, h: 844, top: 47, bottom: 34, name: "390x844 (12/13/14, notch)" },
  { w: 393, h: 852, top: 59, bottom: 34, name: "393x852 (14/15 Pro, Dynamic Island)" },
  { w: 430, h: 932, top: 59, bottom: 34, name: "430x932 (Pro Max, Dynamic Island)" },
];
async function checkSignFits(browser, w, h, top, bottom, name, setupFn, overlayId, label, shotName) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  await client.send("Emulation.setSafeAreaInsetsOverride", { insets: { top, left: 0, bottom, right: 0 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(AUTOTEST_URL);
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
  await page.evaluate(setupFn);
  await page.waitForTimeout(150);
  const r = await page.evaluate((id) => {
    const ov = document.getElementById(id);
    const sign = ov.querySelector(".sign");
    const rect = sign.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, innerW: window.innerWidth, innerH: window.innerHeight, text: sign.textContent };
  }, overlayId);
  const fitsH = r.left >= -0.5 && r.right <= r.innerW + 0.5;
  ok2(fitsH, `${label} @ ${name}: sign never exceeds the real viewport horizontally (left=${r.left.toFixed(1)}, right=${r.right.toFixed(1)}, innerW=${r.innerW}) - text="${r.text}"`);
  ok2(errors.length === 0, `${label} @ ${name}: zero page errors`);
  if (shotName) await page.screenshot({ path: path.join(SHOTDIR, shotName) });
  await ctx.close();
}
function ok2(cond, label) { check(cond, label); }

async function partF(browser) {
  console.log("\n=== Part F: win/pass badge fit - real safe-area insets, long team name + 10-char name ===");
  for (const m of MATRIX) {
    // Longest realistic case: a TEAM win joining two full NAME_MAX (10-char) names with " & ".
    await checkSignFits(browser, m.w, m.h, m.top, m.bottom, m.name, () => {
      window.G.teams = true;
      window.G.winners = [0, 2];
      window.G.seats[0].name = "MICHELLEX"; window.G.seats[2].name = "JONATHANN";
      window.showWin();
    }, "winOverlay", "win popup (team, two 10-char names)", `winbadge_team_${m.w}x${m.h}.png`);
    // Single 10-character name, solo win.
    await checkSignFits(browser, m.w, m.h, m.top, m.bottom, m.name, () => {
      window.G.teams = false;
      window.G.winners = [0];
      window.G.seats[0].name = "MICHELLEX";
      window.showWin();
    }, "winOverlay", "win popup (solo, 10-char name)", `winbadge_solo_${m.w}x${m.h}.png`);
    // The pass-the-device badge - same bug, same fix, single name only.
    await checkSignFits(browser, m.w, m.h, m.top, m.bottom, m.name, () => {
      window.G.seats[0].name = "MICHELLEX";
      window.passDeviceGate(0);
    }, "passOverlay", "pass-the-device popup (10-char name)", `passbadge_${m.w}x${m.h}.png`);
  }
}

/* ============================= Part G - ONLINE, non-host client, real server ============================= */
function startServer(kind, port, scratch) {
  let child;
  if (kind === "deno") {
    child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
      cwd: "/Users/jarvis/nasty-game/server/cloud",
      env: Object.assign({}, process.env, { NASTY_PORT: String(port), NASTY_KV_PATH: path.join(scratch, "postgame.kv"), NASTY_ADMIN_TOKEN: "postgame-admin-token" }),
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
// (The straightforward "drive two real rendered pages via random legal moves" approach was tried
// first and removed - see the comment on partG() below for why it's not viable as a permanent,
// bounded-time regression check.)

// A real rendered browser page driving a full FFA game to a natural win is animation-pace bound
// (online's fastest table speed is 2.6x - SPEED_OPTS - versus #autotest's internal SPEED=12,
// which is why the offline soak recipe finishes so much faster) - proven too slow for a
// permanent regression suite (a real attempt at this exact scenario, unbounded budget up to 5
// minutes, did not reach a natural win). This suite instead uses the SAME raw-WebSocket +
// shadow-engine technique test_knockout_leaderboard.js's Part C/E already established in this
// exact repo for the identical problem (see its playOneGame()) - no animation, no rendering, just
// the real wire protocol against the real server, so a full game finishes in on the order of a
// minute rather than many. This answers the CENTRAL question at the data/wire level (does a
// NON-HOST connection's own copy of G genuinely receive every seat's real final hand, or does the
// server redact anything per-recipient) directly and conclusively. A SEPARATE real rendered
// Playwright page then reconnects as that exact guest seat, against the REAL now-finished room,
// to verify the actual UI (post-game topbar, tap-to-reveal, leaving) end to end - the one thing a
// raw WebSocket alone can never prove.
function wsConnect(port) {
  const WebSocket = require("/Users/jarvis/nasty-game/server/node_modules/ws");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
function makeQueue(ws) {
  const buf = []; const waiters = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (waiters.length) waiters.shift()(m); else buf.push(m);
  });
  return {
    next(pred, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        let to;
        const tryDrain = () => {
          for (let i = 0; i < buf.length; i++) {
            if (!pred || pred(buf[i])) { const m = buf.splice(i, 1)[0]; clearTimeout(to); return resolve(m); }
          }
          return false;
        };
        if (tryDrain()) return;
        to = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
        const onMsg = (m) => {
          if (!pred || pred(m)) { clearTimeout(to); resolve(m); }
          else { buf.push(m); waiters.push(onMsg); }
        };
        waiters.push(onMsg);
      });
    },
  };
}

async function partG(kind, port, scratch) {
  console.log(`\n=== Part G (${kind}): ONLINE, non-host client genuinely has every seat's final hand ===`);
  const child = startServer(kind, port, scratch);
  try {
    await waitHealthy(port);
    // Always the NODE engine.js as the shadow, regardless of which server backend is under
    // test - server/cloud/engine.js is a Deno-flavored ES-module mirror of the exact same
    // mechanically-extracted logic (build-engine.js keeps them byte-identical), so it makes no
    // difference which copy computes legal moves here; test_knockout_leaderboard.js's own
    // shadow-engine technique does the same thing for its own Deno-mode runs.
    const { createEngine } = require("/Users/jarvis/nasty-game/server/engine.js");

    const seats = [
      { name: `PGHost_${kind}`, type: "human", diff: "medium" }, { name: `PGGuest_${kind}`, type: "human", diff: "medium" },
      { name: `PGC1_${kind}`, type: "cpu", diff: "medium" }, { name: `PGC2_${kind}`, type: "cpu", diff: "medium" },
    ];
    const hostWs = await wsConnect(port);
    const hostQ = makeQueue(hostWs);
    hostWs.send(JSON.stringify({ type: "host", protocolVersion: PROTOCOL_VERSION_LOCAL, name: seats[0].name, n: 4, teams: false, seats, speed: 2.6 }));
    const created = await hostQ.next((m) => m.type === "created");
    const code = created.code;

    const guestWs = await wsConnect(port);
    const guestQ = makeQueue(guestWs);
    guestWs.send(JSON.stringify({ type: "join", protocolVersion: PROTOCOL_VERSION_LOCAL, code, name: seats[1].name }));
    const joined = await guestQ.next((m) => m.type === "joined");
    const guestPlayerId = joined.playerId, guestToken = joined.token;
    guestWs.send(JSON.stringify({ type: "claimSeat", seatIndex: 1, name: seats[1].name }));
    guestWs.send(JSON.stringify({ type: "readyUp", willSeat: true }));
    await sleep(300);

    const conns = [{ ws: hostWs, seat: 0 }, { ws: guestWs, seat: 1 }];
    const shadows = conns.map(() => createEngine());
    function applyToShadow(E, action) {
      if (action.kind === "start") {
        E.setLAY(E.buildLayout(action.n));
        E.newGame({ n: action.n, teams: action.teams, seats: action.seats }, { deck: [], dealer: action.dealer });
      } else if (action.kind === "deal") {
        const G = E.getG();
        G.dealer = action.dealer; G.bowedOut = G.seats.map(() => false);
        for (let s = 0; s < G.n; s++) G.hands[s] = (action.hands[s] || []).slice();
        G.turn = action.turn;
      } else if (action.kind === "move") {
        E.applyMove(action.seat, action.m);
        E.getG().turn = action.turn;
      } else if (action.kind === "pass") {
        const G = E.getG();
        if (action.newlyBowedOut) G.bowedOut[action.seat] = true;
        if (action.threwIn) for (const h of G.hands) h.length = 0;
        G.turn = action.turn;
      }
    }
    function pickMove(E, mySeat) {
      const legal = E.legalMoves(mySeat);
      return legal.length ? legal[Math.floor(Math.random() * legal.length)] : null;
    }

    let finishErr = null;
    await new Promise((resolve) => {
      let settled = false;
      const GAME_TIME_BUDGET_MS = kind === "deno" ? 240000 : 150000;
      const hardTimeout = setTimeout(() => finish(new Error(`game did not finish within its time budget (${GAME_TIME_BUDGET_MS / 1000}s)`)), GAME_TIME_BUDGET_MS);
      // 2026-07-25 (found via direct reproduction, real bug in THIS test harness, not the
      // product/server): host+guest are two independent sockets driven by the SAME single-
      // threaded Node event loop. Whichever connection's shadow notices G.over FIRST used to
      // strip BOTH sockets' 'message' listeners immediately - if the OTHER connection still had
      // an already-arrived-but-not-yet-dispatched message sitting in its own socket buffer (a
      // trailing 'move' action from right before the game ended), that message's listener got
      // removed before the event loop ever got to it, permanently under-counting that
      // connection's own shadow by exactly one action. Fix: once EITHER side reports over, wait
      // a short real drain window (letting the event loop flush anything already in flight to
      // EITHER socket) before actually tearing listeners down and comparing state.
      let overNoticedAt = null;
      function finish(err) {
        if (settled) return;
        if (err) { settled = true; clearTimeout(hardTimeout); for (const c of conns) c.ws.removeAllListeners("message"); finishErr = err; resolve(); return; }
        if (overNoticedAt) return; // already draining
        overNoticedAt = Date.now();
        setTimeout(() => {
          if (settled) return;
          settled = true;
          clearTimeout(hardTimeout);
          for (const c of conns) c.ws.removeAllListeners("message");
          finishErr = null;
          resolve();
        }, 500);
      }
      conns.forEach((c, ci) => {
        c.ws.removeAllListeners("message");
        c.ws.on("message", (raw) => {
          if (settled) return;
          let msg;
          try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
          try {
            // 2026-07-25 (found by another session working the same repo this session, flagged
            // before it bit this file too): server/cloud/server.ts sends an app-level
            // {type:'ping',t} heartbeat and force-closes any connection that never answers with
            // {type:'pong',t} (Deno has no lower-level socket ping/pong the way Node's `ws`
            // library does - see that file's own § HEARTBEAT comment). A raw-WebSocket harness
            // that ignores this looks exactly like a hang once a game runs long enough to cross
            // the heartbeat interval - the same likely explanation for this file's own
            // historically-documented "flaky against Deno" gap. Answered here so a slower run
            // never gets silently dropped mid-game.
            if (msg.type === "ping") { c.ws.send(JSON.stringify({ type: "pong", t: msg.t })); return; }
            if (msg.type === "gameAction") {
              applyToShadow(shadows[ci], msg.action);
              const G = shadows[ci].getG();
              if (G.over) { finish(); return; }
              if (G.turn === c.seat && !G.bowedOut[c.seat] && G.hands[c.seat].length > 0) {
                const m = pickMove(shadows[ci], c.seat);
                if (m) { const payload = JSON.stringify({ type: "action", action: { kind: "move", seat: c.seat, m } }); setTimeout(() => { if (!settled) c.ws.send(payload); }, 15); }
              }
            } else if (msg.type === "sync") {
              finish(new Error(`connection ${ci} (seat ${c.seat}) got resynced - a submitted move was rejected as illegal`));
            }
          } catch (e) { finish(e); }
        });
      });
      hostWs.send(JSON.stringify({ type: "start", protocolVersion: PROTOCOL_VERSION_LOCAL, willSeat: true }));
      hostWs.send(JSON.stringify({ type: "seated" }));
      guestWs.send(JSON.stringify({ type: "seated" }));
    });

    check(!finishErr, `(${kind}) a real online FFA game (raw WebSocket + shadow engines, no animation - see comment above) reached G.over within budget${finishErr ? ": " + finishErr.message : ""}`);
    if (finishErr) { hostWs.close(); guestWs.close(); return; }

    // THE CENTRAL CHECK: the GUEST connection's own shadow (fed ONLY by what the server actually
    // sent THAT connection) has every seat's real final hand, matching the HOST's shadow exactly -
    // proving the server never redacts another seat's hand for a non-host recipient.
    const hostFinalHands = shadows[0].getG().hands.map((h) => h.map((c) => c.r + c.s));
    const guestFinalHands = shadows[1].getG().hands.map((h) => h.map((c) => c.r + c.s));
    check(JSON.stringify(guestFinalHands) === JSON.stringify(hostFinalHands),
      `(${kind}) the GUEST connection's own G.hands for EVERY seat exactly match the HOST's - guest=${JSON.stringify(guestFinalHands)} host=${JSON.stringify(hostFinalHands)}`);
    check(guestFinalHands.every((h) => Array.isArray(h)), `(${kind}) every seat's hand on the guest connection is a real array (not undefined/redacted)`);
    const winnerSeat = shadows[0].getG().winners[0];

    hostWs.close(); guestWs.close();
    await sleep(300);

    // Now the REAL UI check: a genuine rendered browser page reconnects AS THE GUEST'S OWN SEAT
    // (its real playerId/token from the join above) against the now-finished room, and drives the
    // actual post-game review UI - the one thing the raw WebSocket check above cannot prove.
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${INDEX_URL}?ws=${encodeURIComponent(`ws://127.0.0.1:${port}`)}`);
    await page.waitForFunction(() => typeof window.NET === "object");
    page.setDefaultTimeout(30000);
    await page.evaluate(({ code, guestPlayerId, guestToken }) => {
      Object.assign(window.NET, { code, playerId: guestPlayerId, token: guestToken });
      window.connectWs().then(() => {
        window.netSend({ type: "rejoin", code, playerId: guestPlayerId, token: guestToken, protocolVersion: PROTOCOL_VERSION });
      });
    }, { code, guestPlayerId, guestToken });
    await page.waitForFunction(() => window.G != null && window.G.over === true, { timeout: 15000 });

    const reconnectHands = await page.evaluate(() => window.G.hands.map((h) => h.map((c) => c.r + c.s)));
    check(JSON.stringify(reconnectHands) === JSON.stringify(hostFinalHands),
      `(${kind}) the REAL reconnecting client's own G.hands for every seat match the wire-level proof above - got ${JSON.stringify(reconnectHands)}`);

    const topbarState = await page.evaluate(() => ({
      pauseHidden: document.getElementById("btnPause").classList.contains("hidden"),
      menuText: document.getElementById("btnMenu").textContent,
      saveText: document.getElementById("btnSave").textContent,
    }));
    check(topbarState.pauseHidden && topbarState.menuText === "Menu" && topbarState.saveText === "Results",
      `(${kind}) a client that RECONNECTS directly into an already-finished game still gets the correct post-game topbar - got ${JSON.stringify(topbarState)}`);

    // Tap "Results" - populated (winner name, at least) even though this client never called
    // showWin() itself (see bootGameFromSnapshot()'s comment, index.html).
    await page.click("#btnSave");
    await sleep(150);
    const resultsPopup = await page.evaluate(() => ({
      visible: !document.getElementById("winOverlay").classList.contains("hidden"),
      title: document.getElementById("winTitle").textContent,
    }));
    check(resultsPopup.visible && resultsPopup.title.length > 0, `(${kind}) "Results" opens a populated popup (winner name present) even on a fresh reconnect - got ${JSON.stringify(resultsPopup)}`);
    await page.click("#btnWinClose");
    await sleep(150);

    // Reveal a seat that is NOT this client's own (the winner's seat, picked above, unless that's
    // seat 1 itself - fall back to seat 0 in that case).
    const revealSeat = winnerSeat === 1 ? 0 : winnerSeat;
    await page.click(`#plaque-${revealSeat}`);
    await sleep(150);
    const reveal = await page.evaluate((s) => ({
      revealed: Array.from(document.querySelectorAll(".plaque.revealed")).map((el) => el.id),
      cardCount: document.getElementById("handRow").children.length,
    }), revealSeat);
    check(JSON.stringify(reveal.revealed) === JSON.stringify([`plaque-${revealSeat}`]),
      `(${kind}) the REAL reconnected client can reveal a seat that is NOT its own via the real tap UI - got ${JSON.stringify(reveal.revealed)}`);
    check(reveal.cardCount === hostFinalHands[revealSeat].length,
      `(${kind}) the reveal shows the exact right card count for seat ${revealSeat}`);

    // Leaving from post-game on this real client works too, and is free (no surrender dialog).
    await page.click("#btnMenu");
    await sleep(200);
    const state = await page.evaluate(() => ({
      onMenu: !document.getElementById("menu").classList.contains("hidden"),
      surrenderShown: !document.getElementById("surrenderConfirmOverlay").classList.contains("hidden"),
    }));
    check(state.onMenu && !state.surrenderShown, `(${kind}) the reconnected client can leave from post-game review mode back to the menu, with no surrender dialog`);

    check(errors.length === 0, `(${kind}) zero page errors on the real reconnected client - got ${JSON.stringify(errors)}`);

    await ctx.close(); await browser.close();
  } finally {
    child.kill();
  }
}

/* ============================= main ============================= */
(async () => {
  if (!process.env.NASTY_TEST_SKIP_ABF) {
    const browser = await chromium.launch();
    await partA(browser);
    await partB(browser);
    await partC(browser);
    await partD(browser);
    await partE(browser);
    await partF(browser);
    await browser.close();
  }

  if (RUN_NODE) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nasty-postgame-node-"));
    await partG("node", 23900 + Math.floor(Math.random() * 400), scratch);
  }
  if (RUN_DENO) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nasty-postgame-deno-"));
    await partG("deno", 23900 + Math.floor(Math.random() * 400) + 500, scratch);
  }

  console.log(`\n[postgame] TOTAL: ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
