"use strict";
/*
 * v0.41 permanent regression suite (2026-07-26) - Blake's played-card placement.
 *
 * Usage:
 *   node test_ui_v041_2026_07_26.js
 *   NASTY_INDEX=/some/other/index.html node test_ui_v041_2026_07_26.js
 *       - points every page at a DIFFERENT copy of the app. That exists so this file can be
 *         proven to mean something: run it against the pre-v0.41 index.html and Part A fails on
 *         45 of its 50 seat/width combinations. A test that cannot fail proves nothing.
 *
 * Offline only. Nothing here needs a relay, a room or a network of any kind, and it never
 * touches production.
 *
 * ---------------------------------------------------------------------------------------
 * WHAT BLAKE ASKED FOR, twice:
 *   "During gameplay, always have the cards be laid in the blank space between pillars on the
 *    board (not covering any holes) this should work on 4 person and 6 person games."
 *   "when the yellow player in 4 person mode puts their card down it always sorta touches the
 *    holes on the board. Move this slightly up."
 *
 * WHY THIS SUITE MEASURES THE DOM AND NOTHING ELSE. An earlier attempt at this checked the
 * NOMINAL numbers in the layout object (LAY.discardPockets' x/y/w/h against LAY.loop's hole
 * centres) and reported zero overlap while Blake could plainly see the problem on his phone.
 * The nominal numbers were not what was on screen: the played card renders a real .dFace card
 * inside the pocket, wears a frame, and used to carry a caption pill underneath it that was
 * nearly 3x the card's own width. So every assertion below reads real getBoundingClientRect()s
 * off real rendered elements and real <circle> holes out of the real board SVG, in screen
 * pixels, exactly as a phone draws them.
 *
 * PART A - the card sits in open wood, every seat, both board sizes, five phone widths.
 * PART B - what the card is made of now: the owner's colour frame, and no caption pill.
 * PART C - the tee-selection badges (v0.37) and the played cards do not fight each other.
 * PART D - the same thing again in a REAL game, after real plays, not a synthetic fixture.
 */

const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
require("./test_ui_v036_welcome_bypass.js").patch(chromium);

const path = require("path");
const fs = require("fs");

const INDEX = process.env.NASTY_INDEX || "/Users/jarvis/nasty-game/index.html";
const SHOTDIR = process.env.NASTY_SHOTDIR || "/tmp/nasty-v041-shots";
fs.mkdirSync(SHOTDIR, { recursive: true });

// Every phone width in the project's standard matrix.
const VIEWPORTS = [
  { w: 320, h: 568 }, { w: 375, h: 667 }, { w: 390, h: 844 },
  { w: 393, h: 852 }, { w: 430, h: 932 },
];

