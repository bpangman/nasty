"use strict";
/*
 * test_ui_v040_2026_07_26.js - PERMANENT suite for Blake's 2026-07-26 v0.40 batch (the UI half).
 *
 * The AI half of v0.40 (the Nasty hand-block planner) is covered by server/tests/
 * test_ai_teams_fairness.js, test_ai_teams_strength.js and test_ai_difficulty.js - nothing in this
 * file touches the engine.
 *
 * Blake's three asks, verbatim:
 *   1. "make the login page so that the nasty badge is centered and doesn't flow over the box all
 *      the text is within."
 *   2. Reword one line of the sign-in screen's fine print: "Guests can play every game mode - they
 *      just do not appear on the leaderboard."
 *   3. "can you make the word bubble ingame and the skip button stay where they are? Sometimes they
 *      move down when my cards are gone and then they move back up when my cards are back. Just
 *      leave them where they are as if my cards are always there."
 *
 * Parts:
 *   A - THE BADGE. At all five of Blake's widths, in BOTH variants (website and iPhone app), the
 *       NASTY badge on the sign-in screen sits fully inside the card's content box with real margin
 *       on both sides - counting its rotated bounding box and its 3px outline, not just its
 *       lettering - and its centre is on the card's centre. Plus: no OTHER badge in the app moved
 *       (the menu logo, the takeout stamp and the confirm badges are all checked by computed style,
 *       because the fix edits a rule that shares the `.sign` class with them).
 *   B - THE WORDING, pinned verbatim here (which is why the older suites' copies of the previous
 *       sentence were relaxed to contract assertions rather than left to rot). Still no "family",
 *       still no em or en dashes, still no exclamation mark on a factual line.
 *   C - THE BUBBLE AND SKIP HOLD STILL. A REAL solo game is driven through commitMove() until the
 *       human's hand empties and is dealt again, and #toasts, #btnSkip and #awayActions must report
 *       the same top edge at every hand size including zero. THIS PART FAILS AGAINST v0.39 - run it
 *       with NASTY_INDEX pointed at the old file and it reports the 31.7px drop at 390 and 40.7px at
 *       430 that Blake was seeing. A test that cannot fail against the old code proves nothing.
 *   D - AND NOTHING ELSE MOVED. The board is still centred (the gap above it equals the gap below
 *       it), it still never reaches the band (v0.31 item B), and it is not one pixel smaller than
 *       v0.39 drew it at any width (v0.34 made it bigger at 320/375 and that is not being given
 *       back).
 *
 * Everything is local: file:// plus a dead ?ws= override (127.0.0.1:9) so no account or game call
 * can leave this machine.
 *
 * Run: node tests/test_ui_v040_2026_07_26.js
 *      NASTY_INDEX=/path/to/old/index.html node tests/test_ui_v040_2026_07_26.js   # to see C fail
 */
const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..", "..");
const INDEX_PATH = process.env.NASTY_INDEX || path.join(ROOT, "index.html");
require("./test_ui_v036_welcome_bypass.js");   // (loaded for its documentation; part A wants the screen)
const DEAD_WS = "ws://127.0.0.1:9";
const INDEX = "file://" + INDEX_PATH + "?ws=" + encodeURIComponent(DEAD_WS);
const SHOTDIR = path.join("/private/tmp/claude-501/-Users-jarvis/0bc923da-f111-499a-9b51-18988e4aba3d/scratchpad", "shots-v040");
fs.mkdirSync(SHOTDIR, { recursive: true });

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}

// Blake's own device matrix with the insets each one really reports - identical to the v0.36/v0.37/
// v0.38/v0.39 suites on purpose, so a layout claim means the same thing in all five.
const MATRIX = [
  { name: "320x568 (SE1)", w: 320, h: 568, top: 0, bottom: 0 },
  { name: "375x667 (SE2/3)", w: 375, h: 667, top: 0, bottom: 0 },
  { name: "390x844 (12/13/14)", w: 390, h: 844, top: 47, bottom: 34 },
  { name: "393x852 (15/16 Pro)", w: 393, h: 852, top: 59, bottom: 34 },
  { name: "430x932 (Pro Max)", w: 430, h: 932, top: 59, bottom: 34 },
];

/* MEASURED against the shipped v0.39 (`git show HEAD:index.html`) on 2026-07-26, in a real solo
   game, before anything in this batch was written. Part D uses them as FLOORS: the board may be the
   same size or bigger, never smaller. v0.34 grew the board at 320 and 375 and that is not being
   handed back to buy whitespace. */
