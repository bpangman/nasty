// 2026-07-23 permanent regression suite - Blake's item 6: "the concede badge is still way
// bigger than my screen and cuts off. Please fix so it isn't larger than any iPhone accessing
// the game (should be relative to the screen size it's on and not take up the full screen
// either)."
//
// Root cause + fix are documented in full at the .confirmCard CSS comment (index.html, § STYLE)
// and fitConfirmCard() (§ UTIL) - short version: v0.27.1 capped .confirmCard at max-height:90vh
// with no overflow; iOS build 38 replaced that with a JS transform:scale() hack that (a) budgeted
// a flat 10% margin with no real iOS safe-area awareness and (b) never re-measured on a viewport
// resize. This session replaced both with a plain CSS max-height that explicitly subtracts the
// REAL safe-area insets, plus overflow-y:auto as an actual scroll fallback - reactive to any
// resize/rotation/Dynamic-Type change with zero JS and zero race window.
//
// This suite specifically drives real iPhone-shaped safe-area insets via the CDP
// Emulation.setSafeAreaInsetsOverride call (notch + Dynamic Island + home-indicator strips) -
// something the existing OVERFLOW checks in test_surrender.js do NOT do (they only check plain
// viewport bounds) - because that's exactly the dimension the prior two fix attempts missed.
//
// Fully offline (file://) - no server needed.
// Run: node test_overlay_sizing.js

const { chromium } = require('/Users/jarvis/clawd/node_modules/playwright');
const path = require('path');

const URL = 'file://' + path.resolve(__dirname, '..', '..', 'index.html') + '#autotest';
let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  OK  ', label); }
  else { fail++; console.log('  FAIL ', label); }
}

// Real device-shaped safe-area insets per viewport, matching Blake's own test matrix.
const MATRIX = [
  { w: 320, h: 568, top: 0, bottom: 0, name: '320x568 (SE1, no notch)' },
  { w: 375, h: 667, top: 0, bottom: 0, name: '375x667 (SE2/3, no notch)' },
  { w: 390, h: 844, top: 47, bottom: 34, name: '390x844 (12/13/14, notch)' },
  { w: 393, h: 852, top: 59, bottom: 34, name: '393x852 (14/15 Pro, Dynamic Island)' },
  { w: 430, h: 932, top: 59, bottom: 34, name: '430x932 (Pro Max, Dynamic Island)' },
];

async function fitCheck(browser, w, h, top, bottom, openFn, overlayId, label, extra) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  await client.send('Emulation.setSafeAreaInsetsOverride', { insets: { top, left: 0, bottom, right: 0 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL);
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
  if (extra) await page.evaluate(extra);
  await page.evaluate(openFn);
  await page.waitForTimeout(200);
  const r = await page.evaluate((id) => {
    const ov = document.getElementById(id);
    const cc = ov.querySelector('.confirmCard');
    const rect = cc.getBoundingClientRect();
    return {
      top: rect.top, bottom: rect.bottom, height: rect.height, innerH: window.innerHeight,
      scrollHeight: cc.scrollHeight, clientHeight: cc.clientHeight,
      canScroll: cc.scrollHeight > cc.clientHeight + 1,
    };
  }, overlayId);
  const fits = r.top >= -0.5 && r.bottom <= r.innerH + 0.5;
  ok(fits, `${label}: fits fully within the real viewport, safe-area insets top=${top}/bottom=${bottom} (top=${r.top.toFixed(1)}, bottom=${r.bottom.toFixed(1)}, innerH=${r.innerH})`);
  ok(errors.length === 0, `${label}: zero page errors`);
  await ctx.close();
  return r;
}

async function partA_smallDialogNotFullScreen(browser) {
  console.log('\n=== Part A: a small 2-button dialog (Quit/Concede) never fills the whole screen ===');
  for (const m of MATRIX) {
    const ctx = await browser.newContext({ viewport: { width: m.w, height: m.h } });
    const page = await ctx.newPage();
    const client = await ctx.newCDPSession(page);
    await client.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: m.top, left: 0, bottom: m.bottom, right: 0 } });
    await page.goto(URL);
    await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
    await page.evaluate(() => window.openSurrenderConfirm());
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => {
      const cc = document.getElementById('surrenderConfirmOverlay').querySelector('.confirmCard');
      const rect = cc.getBoundingClientRect();
      return { height: rect.height, top: rect.top, bottom: rect.bottom, innerH: window.innerHeight };
    });
    ok(r.height < r.innerH * 0.85, `${m.name}: 2-button confirm card is NOT stretched to fill the screen (card ${Math.round(r.height)}px vs viewport ${r.innerH}px)`);
    ok(r.top >= -0.5 && r.bottom <= r.innerH + 0.5, `${m.name}: 2-button confirm still fully on-screen`);
    await ctx.close();
  }
}

