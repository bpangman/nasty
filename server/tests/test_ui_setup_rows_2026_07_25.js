/*
 * 2026-07-25 permanent regression suite - the setup / main-menu screen layout (v0.32).
 *
 * WHY THIS FILE EXISTS. v0.31 shipped a 22-item UI polish batch. Two of its narrow-screen
 * clipping fixes solved a real overflow with a layout Blake rejected the moment he saw it on
 * his phone, in his own words:
 *
 *   1. "on the main menu page, make the slot to input names (even for the CPU's) slightly
 *       smaller so the CPU/Human designation and difficulty level all fit on 1 row. This should
 *       all be symmetrical, but the current design doesn't work"
 *      (v0.31 item J had let .seatRow WRAP - colour dot + name on line one, the Human/computer
 *       and difficulty dropdowns underneath - which made every seat row 112px tall at every
 *       width and left the difficulty dropdown hanging on a line of its own.)
 *
 *   2. "Same thing with Everyone for themselves and Teams (it's okay to make these buttons 2
 *       rows thick for symmetry like it was before). I don't like how both these options are
 *       now below game type while players is in the same row as the options (how these were
 *       before)"
 *      (v0.31 item G had let .optRow WRAP, so GAME TYPE's two buttons dropped underneath their
 *       label while the PLAYERS row above kept its buttons beside the label.)
 *
 * So v0.32 reverses both SHAPES while keeping both OVERFLOW guarantees. This suite locks the
 * new intended behaviour in with the same kind of real rendered geometry that found the
 * original problems: getBoundingClientRect() at the full phone matrix (320x568, 375x667,
 * 390x844, 393x852, 430x932) with real iOS safe-area insets driven through CDP, in BOTH the
 * 4-player and the 6-player seat list, with a mix of Human and computer seats, and with
 * 10-character names (this app's own NAME_MAX).
 *
 * What it asserts, per viewport, per seat count, per seat mix:
 *   1  Every .seatRow is ONE line - all its visible controls share a vertical centre.
 *   2  Every .seatRow is the same height as every other one.
 *   3  Symmetry: the Human/computer dropdown is the same width on every row, the difficulty
 *      dropdown is the same width on every row, and the name box is the same width on every
 *      row - so the four columns run straight down the list.
 *   4  A human seat's HIDDEN difficulty dropdown still holds its column open (visibility, not
 *      display), so human rows line up with computer rows instead of stretching.
 *   5  Zero horizontal overflow: no row, no control, and no options row pokes out of the panel,
 *      and the document never scrolls sideways.
 *   6  The name box shows a genuinely usable amount of text (the measured number is printed),
 *      and a full 10-character name fits uncut - the original bug this must never re-create was
 *      a 60px box with 24px of visible text that truncated every default name mid-word.
 *   7  GAME TYPE's label and its buttons share a line, exactly like PLAYERS - checked as real
 *      geometry (the label's vertical span overlaps the options block's), not as a class name.
 *   8  The PLAYERS options block and the GAME TYPE options block are the same width and start
 *      at the same left edge - Blake's "this should all be symmetrical".
 *   9  Every control on the screen still clears the 44px tap-target floor.
 *  10  The same overflow guarantee on the OTHER screens that reuse .optRow / .segs (the host
 *      setup overlay, the join overlay, the admin overlay) and on the leaderboard's standalone
 *      .segs tabs, which must keep their normal left alignment rather than inheriting the
 *      .optRow right-alignment.
 *
 * Fully offline (file://) - no server needed.
 * Run: node test_ui_setup_rows_2026_07_25.js
 */

const { chromium } = require('/Users/jarvis/clawd/node_modules/playwright');
// v0.36 (2026-07-26): seed the first-run sign-in screen's answer before the page boots, so
// this suite runs as the returning player it was always written about. Real key, real code
// path, no stub - see test_ui_v036_welcome_bypass.js.
require("./test_ui_v036_welcome_bypass.js").patch(chromium);

const path = require('path');
const fs = require('fs');

