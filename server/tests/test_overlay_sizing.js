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
// 2026-07-24 - Blake's 3RD attempt at this same badge problem, root-caused for real this time
// (see Part F below and the .confirmCard/.overlay CSS comments, index.html, § STYLE). The first
// attempt (this file's original Part A-D) verified the CARD's geometry; the second attempt
// (Part E) verified a computed font-size ratio. Neither ever measured the SIGN itself (rotated,
// with its own box-shadow) against the real screen edges, and neither took an actual screenshot -
// which is exactly why both missed the true bug (an overflow-y:auto on .confirmCard forcing
// overflow-x too, clipping the rotated sign's corner and its own shadow). Part F fixes that with
// real per-pixel screenshot verification, permanently, for all five confirm overlays.
//
// Fully offline (file://) - no server needed.
// Run: node test_overlay_sizing.js

const { chromium } = require('/Users/jarvis/clawd/node_modules/playwright');
const path = require('path');
const zlib = require('zlib');

const URL = 'file://' + path.resolve(__dirname, '..', '..', 'index.html') + '#autotest';
let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  OK  ', label); }
  else { fail++; console.log('  FAIL ', label); }
}

// Minimal, dependency-free PNG decoder (8-bit, non-interlaced RGB/RGBA - exactly what
// Playwright's page.screenshot({type:'png'}) produces) so Part F below can sample REAL rendered
// pixels rather than trusting layout geometry alone. Only Node's built-in zlib is used - no new
// package dependency, matching this file's existing "just require playwright" convention.
function decodePNG(buf) {
  let off = 8; // skip the 8-byte PNG signature
  let width, height, bitDepth, colorType;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8); colorType = data.readUInt8(9);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('decodePNG: only 8-bit PNGs supported');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : (() => { throw new Error('decodePNG: unsupported colorType ' + colorType); })();
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let pos = 0;
  let prevRow = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[pos]; pos++;
    const row = raw.slice(pos, pos + stride); pos += stride;
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prevRow[x];
      const c = x >= channels ? prevRow[x - channels] : 0;
      let val = row[x];
      if (filter === 1) val = (val + a) & 0xff;
      else if (filter === 2) val = (val + b) & 0xff;
      else if (filter === 3) val = (val + Math.floor((a + b) / 2)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        val = (val + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 0xff;
      }
      cur[x] = val;
    }
    for (let px = 0; px < width; px++) {
      const si = px * channels, di = (y * width + px) * 4;
      out[di] = cur[si]; out[di + 1] = cur[si + 1]; out[di + 2] = cur[si + 2];
      out[di + 3] = channels === 4 ? cur[si + 3] : 255;
    }
    prevRow = cur;
  }
  return { width, height, data: out };
}
function pixelAt(png, x, y) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return null;
  const i = (png.width * y + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}
function colorDist(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
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
  // 2026-07-24 update (Blake's 3rd-attempt follow-up): the height-cap-and-scroll safety net moved
  // OFF .confirmCard and ONTO .overlay (see the .overlay/.confirmCard CSS comments, index.html,
  // § STYLE, for why - the old cap on .confirmCard was exactly what clipped the sign's own tilt +
  // shadow). So the scrollable element in a pathological case is now the OVERLAY
  // (#leaveConfirmOverlay itself), not .confirmCard - .confirmCard is allowed to be its full
  // natural size and simply extend past the overlay's own viewport-sized box, same as any normal
  // over-tall content inside a scroll container. This part now checks that the OVERLAY scrolls,
  // and that scrolling it all the way actually brings the last button into view (real
  // reachability, not just a scrollHeight>clientHeight boolean).
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
    const ov = document.getElementById('leaveConfirmOverlay');
    return {
      scrollHeight: ov.scrollHeight, clientHeight: ov.clientHeight,
      canScroll: ov.scrollHeight > ov.clientHeight + 1,
      btnCount: document.querySelectorAll('#leaveConfirmOverlay .bigBtns .btn:not(.hidden)').length,
    };
  });
  ok(r.canScroll, 'content taller than the overlay CAN scroll (the overlay itself, not the card - the real fallback, no content is ever silently unreachable)');
  const scrolled = await page.evaluate(() => {
    const ov = document.getElementById('leaveConfirmOverlay');
    ov.scrollTop = ov.scrollHeight;
    const btns = [...document.querySelectorAll('#leaveConfirmOverlay .bigBtns .btn:not(.hidden)')];
    const last = btns[btns.length - 1];
    const r = last.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, innerH: window.innerHeight };
  });
  ok(scrolled.bottom <= scrolled.innerH + 0.5 && scrolled.top >= -0.5, `scrolling the overlay all the way DOES bring the last button fully into view (top=${scrolled.top.toFixed(1)}, bottom=${scrolled.bottom.toFixed(1)}, innerH=${scrolled.innerH}) - nothing is unreachable`);
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

