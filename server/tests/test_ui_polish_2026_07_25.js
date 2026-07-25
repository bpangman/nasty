/*
 * 2026-07-25 permanent regression suite - the UI polish batch (v0.31).
 *
 * Every item below was found by a real-screenshot/real-geometry review, confirmed by direct
 * measurement, and fixed in index.html. This suite locks each fix in place with the SAME kind of
 * measurement that found the bug in the first place - rendered getBoundingClientRect() geometry
 * and computed styles at the full phone matrix (320x568, 375x667, 390x844, 393x852, 430x932)
 * with real iOS safe-area insets driven through CDP, in BOTH 4-player and 6-player games, using
 * 10-character names (this app's own NAME_MAX) as the standard case rather than the short
 * defaults that hid most of these problems.
 *
 * What each part covers, and the measured BEFORE number it exists to prevent coming back:
 *
 *   A - Player name plaques stay FULLY on screen with a 10-character name, every seat, both
 *       boards, every width. Before: every seat overflowed #boardWrap's overflow:hidden clip,
 *       worst 11.5px at 430x932 4P. Root cause + fix: positionPlaques(), § RENDER.
 *   B - The message band (#toasts + #btnSkip) never overlaps the board, and the "your turn"
 *       prompt is genuinely readable. Before: the board intruded 43.8px into the band at
 *       320x568 4P (38.1 at 320 6P, 20.8 at 375 4P, 14.1 at 375 6P), and .toast.myTurn was a
 *       22%-opacity gold fill carrying gold text - 1.03:1 contrast over the light wood it was
 *       landing on. Fix: #boardWrap's margin-bottom + an opaque backing, § STYLE.
 *   C - "EST. 1993" never lands on the board. Before: 34.9px of overlap at 320x568 4P
 *       (29.2 / 11.8 / 5.1 at 320 6P / 375 4P / 375 6P). Fix: updateLogoSub2(), § RENDER.
 *   D - Tee pick bubbles render at 44px or more. Before: 25.8px at 320 4P, 24.9 at 320 6P,
 *       30.3 at 375, 31.5 at 390, 34.7 at 430 - the app's PRIMARY interaction, every one of them
 *       under the tap-target floor. Fix: scale-compensated R in showBubbles(), § UI.
 *   E - The two dialogs that COST a leaderboard loss put the safe option FIRST, matching the
 *       three harmless ones; the saved-tile affordance says what it does; and the topbar Quit
 *       confirm offers a free way out.
 *   F - The leave sheet's two loss-bearing options are styled `danger`, and its buttons are one
 *       consistent full-width stack. Before: 167 / 130 / 195 / 296 / 167px at 320.
 *   G-K - the narrow-screen clipping cases: host setup segmented controls (29px overflow),
 *       lobby seat Rename button (39px outside its row), menu NASTY sign (21px off the right
 *       edge), setup name inputs (24px of visible text), and long toast messages (silently
 *       sliced by a fixed 60px band).
 *
 * NOTE, same day, after Blake reviewed v0.31 on his phone: the two SHAPES that items G and J
 * used to solve their overflow (the .optRow wrapping its buttons under the label, and the
 * .seatRow wrapping its dropdowns under the name) were both reversed - see his feedback quoted
 * in index.html's § STYLE and the companion suite test_ui_setup_rows_2026_07_25.js. Both
 * OVERFLOW guarantees are unchanged and still asserted here; only item J's visible-text
 * threshold moved, with its reason recorded at the assertion itself.
 *
 * Fully offline (file://) - no server needed.
 * Run: node test_ui_polish_2026_07_25.js
 */

const { chromium } = require('/Users/jarvis/clawd/node_modules/playwright');
const path = require('path');
const fs = require('fs');

const URL = 'file://' + path.resolve(__dirname, '..', '..', 'index.html');
const SHOTDIR = path.resolve('/private/tmp/claude-501/-Users-jarvis/0bc923da-f111-499a-9b51-18988e4aba3d/scratchpad/shots-uipolish');
fs.mkdirSync(SHOTDIR, { recursive: true });

/* Strips /* ... *\/ blocks and whole-line // comments from the app's source. Used by the copy
   checks below: this file's own dated comments quote the OLD wording on purpose (that is how a
   future reader knows what changed), so a naive text search would flag its own explanation. Only
   whole-line // comments are removed, never a trailing one after code - a URL's "//" can't
   truncate a line of real code this way, so the check can't be silently weakened by it. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  OK  ', label); }
  else { fail++; console.log('  FAIL ', label); }
}

// Real device-shaped safe-area insets, same method test_overlay_sizing.js uses - the notch /
// Dynamic Island strip at the top and the home-indicator strip at the bottom genuinely change
// how much room the board and the band have to share, so measuring without them would be
// measuring a phone nobody owns.
const MATRIX = [
  { w: 320, h: 568, insets: { top: 20, bottom: 0, left: 0, right: 0 } },   // iPhone SE 1st gen / 5s
  { w: 375, h: 667, insets: { top: 20, bottom: 0, left: 0, right: 0 } },   // iPhone SE 2nd/3rd gen, 8
  { w: 390, h: 844, insets: { top: 47, bottom: 34, left: 0, right: 0 } },  // iPhone 12/13/14
  { w: 393, h: 852, insets: { top: 59, bottom: 34, left: 0, right: 0 } },  // iPhone 15/16 Pro
  { w: 430, h: 932, insets: { top: 59, bottom: 34, left: 0, right: 0 } },  // iPhone 15/16 Pro Max
];

// NAME_MAX is 10 in index.html. These are all exactly 9 or 10 characters and are deliberately
// letter-wide (M/W/G-heavy) so they produce the widest plate a real family name can.
const LONG_NAMES = ['Michelle', 'Christina', 'Grandmama', 'Alexandria', 'Bartholome', 'Cassiopeia'];
const TEN_CHAR = 'Wilhelmina';   // exactly 10 - the hard limit

async function newCtx(browser, m) {
  const ctx = await browser.newContext({ viewport: { width: m.w, height: m.h }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));
  const cdp = await ctx.newCDPSession(page);
  try { await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: m.insets }); } catch (e) { /* older CDP */ }
  return { ctx, page };
}