const URL = 'file://' + path.resolve(__dirname, '..', '..', 'index.html');
const SHOTDIR = path.resolve('/private/tmp/claude-501/-Users-jarvis/0bc923da-f111-499a-9b51-18988e4aba3d/scratchpad/shots-setuprows');
fs.mkdirSync(SHOTDIR, { recursive: true });

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  OK  ', label); }
  else { fail++; console.log('  FAIL ', label); }
}

// Same device-shaped safe-area insets the rest of the UI suites use - the notch strip and the
// home-indicator strip genuinely change how much room a screen has, so measuring without them
// would be measuring a phone nobody owns.
const MATRIX = [
  { w: 320, h: 568, insets: { top: 20, bottom: 0, left: 0, right: 0 } },   // iPhone SE 1st gen / 5s
  { w: 375, h: 667, insets: { top: 20, bottom: 0, left: 0, right: 0 } },   // iPhone SE 2nd/3rd gen, 8
  { w: 390, h: 844, insets: { top: 47, bottom: 34, left: 0, right: 0 } },  // iPhone 12/13/14
  { w: 393, h: 852, insets: { top: 59, bottom: 34, left: 0, right: 0 } },  // iPhone 15/16 Pro
  { w: 430, h: 932, insets: { top: 59, bottom: 34, left: 0, right: 0 } },  // iPhone 15/16 Pro Max
];

const TEN_CHAR = 'Wilhelmina';   // exactly NAME_MAX

// Three seat mixes, because the difficulty dropdown is only shown on computer seats and the
// whole point of item 1 is that a human row still lines up with a computer row.
const MIXES = [
  { key: 'all-computer', fn: () => 'cpu' },
  { key: 'all-human', fn: () => 'human' },
  { key: 'alternating', fn: (i) => (i % 2 === 0 ? 'human' : 'cpu') },
];

async function newCtx(browser, m) {
  const ctx = await browser.newContext({ viewport: { width: m.w, height: m.h }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));
  const cdp = await ctx.newCDPSession(page);
  try { await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: m.insets }); } catch (e) { /* older CDP */ }
  return { ctx, page };
}

/* Sets the seat list to n players, applies a Human/computer mix, and puts a full-length name in
   every box - the worst realistic case, and the one that hid the original bug from every
   earlier test pass (the short default names fit even in a broken box). */
async function setUpSeats(page, n, mixKey, tenChar) {
  return page.evaluate(([nn, mk, nm]) => {
    document.getElementById(nn === 4 ? 'p4' : 'p6').click();
    const pick = { 'all-computer': () => 'cpu', 'all-human': () => 'human', alternating: (i) => (i % 2 === 0 ? 'human' : 'cpu') }[mk];
    [...document.querySelectorAll('.seatRow')].forEach((r, i) => {
      const ts = r.querySelector('.typeSel');
      ts.value = pick(i);
      ts.dispatchEvent(new Event('change'));
    });
    [...document.querySelectorAll('.seatRow input')].forEach((inp) => {
      inp.value = nm;
      inp.dispatchEvent(new Event('input'));
    });
    return document.querySelectorAll('.seatRow').length;
  }, [n, mixKey, tenChar]);
}

