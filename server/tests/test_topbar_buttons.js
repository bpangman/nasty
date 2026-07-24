// 2026-07-23 permanent regression suite - Blake's items 5 and 12:
//   5. Split the combined "Pause/Save" topbar button into two: Pause (unchanged - opens the
//      full options sheet) and Save (new - saves immediately, then asks a simple yes/no "are you
//      sure you want to leave" before it ever leaves the game).
//   12. Every topbar button reads in ALL CAPS with no emoji/icon glyph (Quit, Pause, Save,
//       Speed, Rules, Mute) - the fixed-position Skip button below the board is OUT of scope
//       (it lives outside #topbar entirely, see index.html's own topbar history).
//
// Fully offline (file://) - no server needed for most of this; a couple of online-flavored
// checks stub NET.online directly rather than spinning up a real room, since this suite is about
// the BUTTON/DIALOG behavior, not server-side surrender/save semantics (already covered by
// test_surrender.js and the offline-save machinery already covered elsewhere).
//
// Run: node test_topbar_buttons.js

const { chromium } = require('/Users/jarvis/clawd/node_modules/playwright');
const path = require('path');

const URL = 'file://' + path.resolve(__dirname, '..', '..', 'index.html');
let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  OK  ', label); }
  else { fail++; console.log('  FAIL ', label); }
}
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}✖⏸]/u;   // covers ✕ ⏸ 🔊 🔇 etc.

async function newGame(page) {
  await page.goto(URL);
  await page.waitForSelector('#btnStart');
  await page.click('#btnStart');
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('#handRow .card').length > 0 ||
    !document.getElementById('speedPickerOverlay').classList.contains('hidden'), { timeout: 20000 });
  const pickerVisible = await page.evaluate(() => {
    const sp = document.getElementById('speedPickerOverlay');
    return sp && !sp.classList.contains('hidden');
  });
  if (pickerVisible) await page.click('#btnSpeedPick0');
  await page.waitForTimeout(150);
}

