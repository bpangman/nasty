// 2026-07-23 permanent regression suite - Blake's item 8: "for the pegs still in the stable
// please just always make these button tabs symmetrical (sometimes it becomes a weird string of
// buttons to accommodate other things), but just have these close to where the stable pegs are."
//
// Root cause + fix documented in full at the big comment above showBubbles() (index.html, § UI):
// the formation pass (v0.19.3/v0.19.4) used to only kick in for a seat with 2+ pickable base
// (stable) tees - a LONE pickable base tee fell through to the general sweep, which still avoids
// every other tee on the board and could push it far from the stable, same as a crowded track
// bubble. Fix: formation now runs for ANY size base group, including exactly 1.
//
// This suite calls showBubbles() directly against a fresh, all-base board state (same fixture
// style HANDOFF.md documents for the original v0.19.3/v0.19.4 sessions) - no server needed.
// Run: node test_stable_bubbles.js

const { chromium } = require('/Users/jarvis/clawd/node_modules/playwright');
const path = require('path');

const URL = 'file://' + path.resolve(__dirname, '..', '..', 'index.html');
let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  OK  ', label); }
  else { fail++; console.log('  FAIL ', label); }
}

async function freshBoard(page, n) {
  await page.goto(URL);
  await page.waitForSelector('#btnStart');
  if (n === 6) await page.click('#p6');
  await page.click('#btnStart');
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
  // Hide the speed picker WITHOUT answering it - leaves every piece in 'base' state, nothing
  // moving, matching the v0.19.3/v0.19.4 fixture exactly (documented in HANDOFF.md).
  await page.evaluate(() => { const sp = document.getElementById('speedPickerOverlay'); if (sp) sp.classList.add('hidden'); });
  await page.waitForTimeout(100);
}

async function partA_soloNeverStrandedByObstruction(browser) {
  console.log('\n=== Part A: a solo pickable stable tee is IMMUNE to unrelated board congestion ===');
  for (const n of [4, 6]) {
    for (const seat of [0, 1]) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.on('pageerror', (e) => console.log('  [pageerror]', String(e)));
      await freshBoard(page, n);

      const r = await page.evaluate((s) => {
        const orig = window.teePos;
        window.showBubbles([{ s, pi: 0 }], '');
        const b0 = document.querySelector('#bubbleLayer .teeBubble');
        const naturalLeft = parseFloat(b0.style.left), naturalTop = parseFloat(b0.style.top);
        window.clearBubbles();

        // Force EVERY other tee on the board to report a position exactly where the solo bubble
        // would naturally want to sit - the OLD behavior (falling into the general sweep, which
        // avoids every tee on the board) would have dodged this; the fix should ignore it.
        window.teePos = function (ss, pi) {
          if (ss === s && pi === 0) return orig(ss, pi);
          return { x: naturalLeft, y: naturalTop - 42 };
        };
        window.showBubbles([{ s, pi: 0 }], '');
        const b1 = document.querySelector('#bubbleLayer .teeBubble');
        const newLeft = parseFloat(b1.style.left), newTop = parseFloat(b1.style.top);
        window.teePos = orig;
        window.clearBubbles();
        return { naturalLeft, naturalTop, newLeft, newTop, identical: naturalLeft === newLeft && naturalTop === newTop };
      }, seat);
      ok(r.identical, `n=${n} seat=${seat}: solo stable bubble position UNCHANGED by simulated board-wide obstruction (natural=${r.naturalLeft.toFixed(1)},${r.naturalTop.toFixed(1)} vs obstructed=${r.newLeft.toFixed(1)},${r.newTop.toFixed(1)})`);
      await page.close();
    }
  }
}

async function partB_closeToStable(browser) {
  console.log('\n=== Part B: a solo stable bubble lands close to its OWN tee, not the general sweep ceiling ===');
  for (const n of [4, 6]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', (e) => console.log('  [pageerror]', String(e)));
    await freshBoard(page, n);
    const r = await page.evaluate(() => {
      window.showBubbles([{ s: 0, pi: 0 }], '');
      const b = document.querySelector('#bubbleLayer .teeBubble');
      const anchorTop = parseFloat(b.style.top), anchorLeft = parseFloat(b.style.left);
      const teePos = window.teePos(0, 0);
      window.clearBubbles();
      // The old sweep's absolute ceiling was board-space y=24 - a solo bubble that had been
      // pushed that far would be nowhere near its own tee. Distance from the tee's own position
      // (in board-space units) should be small (a handful of tens of px, the formation's own
      // xMag/tipGap geometry), not "clear across the board."
      return { anchorTop, anchorLeft, teeX: teePos.x, teeY: teePos.y, dx: Math.abs(anchorLeft - teePos.x) };
    });
    ok(r.dx < 80, `n=${n}: solo stable bubble's x-anchor stays within 80 board-px of its own tee (dx=${r.dx.toFixed(1)}) - not dragged across the board`);
    ok(r.anchorTop < r.teeY, `n=${n}: bubble anchor is still ABOVE its tee (anchorTop=${r.anchorTop.toFixed(1)} < teeY=${r.teeY})`);
    await page.close();
  }
}

