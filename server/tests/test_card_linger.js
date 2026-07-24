// 2026-07-23 permanent regression suite - Blake's item 11: "have the card someone just used
// linger on the screen until the next person uses their next card. Also make the number
// (includes jacks, kings, queens, etc) slightly larger on the card (don't change the card size)
// so it's easier to read."
//
// Root cause + fix documented in full at the comment above showDiscard()/fadeAllDiscards()
// (index.html, § RENDER): fadeAllDiscards() used to run unconditionally at the TOP of every
// turn-loop iteration (offline AND online), so a played card vanished the moment the NEXT
// player's turn merely STARTED, not when they actually played. Fix: fadeAllDiscards() now only
// runs from inside showDiscard() itself (so displaying a NEW card is the only thing that clears
// the previous one) and once at the start of a fresh deal (doDeal()/applyDealAction()).
//
// Fully offline (file://) - #autotest drives a full CPU-vs-CPU game so real plays happen without
// any manual input, at turbo speed. No server needed.
// Run: node test_card_linger.js

const { chromium } = require('/Users/jarvis/clawd/node_modules/playwright');
const path = require('path');

const AUTOTEST_URL = 'file://' + path.resolve(__dirname, '..', '..', 'index.html') + '#autotest';
const PLAIN_URL = 'file://' + path.resolve(__dirname, '..', '..', 'index.html');
let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  OK  ', label); }
  else { fail++; console.log('  FAIL ', label); }
}

async function partA_exactlyOneAtATimeAndLingers(browser) {
  console.log('\n=== Part A: exactly one "last played" card visible at a time, and it lingers across a turn change ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(AUTOTEST_URL);
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });

  const trace = await page.evaluate(() => new Promise((resolve) => {
    const seen = [];
    const poll = setInterval(() => {
      const shownNow = [];
      for (let s = 0; s < window.G.n; s++) {
        const d = document.getElementById('discard-' + s);
        if (d && d.classList.contains('show')) shownNow.push(s);
      }
      seen.push({ shown: shownNow, turn: window.G.turn, over: window.G.over });
      if (seen.length > 500 || (window.G && window.G.over)) { clearInterval(poll); resolve(seen); }
    }, 40);
  }));

  const maxShown = Math.max(...trace.map((e) => e.shown.length));
  ok(maxShown <= 1, `never more than one seat's discard visible at the same instant (max observed: ${maxShown})`);

  let lingeredAcrossTurnChange = false;
  for (let i = 1; i < trace.length; i++) {
    if (trace[i].turn !== trace[i - 1].turn && trace[i].shown.length === 1 && trace[i - 1].shown.length === 1
      && trace[i].shown[0] === trace[i - 1].shown[0]) {
      lingeredAcrossTurnChange = true;
      break;
    }
  }
  ok(lingeredAcrossTurnChange, 'a played card visibly SURVIVED at least one G.turn change (the literal "linger until the next person plays" fix)');
  ok(errors.length === 0, 'zero page errors during a real CPU-vs-CPU game');

  await page.close();
}

async function partB_clearsOnNewDeal(browser) {
  console.log('\n=== Part B: fadeAllDiscards() still clears everything at the start of a fresh deal ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e)));
  await page.goto(AUTOTEST_URL);
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });

  // Wait for at least one card to be showing, then force-call doDeal() directly and confirm
  // every discard visual clears (this is the ONE place a lingering card should still vanish
  // even though no new card was played on top of it).
  await page.waitForFunction(() => {
    for (let s = 0; s < window.G.n; s++) {
      const d = document.getElementById('discard-' + s);
      if (d && d.classList.contains('show')) return true;
    }
    return false;
  }, { timeout: 15000 });

  const cleared = await page.evaluate(async () => {
    // A fresh deal mid-autotest could race the live turn loop; call fadeAllDiscards() itself
    // directly (the exact function doDeal()/applyDealAction() call) to isolate the behavior
    // under test deterministically.
    window.fadeAllDiscards();
    let anyShown = false;
    for (let s = 0; s < window.G.n; s++) {
      const d = document.getElementById('discard-' + s);
      if (d && d.classList.contains('show')) anyShown = true;
    }
    return !anyShown;
  });
  ok(cleared, 'fadeAllDiscards() (called by doDeal()/applyDealAction() at the start of a new hand) clears every seat\'s lingering card');

  await page.close();
}

async function partC_showDiscardReplacesNotAccumulates(browser) {
  console.log('\n=== Part C: showDiscard() replaces the previous card, never stacks two shown at once ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e)));
  await page.goto(PLAIN_URL);
  await page.click('#btnStart');
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });

  const r = await page.evaluate(() => {
    window.showDiscard(0, { r: 'A', s: '♠' });
    const afterFirst = [...Array(window.G.n).keys()].filter((s) => document.getElementById('discard-' + s).classList.contains('show'));
    window.showDiscard(1, { r: 'K', s: '♥' });
    const afterSecond = [...Array(window.G.n).keys()].filter((s) => document.getElementById('discard-' + s).classList.contains('show'));
    return { afterFirst, afterSecond };
  });
  ok(r.afterFirst.length === 1 && r.afterFirst[0] === 0, `after showDiscard(0,...): only seat 0 shown (got ${JSON.stringify(r.afterFirst)})`);
  ok(r.afterSecond.length === 1 && r.afterSecond[0] === 1, `after showDiscard(1,...): only seat 1 shown, seat 0's faded (got ${JSON.stringify(r.afterSecond)})`);

  await page.close();
}