async function partA_labels(browser) {
  console.log('\n=== Part A: item 12 - every topbar button, plain text + all-caps display ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e)));
  await newGame(page);

  const ids = ['btnMenu', 'btnPause', 'btnSave', 'btnSpeed', 'btnRules2', 'btnMute'];
  for (const id of ids) {
    const info = await page.evaluate((elId) => {
      const el = document.getElementById(elId);
      const cs = getComputedStyle(el);
      return { text: el.textContent, transform: cs.textTransform, inTopbar: !!el.closest('#topbar') };
    }, id);
    ok(info.inTopbar, `#${id} lives inside #topbar`);
    ok(!EMOJI.test(info.text), `#${id}'s raw text has no emoji/icon glyph (got "${info.text}")`);
    ok(info.transform === 'uppercase', `#${id} is rendered all-caps via CSS (text-transform: ${info.transform})`);
  }

  // Skip stays OUT of scope - fixed position below the board, not part of #topbar.
  const skipInfo = await page.evaluate(() => {
    const el = document.getElementById('btnSkip');
    return { inTopbar: !!el.closest('#topbar'), transform: getComputedStyle(el).textTransform };
  });
  ok(!skipInfo.inTopbar, 'Skip button is NOT inside #topbar (explicitly out of scope for item 12)');
  ok(skipInfo.transform !== 'uppercase', 'Skip button is untouched by the topbar all-caps rule');

  // Mute toggle: label swaps between plain "Mute"/"Unmute", no emoji ever, in either state.
  const muteBefore = await page.evaluate(() => document.getElementById('btnMute').textContent);
  await page.click('#btnMute');
  const muteAfter = await page.evaluate(() => document.getElementById('btnMute').textContent);
  await page.click('#btnMute');   // toggle back, don't leave the game muted for later parts
  ok(!EMOJI.test(muteBefore) && !EMOJI.test(muteAfter), `mute toggle text never uses emoji ("${muteBefore}" <-> "${muteAfter}")`);
  ok(muteBefore !== muteAfter, 'mute toggle text actually changes on click');

  // Visual: real rendered glyphs are uppercase on screen even though textContent is mixed case.
  const rendered = await page.evaluate(() => {
    const b = document.getElementById('btnMenu');
    return getComputedStyle(b, null).textTransform;
  });
  ok(rendered === 'uppercase', 'Quit button computed style is uppercase (display-only, textContent unaffected)');

  await page.close();
}

async function partB_widthMatrix(browser) {
  console.log('\n=== Part B: topbar buttons never wrap/clip their own label, 320px up to the widest iPhone ===');
  const sizes = [320, 375, 390, 393, 430];
  for (const w of sizes) {
    const page = await browser.newPage({ viewport: { width: w, height: 844 } });
    page.on('pageerror', (e) => console.log('  [pageerror]', String(e)));
    await newGame(page);
    const btns = await page.evaluate(() => {
      return [...document.querySelectorAll('#topbar .iconBtn')].map((b) => {
        const r = b.getBoundingClientRect();
        return { id: b.id, h: r.height, w: r.width };
      });
    });
    const heights = btns.map((b) => b.h);
    const uniform = heights.every((h) => Math.abs(h - heights[0]) < 1);
    ok(uniform, `${w}px: every topbar button is the same height (no 2-line wrap on any one) - ${JSON.stringify(heights.map(h=>Math.round(h)))}`);
    ok(btns.every((b) => b.w > 0), `${w}px: every topbar button has non-zero rendered width (nothing clipped to invisible)`);
    await page.close();
  }
}

// 2026-07-23 FOLLOW-UP (coordinator escalation): a 6th topbar button (#btnSave) made the row
// wider than every current iPhone, forcing a horizontal scroll to reach Rules/Mute - flagged
// honestly in the first pass of this batch, but ruled unacceptable given item 6 in this SAME
// batch was itself a complaint about something being bigger than the screen. This is now a
// PERMANENT hard assertion so that regression can never silently come back: the topbar's own
// scrollWidth must exactly equal its clientWidth (zero horizontal overflow, no scrollbar needed
// at all) at every width in Blake's own test matrix, WITH real iPhone-shaped safe-area insets
// applied (notch/Dynamic Island top strip + home-indicator bottom strip - safe-area insets are
// vertical padding, not horizontal, but applied anyway for parity with test_overlay_sizing.js and
// to rule out any interaction), AND with every button forced to its OWN worst-case (longest)
// label at once: Speed on Turbo (the longest speed word) and Mute toggled to "Unmute" (the
// longest mute word) simultaneously - a real family game will eventually land on exactly this
// combination, and it must still fit with zero scroll, not just the defaults.
async function partB2_zeroHorizontalOverflowMatrix(browser) {
  console.log('\n=== Part B2: ZERO horizontal overflow, full matrix, real safe-area insets, worst-case labels ===');
  const MATRIX = [
    { w: 320, h: 568, top: 0, bottom: 0 },
    { w: 375, h: 667, top: 0, bottom: 0 },
    { w: 390, h: 844, top: 47, bottom: 34 },
    { w: 393, h: 852, top: 59, bottom: 34 },
    { w: 430, h: 932, top: 59, bottom: 34 },
  ];
  for (const m of MATRIX) {
    const ctx = await browser.newContext({ viewport: { width: m.w, height: m.h } });
    const page = await ctx.newPage();
    const client = await ctx.newCDPSession(page);
    await client.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: m.top, left: 0, bottom: m.bottom, right: 0 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await newGame(page);
    // Force the worst-case label combination: Turbo speed + Unmute state. USER_SPEED/muted are
    // script-local `let` bindings, not window properties - bare-identifier assignment inside
    // evaluate() reaches the real top-level binding (see HANDOFF.md's window.SPEED note for why
    // `window.USER_SPEED=` would silently no-op instead).
    await page.evaluate(() => {
      USER_SPEED = 2.6;
      updateSpeedButtonLabel();
      muted = true;
      document.getElementById('btnMute').textContent = 'Unmute';
    });
    await page.waitForTimeout(100);
    const info = await page.evaluate(() => {
      const tb = document.getElementById('topbar');
      const btns = [...tb.querySelectorAll('.iconBtn')].map((b) => {
        const r = b.getBoundingClientRect();
        return { id: b.id, text: b.textContent, h: r.height, left: r.left, right: r.right };
      });
      return { clientWidth: tb.clientWidth, scrollWidth: tb.scrollWidth, btns };
    });
    ok(info.scrollWidth === info.clientWidth,
      `${m.w}x${m.h} (safe-area top=${m.top}/bottom=${m.bottom}): scrollWidth (${info.scrollWidth}) === clientWidth (${info.clientWidth}) - ZERO horizontal overflow, worst-case labels ${JSON.stringify(info.btns.map((b) => b.text))}`);
    ok(info.btns.every((b) => b.h >= 44), `${m.w}x${m.h}: every button stays at/above the 44px tap-target floor (heights: ${JSON.stringify(info.btns.map((b) => Math.round(b.h)))})`);
    ok(info.btns.every((b) => b.left >= -0.5 && b.right <= m.w + 0.5), `${m.w}x${m.h}: every button fully within the viewport, none clipped off-edge`);
    ok(errors.length === 0, `${m.w}x${m.h}: zero page errors`);
    await ctx.close();
  }
}

async function partC_saveButtonBehavior(browser) {
  console.log('\n=== Part C: item 5 - Save button (offline) ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e)));
  await newGame(page);

  const savedBeforeTap = await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('nasty-save')));
  ok(!savedBeforeTap, 'sanity: no offline save exists yet, fresh game');

  await page.click('#btnSave');
  await page.waitForTimeout(200);
  const overlayShown = await page.evaluate(() => !document.getElementById('saveLeaveConfirmOverlay').classList.contains('hidden'));
  ok(overlayShown, 'tapping Save opens the save-leave confirm overlay');

  const savedAfterTapBeforeAnswer = await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('nasty-save')));
  ok(savedAfterTapBeforeAnswer, 'THE SAVE ALREADY HAPPENED before the confirm is answered at all (Blake: "the game is saved regardless")');

  // Pause was NEVER requested by this path (no PAUSED_BY_SHEET-style freeze for a quick save tap).
  const pausedWhileConfirmOpen = await page.evaluate(() => window.G.paused);
  ok(pausedWhileConfirmOpen === false, 'the table is NOT paused while the Save confirm is open (unlike the Pause sheet)');

  // Cancel: stays in the game, save persists (harmless - it already happened).
  await page.click('#btnSaveLeaveCancel');
  await page.waitForTimeout(150);
  const stillInGame = await page.evaluate(() => !document.getElementById('game').classList.contains('hidden'));
  ok(stillInGame, 'Cancel ("Keep Playing") returns to the SAME game, does not leave');
  const overlayHiddenAfterCancel = await page.evaluate(() => document.getElementById('saveLeaveConfirmOverlay').classList.contains('hidden'));
  ok(overlayHiddenAfterCancel, 'Cancel closes the confirm overlay');

  const statsBefore = await page.evaluate(() => localStorage.getItem('nasty-stats'));

  // Tap Save again, this time confirm Leave.
  await page.click('#btnSave');
  await page.waitForTimeout(150);
  await page.click('#btnSaveLeaveConfirm');
  await page.waitForTimeout(200);
  const onMenu = await page.evaluate(() => !document.getElementById('menu').classList.contains('hidden'));
  ok(onMenu, 'confirming Leave lands back on the menu');

  const savedAfterLeave = await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('nasty-save')));
  ok(savedAfterLeave, 'the save is still on disk after leaving (this is "Save & leave", not a discard)');

  const statsAfter = await page.evaluate(() => localStorage.getItem('nasty-stats'));
  ok(statsBefore === statsAfter, 'no stat/loss was recorded by Save & Leave (never a surrender/concede path)');

  const resumeTileVisible = await page.evaluate(() => {
    const t1 = [...document.querySelectorAll('.t1')].find((e) => /Resume Saved Game/i.test(e.textContent));
    return !!t1 && !t1.closest('.hidden');
  });
  ok(resumeTileVisible, 'the menu shows a real "Resume Saved Game" tile afterward - the save is genuine and resumable');

  await page.close();
}