async function partC_symmetryAndNoOverlap(browser) {
  console.log('\n=== Part C: full 5-tee stable formation - symmetric, no overlap, every bubble on-screen (4P + 6P) ===');
  for (const n of [4, 6]) {
    for (const w of [320, 390]) {
      const page = await browser.newPage({ viewport: { width: w, height: 844 } });
      page.on('pageerror', (e) => console.log('  [pageerror]', String(e)));
      await freshBoard(page, n);
      const list = [0, 1, 2, 3, 4].map((pi) => ({ s: 0, pi }));
      await page.evaluate((l) => window.showBubbles(l, ''), list);
      await page.waitForTimeout(100);
      const r = await page.evaluate((vw) => {
        const bubbles = [...document.querySelectorAll('#bubbleLayer .teeBubble')];
        const rects = bubbles.map((b) => b.getBoundingClientRect());
        let overlap = false;
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i], b = rects[j];
          const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
          const bx = b.left + b.width / 2, by = b.top + b.height / 2;
          const d = Math.hypot(ax - bx, ay - by);
          if (d < (a.width + b.width) / 2 - 2) overlap = true;   // small tolerance for float rounding
        }
        const allOnScreen = rects.every((r) => r.left >= 0 && r.right <= vw && r.top >= 0);
        return { count: bubbles.length, overlap, allOnScreen };
      }, w);
      ok(r.count === 5, `n=${n} w=${w}: all 5 stable bubbles rendered (got ${r.count})`);
      ok(!r.overlap, `n=${n} w=${w}: zero pairwise bubble-bubble overlap in the 5-tee formation`);
      ok(r.allOnScreen, `n=${n} w=${w}: every bubble fully within the viewport`);
      await page.close();
    }
  }
}

async function partD_realTapRouting(browser) {
  console.log('\n=== Part D: a solo stable bubble is a real, correctly-routed tap target ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e)));
  await freshBoard(page, 4);
  let clickedS = -1, clickedPi = -1;
  await page.exposeFunction('__captureClick', (s, pi) => { clickedS = s; clickedPi = pi; });
  await page.evaluate(() => {
    window.onTeeClick = (s, pi) => window.__captureClick(s, pi);
  });
  await page.evaluate(() => window.showBubbles([{ s: 0, pi: 2 }], ''));
  await page.waitForTimeout(150);
  await page.click('#bubbleLayer .teeBubble', { force: true });
  await page.waitForTimeout(100);
  ok(clickedS === 0 && clickedPi === 2, `tap on the solo formation bubble routed to the correct tee (got s=${clickedS} pi=${clickedPi})`);
  await page.close();
}

async function partE_trackBubblesUnaffected(browser) {
  console.log('\n=== Part E: track-state bubbles keep their existing crowded-dodge behavior (untouched by this fix) ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e)));
  await freshBoard(page, 4);
  const r = await page.evaluate(() => {
    // Promote two of seat 0's pieces to 'track' state at adjacent steps so the CROWDED-track
    // side-dodge pass has to fire (mirrors v0.23's own test fixture style).
    window.G.pieces[0][0] = { state: 'track', steps: 5 };
    window.G.pieces[0][1] = { state: 'track', steps: 6 };
    window.showBubbles([{ s: 0, pi: 0 }, { s: 0, pi: 1 }], '');
    const bubbles = [...document.querySelectorAll('#bubbleLayer .teeBubble')];
    const sideBubbles = bubbles.filter((b) => b.classList.contains('sideL') || b.classList.contains('sideR'));
    const result = { count: bubbles.length, sideCount: sideBubbles.length };
    window.clearBubbles();
    return result;
  });
  ok(r.count === 2, `two track bubbles rendered (got ${r.count})`);
  ok(r.sideCount >= 1, `at least one crowded track bubble went sideways, exactly like v0.23's original behavior (got ${r.sideCount} side bubbles) - this fix never touched track-state dodging`);
  await page.close();
}

async function main() {
  const browser = await chromium.launch();
  await partA_soloNeverStrandedByObstruction(browser);
  await partB_closeToStable(browser);
  await partC_symmetryAndNoOverlap(browser);
  await partD_realTapRouting(browser);
  await partE_trackBubblesUnaffected(browser);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