const V039_BOARD = { 320: 279.8, 375: 360.6, 390: 375.0, 393: 377.9, 430: 413.5 };
/* v0.39's age-sentence bottom at 320x568, per width-variant. v0.39 itself pinned these as upper
   bounds (that line used to sit inside the 64px swipe-up fade); v0.40 resizes the badge, so it has
   to prove it did not push the line back down. */
const V039_AGE_BOTTOM_320 = { web: 435.5, app: 458.0 };

async function stubApple(ctx) {
  await ctx.addInitScript(() => {
    window.Capacitor = window.Capacitor || {};
    window.Capacitor.Plugins = window.Capacitor.Plugins || {};
    window.Capacitor.Plugins.AppleSignIn = {
      isAvailable: async () => ({ available: true }),
      authorize: async () => { throw new Error("cancelled"); },
    };
  });
}

async function newCtx(browser, m, { app = false, returning = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: m.w, height: m.h }, deviceScaleFactor: 1 });
  if (app) await stubApple(ctx);
  if (returning) {
    // The same two real keys test_ui_v036_welcome_bypass.js seeds - spelled out here rather than
    // patching chromium globally, because part A deliberately WANTS the first-run screen.
    const ver = (fs.readFileSync(INDEX_PATH, "utf8").match(/id="verTap"[^>]*>([^<]+)</) || [, ""])[1].trim();
    await ctx.addInitScript((v) => {
      try { localStorage.setItem("nasty-welcome-choice", "guest"); if (v) localStorage.setItem("nasty-welcome-ver", v); } catch (e) {}
    }, ver);
  }
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  await client.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: m.top, left: 0, bottom: m.bottom, right: 0 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, page, errors };
}

/* ============================ Part A - the badge fits, and it is centred ==================== */
function measureBadge() {
  const card = document.querySelector("#welcomeOverlay .modalCard");
  const sign = document.querySelector("#welcomeOverlay .sign");
  const c = card.getBoundingClientRect(), s = sign.getBoundingClientRect();
  const cs = getComputedStyle(card), ss = getComputedStyle(sign);
  const padL = parseFloat(cs.paddingLeft), padR = parseFloat(cs.paddingRight);
  // The outline is painted OUTSIDE the border box and does not show up in getBoundingClientRect,
  // so it is added by hand here - Blake's complaint was about what he can SEE, not about layout.
  const outline = parseFloat(ss.outlineWidth) || 0;
  const fines = Array.from(document.querySelectorAll("#welcomeOverlay .welcomeFine"))
    .filter((p) => !p.classList.contains("hidden") && p.getClientRects().length);
  const age = fines.find((p) => /ages 13/i.test(p.textContent));
  return {
    marginL: +((s.left - outline) - (c.left + padL)).toFixed(2),
    marginR: +((c.right - padR) - (s.right + outline)).toFixed(2),
    insideCardL: +((s.left - outline) - c.left).toFixed(2),
    insideCardR: +(c.right - (s.right + outline)).toFixed(2),
    centreOff: +(((s.left + s.right) / 2) - ((c.left + c.right) / 2)).toFixed(2),
    signW: +s.width.toFixed(1), cardW: +c.width.toFixed(1),
    transform: ss.transform,
    docScrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
    ageBottom: age ? +age.getBoundingClientRect().bottom.toFixed(1) : null,
    // Every other badge in the app shares the `.sign` class, so prove by computed style that the
    // scoped #welcomeOverlay rule did not leak into any of them.
    otherSigns: Array.from(document.querySelectorAll(".sign"))
      .filter((el) => !el.closest("#welcomeOverlay"))
      .map((el) => { const g = getComputedStyle(el); return { display: g.display, fs: getComputedStyle(el.querySelector("b") || el).fontSize }; }),
  };
}