async function partD_pauseButtonUnchanged(browser) {
  console.log('\n=== Part D: item 5 - Pause button keeps every option the old combined button had ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e)));
  await newGame(page);

  await page.click('#btnPause');
  await page.waitForTimeout(150);
  const sheetShown = await page.evaluate(() => !document.getElementById('leaveConfirmOverlay').classList.contains('hidden'));
  ok(sheetShown, 'tapping Pause opens the full options sheet (leaveConfirmOverlay), unchanged');

  const pausedNow = await page.evaluate(() => window.G.paused);
  ok(pausedNow === true, 'tapping Pause DOES pause the table (unlike the new Save button)');

  const labels = await page.evaluate(() => {
    return [...document.querySelectorAll('#leaveConfirmOverlay .bigBtns .btn')]
      .filter((b) => !b.classList.contains('hidden'))
      .map((b) => b.textContent.trim());
  });
  ok(labels.some((t) => /return to game/i.test(t)), 'sheet still offers "Return to Game"');
  ok(labels.some((t) => /save.*leave/i.test(t)), 'sheet still offers "Save & leave"');
  ok(labels.some((t) => /leave without saving/i.test(t)), 'sheet still offers "Leave without saving"');
  ok(!labels.some((t) => /have a computer take over/i.test(t)), 'offline: "Have a computer take over" correctly hidden (online-only, unchanged gating)');

  await page.evaluate(() => document.getElementById('btnLeaveCancel').click());
  await page.waitForTimeout(150);
  const resumed = await page.evaluate(() => window.G.paused === false);
  ok(resumed, 'Return to Game / Cancel resumes the table again, sheet-started pause released');

  await page.close();
}

async function main() {
  const browser = await chromium.launch();
  await partA_labels(browser);
  await partB_widthMatrix(browser);
  await partB2_zeroHorizontalOverflowMatrix(browser);
  await partC_saveButtonBehavior(browser);
  await partD_pauseButtonUnchanged(browser);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