/* ============ Part 1: the seat rows are one line, identical, and symmetrical ============ */
async function partSeatRows(browser) {
  console.log('\n=== Part 1: every seat row is ONE line, all rows identical, columns symmetrical ===');
  for (const m of MATRIX) {
    const { ctx, page } = await newCtx(browser, m);
    await page.goto(URL);
    await page.waitForSelector('#btnStart');

    for (const n of [4, 6]) {
      for (const mix of MIXES) {
        const count = await setUpSeats(page, n, mix.key, TEN_CHAR);
        ok(count === n, `${m.w} ${n}P ${mix.key}: the seat list really has ${n} rows (${count})`);

        const d = await page.evaluate(() => {
          const panel = document.querySelector('.panel').getBoundingClientRect();
          const rows = [...document.querySelectorAll('.seatRow')];
          return rows.map((r) => {
            const b = r.getBoundingClientRect();
            const kids = [...r.children].map((k) => {
              const kb = k.getBoundingClientRect();
              const cs = getComputedStyle(k);
              return {
                cls: (k.className || '').toString().split(' ')[0] || k.tagName.toLowerCase(),
                w: +kb.width.toFixed(2), h: +kb.height.toFixed(2),
                cy: +(kb.top + kb.height / 2).toFixed(2),
                vis: cs.visibility, disp: cs.display,
                over: +Math.max(0, panel.left - kb.left, kb.right - panel.right).toFixed(2),
              };
            });
            return {
              h: +b.height.toFixed(2),
              over: +Math.max(0, panel.left - b.left, b.right - panel.right).toFixed(2),
              scrollOver: r.scrollWidth - r.clientWidth,
              kids,
            };
          });
        });

        // 1 - one line: every control in a row shares a vertical centre. (Tops differ on
        // purpose: the colour dot is 20px tall and the controls are 44px, all centred.)
        const spread = Math.max(...d.map((r) => {
          const cys = r.kids.map((k) => k.cy);
          return Math.max(...cys) - Math.min(...cys);
        }));
        ok(spread <= 2, `${m.w} ${n}P ${mix.key}: every control in every seat row is on ONE line (worst centre spread ${spread.toFixed(2)}px; the rejected v0.31 layout put the difficulty dropdown 52px below the others)`);

        // 2 - all rows the same height, and that height is a single-line height.
        const heights = [...new Set(d.map((r) => r.h))];
        ok(heights.length === 1, `${m.w} ${n}P ${mix.key}: every seat row is exactly the same height (${heights.join(' / ')}px)`);
        ok(heights[0] <= 80, `${m.w} ${n}P ${mix.key}: a seat row is a single-line height, ${heights[0]}px (the rejected two-line layout was 112px at every width)`);

        // 3 - symmetry: matching control widths straight down the list.
        const byCol = (i) => [...new Set(d.map((r) => r.kids[i].w))];
        const [dotW, nameW, typeW, diffW] = [byCol(0), byCol(1), byCol(2), byCol(3)];
        ok(dotW.length === 1, `${m.w} ${n}P ${mix.key}: the colour dot is one width on every row (${dotW.join('/')}px)`);
        ok(nameW.length === 1, `${m.w} ${n}P ${mix.key}: the name box is one width on every row (${nameW.join('/')}px)`);
        ok(typeW.length === 1, `${m.w} ${n}P ${mix.key}: the Human/computer dropdown is one width on every row (${typeW.join('/')}px)`);
        ok(diffW.length === 1, `${m.w} ${n}P ${mix.key}: the difficulty dropdown is one width on every row, shown or hidden (${diffW.join('/')}px)`);

        // 4 - a hidden difficulty dropdown still holds its column open.
        const humanRows = d.filter((r) => r.kids[3].vis === 'hidden');
        const cpuRows = d.filter((r) => r.kids[3].vis === 'visible');
        if (humanRows.length && cpuRows.length) {
          ok(humanRows[0].kids[1].w === cpuRows[0].kids[1].w,
            `${m.w} ${n}P ${mix.key}: a human seat's name box is the SAME width as a computer seat's (${humanRows[0].kids[1].w}px) - the hidden difficulty dropdown holds its column instead of the row stretching`);
        }
        if (humanRows.length) {
          ok(humanRows.every((r) => r.kids[3].disp !== 'none' && r.kids[3].w > 0),
            `${m.w} ${n}P ${mix.key}: the hidden difficulty dropdown still occupies its ${humanRows[0].kids[3].w}px column (visibility, not display:none)`);
        }

        // 5 - zero horizontal overflow, row by row and control by control.
        const worstRow = Math.max(...d.map((r) => r.over));
        const worstKid = Math.max(...d.map((r) => Math.max(...r.kids.map((k) => k.over))));
        const worstScroll = Math.max(...d.map((r) => r.scrollOver));
        ok(worstRow <= 0.5, `${m.w} ${n}P ${mix.key}: no seat row pokes out of the panel (${worstRow.toFixed(2)}px)`);
        ok(worstKid <= 0.5, `${m.w} ${n}P ${mix.key}: no control inside a seat row pokes out of the panel (${worstKid.toFixed(2)}px)`);
        ok(worstScroll <= 1, `${m.w} ${n}P ${mix.key}: no seat row scrolls its own contents sideways (${worstScroll}px)`);

        // 9 - tap targets. The colour dot is a decoration, not a control, so it is exempt.
        const tapFloor = Math.min(...d.map((r) => Math.min(...r.kids.slice(1).map((k) => k.h))));
        ok(tapFloor >= 44, `${m.w} ${n}P ${mix.key}: every control in a seat row still clears the 44px tap-target floor (smallest ${tapFloor}px)`);
      }
    }
    await ctx.close();
  }
}