function log(...a) { console.log("[v041]", new Date().toISOString(), ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freshBoard(page, n) {
  /* Same clean-slate fixture the other UI suites use: a returning player who has already
     answered the one-time speed question, with no saved game of any kind lying around. */
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
  await sleep(150);
}

/* ===========================================================================================
 * The measurement. Everything in here is a real rendered rect or a real rendered circle.
 * =========================================================================================== */
const MEASURE = (seat) => {
  const LAY = window.LAY;
  // Worst case on purpose: the app's own NAME_MAX is 10 characters and "10" is its widest rank.
  // (Pre-v0.41 that combination is what produced the 175 board-px caption this all turned on.)
  window.G.seats.forEach((s) => (s.name = "WWWWWWWWWW"));
  window.showDiscard(seat, { r: "10", s: "♥" });

  const d = document.getElementById("discard-" + seat);
  const cardEl = d.querySelector(".dFace .card");
  const bs = document.getElementById("boardScale").getBoundingClientRect();
  const scale = bs.width / 1000;
  const b = cardEl.getBoundingClientRect();
  // The owner-colour frame is a 3 board-px box-shadow ring, so it is real ink outside the rect.
  const RING = 3 * scale;
  let foot = { l: b.left - RING, t: b.top - RING, r: b.right + RING, b: b.bottom + RING };

  // Any caption pill still under the card counts as part of the card's footprint. v0.41 does not
  // render one; a pre-v0.41 build does, and this is where that build gets caught.
  const lab = d.querySelector(".dLabel");
  let labelShown = false;
  if (lab && !lab.classList.contains("hidden")) {
    const lr = lab.getBoundingClientRect();
    if (lr.width > 0 && lr.height > 0) {
      labelShown = true;
      foot = { l: Math.min(foot.l, lr.left), t: Math.min(foot.t, lr.top),
               r: Math.max(foot.r, lr.right), b: Math.max(foot.b, lr.bottom) };
    }
  }

  // The real holes: drawBoard() paints each one as a <circle fill="url(#hole)">. The coloured
  // rings around them are separate strokes and are deliberately NOT counted as the hole itself -
  // this measures the thing Blake pointed at.
  const holes = [];
  document.getElementById("boardSvg").querySelectorAll("circle").forEach((c) => {
    if (c.getAttribute("fill") !== "url(#hole)") return;
    const r = c.getBoundingClientRect();
    holes.push({ cx: r.left + r.width / 2, cy: r.top + r.height / 2, r: r.width / 2 });
  });

  const plaques = [...document.querySelectorAll("#plaqueLayer .plaque")].map((p) => p.getBoundingClientRect());

  // The deck lives in whichever seat is dealing, so park it on THIS seat - the worst case for
  // this seat's own card, and a real one (you play a card on the hand you dealt).
  const deckEl = document.getElementById("deckSpot");
  const dp = LAY.deckPockets[seat];
  deckEl.style.left = dp.x + "px"; deckEl.style.top = dp.y + "px";
  const deckR = deckEl.getBoundingClientRect();
  const countR = document.getElementById("deckCount").getBoundingClientRect();
  const boardR = document.getElementById("boardSvg").getBoundingClientRect();

  const gapCircle = (R, h) => {
    const nx = Math.max(R.l, Math.min(h.cx, R.r)), ny = Math.max(R.t, Math.min(h.cy, R.b));
    return Math.hypot(h.cx - nx, h.cy - ny) - h.r;
  };
  const gapRect = (R, o) => {
    const dx = Math.max(o.left - R.r, R.l - o.right), dy = Math.max(o.top - R.b, R.t - o.bottom);
    if (dx >= 0 && dy >= 0) return Math.hypot(dx, dy);
    return Math.max(dx, dy);
  };

  let holeGap = Infinity, holeHits = 0;
  holes.forEach((h) => { const g = gapCircle(foot, h); if (g < holeGap) holeGap = g; if (g < 0) holeHits++; });
  let plaqueGap = Infinity, plaqueHits = 0;
  plaques.forEach((p) => { const g = gapRect(foot, p); if (g < plaqueGap) plaqueGap = g; if (g < 0) plaqueHits++; });
  const deckGap = Math.min(gapRect(foot, deckR), gapRect(foot, countR));
  const inBoard = foot.l >= boardR.left - 0.5 && foot.r <= boardR.right + 0.5 &&
                  foot.t >= boardR.top - 0.5 && foot.b <= boardR.bottom + 0.5;

  return {
    seat, scale, holes: holes.length,
    moved: d.dataset.moved === undefined ? null : parseFloat(d.dataset.moved),
    cardW: b.width, cardH: b.height,
    holeGap, holeHits, plaqueGap, plaqueHits, deckGap, inBoard, labelShown,
    frame: getComputedStyle(cardEl).boxShadow,
    seatColour: window.G.seats[seat].color.c,
  };
};

/* ===========================================================================================
 * PART A - a played card lands in open wood: every seat, both boards, five phone widths.
 * =========================================================================================== */
async function partA(browser) {
  log("--- Part A: played cards sit in the blank space, never on a hole ---");
  const table = [];
  for (const n of [4, 6]) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      const errs = [];
      page.on("pageerror", (e) => errs.push(String(e)));
      await freshBoard(page, n);
      for (let s = 0; s < n; s++) {
        const m = await page.evaluate(MEASURE, s);
        table.push(Object.assign({ n, vp: `${vp.w}x${vp.h}` }, m));
        const tag = `A ${n}P ${vp.w}x${vp.h} seat ${s}`;
        check(m.holes > 0, `${tag}: the board really painted its holes (${m.holes} of them)`);
        check(m.holeHits === 0,
          `${tag}: card is off every hole (nearest ${m.holeGap.toFixed(1)}px of daylight, ${m.holeHits} covered)`);
        check(m.plaqueHits === 0, `${tag}: card is off every name plate (nearest ${m.plaqueGap.toFixed(1)}px)`);
        check(m.deckGap >= 0, `${tag}: card is off the deck and its count chip (${m.deckGap.toFixed(1)}px)`);
        check(m.inBoard, `${tag}: the whole card is on the board`);
      }
      if (vp.w === 320 || vp.w === 390) {
        await page.evaluate(() => {
          for (let s = 0; s < window.G.n; s++) window.showDiscard(s, { r: "10", s: "♥" });
          for (let s = 0; s < window.G.n; s++) document.getElementById("discard-" + s).classList.add("show");
        });
        await sleep(250);
        await page.screenshot({ path: path.join(SHOTDIR, `A_cards_${n}p_${vp.w}.png`) });
      }
      check(errs.length === 0, `A ${n}P ${vp.w}x${vp.h}: no page errors (${errs.length})`);
      await ctx.close();
    }
  }
  // One compact readout, so a failure report carries the actual numbers with it.
  log("per-seat summary (screen px):");
  for (const r of table) {
    log(`   ${r.n}P ${r.vp.padEnd(8)} seat ${r.seat}  moved ${String(r.moved).padStart(6)} board px  ` +
      `hole ${r.holeGap.toFixed(1)} (${r.holeHits})  plate ${r.plaqueGap.toFixed(1)} (${r.plaqueHits})  ` +
      `deck ${r.deckGap.toFixed(1)}  caption ${r.labelShown}`);
  }
  const worst4 = Math.min(...table.filter((r) => r.n === 4).map((r) => r.holeGap));
  const worst6 = Math.min(...table.filter((r) => r.n === 6).map((r) => r.holeGap));
  log(`worst hole clearance anywhere: 4P ${worst4.toFixed(1)}px, 6P ${worst6.toFixed(1)}px`);
  /* These floors are the measured v0.41 result minus a little slack, not aspirations. They exist
     so a future board/layout change that quietly eats the clearance is caught here rather than by
     Blake. 6P's is much tighter than 4P's because a 6-player board genuinely has less open wood
     between its pillars - see HANDOFF.md's v0.41 section for the full trade-off table. */
  check(worst4 >= 4.0, `A: 4P worst hole clearance ${worst4.toFixed(1)}px is at or above the 4.0px floor`);
  check(worst6 >= 1.8, `A: 6P worst hole clearance ${worst6.toFixed(1)}px is at or above the 1.8px floor`);
  return table;
}