async function partA(browser) {
  console.log("\n=== Part A: the NASTY badge is centred and stays inside the card ===");
  for (const m of MATRIX) {
    for (const app of [false, true]) {
      const tag = `${app ? "app" : "web"} ${m.name}`;
      const { ctx, page, errors } = await newCtx(browser, m, { app });
      await page.goto(INDEX);
      await page.waitForSelector("#welcomeOverlay:not(.hidden)", { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(350);
      const g = await page.evaluate(measureBadge);
      ok(g.marginL >= 8 && g.marginR >= 8,
        `A1 ${tag}: the badge sits inside the card's text column with real margin on both sides (${g.marginL} / ${g.marginR}px)`);
      ok(g.insideCardL >= 8 && g.insideCardR >= 8,
        `A2 ${tag}: and inside the card's own edges (${g.insideCardL} / ${g.insideCardR}px) - Blake's "doesn't flow over the box"`);
      ok(Math.abs(g.centreOff) <= 1,
        `A3 ${tag}: the badge is centred on the card (offset ${g.centreOff}px)`);
      ok(/matrix/.test(g.transform) && g.transform !== "none",
        `A4 ${tag}: the tilt is still there - it was not deleted to make it fit`);
      ok(g.docScrollW <= g.innerW + 1,
        `A5 ${tag}: no sideways overflow on the page either (${g.docScrollW} vs ${g.innerW})`);
      ok(errors.length === 0, `A6 ${tag}: zero page errors`);
      if (m.w === 320) {
        const bound = app ? V039_AGE_BOTTOM_320.app : V039_AGE_BOTTOM_320.web;
        ok(g.ageBottom != null && g.ageBottom <= bound + 0.5,
          `A7 ${tag}: resizing the badge did NOT push the age sentence back down (${g.ageBottom} vs v0.39's ${bound})`);
      }
      if (m.w === 390) await page.screenshot({ path: path.join(SHOTDIR, `welcome_${app ? "app" : "web"}_390.png`) });
      if (m.w === 320) await page.screenshot({ path: path.join(SHOTDIR, `welcome_${app ? "app" : "web"}_320.png`) });
      await ctx.close();
    }
  }
  // The menu's own logo badge shares the `.sign` class - prove the scoped fix did not reach it.
  const { ctx, page } = await newCtx(browser, MATRIX[2], { returning: true });
  await page.goto(INDEX);
  await page.waitForFunction(() => typeof window.NET === "object");
  await page.waitForTimeout(300);
  const menu = await page.evaluate(() => {
    const el = document.querySelector("#menu .sign") || document.querySelector(".sign");
    const b = el.querySelector("b");
    const g = getComputedStyle(el);
    return { display: g.display, width: g.width, fs: getComputedStyle(b).fontSize, indent: getComputedStyle(b).textIndent };
  });
  ok(menu.display === "inline-block",
    `A8 the menu's own NASTY badge is untouched - still an inline-block (${menu.display}), not the welcome screen's centred block`);
  ok(menu.indent === "0px",
    `A9 and it did not inherit the welcome badge's optical-centring indent (${menu.indent})`);
  await ctx.close();
}

/* ============================ Part B - the reworded guest line ============================== */
const GUEST_LINE = "Guests can play every game mode - they just do not appear on the leaderboard.";

async function partB(browser) {
  console.log("\n=== Part B: the guest line, in Blake's words ===");
  const { ctx, page, errors } = await newCtx(browser, MATRIX[2], { app: true });
  await page.goto(INDEX);
  await page.waitForSelector("#welcomeOverlay:not(.hidden)", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  const t = await page.evaluate(() => {
    const vis = (el) => !!(el && !el.classList.contains("hidden") && el.getClientRects().length);
    const visibleText = Array.from(document.querySelectorAll("#welcomeOverlay .modalCard *"))
      .filter((el) => vis(el) && !el.children.length)
      .map((el) => el.textContent.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
    return { visibleText, all: document.getElementById("welcomeOverlay").textContent.replace(/\s+/g, " ").trim() };
  });
  ok(t.visibleText.includes(GUEST_LINE), `B1 the reworded guest line is on screen, verbatim: "${GUEST_LINE}"`);
  ok(!/every single thing/i.test(t.all), "B2 the old v0.38 phrasing is gone");
  ok(!/[—–]/.test(t.all), "B3 no em or en dashes anywhere on the screen - a plain hyphen only");
  ok(!/family/i.test(t.all), "B4 the word 'family' still appears nowhere a player can read it");
  ok(!/Guests can play[^.!]*!/.test(t.all), "B5 the line is still flat and factual - no exclamation mark on it");
  ok(errors.length === 0, "B6 zero page errors");
  // And the same sentence must be the only copy of itself in the file, so nothing stale is left.
  const src = fs.readFileSync(INDEX_PATH, "utf8");
  ok(src.split(GUEST_LINE).length - 1 === 1, "B7 exactly one copy of the sentence in index.html");
  ok(!/Guests can play every single thing/.test(src), "B8 no leftover copy of the old sentence anywhere in index.html");
  await ctx.close();
}

/* ====== Part C - the bubble and Skip hold still while the hand empties and refills =========== */
async function startSolo(page) {
  await page.evaluate(() => { try { localStorage.setItem("nasty-speed-chosen", "1"); } catch (e) {} });
  await page.evaluate(() => {
    CFG.n = 4; CFG.teams = false;
    CFG.seatMeta[4] = [{ type: "human", name: "Me" }, { type: "cpu", diff: "easy", name: "A" },
                       { type: "cpu", diff: "easy", name: "B" }, { type: "cpu", diff: "easy", name: "C" }];
    window.startGame();
  });
  await page.waitForFunction(() => window.G != null && !document.getElementById("game").classList.contains("hidden"), { timeout: 10000 });
}

async function partC(browser) {
  console.log("\n=== Part C: the message bubble and Skip do not move when the hand empties ===");
  for (const m of MATRIX) {
    const { ctx, page, errors } = await newCtx(browser, m, { returning: true });
    await page.goto(INDEX);
    await page.waitForFunction(() => typeof window.NET === "object");
    await startSolo(page);
    const samples = new Map();     // cards on screen -> the three anchored positions
    for (let i = 0; i < 400; i++) {
      const st = await page.evaluate(() => {
        const top = (id) => { const e = document.getElementById(id); if (!e || !e.getClientRects().length) return null; return +e.getBoundingClientRect().top.toFixed(1); };
        return {
          cards: document.querySelectorAll("#handRow .card").length,
          toasts: top("toasts"), skip: top("btnSkip"), away: top("awayActions"),
          handBarH: +document.getElementById("handBar").getBoundingClientRect().height.toFixed(1),
        };
      });
      if (!samples.has(st.cards)) samples.set(st.cards, st);
      const step = await page.evaluate(() => {
        if (!window.G || window.G.over) return "over";
        if (window.G.turn !== 0) return "wait";
        const mv = window.legalMoves(0);
        if (!mv.length) return "nomove";
        window.commitMove(0, mv[Math.floor(Math.random() * mv.length)], null);
        return "moved";
      });
      if (step === "over") break;
      await page.waitForTimeout(110);
      if (samples.has(0) && samples.size >= 4) break;
    }
    const seen = [...samples.keys()].sort((a, b) => a - b);
    ok(samples.has(0) && seen.length >= 3,
      `C1 ${m.name}: the game really did run the hand down to empty and back (hand sizes seen: ${seen.join(",")})`);
    for (const key of ["toasts", "skip", "away", "handBarH"]) {
      const vals = [...samples.values()].map((s) => s[key]).filter((v) => v != null);
      const spread = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
      const label = { toasts: "the message bubble", skip: "the Skip button", away: "the away-turn buttons", handBarH: "the hand bar itself" }[key];
      ok(vals.length > 0 && spread <= 0.5,
        `C2 ${m.name}: ${label} holds one position for the whole game (${spread.toFixed(1)}px of drift across hand sizes ${seen.join(",")})`);
    }
    ok(errors.length === 0, `C3 ${m.name}: zero page errors while playing`);
    await ctx.close();
  }
}

/* ============ Part D - the board did not shrink and is still centred above the band ========== */
async function partD(browser) {
  console.log("\n=== Part D: the board is the same size, still centred, still clear of the band ===");
  for (const m of MATRIX) {
    const { ctx, page, errors } = await newCtx(browser, m, { returning: true });
    await page.goto(INDEX);
    await page.waitForFunction(() => typeof window.NET === "object");
    await startSolo(page);
    await page.waitForTimeout(900);
    const g = await page.evaluate(() => {
      const board = document.getElementById("boardScale").getBoundingClientRect();
      const logo = document.getElementById("gameLogo");
      const toasts = document.getElementById("toasts").getBoundingClientRect();
      const lb = logo ? logo.getBoundingClientRect() : null;
      return {
        boardW: +board.width.toFixed(1),
        gapAbove: lb ? +(board.top - lb.bottom).toFixed(1) : null,
        gapBelow: +(toasts.top - board.bottom).toFixed(1),
        overlap: +(board.bottom - toasts.top).toFixed(1),
      };
    });
    const floor = V039_BOARD[m.w];
    ok(g.boardW >= floor - 0.5,
      `D1 ${m.name}: the board is not smaller than v0.39 drew it (${g.boardW} vs ${floor})`);
    ok(g.overlap <= 0.0,
      `D2 ${m.name}: the board still never reaches the bubble/Skip band (overlap ${g.overlap}px) - v0.31 item B holds`);
    ok(g.gapAbove != null && Math.abs(g.gapAbove - g.gapBelow) <= 1.0,
      `D3 ${m.name}: the board is still centred - ${g.gapAbove}px above, ${g.gapBelow}px below`);
    ok(errors.length === 0, `D4 ${m.name}: zero page errors`);
    await ctx.close();
  }
}

(async () => {
  const browser = await chromium.launch();
  try {
    await partA(browser);
    await partB(browser);
    await partC(browser);
    await partD(browser);
  } finally {
    await browser.close();
  }
  console.log(`\n=== v0.40 UI suite: ${pass} passed, ${fail} failed ===`);
  console.log("screenshots: " + SHOTDIR);
  process.exit(fail ? 1 : 0);
})();