/* ============ Part 2: the name box stays genuinely usable ============ */
async function partNameBox(browser) {
  console.log('\n=== Part 2: the name box is smaller, but still readable and never truncating ===');
  for (const m of MATRIX) {
    const { ctx, page } = await newCtx(browser, m);
    await page.goto(URL);
    await page.waitForSelector('#btnStart');

    for (const n of [4, 6]) {
      await setUpSeats(page, n, 'alternating', TEN_CHAR);
      const d = await page.evaluate((nm) => {
        const inputs = [...document.querySelectorAll('.seatRow input')];
        const first = inputs[0];
        const cs = getComputedStyle(first);
        const r = first.getBoundingClientRect();
        // scrollWidth > clientWidth on an <input> is exactly "the value does not fit".
        const anyCut = inputs.some((i) => i.scrollWidth > i.clientWidth + 1);
        const values = inputs.map((i) => i.value);
        return {
          w: +r.width.toFixed(2),
          padL: parseFloat(cs.paddingLeft), padR: parseFloat(cs.paddingRight),
          fontSize: parseFloat(cs.fontSize),
          anyCut, values, sw: first.scrollWidth, cw: first.clientWidth,
        };
      }, TEN_CHAR);
      const visible = +(d.w - d.padL - d.padR).toFixed(1);
      /* 60px is the floor this whole exercise is about. The ORIGINAL bug (pre-v0.31) was a
         60px-WIDE box whose own padding left 24px of actual text, which truncated even the
         short default names mid-word. Anything at or above 60px of real text is more than
         double that, and the un-truncated 10-character check below is the real proof. */
      ok(visible >= 60, `${m.w} ${n}P: the name box shows ${visible}px of actual text at ${d.fontSize}px type (the bug this replaces left 24px)`);
      ok(!d.anyCut, `${m.w} ${n}P: a full 10-character name fits uncut in EVERY seat's box (first box ${d.sw} vs ${d.cw})`);
      ok(d.values.every((v) => v === TEN_CHAR), `${m.w} ${n}P: all ${n} boxes really hold the 10-character name`);
    }
    await ctx.close();
  }
}