/* ===========================================================================================
 * PART B - what a played card is made of in v0.41.
 * =========================================================================================== */
async function partB(browser) {
  log("--- Part B: the owner's colour frame replaces the caption pill ---");
  for (const n of [4, 6]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await freshBoard(page, n);
    const r = await page.evaluate((n) => {
      const out = [];
      for (let s = 0; s < n; s++) {
        window.showDiscard(s, { r: "K", s: "♠" });
        const d = document.getElementById("discard-" + s);
        const card = d.querySelector(".dFace .card");
        const lab = d.querySelector(".dLabel");
        out.push({
          s,
          colour: window.G.seats[s].color.c,
          varSet: d.style.getPropertyValue("--dcol").trim(),
          shadow: getComputedStyle(card).boxShadow,
          captionInDom: !!lab,
          captionVisible: !!(lab && !lab.classList.contains("hidden") && lab.getBoundingClientRect().width > 0),
          rank: (d.querySelector(".dFace .rk") || {}).textContent || "",
        });
      }
      return out;
    }, n);
    const hexToRgb = (h) => {
      const m = h.replace("#", "");
      const v = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
      return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
    };
    for (const o of r) {
      check(o.varSet.toLowerCase() === o.colour.toLowerCase(),
        `B ${n}P seat ${o.s}: the card carries this seat's own colour (${o.varSet} = ${o.colour})`);
      const [R, G, B] = hexToRgb(o.colour);
      check(o.shadow.includes(`rgb(${R}, ${G}, ${B})`),
        `B ${n}P seat ${o.s}: that colour is really painted as the card's frame`);
      check(!o.captionVisible, `B ${n}P seat ${o.s}: no caption pill hangs under the card`);
      check(o.rank.indexOf("K") === 0, `B ${n}P seat ${o.s}: the played card still shows its own rank (${o.rank.trim()})`);
    }
    await ctx.close();
  }
}