// 2026-07-24 permanent regression check - Blake's follow-up to item 6: "the concede leave game
// and save and leave badges that pop up when you press those buttons still are too big for the
// panel that you've given them. Please make them about 65% of the size that you currently have."
// Scoped to .confirmCard .sign only (index.html, § STYLE, right below the .confirmCard block) -
// the NASTY! takeout stamp (.nastyStamp .sign) and menu game logo (#gameLogo .sign) share the
// same base .sign rule but must NOT shrink. This asserts the confirm-card sign is meaningfully
// smaller than the base/stamp sign at BOTH size tiers, so a future edit that accidentally removes
// or waters down the .confirmCard .sign scoping can't silently regress back to oversized badges.
async function partE_confirmCardSignScopedSmaller(browser) {
  console.log('\n=== Part E: .confirmCard sign is meaningfully smaller than the base/stamp sign (both tiers) ===');
  // Tall tier (viewport height > 660, the max-height:660px block does NOT apply).
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(URL);
    await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
    await page.evaluate(() => window.openSurrenderConfirm());
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => {
      const confirmB = document.querySelector('#surrenderConfirmOverlay .confirmCard .sign b');
      // A bare, un-scoped .sign probe gets the BASE rule's computed style (56px) - the same base
      // every one of .confirmCard/.nastyStamp/#gameLogo's own .sign rules starts from before its
      // own scoped override applies. This is the one unambiguous "before shrinking" reference.
      const probe = document.createElement('div');
      probe.innerHTML = '<div class="sign"><b>NASTY!</b></div>';
      document.body.appendChild(probe);
      const baseB = probe.querySelector('.sign b');
      const out = { confirmPx: parseFloat(getComputedStyle(confirmB).fontSize), basePx: parseFloat(getComputedStyle(baseB).fontSize) };
      probe.remove();
      return out;
    });
    ok(r.confirmPx < r.basePx, `tall tier: confirm-card sign font (${r.confirmPx}px) is smaller than the base sign font (${r.basePx}px)`);
    ok(r.confirmPx <= r.basePx * 0.75, `tall tier: confirm-card sign font (${r.confirmPx}px) is at most 75% of the base sign font (${r.basePx}px - the real value is ~65%, 75% leaves headroom without allowing a regression back toward full size)`);
    await ctx.close();
  }
  // Short tier (viewport height <= 660, the max-height:660px block DOES apply to both).
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 600 } });
    const page = await ctx.newPage();
    await page.goto(URL);
    await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
    await page.evaluate(() => window.openSurrenderConfirm());
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => {
      const confirmB = document.querySelector('#surrenderConfirmOverlay .confirmCard .sign b');
      // .nastyStamp itself has no max-height:660px override, so it stays at its own fixed 34px
      // here regardless of viewport - a fair "stamp sign, unaffected by the media query" reference.
      const probe = document.createElement('div');
      probe.className = 'nastyStamp'; probe.innerHTML = '<div class="sign"><b>NASTY!</b></div>';
      document.body.appendChild(probe);
      const stampB = probe.querySelector('.sign b');
      const out = { confirmPx: parseFloat(getComputedStyle(confirmB).fontSize), stampPx: parseFloat(getComputedStyle(stampB).fontSize) };
      probe.remove();
      return out;
    });
    ok(r.confirmPx < r.stampPx, `short tier (<=660h): confirm-card sign font (${r.confirmPx}px) is smaller than the stamp sign font (${r.stampPx}px, unaffected by the media query)`);
    await ctx.close();
  }
}