// Start a REAL game through the menu, then hold it at the first-run speed picker WITHOUT
// answering it (same fixture style test_stable_bubbles.js uses): the board is fully laid out and
// measurable, but the turn loop has not begun, so nothing moves, no deal fires, and nothing
// clears the message band out from under a measurement. Then rename every seat to the worst-case
// long names and rebuild - buildTable()+fitBoard() is exactly the path a real name change goes
// through, so this measures the real thing rather than a fixture.
async function boardWithLongNames(page, n) {
  await page.goto(URL);
  await page.waitForSelector('#btnStart');
  if (n === 6) await page.click('#p6');
  await page.click('#btnStart');
  await page.waitForFunction(() => window.G && window.LAY, null, { timeout: 25000 });
  await page.evaluate((names) => {
    const sp = document.getElementById('speedPickerOverlay'); if (sp) sp.classList.add('hidden');
    for (let i = 0; i < window.G.n; i++) window.G.seats[i].name = names[i];
    window.buildTable(); window.fitBoard();
  }, LONG_NAMES);
  await page.waitForTimeout(250);
}

/* ===================== Part A: name plaques never leave the screen ===================== */
async function partA(browser) {
  console.log('\n=== Part A: name plaques stay FULLY on screen with 10-character names (4P + 6P, full matrix) ===');
  for (const m of MATRIX) {
    for (const n of [4, 6]) {
      const { ctx, page } = await newCtx(browser, m);
      await boardWithLongNames(page, n);
      const r = await page.evaluate(() => {
        const wrap = document.getElementById('boardWrap').getBoundingClientRect();
        const out = [];
        for (let s = 0; s < window.G.n; s++) {
          const el = document.getElementById('plaque-' + s);
          const b = el.getBoundingClientRect();
          out.push({
            s, name: window.G.seats[s].name,
            over: Math.max(0, wrap.left - b.left, b.right - wrap.right, wrap.top - b.top, b.bottom - wrap.bottom),
            w: b.width, h: b.height,
          });
        }
        return out;
      });
      const worst = Math.max(...r.map((p) => p.over));
      ok(worst <= 0.5,
        `${m.w}x${m.h} ${n}P: every name plate fully inside the board area with long names - worst overflow ${worst.toFixed(1)}px (was up to 11.5px before this fix)`);
      ok(r.every((p) => p.w > 8 && p.h > 8), `${m.w}x${m.h} ${n}P: every plate still has real size (none collapsed by the clamp)`);
      await ctx.close();
    }
  }
  // The absolute worst case: EVERY seat carrying the full 10-character maximum at once.
  for (const n of [4, 6]) {
    const { ctx, page } = await newCtx(browser, MATRIX[0]);
    await freshBoard(page, n);
    await page.evaluate((nm) => {
      for (let i = 0; i < window.G.n; i++) window.G.seats[i].name = nm;
      window.buildTable(); window.fitBoard();
    }, TEN_CHAR);
    await page.waitForTimeout(250);
    const worst = await page.evaluate(() => {
      const wrap = document.getElementById('boardWrap').getBoundingClientRect();
      let w = 0;
      for (let s = 0; s < window.G.n; s++) {
        const b = document.getElementById('plaque-' + s).getBoundingClientRect();
        w = Math.max(w, wrap.left - b.left, b.right - wrap.right, wrap.top - b.top, b.bottom - wrap.bottom);
      }
      return w;
    });
    ok(worst <= 0.5, `320x568 ${n}P: all seats at the full 10-character limit at once - worst overflow ${worst.toFixed(1)}px`);
    await page.screenshot({ path: path.join(SHOTDIR, `plaques_320_${n}p_10char.png`) });
    await ctx.close();
  }
}

/* ============ Part B: the message band never sits on the board, and is readable ============ */
function relLum(rgb) {
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}
function contrast(a, b) {
  const l1 = relLum(a), l2 = relLum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
function parseRGBA(s) {
  const m = s && s.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(',').map((x) => parseFloat(x.trim()));
  return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
}

async function partB(browser) {
  console.log('\n=== Part B: the toast/Skip band never overlaps the board, and the turn prompt is readable ===');
  for (const m of MATRIX) {
    for (const n of [4, 6]) {
      const { ctx, page } = await newCtx(browser, m);
      await boardWithLongNames(page, n);
      await page.evaluate(() => window.turnPrompt('Your turn, Wilhelmina - tap a card', true));
      // .toast animates in with a 0.25s translateY(12px) - measuring before it lands would be
      // measuring the animation, not the layout. This bit us once already while writing this
      // suite (a phantom 12px "baseline" failure at every viewport).
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => {
        const board = document.getElementById('boardScale').getBoundingClientRect();
        const band = document.getElementById('toasts').getBoundingClientRect();
        const skip = document.getElementById('btnSkip').getBoundingClientRect();
        const bubble = document.querySelector('#toasts .toast');
        const bub = bubble ? bubble.getBoundingClientRect() : null;
        const cs = bubble ? getComputedStyle(bubble) : null;
        return {
          intoBand: Math.max(0, board.bottom - band.top),
          intoSkip: Math.max(0, board.bottom - skip.top),
          intoBubble: bub ? Math.max(0, board.bottom - bub.top) : 0,
          myTurn: bubble ? bubble.classList.contains('myTurn') : false,
          bg: cs ? cs.backgroundColor : null,
          fg: cs ? cs.color : null,
          bubbleBottom: bub ? bub.bottom : 0, skipBottom: skip.bottom,
        };
      });
      ok(r.intoBand <= 0.5, `${m.w}x${m.h} ${n}P: the board's bottom edge never reaches the message band (intrusion ${r.intoBand.toFixed(1)}px, was up to 43.8px)`);
      ok(r.intoSkip <= 0.5, `${m.w}x${m.h} ${n}P: the board never reaches the Skip button either (${r.intoSkip.toFixed(1)}px)`);
      ok(r.intoBubble <= 0.5, `${m.w}x${m.h} ${n}P: the board never reaches the live "your turn" bubble (${r.intoBubble.toFixed(1)}px)`);
      ok(r.myTurn, `${m.w}x${m.h} ${n}P: the turn prompt really is the gold .myTurn treatment (so this measured the right thing)`);
      ok(Math.abs(r.bubbleBottom - r.skipBottom) <= 1.5, `${m.w}x${m.h} ${n}P: bubble and Skip still share one baseline (${r.bubbleBottom.toFixed(1)} vs ${r.skipBottom.toFixed(1)})`);
      const bg = parseRGBA(r.bg), fg = parseRGBA(r.fg);
      ok(bg && bg.a >= 0.85, `${m.w}x${m.h} ${n}P: the turn prompt's fill is opaque enough not to depend on what is behind it (alpha ${bg ? bg.a : 'n/a'})`);
      const c = bg && fg ? contrast(bg.rgb, fg.rgb) : 0;
      ok(c >= 4.5, `${m.w}x${m.h} ${n}P: "your turn" text contrast ${c.toFixed(1)}:1 against its own fill (was 1.03:1 over the wood)`);
      if (m.w === 320) await page.screenshot({ path: path.join(SHOTDIR, `band_320_${n}p.png`) });
      await ctx.close();
    }
  }
}