/* ============ Part 3: GAME TYPE reads like PLAYERS - label and options on one line ============ */
async function partOptRows(browser) {
  console.log('\n=== Part 3: GAME TYPE\'s label and its buttons share a line, exactly like PLAYERS ===');
  for (const m of MATRIX) {
    const { ctx, page } = await newCtx(browser, m);
    await page.goto(URL);
    await page.waitForSelector('#btnStart');

    const d = await page.evaluate(() => {
      const panel = document.querySelector('.panel').getBoundingClientRect();
      const rows = [...document.querySelectorAll('#menu .optRow')];
      return {
        panelW: +panel.width.toFixed(2),
        rows: rows.map((r) => {
          const b = r.getBoundingClientRect();
          const lab = r.querySelector('label');
          const lb = lab.getBoundingClientRect();
          const segsEl = r.querySelector('.segs');
          const sb = segsEl.getBoundingClientRect();
          const btns = [...r.querySelectorAll('.seg')].map((s) => {
            const bb = s.getBoundingClientRect();
            return {
              text: s.textContent, w: +bb.width.toFixed(2), h: +bb.height.toFixed(2),
              top: +bb.top.toFixed(2),
              over: +Math.max(0, panel.left - bb.left, bb.right - panel.right).toFixed(2),
            };
          });
          return {
            label: lab.textContent,
            // "Same line" as real geometry: the two boxes' vertical spans overlap. The rejected
            // v0.31 layout had the buttons starting strictly BELOW the label's bottom edge.
            sameLine: sb.top < lb.bottom - 0.5 && lb.top < sb.bottom - 0.5,
            labelBottom: +lb.bottom.toFixed(2), segsTop: +sb.top.toFixed(2),
            labelRight: +lb.right.toFixed(2),
            segsLeft: +sb.left.toFixed(2), segsW: +sb.width.toFixed(2),
            rowOver: +Math.max(0, panel.left - b.left, b.right - panel.right).toFixed(2),
            segsScrollOver: segsEl.scrollWidth - segsEl.clientWidth,
            btns,
          };
        }),
        docW: document.documentElement.scrollWidth,
        vw: window.innerWidth,
      };
    });

    const players = d.rows.find((r) => /players/i.test(r.label));
    const gameType = d.rows.find((r) => /game type/i.test(r.label));

    ok(players && gameType, `${m.w}: the setup card has both a PLAYERS row and a GAME TYPE row`);
    ok(players.sameLine, `${m.w}: PLAYERS keeps its label and its buttons on one line (label bottom ${players.labelBottom}, buttons top ${players.segsTop})`);
    ok(gameType.sameLine, `${m.w}: GAME TYPE's label and its buttons now share a line too (label bottom ${gameType.labelBottom}, buttons top ${gameType.segsTop}) - in v0.31 the buttons started strictly below the label, which is what Blake rejected`);

    // 8 - the two option blocks are the same width and the same left edge.
    ok(Math.abs(players.segsW - gameType.segsW) <= 0.5,
      `${m.w}: the PLAYERS and GAME TYPE option blocks are the same width (${players.segsW} vs ${gameType.segsW}px)`);
    ok(Math.abs(players.segsLeft - gameType.segsLeft) <= 0.5,
      `${m.w}: the two option blocks start at the same left edge (${players.segsLeft} vs ${gameType.segsLeft}px)`);
    /* 2026-07-25 (Blake, v0.34): "Can you make the buttons have a little space away from 'game
       type' but still have them start even with the ones above them?" The gap between the label
       column and the first button must be a real, visible gap on BOTH rows, and the same one. */
    for (const [label, row] of [['PLAYERS', players], ['GAME TYPE', gameType]]) {
      const gap = +(row.segsLeft - row.labelRight).toFixed(2);
      ok(gap >= 10, `${m.w}: ${label}'s buttons stand clear of its label (${gap}px of gap)`);
    }
    ok(Math.abs((players.segsLeft - players.labelRight) - (gameType.segsLeft - gameType.labelRight)) <= 0.5,
      `${m.w}: both rows use the SAME label-to-buttons gap (${(players.segsLeft - players.labelRight).toFixed(2)} vs ${(gameType.segsLeft - gameType.labelRight).toFixed(2)}px)`);

    /* Within a block, every LINE of buttons fills the block edge to edge - so if a button ever
       does drop under its neighbour on a narrow phone the two read as one tidy stacked pair
       (both full width) rather than a big button with a little one hanging off it, and when they
       fit side by side they still fill the row. Deliberately NOT "both buttons are the same
       width": they share their line in proportion to their own text, which is what a segmented
       control should look like.
       2026-07-25 (v0.34): "Everyone for themselves" was renamed to "FFA" (Blake asked for the
       free-for-all phrasing), which is short enough that the GAME TYPE block now sits on ONE line
       at every width in this matrix, 320 included. This check is unchanged and simply passes with
       one line per block instead of two on the narrow sizes. */
    for (const [label, row] of [['PLAYERS', players], ['GAME TYPE', gameType]]) {
      const lines = {};
      row.btns.forEach((b) => { (lines[Math.round(b.top)] = lines[Math.round(b.top)] || []).push(b.w); });
      const GAP = 6;   // .segs gap
      const fills = Object.values(lines).map((ws) => ws.reduce((a, b) => a + b, 0) + GAP * (ws.length - 1));
      const worstGap = Math.max(...fills.map((f) => Math.abs(f - row.segsW)));
      ok(worstGap <= 1, `${m.w}: every line of ${label} buttons fills its options block edge to edge (lines ${JSON.stringify(fills.map((f) => +f.toFixed(1)))} vs block ${row.segsW}px)`);
    }

    // 5/10 - zero overflow anywhere on this card.
    const worst = Math.max(...d.rows.map((r) => Math.max(r.rowOver, ...r.btns.map((b) => b.over))));
    ok(worst <= 0.5, `${m.w}: no options row or button pokes out of the setup panel (${worst.toFixed(2)}px; item G's original bug was 29px at 320)`);
    const worstScroll = Math.max(...d.rows.map((r) => r.segsScrollOver));
    ok(worstScroll <= 1, `${m.w}: no options block scrolls its own contents sideways (${worstScroll}px)`);
    ok(d.docW <= d.vw + 0.5, `${m.w}: the menu page itself has zero horizontal overflow (scrollWidth ${d.docW} vs ${d.vw})`);

    // 9 - the segmented buttons keep the 44px tap-target floor.
    const smallest = Math.min(...d.rows.flatMap((r) => r.btns.map((b) => b.h)));
    ok(smallest >= 44, `${m.w}: every segmented button still clears the 44px tap-target floor (smallest ${smallest}px)`);

    await page.screenshot({ path: `${SHOTDIR}/suite_menu_${m.w}.png` });
    await ctx.close();
  }
}