// 2026-07-24 PERMANENT regression check - Blake's 3RD attempt at this same badge problem. The
// first attempt (this file's original Part A-D) only checked geometry - the .confirmCard
// bounding rect vs the viewport - and the second attempt (Part E) only checked a computed
// font-size ratio. NEITHER caught the real bug Blake kept seeing, because the badge (.sign) is
// rotated and carries its own box-shadow, so its true visual footprint is neither the same as
// .confirmCard's own box NOR something a font-size number alone can describe. Root cause (see the
// .confirmCard/.overlay CSS comments, index.html, § STYLE, for the full writeup): .confirmCard
// used to carry overflow-y:auto, which (per spec) forces overflow-x:auto too, turning the card
// into a clip box that sliced the rotated sign's top corner and hard-cut its soft shadow on all
// sides - a bug pure geometry-vs-card checks can never see, because the CARD's own rect is what
// was doing the clipping in the first place. This Part F fixes that blind spot two ways: (1) a
// real geometry check of the SIGN's own rect (not the card's) against the actual viewport edges,
// requiring a genuinely non-zero net margin after accounting for the shadow's blur radius, and
// (2) an ACTUAL PIXEL check - a real screenshot, decoded and sampled just outside that margin, to
// confirm those pixels are the dark overlay background and not badge green/white/shadow bleeding
// to the edge. Geometry alone cannot catch a css clip-box bug like this one; pixels can.
//
// 2026-07-24 follow-up #1 (Blake, same day: "double them in size so they fill up more of the
// screen, still leave some room on the ends though"): the badge grew about 15% linear, keyed to
// keep all five headings safe together.
//
// 2026-07-24 follow-up #2 (same day again: "far too timid, push much harder, roughly double,
// go as large as fits"): re-keyed the main rule to just the three named badges
// (CONCEDE?/LEAVE GAME?/SAVE & LEAVE?), fully decoupled from the two "replace" warnings' own
// override - see the dated CSS comment above .confirmCard .sign, index.html, § STYLE, for the
// full writeup, including why the confirm-style overlays' own outer padding was trimmed
// (22px -> 10px) to buy the badge more room to grow into before it would wrap. Margins shrank
// again as a DIRECT, intended result (a badge that fills more of the screen necessarily leaves
// less empty space around it) - MIN_NET_MARGIN is lowered to match the new smallest real case
// (the tightest is "REPLACE A SAVE?" at 375px wide, ~5.9px) while staying a real, meaningful
// floor, not a bare "not zero." The single-line check (Range.getClientRects().length === 1,
// added in follow-up #1) matters even more now - several headings are tuned close to their own
// wrap limit on purpose ("as large as fits"), so this needs to keep being a permanent per-viewport
// check, not a one-time measurement. Part G/H below lock in the specific percentage targets Blake
// asked for (5%+ margin at the narrowest phone, ~85% badge width with a 6-8% margin band on
// Blake's own phone class for "SAVE & LEAVE?").
const SIGN_BOX_SHADOW_BLUR = 16; // px - must match .confirmCard .sign's box-shadow blur radius (index.html, § STYLE)
const PIXEL_BLEED_PROBE = SIGN_BOX_SHADOW_BLUR + 2; // sample just past the shadow's real reach
const MIN_NET_MARGIN = 4; // px - a real floor (smallest real case across the full matrix is ~5.9px, "REPLACE A SAVE?" at 375px wide)
// 2026-07-24 follow-up: raised from 30 to 45. The overlay backdrop is only 90% opaque
// (rgba(5,15,9,.9)), so on the busier confirm dialogs (the online leaveConfirmOverlay sits over
// the full board plus top bar) a probe point can occasionally land over a bright board element or
// button showing faintly through - measured up to ~35 even on the unmodified v0.28.2 code, nothing
// to do with badge size. Real badge/shadow bleed reads 100+, so 45 still leaves a wide, safe gap
// between "background noise" and "the badge is actually clipped."
const MAX_BG_COLOR_DIST = 45;

const CONFIRM_OVERLAYS = [
  { id: 'surrenderConfirmOverlay', label: 'CONCEDE?', open: () => window.openSurrenderConfirm() },
  { id: 'leaveConfirmOverlay', label: 'LEAVE GAME? (6-button online list)', open: () => { window.NET.online = true; window.openLeaveConfirm(); } },
  { id: 'saveLeaveConfirmOverlay', label: 'SAVE & LEAVE?', open: () => window.openSaveConfirm() },
  { id: 'overwriteWarnOverlay', label: 'REPLACE GAME?', open: () => document.getElementById('overwriteWarnOverlay').classList.remove('hidden') },
  { id: 'slotReplaceOverlay', label: 'REPLACE A SAVE?', open: () => document.getElementById('slotReplaceOverlay').classList.remove('hidden') },
];