/* ===================== Part C: "EST. 1993" never lands on the board ===================== */
async function partC(browser) {
  console.log('\n=== Part C: the in-game logo\'s "EST. 1993" line never overlaps the board ===');
  for (const m of MATRIX) {
    for (const n of [4, 6]) {
      const { ctx, page } = await newCtx(browser, m);
      await boardWithLongNames(page, n);
      const r = await page.evaluate(() => {
        const sub = document.querySelector('#gameLogo .sub2');
        const board = document.getElementById('boardScale').getBoundingClientRect();
        const vis = getComputedStyle(sub).visibility !== 'hidden' && getComputedStyle(sub).display !== 'none';
        const sr = sub.getBoundingClientRect();
        const logo = document.querySelector('#gameLogo .sign').getBoundingClientRect();
        return { vis, overlap: vis ? Math.max(0, sr.bottom - board.top) : 0, signBottom: logo.bottom, signTop: logo.top };
      });
      ok(r.overlap <= 2.5, `${m.w}x${m.h} ${n}P: "EST. 1993" overlaps the board by ${r.overlap.toFixed(1)}px (was up to 34.9px) - ${r.vis ? 'shown' : 'hidden on this short screen'}`);
      ok(r.signBottom > r.signTop, `${m.w}x${m.h} ${n}P: the NASTY sign itself is untouched and still rendered`);
      await ctx.close();
    }
  }
}

/* =============== Part D: tee pick bubbles are real 44px+ tap targets =============== */
async function freshBoard(page, n) {
  await page.goto(URL);
  await page.waitForSelector('#btnStart');
  if (n === 6) await page.click('#p6');
  await page.click('#btnStart');
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 25000 });
  // Hide the speed picker WITHOUT answering it - leaves every piece in 'base' state, nothing
  // moving. Same fixture style test_stable_bubbles.js uses.
  await page.evaluate(() => { const sp = document.getElementById('speedPickerOverlay'); if (sp) sp.classList.add('hidden'); });
  await page.waitForTimeout(120);
}

async function partD(browser) {
  console.log('\n=== Part D: tee pick bubbles render at 44px or more, and stay distinct (full matrix, 4P + 6P) ===');
  for (const m of MATRIX) {
    for (const n of [4, 6]) {
      const { ctx, page } = await newCtx(browser, m);
      await freshBoard(page, n);
      // The everyday case: the whole stable pickable at once (a King/Ace on a fresh board).
      const r = await page.evaluate(() => {
        window.showBubbles([0, 1, 2, 3, 4].map((pi) => ({ s: 0, pi })), '');
        const els = [...document.querySelectorAll('#bubbleLayer .teeBubble')];
        const rects = els.map((e) => e.getBoundingClientRect());
        let overlap = 0, minGap = Infinity;
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i], b = rects[j];
          const d = Math.hypot((a.left + a.width / 2) - (b.left + b.width / 2), (a.top + a.height / 2) - (b.top + b.height / 2));
          const gap = d - (a.width + b.width) / 2;
          minGap = Math.min(minGap, gap);
          if (gap < -2) overlap++;
        }
        const off = rects.filter((x) => x.left < -0.5 || x.right > window.innerWidth + 0.5 || x.top < -0.5).length;
        const out = { count: rects.length, min: Math.min(...rects.map((x) => x.width)), overlap, minGap, off };
        return out;
      });
      ok(r.count === 5, `${m.w}x${m.h} ${n}P: all 5 stable bubbles rendered (got ${r.count})`);
      ok(r.min >= 44, `${m.w}x${m.h} ${n}P: smallest rendered bubble is ${r.min.toFixed(1)}px - at or above the 44px tap floor (was ${n === 6 ? '24.9-33.4' : '25.8-34.7'}px)`);
      ok(r.overlap === 0, `${m.w}x${m.h} ${n}P: zero pairwise bubble overlap at that size (closest gap ${r.minGap.toFixed(1)}px)`);
      ok(r.off === 0, `${m.w}x${m.h} ${n}P: every bubble fully on screen`);
      if (m.w === 320) await page.screenshot({ path: path.join(SHOTDIR, `bubbles_320_${n}p.png`) });
      await ctx.close();
    }
  }

  console.log('\n--- Part D2: the v0.23 crowded-track sideways dodge still fires, and is never WORSE than before ---');
  for (const n of [4, 6]) {
    const { ctx, page } = await newCtx(browser, MATRIX[0]);
    await freshBoard(page, n);
    const r = await page.evaluate(() => {
      // Two of the same seat's tees on adjacent track holes - v0.23's own fixture shape.
      window.G.pieces[0][0] = { state: 'track', steps: 5 };
      window.G.pieces[0][1] = { state: 'track', steps: 6 };
      window.showBubbles([{ s: 0, pi: 0 }, { s: 0, pi: 1 }], '');
      const els = [...document.querySelectorAll('#bubbleLayer .teeBubble')];
      const sides = els.filter((e) => e.classList.contains('sideL') || e.classList.contains('sideR')).length;
      const rects = els.map((e) => e.getBoundingClientRect());
      let overlap = 0;
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        const d = Math.hypot((a.left + a.width / 2) - (b.left + b.width / 2), (a.top + a.height / 2) - (b.top + b.height / 2));
        if (d < (a.width + b.width) / 2 - 2) overlap++;
      }
      return { count: els.length, sides, overlap, min: Math.min(...rects.map((x) => x.width)) };
    });
    ok(r.count === 2 && r.sides >= 1, `320x568 ${n}P: crowded track bubbles still dodge sideways exactly like v0.23 (${r.sides} side bubbles of ${r.count})`);
    ok(r.overlap === 0, `320x568 ${n}P: the two crowded track bubbles do not overlap`);
    ok(r.min >= 44, `320x568 ${n}P: crowded track bubbles are still ${r.min.toFixed(1)}px - above the tap floor`);
    await ctx.close();
  }

  console.log('\n--- Part D3: a genuinely impossible board falls back to the OLD size, never smaller ---');
  {
    const { ctx, page } = await newCtx(browser, MATRIX[0]);
    await freshBoard(page, 6);
    const r = await page.evaluate(() => {
      // Pathological: five of one seat's tees on five CONSECUTIVE holes, all pickable. No layout
      // of five 44px circles fits that span on a 320px phone - the size negotiation in
      // showBubbles() must fall back, and its floor is the historical 84 board-px size.
      for (let pi = 0; pi < 5; pi++) window.G.pieces[0][pi] = { state: 'track', steps: 3 + pi };
      window.showBubbles([0, 1, 2, 3, 4].map((pi) => ({ s: 0, pi })), '');
      const els = [...document.querySelectorAll('#bubbleLayer .teeBubble')];
      const d = parseFloat(getComputedStyle(els[0]).getPropertyValue('--bubD'));
      return { count: els.length, bubD: d };
    });
    ok(r.count === 5, 'pathological board still renders every bubble');
    ok(r.bubD >= 84 - 0.5, `pathological board falls back to the historical 84 board-px size, never below it (got --bubD ${r.bubD.toFixed(1)})`);
    await ctx.close();
  }
}