/* ===========================================================================================
 * PART C - v0.41 and v0.37 do not fight.
 *
 * The tee-selection badges may never move more than MAX_BADGE_SHIFT = 3 x holeR from their peg
 * (v0.37, Blake: "not half the board away from the peg"), and since v0.37 they only move to
 * avoid ANOTHER BADGE - board art underneath them is explicitly allowed. So moving the played
 * cards must not make a single badge move. This proves both halves of that: the cap still holds
 * with a played card sitting in the badges' neighbourhood, and a badge's position is byte for
 * byte the same whether a card is on the table or not.
 * =========================================================================================== */
const CAP = { 4: 3 * 13, 6: 3 * 10.5 };
async function partC(browser) {
  log("--- Part C: played cards never push a tee-selection badge ---");
  for (const n of [4, 6]) {
    for (const vp of [{ w: 320, h: 568 }, { w: 390, h: 844 }]) {
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await freshBoard(page, n);
      const r = await page.evaluate(() => {
        const read = () => [...document.querySelectorAll("#bubbleLayer .teeBubble")].map((e) => ({
          left: e.style.left, top: e.style.top, shift: parseFloat(e.dataset.shift || "0"),
        }));
        const pegs = [{ s: 0, pi: 0, steps: 4 }, { s: 0, pi: 1, steps: 5 }, { s: 0, pi: 2, steps: 6 }];
        pegs.forEach((p) => (window.G.pieces[p.s][p.pi] = { state: "track", steps: p.steps }));
        // no cards on the table
        for (let s = 0; s < window.G.n; s++) document.getElementById("discard-" + s).classList.remove("show");
        window.showBubbles(pegs.map((p) => ({ s: p.s, pi: p.pi })), "");
        const bare = read();
        // now every seat has a card down
        for (let s = 0; s < window.G.n; s++) window.showDiscard(s, { r: "10", s: "♥" });
        for (let s = 0; s < window.G.n; s++) document.getElementById("discard-" + s).classList.add("show");
        window.showBubbles(pegs.map((p) => ({ s: p.s, pi: p.pi })), "");
        const withCards = read();
        return { bare, withCards };
      });
      const same = JSON.stringify(r.bare) === JSON.stringify(r.withCards);
      check(same, `C ${n}P ${vp.w}x${vp.h}: badges land in exactly the same place with cards on the table as without`);
      const worst = Math.max(...r.withCards.map((b) => b.shift));
      check(worst <= CAP[n] + 0.01,
        `C ${n}P ${vp.w}x${vp.h}: v0.37's displacement cap still holds with cards down (worst ${worst.toFixed(1)}, cap ${CAP[n]})`);
      await ctx.close();
    }
  }
}

/* ===========================================================================================
 * PART D - the same promise, in a REAL game. Part A poses the cards by hand; this one lets an
 * all-CPU game play itself and checks whatever the game actually put on the table.
 * =========================================================================================== */