async function partF_badgeMarginNeverClipped(browser) {
  console.log('\n=== Part F: PERMANENT - the confirm-card badge (plus its shadow) keeps a real, non-zero empty margin from all four screen edges, verified against actual rendered pixels ===');
  for (const m of MATRIX) {
    for (const o of CONFIRM_OVERLAYS) {
      const ctx = await browser.newContext({ viewport: { width: m.w, height: m.h }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const client = await ctx.newCDPSession(page);
      await client.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: m.top, left: 0, bottom: m.bottom, right: 0 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(URL);
      await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
      await page.evaluate(o.open);
      await page.waitForTimeout(200);
      const geo = await page.evaluate((id) => {
        const ov = document.getElementById(id);
        const cc = ov.querySelector('.confirmCard');
        const sign = cc.querySelector('.sign');
        const b = cc.querySelector('.sign b');
        const sr = sign.getBoundingClientRect();
        const cr = cc.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(b);
        return { top: sr.top, bottom: sr.bottom, left: sr.left, right: sr.right, cardBottom: cr.bottom, w: window.innerWidth, h: window.innerHeight, numLines: range.getClientRects().length };
      }, o.id);
      const label = `${m.name}, ${o.label}`;
      // 2026-07-24 follow-up: the enlarged badge is close enough to some headings' natural wrap
      // limit (see the dated CSS comment, index.html § STYLE) that "never wraps to a second line"
      // is now its own permanent check, using Range.getClientRects() (one ClientRect per real line
      // box - not a height heuristic, which false-positives because a single line's own rendered
      // box is already taller than its nominal font-size).
      ok(geo.numLines === 1, `${label}: heading stays on ONE line (numLines=${geo.numLines})`);
      // Geometry: net margin (raw gap to the real screen edge, minus the shadow's blur radius)
      // must be genuinely positive on all four sides. LEFT/RIGHT/TOP use the SIGN's own rect
      // (nothing else in the card sits beside or above it); BOTTOM uses the whole CARD's rect
      // (the paragraph + buttons legitimately sit below the sign inside the card - that is normal
      // UI, not a clip bug, so the meaningful "does it reach the real bottom edge" question is
      // about the card as a whole, not the sign alone).
      const netLeft = geo.left - SIGN_BOX_SHADOW_BLUR;
      const netRight = (geo.w - geo.right) - SIGN_BOX_SHADOW_BLUR;
      const netTop = geo.top - SIGN_BOX_SHADOW_BLUR;
      const netBottom = geo.h - geo.cardBottom; // no shadow bleed to net out here - see above
      ok(netLeft >= MIN_NET_MARGIN, `${label}: real left margin ${netLeft.toFixed(1)}px (badge left=${geo.left.toFixed(1)}, minus ${SIGN_BOX_SHADOW_BLUR}px shadow reach)`);
      ok(netRight >= MIN_NET_MARGIN, `${label}: real right margin ${netRight.toFixed(1)}px`);
      ok(netTop >= MIN_NET_MARGIN, `${label}: real top margin ${netTop.toFixed(1)}px`);
      ok(netBottom >= MIN_NET_MARGIN, `${label}: real bottom margin ${netBottom.toFixed(1)}px (whole card bottom=${geo.cardBottom.toFixed(1)} vs viewport ${geo.h})`);
      // Pixels: an ACTUAL screenshot, decoded, sampled just past the margin above. This is the
      // check the first two fix attempts never did - both prior "fixes" verified the CARD's
      // geometry (or a font-size ratio) and missed that the SIGN itself, rotated with a shadow,
      // was the thing actually getting clipped by the card's own overflow box.
      const buf = await page.screenshot();
      const png = decodePNG(buf);
      const bg = pixelAt(png, 3, 3); // a corner of the screen, always outside the centered card
      const cx = Math.round((geo.left + geo.right) / 2);
      const cy = Math.round((geo.top + geo.bottom) / 2);
      const probes = {
        left: pixelAt(png, geo.left - PIXEL_BLEED_PROBE, cy),
        right: pixelAt(png, geo.right + PIXEL_BLEED_PROBE, cy),
        top: pixelAt(png, cx, geo.top - PIXEL_BLEED_PROBE),
        bottom: pixelAt(png, cx, Math.min(geo.cardBottom + PIXEL_BLEED_PROBE, png.height - 2)),
      };
      for (const side of ['left', 'right', 'top', 'bottom']) {
        const p = probes[side];
        if (!p) { ok(true, `${label}: ${side} probe point is off-screen (only possible with even MORE margin than required - fine)`); continue; }
        const d = colorDist(p, bg);
        ok(d <= MAX_BG_COLOR_DIST, `${label}: ${side} pixel just past the badge/card reads as background (color distance ${d.toFixed(1)}, badge/shadow would read 100+)`);
      }
      ok(errors.length === 0, `${label}: zero page errors`);
      await ctx.close();
    }
  }
}

// 2026-07-24 PERMANENT regression check - Blake's follow-up to the clip fix: "double them in size
// so they fill up more of the screen. Still leave some room on the ends though!" This quantifies
// the specific "room on the ends" band he asked for at the narrowest supported phone (320px wide,
// the short-screen tier) for the longest heading. Measured directly (Playwright), "REPLACE A
// SAVE?" (slotReplaceOverlay) - not "SAVE & LEAVE?" - turned out to be the true widest-rendered
// heading, so it is the one this check targets; see the dated CSS comment above .confirmCard .sign
// (index.html, § STYLE) for the full writeup on why the two "replace" overlays get their own
// smaller override instead of sharing the bigger enlargement the other three headings got.
async function partG_320pxMarginBand(browser) {
  console.log('\n=== Part G: PERMANENT - at the narrowest supported phone (320px), the longest heading keeps a real 5-10 percent margin band on each side (Blake\'s "room on the ends") ===');
  const MIN_PCT = 3.5, MAX_PCT = 12; // a little slack around the 5-10% target for font-render variance
  const ctx = await browser.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await ctx.newCDPSession(page).then((c) => c.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, bottom: 0, right: 0 } }));
  await page.goto(URL);
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
  await page.evaluate(() => document.getElementById('slotReplaceOverlay').classList.remove('hidden'));
  await page.waitForTimeout(200);
  const geo = await page.evaluate(() => {
    const sign = document.querySelector('#slotReplaceOverlay .confirmCard .sign');
    const b = document.querySelector('#slotReplaceOverlay .confirmCard .sign b');
    const sr = sign.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(b);
    return { left: sr.left, right: sr.right, w: window.innerWidth, numLines: range.getClientRects().length };
  });
  const netLeft = geo.left - SIGN_BOX_SHADOW_BLUR;
  const netRight = (geo.w - geo.right) - SIGN_BOX_SHADOW_BLUR;
  const pctLeft = netLeft / geo.w * 100, pctRight = netRight / geo.w * 100;
  ok(geo.numLines === 1, `320x568 REPLACE A SAVE?: stays on one line`);
  ok(pctLeft >= MIN_PCT && pctLeft <= MAX_PCT, `320x568 REPLACE A SAVE?: left margin ${pctLeft.toFixed(1)}% of screen width (target ${MIN_PCT}-${MAX_PCT}%, real ask was 5-10%)`);
  ok(pctRight >= MIN_PCT && pctRight <= MAX_PCT, `320x568 REPLACE A SAVE?: right margin ${pctRight.toFixed(1)}% of screen width`);
  await ctx.close();
}