/* ========== Part E: safe option FIRST in the two dialogs that cost a loss ========== */
async function partE(browser) {
  console.log('\n=== Part E: the two loss-bearing dialogs put the SAFE option first, and the saved-tile affordance tells the truth ===');
  const { ctx, page } = await newCtx(browser, MATRIX[0]);
  await freshBoard(page, 4);

  // 1. The concede confirm, reached from the topbar Quit button.
  const surr = await page.evaluate(() => {
    document.getElementById('btnMenu').click();
    const btns = [...document.querySelectorAll('#surrenderConfirmOverlay .bigBtns .btn')];
    return {
      open: !document.getElementById('surrenderConfirmOverlay').classList.contains('hidden'),
      ids: btns.map((b) => b.id),
      texts: btns.map((b) => b.textContent.trim()),
      classes: btns.map((b) => b.className),
      widths: btns.map((b) => +b.getBoundingClientRect().width.toFixed(1)),
    };
  });
  ok(surr.open, 'the topbar Quit button still opens the concede confirm');
  ok(surr.ids[0] === 'btnSurrenderCancel', `the SAFE option is first in the concede confirm (got ${JSON.stringify(surr.ids)})`);
  ok(surr.ids[surr.ids.length - 1] === 'btnSurrenderConfirm', 'the destructive option is LAST in the concede confirm');
  ok(/danger/.test(surr.classes[surr.classes.length - 1]), 'the destructive option is still the red danger button');
  ok(surr.ids.includes('btnSurrenderSave'), 'the concede confirm now offers a free "Save & leave instead" route out');
  ok(new Set(surr.widths).size === 1, `all concede-confirm buttons render at one consistent width (got ${JSON.stringify(surr.widths)})`);
  await page.evaluate(() => document.getElementById('btnSurrenderCancel').click());

  // 2. "Save & leave instead" really is the safe path - the game is saved and no loss is written.
  const safeExit = await page.evaluate(() => {
    try { localStorage.removeItem('nasty-stats-v2'); } catch (e) {}
    document.getElementById('btnMenu').click();
    document.getElementById('btnSurrenderSave').click();
    return {
      onMenu: !document.getElementById('menu').classList.contains('hidden'),
      saved: !!(localStorage.getItem('nasty-save-offline-1') || localStorage.getItem('nasty-save-offline-2')),
      stats: localStorage.getItem('nasty-stats-v2'),
    };
  });
  ok(safeExit.onMenu, '"Save & leave instead" lands back on the menu');
  ok(safeExit.saved, '"Save & leave instead" actually kept the game in a save slot');
  ok(!safeExit.stats || !/hg4s/.test(safeExit.stats), `"Save & leave instead" wrote NO loss (stats: ${safeExit.stats})`);

  // 3. The saved-tile affordance: not a trash can, not labelled "delete", and its confirm puts
  //    the safe option first.
  const tile = await page.evaluate(() => {
    const t = document.getElementById('savedGameTrash');
    t.click();
    const row = [...document.querySelectorAll('#savedGameConfirm .savedTileConfirmRow .btn')];
    return {
      icon: t.textContent.trim(),
      aria: t.getAttribute('aria-label'),
      ids: row.map((b) => b.id),
      classes: row.map((b) => b.className),
    };
  });
  ok(!/\u{1F5D1}/u.test(tile.icon), `the saved-game affordance is no longer a trash can (got "${tile.icon}")`);
  ok(/concede|give up/i.test(tile.icon), `its label says what it actually does (got "${tile.icon}")`);
  ok(!/delete/i.test(tile.aria) && /(loss|concede|give up)/i.test(tile.aria), `its accessible label matches the consequence too (got "${tile.aria}")`);
  ok(tile.ids[0] === 'savedGameCancel', `the SAFE option is first in the saved-tile confirm (got ${JSON.stringify(tile.ids)})`);
  ok(/danger/.test(tile.classes[tile.classes.length - 1]), 'the concede option is still the red danger button, and is last');

  // 4. The three harmless dialogs still put their safe option first (they always did - this is
  //    the pattern the two above were made to match, so it is worth pinning down).
  const harmless = await page.evaluate(() => {
    const pick = (sel) => [...document.querySelectorAll(sel + ' .bigBtns .btn')].map((b) => b.id);
    return {
      saveLeave: pick('#saveLeaveConfirmOverlay'),
      overwrite: pick('#overwriteWarnOverlay'),
      leave: pick('#leaveConfirmOverlay'),
    };
  });
  ok(harmless.saveLeave[0] === 'btnSaveLeaveCancel', 'SAVE & LEAVE? still puts "Keep playing" first');
  ok(harmless.overwrite[0] === 'btnOverwriteConfirm', 'REPLACE GAME? layout unchanged');
  ok(harmless.leave[0] === 'btnLeaveCancel', 'the leave sheet still puts "Return to game" first');
  await ctx.close();
}