async function partB_bigDialogFitsWithRealSafeArea(browser) {
  console.log('\n=== Part B: the historically-overflowing 6-button online leave sheet, real safe-area insets ===');
  for (const m of MATRIX) {
    await fitCheck(browser, m.w, m.h, m.top, m.bottom,
      () => window.openLeaveConfirm(), 'leaveConfirmOverlay',
      m.name, () => { window.NET.online = true; });
  }
}

async function partC_pathologicalTinyViewport(browser) {
  console.log('\n=== Part C: pathological viewport (way too short for ANY sizing scheme) - scroll must reach every button ===');
  const ctx = await browser.newContext({ viewport: { width: 320, height: 280 } });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  await client.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 20, left: 0, bottom: 20, right: 0 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL);
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
  await page.evaluate(() => { window.NET.online = true; window.openLeaveConfirm(); });
  await page.waitForTimeout(200);
  const r = await page.evaluate(() => {
    const cc = document.getElementById('leaveConfirmOverlay').querySelector('.confirmCard');
    const rect = cc.getBoundingClientRect();
    return {
      top: rect.top, bottom: rect.bottom, innerH: window.innerHeight,
      scrollHeight: cc.scrollHeight, clientHeight: cc.clientHeight,
      canScroll: cc.scrollHeight > cc.clientHeight + 1,
      btnCount: document.querySelectorAll('#leaveConfirmOverlay .bigBtns .btn:not(.hidden)').length,
    };
  });
  ok(r.top >= -0.5 && r.bottom <= r.innerH + 0.5, `card container itself never exceeds the tiny viewport (top=${r.top.toFixed(1)}, bottom=${r.bottom.toFixed(1)}, innerH=${r.innerH})`);
  ok(r.canScroll, 'content taller than the card CAN scroll internally - the real fallback (no content is ever silently unreachable)');
  ok(r.btnCount >= 5, `every button is still present in the DOM, reachable by scrolling (found ${r.btnCount})`);
  ok(errors.length === 0, 'zero page errors even in a pathological viewport');
  await ctx.close();
}

async function partD_reactiveToResize(browser) {
  console.log('\n=== Part D: pure-CSS sizing reacts to a viewport resize AFTER the dialog is already open (the real bug in the old JS-scale approach) ===');
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL);
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
  await page.evaluate(() => { window.NET.online = true; window.openLeaveConfirm(); });
  await page.waitForTimeout(200);
  const before = await page.evaluate(() => {
    const rect = document.getElementById('leaveConfirmOverlay').querySelector('.confirmCard').getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  });
  // Simulate mobile Safari's address bar re-appearing (viewport height SHRINKS) WITHOUT the
  // dialog being closed/reopened - the old JS scale() was computed once at open time and never
  // revisited; pure CSS recomputes automatically on this resize with no JS at all.
  await page.setViewportSize({ width: 430, height: 500 });
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => {
    const cc = document.getElementById('leaveConfirmOverlay').querySelector('.confirmCard');
    const rect = cc.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, innerH: window.innerHeight, canScroll: cc.scrollHeight > cc.clientHeight + 1 };
  });
  ok(after.bottom <= after.innerH + 0.5, `after the viewport shrinks mid-dialog (${before.bottom.toFixed(1)} -> would-be still using the OLD scale), the card still fits the NEW smaller viewport (bottom=${after.bottom.toFixed(1)}, innerH=${after.innerH})`);
  ok(errors.length === 0, 'zero page errors across the resize');
  await ctx.close();
}

async function main() {
  const browser = await chromium.launch();
  await partA_smallDialogNotFullScreen(browser);
  await partB_bigDialogFitsWithRealSafeArea(browser);
  await partC_pathologicalTinyViewport(browser);
  await partD_reactiveToResize(browser);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