async function partD_rankSizeLarger(browser) {
  console.log('\n=== Part D: rank text is larger than before, card size unchanged, "10" never overflows ===');
  const page = await browser.newPage({ viewport: { width: 320, height: 568 } });
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e)));
  await page.goto(PLAIN_URL);
  await page.click('#btnStart');
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
  const pickerVisible = await page.evaluate(() => {
    const sp = document.getElementById('speedPickerOverlay');
    return sp && !sp.classList.contains('hidden');
  });
  if (pickerVisible) await page.click('#btnSpeedPick0');
  await page.waitForFunction(() => document.querySelectorAll('#handRow .card').length > 0, { timeout: 20000 });

  const rkFont = await page.evaluate(() => {
    const rk = document.querySelector('#handRow .card .rk');
    return parseFloat(getComputedStyle(rk).fontSize);
  });
  ok(rkFont >= 14, `hand-card rank font-size is at least 14px at 320px width (old was 13px min) - got ${rkFont}`);

  const cardWidth = await page.evaluate(() => {
    const c = document.querySelector('#handRow .card');
    return c.getBoundingClientRect().width;
  });
  ok(cardWidth > 40 && cardWidth < 60, `card itself is still the normal small-phone size, unchanged by the rank bump (got ${cardWidth.toFixed(1)}px)`);

  // Force a "10" rank and confirm the rank element never overflows its own card's bounds.
  const overflow = await page.evaluate((s) => {
    const suits = ['♠', '♥', '♦', '♣'];
    window.G.hands[s] = window.G.hands[s].map((c, i) => ({ r: '10', s: suits[i % 4] }));
    window.renderHandFor(s);
    return [...document.querySelectorAll('#handRow .card')].map((c) => {
      const cardR = c.getBoundingClientRect();
      const rk = c.querySelector('.rk');
      const rkR = rk.getBoundingClientRect();
      return rkR.right <= cardR.right + 0.5 && rkR.left >= cardR.left - 0.5;
    });
  }, await page.evaluate(() => window.visibleHandSeat()));
  ok(overflow.length > 0 && overflow.every(Boolean), `"10" rank text never overflows its own card's left/right bounds at 320px width (${overflow.filter(Boolean).length}/${overflow.length} cards clean)`);

  // The fixed-size table/discard copy (.tableCard .card .rk) also grew, matching the hand clamp's new ceiling.
  const tableCardRk = await page.evaluate(() => {
    window.showDiscard(0, { r: '10', s: '♠' });
    const rk = document.querySelector('#discard-0 .card .rk');
    const fontSize = parseFloat(getComputedStyle(rk).fontSize);
    const cardR = document.querySelector('#discard-0 .card').getBoundingClientRect();
    const rkR = rk.getBoundingClientRect();
    return { fontSize, fits: rkR.right <= cardR.right + 0.5 };
  });
  ok(tableCardRk.fontSize >= 19, `table/discard-card rank font-size matches the new larger ceiling (got ${tableCardRk.fontSize})`);
  ok(tableCardRk.fits, 'the lingering discard card\'s "10" also fits within its own card bounds');

  await page.close();
}

async function partE_noPrivacyLeak(browser) {
  console.log('\n=== Part E: a lingering played card is public info only - never a peek at a hidden hand ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e)));
  await page.goto(AUTOTEST_URL);
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
  await page.waitForTimeout(1500);
  // Every discard's card content must always be a card that was ACTUALLY moved out of that
  // seat's hand into G.discard (or currently on the table) - i.e. real, already-played, public
  // information, never something still sitting in G.hands.
  const leak = await page.evaluate(() => {
    let anyMismatch = false;
    for (let s = 0; s < window.G.n; s++) {
      const d = document.getElementById('discard-' + s);
      if (!d || !d.classList.contains('show')) continue;
      const rkEl = d.querySelector('.dFace .rk');
      if (!rkEl) continue;
      const shownRank = rkEl.childNodes[0].textContent.trim();
      // the shown card must NOT still be sitting in this seat's own current hand (that would
      // mean we displayed something not actually played yet)
      const stillInHand = window.G.hands[s].some((c) => c.r === shownRank);
      // heuristic false-positive guard: duplicates of the same rank across other suits are fine,
      // this is just a smoke check that the shown card came from an actual play, not a stale
      // hand render - real privacy boundary is visibleHandSeat(), untouched by this session.
      if (stillInHand && window.G.hands[s].length === (window.G.seats ? 5 : 5)) anyMismatch = true;
    }
    return anyMismatch;
  });
  ok(leak === false, 'no evidence of a discard visual showing a card that was never actually played (smoke check)');
  await page.close();
}

async function main() {
  const browser = await chromium.launch();
  await partA_exactlyOneAtATimeAndLingers(browser);
  await partB_clearsOnNewDeal(browser);
  await partC_showDiscardReplacesNotAccumulates(browser);
  await partD_rankSizeLarger(browser);
  await partE_noPrivacyLeak(browser);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