/* ====== Part F: the leave sheet shows cost, and stops being a ragged pile of widths ====== */
async function partF(browser) {
  console.log('\n=== Part F: the leave sheet - loss-bearing options look expensive, all buttons one width ===');
  for (const m of [MATRIX[0], MATRIX[4]]) {
    const { ctx, page } = await newCtx(browser, m);
    await freshBoard(page, 4);
    const r = await page.evaluate(() => {
      // Force the ONLINE shape too - all five buttons visible at once, the widest case.
      document.getElementById('btnLeaveForGood').classList.remove('hidden');
      document.getElementById('btnResetConnection').classList.remove('hidden');
      document.getElementById('leaveConfirmOverlay').classList.remove('hidden');
      const btns = [...document.querySelectorAll('#leaveConfirmOverlay .bigBtns .btn')];
      return btns.map((b) => ({ id: b.id, cls: b.className, w: +b.getBoundingClientRect().width.toFixed(1), text: b.textContent.trim() }));
    });
    const widths = r.map((b) => b.w);
    ok(new Set(widths).size === 1, `${m.w}x${m.h}: all five leave-sheet buttons render at ONE width (got ${JSON.stringify(widths)}; was 167/130/195/296/167 at 320)`);
    const discard = r.find((b) => b.id === 'btnLeaveDiscard');
    const forGood = r.find((b) => b.id === 'btnLeaveForGood');
    ok(discard && /danger/.test(discard.cls), '"Leave without saving" is styled as costly (it records a loss)');
    ok(forGood && /danger/.test(forGood.cls), '"Have a computer take over my seat" is styled as costly (it records a loss)');
    const save = r.find((b) => b.id === 'btnLeaveSave');
    const reset = r.find((b) => b.id === 'btnResetConnection');
    ok(save && !/danger/.test(save.cls), '"Save & leave" is NOT styled as costly - it is the free one');
    ok(reset && !/danger/.test(reset.cls), 'the connection button is NOT styled as costly - it keeps you at the table');
    ok(reset && !/reset connection/i.test(reset.text), `the connection button is no longer engineer-speak (got "${reset ? reset.text : ''}")`);
    if (m.w === 320) await page.screenshot({ path: path.join(SHOTDIR, 'leavesheet_320.png') });
    await ctx.close();
  }
}