/* ============ Part 4: the other screens that reuse .optRow / .segs ============ */
async function partOtherScreens(browser) {
  console.log('\n=== Part 4: the same guarantee on every other screen that reuses these rows ===');
  for (const m of MATRIX) {
    const { ctx, page } = await newCtx(browser, m);
    await page.goto(URL);
    await page.waitForSelector('#btnStart');

    const d = await page.evaluate(() => {
      const out = {};
      const measure = (sel) => {
        const card = document.querySelector(sel + ' .modalCard');
        if (!card) return { worst: -1, rows: 0 };
        const cb = card.getBoundingClientRect();
        let worst = 0, rows = 0;
        [...document.querySelectorAll(sel + ' .optRow')].forEach((r) => {
          rows++;
          const b = r.getBoundingClientRect();
          worst = Math.max(worst, cb.left - b.left, b.right - cb.right);
        });
        [...document.querySelectorAll(sel + ' .optRow > *')].forEach((s) => {
          const b = s.getBoundingClientRect();
          worst = Math.max(worst, cb.left - b.left, b.right - cb.right);
        });
        [...document.querySelectorAll(sel + ' .seg')].forEach((s) => {
          const b = s.getBoundingClientRect();
          worst = Math.max(worst, cb.left - b.left, b.right - cb.right);
        });
        return { worst: +Math.max(0, worst).toFixed(2), rows };
      };
      const show = (id) => document.getElementById(id).classList.remove('hidden');
      const hide = (id) => document.getElementById(id).classList.add('hidden');

      window.openHostSpeedOverlay();
      out.hostSetup = measure('#hostSpeedOverlay');
      out.hostSameLine = (() => {
        const r = [...document.querySelectorAll('#hostSpeedOverlay .optRow')].map((row) => {
          const lb = row.querySelector('label').getBoundingClientRect();
          const sb = row.querySelector('.segs').getBoundingClientRect();
          return sb.top < lb.bottom - 0.5 && lb.top < sb.bottom - 0.5;
        });
        return r.length > 0 && r.every(Boolean);
      })();
      hide('hostSpeedOverlay');

      show('joinOverlay'); show('joinCodeStep'); show('joinNameStep');
      out.join = measure('#joinOverlay');
      hide('joinOverlay');

      show('lbOverlay');
      out.leaderboard = measure('#lbOverlay');
      const tabsEl = document.querySelector('#lbOverlay .segs');
      out.lbTabs = [...tabsEl.querySelectorAll('.seg')].map((s) => s.textContent);
      out.lbTabHeights = [...tabsEl.querySelectorAll('.seg')].map((s) => +s.getBoundingClientRect().height.toFixed(2));
      out.lbScrollOver = tabsEl.scrollWidth - tabsEl.clientWidth;
      // The leaderboard tabs are a STANDALONE .segs, not inside an .optRow - they must keep
      // their normal left alignment and size to their own text, not inherit the right-aligned
      // stretch-to-fill treatment the setup card's option rows use.
      out.lbJustify = getComputedStyle(tabsEl).justifyContent;
      out.lbTabWidths = [...tabsEl.querySelectorAll('.seg')].map((s) => +s.getBoundingClientRect().width.toFixed(2));
      hide('lbOverlay');

      show('adminOverlay'); show('adminLocked');
      out.admin = measure('#adminOverlay');
      hide('adminOverlay');
      return out;
    });

    ok(d.hostSetup.rows >= 2 && d.hostSetup.worst <= 0.5, `${m.w}: the host setup overlay's ${d.hostSetup.rows} option rows stay inside their card (${d.hostSetup.worst}px)`);
    ok(d.hostSameLine, `${m.w}: the host setup overlay's option rows also keep label and buttons on one line`);
    ok(d.join.worst <= 0.5, `${m.w}: the join overlay's room-code and name rows stay inside their card (${d.join.worst}px)`);
    ok(d.admin.worst <= 0.5, `${m.w}: the admin overlay's token row stays inside its card (${d.admin.worst}px)`);
    ok(d.leaderboard.worst <= 0.5, `${m.w}: the leaderboard's tabs stay inside their card (${d.leaderboard.worst}px)`);
    ok(d.lbScrollOver <= 1, `${m.w}: the leaderboard's tab strip does not scroll sideways (${d.lbScrollOver}px)`);
    ok(d.lbTabs.join('/') === 'Solo/Teams/KOs', `${m.w}: the leaderboard still has all three tabs (${d.lbTabs.join('/')})`);
    ok(d.lbJustify !== 'flex-end', `${m.w}: the leaderboard tabs keep their own left alignment (justify-content: ${d.lbJustify}) rather than inheriting the setup card's right-aligned option blocks`);
    ok(new Set(d.lbTabWidths).size > 1, `${m.w}: the leaderboard tabs still size to their own text (${JSON.stringify(d.lbTabWidths)}) rather than stretching to fill`);
    ok(Math.min(...d.lbTabHeights) >= 44, `${m.w}: the leaderboard tabs still clear the 44px tap-target floor (smallest ${Math.min(...d.lbTabHeights)}px)`);

    await ctx.close();
  }
}