// 2026-07-24 PERMANENT regression check - Blake's SAME-DAY follow-up to follow-up #1: "the 15%
// growth is far too timid, push much harder, roughly double, go as large as fits." His concrete
// numeric targets, keyed specifically to "SAVE & LEAVE?" (the longest of the three badges he
// actually named - CONCEDE?/LEAVE GAME?/SAVE & LEAVE? - fully decoupled from the two "replace"
// warnings' own smaller override, see the dated CSS comment above .confirmCard .sign, index.html,
// § STYLE):
// 1. On Blake's own phone class (390-430px wide), "SAVE & LEAVE?" should fill roughly 85% of the
//    screen width, with about a 6-8% margin left on each side.
// 2. At the narrowest supported phone (320px wide), "SAVE & LEAVE?" must still keep at least
//    roughly 5% margin on each side (the hard floor, separate from Part G's own check of
//    "REPLACE A SAVE?", the overall widest heading, which lives in the smaller override group).
async function partH_saveLeaveBigTarget(browser) {
  console.log('\n=== Part H: PERMANENT - "SAVE & LEAVE?" fills ~85% of the screen width with a real 6-8% margin on Blake\'s phone class (390-430px), and keeps >=5% margin at the narrowest 320px phone ===');
  async function measure(w, h) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await ctx.newCDPSession(page).then((c) => c.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, bottom: 0, right: 0 } }));
    await page.goto(URL);
    await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
    await page.evaluate(() => window.openSaveConfirm());
    await page.waitForTimeout(200);
    const geo = await page.evaluate(() => {
      const sign = document.querySelector('#saveLeaveConfirmOverlay .confirmCard .sign');
      const b = document.querySelector('#saveLeaveConfirmOverlay .confirmCard .sign b');
      const sr = sign.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(b);
      return { left: sr.left, right: sr.right, width: sr.width, w: window.innerWidth, numLines: range.getClientRects().length };
    });
    await ctx.close();
    const netLeft = geo.left - SIGN_BOX_SHADOW_BLUR;
    const netRight = (geo.w - geo.right) - SIGN_BOX_SHADOW_BLUR;
    const rawLeft = geo.left, rawRight = geo.w - geo.right; // Blake's own framing when he measured
    // CONCEDE?'s size ("79px of empty space each side") was the RAW gap to the edge, not net-of-
    // shadow-blur - the 6-8%/~5% targets below are checked against this RAW percentage to match
    // how the ask was actually phrased and measured, while the net (post-blur) figure is still
    // required to clear the file's real MIN_NET_MARGIN floor so the badge is never actually clipped.
    return {
      numLines: geo.numLines, pctWidth: geo.width / geo.w * 100,
      netLeft, netRight, pctRawLeft: rawLeft / geo.w * 100, pctRawRight: rawRight / geo.w * 100,
    };
  }
  // Phone-class check (390 and 430 - the span the "roughly 85%, 6-8% margin" target names).
  for (const [w, h] of [[390, 844], [430, 932]]) {
    const m = await measure(w, h);
    ok(m.numLines === 1, `${w}x${h} SAVE & LEAVE?: stays on one line`);
    ok(m.pctWidth >= 78 && m.pctWidth <= 94, `${w}x${h} SAVE & LEAVE?: badge is ${m.pctWidth.toFixed(1)}% of screen width (target ~85%)`);
    ok(m.pctRawLeft >= 4.5 && m.pctRawLeft <= 10, `${w}x${h} SAVE & LEAVE?: raw left margin ${m.pctRawLeft.toFixed(1)}% of screen width (target 6-8%)`);
    ok(m.pctRawRight >= 4.5 && m.pctRawRight <= 10, `${w}x${h} SAVE & LEAVE?: raw right margin ${m.pctRawRight.toFixed(1)}% of screen width`);
    ok(m.netLeft >= MIN_NET_MARGIN, `${w}x${h} SAVE & LEAVE?: net (post-shadow-blur) left margin ${m.netLeft.toFixed(1)}px clears the real "never clipped" floor`);
    ok(m.netRight >= MIN_NET_MARGIN, `${w}x${h} SAVE & LEAVE?: net (post-shadow-blur) right margin ${m.netRight.toFixed(1)}px clears the real "never clipped" floor`);
  }
  // Narrowest-phone hard floor (320px - the ~5% minimum, using the short-screen tier). Blake's
  // own ~5% ask is checked against the RAW gap (his own framing); the net (post-blur) figure is
  // required to clear the same MIN_NET_MARGIN floor as everywhere else in this file.
  {
    const m = await measure(320, 568);
    ok(m.numLines === 1, `320x568 SAVE & LEAVE?: stays on one line`);
    ok(m.pctRawLeft >= 4.5, `320x568 SAVE & LEAVE?: raw left margin ${m.pctRawLeft.toFixed(1)}% of screen width (hard floor ~5%)`);
    ok(m.pctRawRight >= 4.5, `320x568 SAVE & LEAVE?: raw right margin ${m.pctRawRight.toFixed(1)}% of screen width`);
    ok(m.netLeft >= MIN_NET_MARGIN, `320x568 SAVE & LEAVE?: net (post-shadow-blur) left margin ${m.netLeft.toFixed(1)}px clears the real "never clipped" floor`);
    ok(m.netRight >= MIN_NET_MARGIN, `320x568 SAVE & LEAVE?: net (post-shadow-blur) right margin ${m.netRight.toFixed(1)}px clears the real "never clipped" floor`);
  }
}

async function main() {
  const browser = await chromium.launch();
  await partA_smallDialogNotFullScreen(browser);
  await partB_bigDialogFitsWithRealSafeArea(browser);
  await partC_pathologicalTinyViewport(browser);
  await partD_reactiveToResize(browser);
  await partE_confirmCardSignScopedSmaller(browser);
  await partF_badgeMarginNeverClipped(browser);
  await partG_320pxMarginBand(browser);
  await partH_saveLeaveBigTarget(browser);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