/* ============ Parts G-K: narrow-screen clipping, all measured at the real widths ============ */
async function partGtoK(browser) {
  console.log('\n=== Parts G-K: nothing is silently clipped at narrow widths ===');
  for (const m of MATRIX) {
    const { ctx, page } = await newCtx(browser, m);
    await page.goto(URL);
    await page.waitForSelector('#btnStart');

    // I - the menu's NASTY road sign (was 326.3px inside a 288px content box at 320)
    const sign = await page.evaluate(() => {
      const s = document.querySelector('#menu .sign'), r = s.getBoundingClientRect();
      return { left: r.left, right: r.right, w: r.width, vw: window.innerWidth, docW: document.documentElement.scrollWidth };
    });
    ok(sign.left >= -0.5 && sign.right <= sign.vw + 0.5,
      `${m.w}: (I) the menu NASTY sign is fully on screen - ${sign.w.toFixed(1)}px wide, ${sign.left.toFixed(1)}..${sign.right.toFixed(1)} in a ${sign.vw}px viewport (was 21px off the right edge at 320)`);
    ok(sign.docW <= sign.vw + 0.5, `${m.w}: (I) the menu itself has zero horizontal overflow (scrollWidth ${sign.docW} vs ${sign.vw})`);

    // J - the setup screen's seat name inputs (were down to 24px of visible text)
    const seats = await page.evaluate(() => {
      const row = document.querySelector('.seatRow');
      const input = row.querySelector('input');
      const cs = getComputedStyle(input);
      const r = input.getBoundingClientRect();
      const panel = document.querySelector('.panel').getBoundingClientRect();
      const rows = [...document.querySelectorAll('.seatRow')];
      let clipped = 0;
      rows.forEach((x) => { const b = x.getBoundingClientRect(); if (b.left < panel.left - 0.5 || b.right > panel.right + 0.5) clipped++; });
      return { w: r.width, padL: parseFloat(cs.paddingLeft), padR: parseFloat(cs.paddingRight), clipped };
    });
    const visibleText = seats.w - seats.padL - seats.padR;
    /* 2026-07-25, later the same day - THRESHOLD UPDATED, DELIBERATELY, from 100 to 60.
       Item J bought its 100px+ of visible text by letting .seatRow WRAP onto two lines, and
       Blake rejected that layout as soon as he saw it on his phone ("make the slot to input
       names slightly smaller so the CPU/Human designation and difficulty level all fit on 1
       row"). The seat row is one line again, so the name box is deliberately narrower - 67px
       of visible text at 320 and 88-148px at 375 and up. What this assertion exists to prevent
       is the ORIGINAL bug (a 24px box that truncated every default name mid-word), and 60px is
       comfortably above that while being honest about the one-row budget. The real usability
       check is the one immediately below it, which is unchanged and un-weakened: a full
       10-character name must still fit uncut at every width. See
       test_ui_setup_rows_2026_07_25.js for the full one-row/symmetry coverage. */
    ok(visibleText >= 60, `${m.w}: (J) a seat name input shows ${visibleText.toFixed(0)}px of actual text (was 24px at 320, still clipping a 10-char name at 390)`);
    ok(seats.clipped === 0, `${m.w}: (J) no seat row overflows the setup panel`);

    // J again, with real content: a 10-character name must not be cut off mid-word.
    const nameFits = await page.evaluate((nm) => {
      const input = document.querySelector('.seatRow input');
      input.value = nm;
      // scrollWidth > clientWidth on an <input> is exactly "the value does not fit".
      return { fits: input.scrollWidth <= input.clientWidth + 1, sw: input.scrollWidth, cw: input.clientWidth };
    }, TEN_CHAR);
    ok(nameFits.fits, `${m.w}: (J) a full 10-character name fits in the box without being cut (${nameFits.sw} vs ${nameFits.cw})`);

    // G - the host setup screen's segmented controls (were overflowing the card by 29px)
    const segs = await page.evaluate(() => {
      window.openHostSpeedOverlay();
      const card = document.querySelector('#hostSpeedOverlay .modalCard').getBoundingClientRect();
      const rows = [...document.querySelectorAll('#hostSpeedOverlay .optRow')];
      let worst = 0;
      const detail = rows.map((r) => {
        const b = r.getBoundingClientRect();
        const over = Math.max(0, card.left - b.left, b.right - card.right);
        worst = Math.max(worst, over);
        return { over, w: b.width };
      });
      const segBtns = [...document.querySelectorAll('#hostSpeedOverlay .segs .seg')];
      let segOver = 0;
      segBtns.forEach((s) => { const b = s.getBoundingClientRect(); segOver = Math.max(segOver, card.left - b.left, b.right - card.right); });
      const speedBtns = [...document.querySelectorAll('#hostSpeedBtns .btn')].map((b) => +b.getBoundingClientRect().width.toFixed(1));
      return { worst, segOver: Math.max(0, segOver), detail, speedBtns };
    });
    ok(segs.worst <= 0.5, `${m.w}: (G) host setup's segmented rows stay inside the card (worst ${segs.worst.toFixed(1)}px, was 29px at 320)`);
    ok(segs.segOver <= 0.5, `${m.w}: (G) no individual segment button pokes out of the card (${segs.segOver.toFixed(1)}px)`);

    // N - both speed pickers are the same 2x2 grid with the same plain-English subtitles
    ok(segs.speedBtns.length === 4 && new Set(segs.speedBtns).size === 1,
      `${m.w}: (N) the host speed picker's four tiles are one consistent width (${JSON.stringify(segs.speedBtns)})`);
    const firstRun = await page.evaluate(() => {
      document.getElementById('hostSpeedOverlay').classList.add('hidden');
      document.getElementById('speedPickerOverlay').classList.remove('hidden');
      const btns = [...document.querySelectorAll('#speedPickerBtns .btn')];
      return {
        n: btns.length,
        widths: btns.map((b) => +b.getBoundingClientRect().width.toFixed(1)),
        subs: btns.map((b) => (b.querySelector('small') || {}).textContent || ''),
        grid: getComputedStyle(document.getElementById('speedPickerBtns')).display,
      };
    });
    ok(firstRun.n === 4 && new Set(firstRun.widths).size === 1,
      `${m.w}: (N) the FIRST-RUN speed picker is now the same even grid (${JSON.stringify(firstRun.widths)}, was a ragged stack)`);
    ok(firstRun.grid === 'grid', `${m.w}: (N) the first-run picker really is a grid, matching the host picker`);
    ok(firstRun.subs.every((s) => s && !/x$/.test(s.trim())),
      `${m.w}: (N) both pickers use plain-English subtitles, no "4.3x" multipliers (${JSON.stringify(firstRun.subs)})`);
    await page.evaluate(() => document.getElementById('speedPickerOverlay').classList.add('hidden'));

    // H - the lobby seat row's Rename button (was pushed 39px outside its row)
    const lobby = await page.evaluate((nm) => {
      const host = document.createElement('div');
      host.className = 'panel';
      host.style.cssText = 'position:fixed;left:0;top:0;width:100%';
      host.id = '__lobbyProbe';
      const row = document.createElement('div');
      row.className = 'lobbySeat';
      row.innerHTML = '<span class="dot" style="background:#c33"></span>' +
        '<span class="nm">' + nm + nm + '</span>' +
        '<span class="st">ready</span>' +
        '<button>Rename</button>';
      host.appendChild(row);
      document.body.appendChild(host);
      const rb = row.getBoundingClientRect(), bb = row.querySelector('button').getBoundingClientRect();
      const nmEl = row.querySelector('.nm').getBoundingClientRect();
      const out = { over: Math.max(0, bb.right - rb.right, rb.left - bb.left), rowW: rb.width, btnRight: bb.right, rowRight: rb.right, nmW: nmEl.width };
      host.remove();
      return out;
    }, TEN_CHAR);
    ok(lobby.over <= 0.5, `${m.w}: (H) the lobby Rename button stays inside its own row even with a 20-char name (${lobby.over.toFixed(1)}px out, was 39px at 320)`);

    // K - a long toast message is never sliced
    await page.evaluate(() => { document.getElementById('menu').classList.add('hidden'); document.getElementById('game').classList.remove('hidden'); });
    const toastFit = await page.evaluate((nm) => {
      window.toast('\u{1F4A5} NASTY! ' + nm + ' sends ' + nm + ' back to base!', 4000, true);
      const t = document.querySelector('#toasts .toast');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { clipped: t.scrollHeight > t.clientHeight + 1, h: r.height, sh: t.scrollHeight, ch: t.clientHeight, top: r.top, bottom: r.bottom, vh: window.innerHeight };
    }, TEN_CHAR);
    ok(toastFit && !toastFit.clipped,
      `${m.w}: (K) the "NASTY! X sends Y back to base!" message with two 10-char names is fully visible, not sliced (scrollHeight ${toastFit ? toastFit.sh : '?'} vs clientHeight ${toastFit ? toastFit.ch : '?'}; the box grew to ${toastFit ? toastFit.h.toFixed(0) : '?'}px)`);
    ok(toastFit && toastFit.top >= -0.5 && toastFit.bottom <= toastFit.vh + 0.5, `${m.w}: (K) the grown bubble is still fully on screen`);
    await ctx.close();
  }
}