/* ============ Part 5: the reasons are written down where the next session will find them ==== */
async function partComments() {
  console.log('\n=== Part 5: the WHY is recorded in the source, so nobody flips this back ===');
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'index.html'), 'utf8');
  ok(/flex-wrap:nowrap;gap:var\(--seatGap\)/.test(src), 'index.html: .seatRow is nowrap (one line per seat)');
  // 2026-07-25 (v0.34): .optRow gained a --optGap custom property on its first line (Blake asked
  // for real space between each label and its buttons), so the rule no longer starts with
  // `display:flex`. The property this assertion exists to protect - nowrap, i.e. the label and
  // its options always share a line - is unchanged and is what is matched here.
  ok(/\.optRow\{[^}]*flex-wrap:nowrap/.test(src), 'index.html: .optRow is nowrap (label and options share a line)');
  ok(/\.optRow\{--optGap:\d/.test(src) && /gap:var\(--optGap\)/.test(src),
    'index.html: the label-to-buttons gap is ONE custom property shared by both option rows (so they can never drift apart)');
  ok(/all fit on 1\s*\n?\s*row/.test(src) || /all fit on 1/.test(src), 'index.html: Blake\'s item-1 wording is quoted next to the .seatRow rules');
  ok(/2 rows thick for symmetry/.test(src), 'index.html: Blake\'s item-2 wording is quoted next to the .optRow rules');
  ok(/item J/.test(src) && /item G/.test(src), 'index.html: both v0.31 items this reverses are named, with their original overflow numbers kept');
  ok(/visibility:hidden/.test(src), 'index.html: the hidden difficulty dropdown still uses visibility, and the comment says not to change it');
}

(async () => {
  const browser = await chromium.launch();
  try {
    await partSeatRows(browser);
    await partNameBox(browser);
    await partOptRows(browser);
    await partOtherScreens(browser);
    await partComments();
  } finally {
    await browser.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`screenshots: ${SHOTDIR}`);
  process.exit(fail ? 1 : 0);
})();