async function partD(browser) {
  log("--- Part D: a real game, real plays, cards still off the holes ---");
  for (const [hash, n] of [["#autotest", 4], ["#autotest6", 6]]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    // The autotest fixture is decided at BOOT (`if(location.hash==='#autotest')` at the very
    // bottom of index.html), so the hash has to be on the URL for a real page load - navigating
    // to it from the same document only changes the hash and boots nothing.
    await page.goto(`file://${INDEX}${hash}`);
    await page.evaluate(() => { try { localStorage.setItem("nasty-speed-chosen", "1"); } catch (e) {} });
    await page.reload();
    await page.waitForFunction(() => window.G && window.G.n, { timeout: 30000 });

    /* Sample whatever card happens to be on the table, repeatedly, while the game plays itself.
       Every seat gets caught eventually because the turn order goes round; the loop stops once it
       has seen every seat play at least once, or after a generous number of samples. */
    const seen = new Set();
    let worst = Infinity, hits = 0, samples = 0;
    for (let i = 0; i < 900 && seen.size < n; i++) {
      const m = await page.evaluate(() => {
        const shown = [...document.querySelectorAll(".discardCard.show")];
        if (!shown.length) return null;
        const d = shown[0];
        const seat = parseInt(d.id.split("-")[1], 10);
        const cardEl = d.querySelector(".dFace .card");
        if (!cardEl) return null;
        const bs = document.getElementById("boardScale").getBoundingClientRect();
        const RING = 3 * (bs.width / 1000);
        const b = cardEl.getBoundingClientRect();
        let foot = { l: b.left - RING, t: b.top - RING, r: b.right + RING, b: b.bottom + RING };
        const lab = d.querySelector(".dLabel");
        if (lab && !lab.classList.contains("hidden")) {
          const lr = lab.getBoundingClientRect();
          if (lr.width > 0) foot = { l: Math.min(foot.l, lr.left), t: Math.min(foot.t, lr.top), r: Math.max(foot.r, lr.right), b: Math.max(foot.b, lr.bottom) };
        }
        let gap = Infinity;
        document.getElementById("boardSvg").querySelectorAll("circle").forEach((c) => {
          if (c.getAttribute("fill") !== "url(#hole)") return;
          const r = c.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2, rr = r.width / 2;
          const nx = Math.max(foot.l, Math.min(cx, foot.r)), ny = Math.max(foot.t, Math.min(cy, foot.b));
          gap = Math.min(gap, Math.hypot(cx - nx, cy - ny) - rr);
        });
        return { seat, gap, over: !!window.G.over };
      });
      if (m) {
        samples++; seen.add(m.seat);
        if (m.gap < worst) worst = m.gap;
        if (m.gap < 0) hits++;
        if (m.over) break;
      }
      await sleep(120);
    }
    check(seen.size === n, `D ${n}P: saw a real played card from all ${n} seats (${seen.size})`);
    check(hits === 0, `D ${n}P: none of the ${samples} sampled real plays covered a hole`);
    check(worst > 0, `D ${n}P: worst real-game clearance ${worst === Infinity ? "n/a" : worst.toFixed(1) + "px"}`);
    check(errs.length === 0, `D ${n}P: no page errors during a real game (${errs.length})`);
    await page.screenshot({ path: path.join(SHOTDIR, `D_realgame_${n}p.png`) });
    await ctx.close();
  }
}

/* ------------------------------------ main ------------------------------------ */
async function main() {
  log(`index under test: ${INDEX}`);
  const browser = await chromium.launch();
  const only = process.env.NASTY_V041_ONLY;
  try {
    if (!only || only.includes("A")) await partA(browser);
    if (!only || only.includes("B")) await partB(browser);
    if (!only || only.includes("C")) await partC(browser);
    if (!only || only.includes("D")) await partD(browser);
  } finally {
    await browser.close();
  }
  log(`RESULT ${PASS} passed, ${FAIL} failed`);
  log(`screenshots: ${SHOTDIR}`);
  process.exit(FAIL ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