/* ============ Part L-V: the smaller polish items, pinned so they cannot drift back ============ */
async function partPolish(browser) {
  console.log('\n=== Parts L, M, O, P, Q, S, T, U, V: wording, tap targets, reduced motion, dead cards ===');
  const { ctx, page } = await newCtx(browser, MATRIX[2]);
  await page.goto(URL);
  await page.waitForSelector('#btnStart');

  // L + M: no "CPU" left in user-visible copy, no leading glyphs on buttons, no Title Case strays
  const copy = await page.evaluate(() => {
    const texts = [];
    document.querySelectorAll('button,.btn,.t1,#lbCaption,h3,option').forEach((el) => {
      if (el.children.length === 0 || el.tagName === 'OPTION') texts.push({ id: el.id || el.className, t: (el.textContent || '').trim() });
    });
    return texts.filter((x) => x.t);
  });
  const cpuLeft = copy.filter((x) => /\bCPUs?\b/.test(x.t));
  ok(cpuLeft.length === 0, `(L) no user-visible control still says "CPU" (${JSON.stringify(cpuLeft.slice(0, 4))})`);
  // An icon-ONLY control (the win overlay's close X, which carries a real aria-label and no text
  // label at all) is the icon, not a label with a glyph bolted on front - out of scope for item M,
  // which was about buttons whose WORDS were being prefixed.
  const glyphed = copy.filter((x) => x.t.length > 2 && /^[\u{1F300}-\u{1FAFF}\u{2190}-\u{27BF}\u{FE0F}]/u.test(x.t));
  ok(glyphed.length === 0, `(M) no button starts with a decorative glyph any more (${JSON.stringify(glyphed.slice(0, 4))})`);
  const captions = await page.evaluate(() => document.getElementById('lbCaption').textContent);
  ok(!/\bpegs?\b/i.test(captions), `(L) the leaderboard caption says tees, not pegs (got "${captions.slice(0, 90)}...")`);

  // V: one kind of ellipsis, the real one.
  // Checked against the SOURCE with comments removed rather than against innerHTML: this file's
  // dated comments deliberately quote the old wording to explain what changed and why, and a
  // check that could not tell a comment from a live string would be permanently red.
  const src = stripComments(fs.readFileSync(path.resolve(__dirname, '..', '..', 'index.html'), 'utf8'));
  ok(!/Recalibrating\.\.\.|Reconnecting\.\.\.|Asking the computer\.\.\./.test(src), '(V) the three-dot spellings of the connection/computer wait messages are gone from the live copy');

  // U: the deck-count chip's contrast
  const deck = await page.evaluate(() => {
    const el = document.getElementById('deckCount');
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, fg: cs.color };
  });
  const dbg = parseRGBA(deck.bg), dfg = parseRGBA(deck.fg);
  ok(dbg && dbg.a >= 0.65, `(U) the deck-count pill is dark enough not to let the wood through (alpha ${dbg ? dbg.a : '?'}, was 0.35)`);
  ok(dbg && dfg && contrast([dbg.rgb[0] * dbg.a, dbg.rgb[1] * dbg.a, dbg.rgb[2] * dbg.a], dfg.rgb) >= 4.5,
    `(U) deck-count text contrast against its own pill is ${dbg && dfg ? contrast([dbg.rgb[0] * dbg.a, dbg.rgb[1] * dbg.a, dbg.rgb[2] * dbg.a], dfg.rgb).toFixed(1) : '?'}:1 (was ~2.5:1)`);

  // Q: the away-ladder buttons finally meet the 44px floor
  const away = await page.evaluate(() => {
    const row = document.getElementById('awayActions');
    const b = document.createElement('button'); b.textContent = 'Wait for them';
    row.appendChild(b);
    const h = b.getBoundingClientRect().height;
    row.innerHTML = '';
    return h;
  });
  ok(away >= 44, `(Q) away-ladder buttons are ${away.toFixed(1)}px tall - at the 44px floor (were 29px)`);

  // O: reduced motion actually reaches the infinite animations, and re-reads live
  await ctx.close();
  const rmCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const rm = await rmCtx.newPage();
  await rm.goto(URL);
  await rm.waitForSelector('#btnStart');
  const anims = await rm.evaluate(() => {
    const mk = (cls, parent) => {
      const d = document.createElement('div');
      d.className = cls;
      (parent || document.body).appendChild(d);
      const a = getComputedStyle(d).animationName;
      d.remove();
      return a;
    };
    return {
      kill: mk('pathDot pathKill'),
      spotlight: mk('tee spotlightGlow'),
      conn: (() => { const el = document.getElementById('connIndicator'); el.classList.add('reconnecting'); const a = getComputedStyle(el).animationName; el.classList.remove('reconnecting'); return a; })(),
      bubble: mk('teeBubble'),
      ring: mk('changeRing'),
      reducedFlag: REDUCED,
    };
  });
  ok(anims.kill === 'none', `(O) the red kill-dot pulse is off under Reduce Motion (got ${anims.kill})`);
  ok(anims.spotlight === 'none', `(O) the skip spotlight glow is off under Reduce Motion (got ${anims.spotlight})`);
  ok(anims.conn === 'none', `(O) the connection chip's pulse is off under Reduce Motion (got ${anims.conn})`);
  ok(anims.bubble === 'none', `(O) the tee bubble pulse stays off (unchanged, was already covered)`);
  ok(anims.ring === 'none', `(O) the one-shot change ring is off too (got ${anims.ring})`);
  // The confetti gate is JS, not CSS - prove it by counting what actually lands in the DOM.
  const confetti = await rm.evaluate(() => {
    window.G = { winners: [0], seats: [{ color: { c: '#fff' } }] };
    window.confettiBurst();
    const n = document.querySelectorAll('.confetti').length;
    document.querySelectorAll('.confetti').forEach((c) => c.remove());
    return n;
  });
  ok(confetti === 0, `(O) confettiBurst() creates ZERO elements under Reduce Motion (got ${confetti}; it used to always make 90)`);
  // The live listener: REDUCED must be a re-readable binding, not a load-time constant.
  const live = await rm.evaluate(() => {
    // Top-level `let`/`const` in a classic script live in the global LEXICAL environment, not on
    // `window` - so this has to be read as a bare identifier, which is exactly how the app's own
    // code reads it.
    const before = REDUCED;
    // Emulation below flips the real media query; this just proves the binding is writable-by-
    // the-listener rather than frozen at load (a `const` would throw here).
    let assignable = true;
    try { window.eval('REDUCED = REDUCED;'); } catch (e) { assignable = false; }
    return { before, assignable };
  });
  ok(live.before === true, '(O) REDUCED reflects the emulated Reduce Motion setting');
  ok(live.assignable, '(O) REDUCED is a live binding a media-query change listener can update (it was a const read once at load)');
  await rmCtx.close();

  // P + T: dead cards explain themselves; deselecting keeps the player's name in the prompt
  const { ctx: c2, page: p2 } = await newCtx(browser, MATRIX[2]);
  await freshBoard(p2, 4);
  const dead = await p2.evaluate(() => {
    // Arm seat 0's hand with a hand where only one card is playable, then tap a dead one.
    const row = document.getElementById('handRow');
    row.innerHTML = '<div class="card" data-ci="0"></div><div class="card" data-ci="1"></div>';
    window.G.hands[0] = [{ r: 'Q', s: '♠' }, { r: '3', s: '♥' }];
    window.enableSelection(0, [{ ci: 0 }]);
    const deadCard = row.querySelector('[data-ci="1"]');
    const cursor = getComputedStyle(deadCard).cursor;
    const hasHandler = typeof deadCard.onclick === 'function';
    deadCard.onclick();
    const t = document.querySelector('#toasts .toast');
    return { cursor, hasHandler, msg: t ? t.textContent : null, isDead: deadCard.classList.contains('dead') };
  });
  ok(dead.isDead, '(P) the unplayable card really is marked dead (so this measured the right card)');
  ok(dead.hasHandler, '(P) an unplayable card now has a tap handler at all - it used to be a silent no-op');
  ok(dead.cursor !== 'pointer', `(P) an unplayable card no longer shows a pointer cursor it cannot honour (got "${dead.cursor}")`);
  ok(dead.msg && /3 .*backward/i.test(dead.msg), `(P) tapping it explains WHY in plain language (got "${dead.msg}")`);

  const prompt = await p2.evaluate(() => {
    window.G.seats[0].name = 'Wilhelmina';
    window.CUR_SEAT = 0;
    window.clearSelection(true);
    const t = document.querySelector('#toasts .toast');
    return t ? t.textContent : null;
  });
  ok(prompt && /Wilhelmina/.test(prompt), `(T) deselecting a card keeps the player's NAME in the turn prompt (got "${prompt}")`);

  // S: the move-failure message no longer points at a button that does not exist (same
  // comment-stripped source check as V above, for the same reason).
  const src2 = stripComments(fs.readFileSync(path.resolve(__dirname, '..', '..', 'index.html'), 'utf8'));
  ok(!/Menu\s*(→|-&gt;|->)\s*Resume/.test(src2), '(S) the move-failure message no longer sends the player to a "Menu" button that has not existed since v0.27');
  ok(!/reload the page/i.test(src2), '(S) it no longer says "reload the page", which means nothing inside the iOS app');
  await c2.close();
}

/* ============ Part R: scrollable cards say so ============ */
async function partR(browser) {
  console.log('\n=== Part R: a scrollable modal shows that it scrolls, so the primary action is findable ===');
  const { ctx, page } = await newCtx(browser, MATRIX[0]);
  await page.goto(URL);
  await page.waitForSelector('#btnStart');
  const r = await page.evaluate(async () => {
    document.getElementById('rulesOverlay').classList.remove('hidden');
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const ov = document.getElementById('rulesOverlay');
    const card = ov.querySelector('.modalCard');
    const scrolls = card.scrollHeight - card.clientHeight > 6 || ov.scrollHeight - ov.clientHeight > 6;
    return { scrolls, hinted: ov.classList.contains('canScroll') };
  });
  ok(r.scrolls, '320x568: the rules panel genuinely is scrollable there (so this is testing a real case)');
  ok(r.hinted, '320x568: and it now carries the .canScroll hint (bottom fade + "more below - swipe up")');

  const bottom = await page.evaluate(async () => {
    const ov = document.getElementById('rulesOverlay');
    const card = ov.querySelector('.modalCard');
    card.scrollTop = card.scrollHeight;
    ov.scrollTop = ov.scrollHeight;
    await new Promise((res) => setTimeout(res, 60));
    return ov.classList.contains('canScroll');
  });
  ok(!bottom, '320x568: once scrolled to the bottom, the hint takes itself away instead of nagging');
  await page.screenshot({ path: path.join(SHOTDIR, 'scrollhint_320_rules.png') });
  await ctx.close();
}

async function main() {
  const browser = await chromium.launch();
  try {
    await partA(browser);
    await partB(browser);
    await partC(browser);
    await partD(browser);
    await partE(browser);
    await partF(browser);
    await partGtoK(browser);
    await partPolish(browser);
    await partR(browser);
  } finally {
    await browser.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('screenshots in ' + SHOTDIR);
  process.exit(fail ? 1 : 0);
}
main();
