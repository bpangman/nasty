// v0.24 SPOTLIGHT tuning + glow regression suite (item 3 of the v0.24 batch).
// Offline-only (SKIP is a pass-and-play-only feature - see startSkip()'s `if(NET.online...)`
// guard, index.html), so this never touches any server or prod. Drives the real engine/UI
// functions directly via page.evaluate (the documented "fine to call the real functions
// directly" convention already used by chaos_v15.js et al) - rigs G.hands/G.pieces to force an
// exact kick or Jack swap, then calls performMove() directly, bypassing the turn loop/UI taps
// entirely (irrelevant to what's being tested: the animation/glow logic inside
// performMoveInner()).
//
// What v0.24 changed (see HANDOFF.md v0.24, index.html's applySpeed()/spotlightEvent()/
// performMoveInner()):
//   - SPOTLIGHT's boost dropped from a flat 2x to a two-tier scheme: 1.2x (near-normal pace)
//     when the kick/swap involves at least one HUMAN seat's peg, else the original 2x.
//   - A bright pulsing gold glow (.spotlightGlow) is added to the involved tee(s) for the
//     duration of a human-involved skip kick/swap - the attacker+victim for a kick (victim
//     keeps glowing through a brief extra "stable beat" after landing), both tees for a swap.
//   - All of this is SKIP-only and human-only. Normal (non-skip) play and INSTANT reconnect
//     catch-up are untouched; a pure CPU-vs-CPU kick/swap during a skip keeps the old plain 2x
//     pace with no glow at all.
//
// Run: node test_spotlight_v024.js

const { chromium } = require('/Users/jarvis/clawd/node_modules/playwright');

const URL = 'file:///Users/jarvis/nasty-game/index.html';
let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  OK  ', label); }
  else { fail++; console.log('  FAIL ', label); }
}

// ---- in-page helpers, installed once per page load ----
const INSTALL = () => {
  // n=4 FFA, `types` = ['human'|'cpu', ...] per seat. Rebuilds G/LAY/DOM from scratch so
  // successive sub-tests never bleed state into each other.
  window.__setupGame = (types) => {
    const n = types.length;
    const cols = n === 4 ? COLORS4 : COLORS6;
    const seats = types.map((t, i) => ({ name: 'P' + i, type: t, diff: 'medium', color: cols[i] }));
    LAY = buildLayout(n, computeViewSeat(n, seats));
    newGame({ n, teams: false, seats });
    document.getElementById('menu').classList.add('hidden');
    document.getElementById('game').classList.remove('hidden');
    document.getElementById('winOverlay').classList.add('hidden');
    clearToasts();
    drawBoard(); buildTable(); fitBoard();
    window.G = G; window.LAY = LAY;
    NETGEN++; // invalidate any stray queued microtask left over from a prior sub-test's G
    SKIP = false; SPOTLIGHT = false; SPOTLIGHT_HUMAN = false; INSTANT = false; applySpeed();
    // Test-only: pass-and-play's "pass the device" privacy screen (#passOverlay) reacts to
    // whose turn it visually is - irrelevant to what's being tested here (glow/timing) and
    // would otherwise cover the whole board in every screenshot. Force it hidden.
    document.getElementById('passOverlay').classList.add('hidden');
  };
  // Rigs seat `attacker`'s piece 0 to land exactly on seat `victim`'s piece 0 with a forward-5
  // card, then returns the real legalMoves() move object for it (kick guaranteed present).
  window.__rigKick = (attacker, victim) => {
    G.hands[attacker] = [{ r: '5', s: '♠', id: 9000 + attacker }];
    G.pieces[attacker][0] = { state: 'track', steps: 10 };
    const targetAbs = loopIdx(attacker, 15);
    const victimSteps = ((targetAbs - entryIdx(victim)) % LAY.L + LAY.L) % LAY.L;
    G.pieces[victim][0] = { state: 'track', steps: victimSteps };
    const moves = legalMoves(attacker);
    const m = moves.find((mv) => mv.type === 'move' && mv.kick && mv.kick.seat === victim);
    if (!m) throw new Error('rigKick: no matching move in legalMoves()');
    return m;
  };
  // Rigs seat `a`'s piece 1 and seat `b`'s piece 1 both onto the track with a Jack in `a`'s
  // hand, then returns the real legalMoves() swap move object.
  window.__rigSwap = (a, b) => {
    G.hands[a] = [{ r: 'J', s: '♥', id: 9100 + a }];
    G.pieces[a][1] = { state: 'track', steps: 20 };
    G.pieces[b][1] = { state: 'track', steps: 25 };
    const moves = legalMoves(a);
    const m = moves.find((mv) => mv.type === 'swap' && mv.pi === 1 && mv.ts === b && mv.tpi === 1);
    if (!m) throw new Error('rigSwap: no matching move in legalMoves()');
    return m;
  };
  window.__startMove = (seat, move, skip, instant) => {
    SKIP = !!skip; INSTANT = !!instant; SPOTLIGHT = false; SPOTLIGHT_HUMAN = false; applySpeed();
    // v0.24 test fix: __rigKick/__rigSwap mutate G.pieces AFTER buildTable() already rendered
    // every tee at its ORIGINAL (pre-rig) position - without this, the rigged piece's on-screen
    // element never actually sits at its rigged track spot, so a "did it land in its base slot"
    // check based on the DOM transform is meaningless (a still-in-base piece already visually
    // sits exactly at LAY.base, a false "already landed" match from frame zero). syncAll() here
    // makes the DOM match the rigged G state before the move's own animation starts, exactly
    // like a real turn does after every state change (§ ANIM's own convention).
    syncAll();
    window.__done = false; window.__err = null; window.__elapsed = null;
    const t0 = performance.now();
    window.__p = (async () => {
      try { await performMove(seat, move, null); }
      catch (e) { window.__err = String((e && e.stack) || e); }
      finally { window.__elapsed = performance.now() - t0; window.__done = true; }
    })();
    return true;
  };
  // Numeric "is this tee currently sitting in its base slot" check - deliberately NOT a string
  // compare against a hand-built "translate(x,y)" string: the browser normalizes/rounds
  // style.transform on readback (2 decimals, a space after the comma) while LAY.base's raw
  // floats do not, so a string compare silently never matches. Parse + compare numerically
  // with a small epsilon instead.
  window.__nearBase = (id, seat, pi) => {
    const t = document.getElementById(id).style.transform;
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(t);
    if (!m) return false;
    const x = parseFloat(m[1]), y = parseFloat(m[2]);
    const p = LAY.base[seat][pi];
    return Math.abs(x - p.x) < 0.5 && Math.abs(y - p.y) < 0.5;
  };
  window.__glowSnap = (ids) => ({
    done: window.__done,
    state: ids.map((id) => {
      const el = document.getElementById(id);
      return el ? el.classList.contains('spotlightGlow') : null;
    }),
  });
};

// Polls window.__done + the given tee-element glow classes at a short interval until the move
// resolves. Returns {elapsed, err, sawGlow: [boolean per id], everBothGlowSimultaneously,
// glowClearedBeforeDone}.
async function trackMove(page, ids, intervalMs = 12) {
  const seenGlow = ids.map(() => false);
  let sawBothAtOnce = false;
  let lastState = ids.map(() => false);
  let glowClearedTimestampSeen = false;
  for (;;) {
    const snap = await page.evaluate((ids) => window.__glowSnap(ids), ids);
    snap.state.forEach((v, i) => { if (v) seenGlow[i] = true; });
    if (snap.state.every(Boolean) && ids.length > 1) sawBothAtOnce = true;
    lastState = snap.state;
    if (snap.done) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  // one more sample right after done to confirm cleared
  const post = await page.evaluate((ids) => window.__glowSnap(ids), ids);
  const { elapsed, err } = await page.evaluate(() => ({ elapsed: window.__elapsed, err: window.__err }));
  return {
    elapsed, err,
    seenGlow, sawBothAtOnce,
    clearedAfterDone: post.state.every((v) => !v),
  };
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e)));
  await page.addInitScript(() => {
    try {
      localStorage.setItem('nasty-speed-chosen', '1');
      localStorage.setItem('nasty-speed', '0.6'); // "Normal" - the ladder default
    } catch (e) {}
  });
  await page.goto(URL);
  await page.waitForFunction(() => typeof CFG === 'object');
  await page.evaluate(INSTALL);

  console.log('\n=== 1. Human-involved SKIP swap: glow + near-normal pace ===');
  await page.evaluate(() => window.__setupGame(['human', 'human', 'cpu', 'cpu']));
  let move = await page.evaluate(() => window.__rigSwap(0, 1));
  await page.evaluate(({ move }) => window.__startMove(0, move, true, false), { move });
  let r = await trackMove(page, ['tee-0-1', 'tee-1-1']);
  ok(!r.err, 'swap (human, skip): no JS error - ' + r.err);
  ok(r.sawBothAtOnce, 'swap (human, skip): both swapping tees glowed simultaneously');
  ok(r.clearedAfterDone, 'swap (human, skip): glow class removed once the move resolved');
  const humanSkipSwapMs = r.elapsed;
  console.log('  elapsed:', humanSkipSwapMs.toFixed(0), 'ms');

  console.log('\n=== 2. Same swap, non-skip: baseline pace + proves no glow ever ===');
  await page.evaluate(() => window.__setupGame(['human', 'human', 'cpu', 'cpu']));
  move = await page.evaluate(() => window.__rigSwap(0, 1));
  await page.evaluate(({ move }) => window.__startMove(0, move, false, false), { move });
  r = await trackMove(page, ['tee-0-1', 'tee-1-1']);
  ok(!r.err, 'swap (human, non-skip): no JS error - ' + r.err);
  ok(r.seenGlow.every((v) => !v), 'swap (human, non-skip): glow class NEVER appears in normal play');
  const nonSkipSwapMs = r.elapsed;
  console.log('  elapsed:', nonSkipSwapMs.toFixed(0), 'ms (normal-speed baseline)');
  const swapRatio = humanSkipSwapMs / nonSkipSwapMs;
  ok(swapRatio > 0.5 && swapRatio < 1.3, `swap skip pace is near-normal (ratio ${swapRatio.toFixed(2)}, want ~0.5-1.3x normal, i.e. roughly normal or a bit faster, not a 30x blur)`);

  console.log('\n=== 3. CPU-vs-CPU SKIP swap: no glow, old fast 2x pace ===');
  await page.evaluate(() => window.__setupGame(['human', 'human', 'cpu', 'cpu']));
  move = await page.evaluate(() => window.__rigSwap(2, 3)); // both CPU seats
  await page.evaluate(({ move }) => window.__startMove(2, move, true, false), { move });
  r = await trackMove(page, ['tee-2-1', 'tee-3-1']);
  ok(!r.err, 'swap (CPU-vs-CPU, skip): no JS error - ' + r.err);
  ok(r.seenGlow.every((v) => !v), 'swap (CPU-vs-CPU, skip): NO glow - Blake only wants human-touching pieces highlighted');
  const cpuSkipSwapMs = r.elapsed;
  console.log('  elapsed:', cpuSkipSwapMs.toFixed(0), 'ms');
  ok(cpuSkipSwapMs < humanSkipSwapMs * 0.85, `CPU-vs-CPU skip swap (${cpuSkipSwapMs.toFixed(0)}ms) is meaningfully faster than the human-involved skip swap (${humanSkipSwapMs.toFixed(0)}ms) - old 2x pace preserved for CPU-only events`);

  console.log('\n=== 4. Human-involved SKIP kick: attacker+victim glow, stable beat, near-normal pace ===');
  await page.evaluate(() => window.__setupGame(['human', 'human', 'cpu', 'cpu']));
  move = await page.evaluate(() => window.__rigKick(0, 1));
  await page.evaluate(({ move }) => window.__startMove(0, move, true, false), { move });
  // finer-grained poll for the kick so we can see the victim land in its stable WHILE still glowing
  let landedWhileGlowing = false, glowAfterLanded = 0, landedAt = -1, tglow0 = Date.now();
  let atkVicBothGlowed = false;
  for (;;) {
    const snap = await page.evaluate(
      (a) => ({
        done: window.__done,
        atk: document.getElementById(a.atk).classList.contains('spotlightGlow'),
        vic: document.getElementById(a.vic).classList.contains('spotlightGlow'),
        atBase: window.__nearBase(a.vic, 1, 0),
      }),
      { atk: 'tee-0-0', vic: 'tee-1-0' }
    );
    if (snap.atk && snap.vic) atkVicBothGlowed = true;
    if (snap.atBase && landedAt < 0) landedAt = Date.now() - tglow0;
    if (snap.vic && snap.atBase) { landedWhileGlowing = true; glowAfterLanded = Date.now() - tglow0 - landedAt; }
    if (snap.done) break;
    await new Promise((res) => setTimeout(res, 8));
  }
  ok(atkVicBothGlowed, 'kick (human, skip): attacker AND victim glowed simultaneously (exactly the two involved tees)');
  const post2 = await page.evaluate((a) => ({
    atk: document.getElementById(a.atk).classList.contains('spotlightGlow'),
    vic: document.getElementById(a.vic).classList.contains('spotlightGlow'),
  }), { atk: 'tee-0-0', vic: 'tee-1-0' });
  const { elapsed: humanSkipKickMs, err: kickErr } = await page.evaluate(() => ({ elapsed: window.__elapsed, err: window.__err }));
  ok(!kickErr, 'kick (human, skip): no JS error - ' + kickErr);
  ok(landedWhileGlowing, 'kick (human, skip): victim tee glowed while sitting in its stable (the extra beat)');
  ok(glowAfterLanded > 100, `kick (human, skip): victim glow persisted a visible beat after landing (~${glowAfterLanded}ms measured, want >100ms)`);
  ok(!post2.atk && !post2.vic, 'kick (human, skip): both glow classes removed once the move resolved');
  console.log('  elapsed:', humanSkipKickMs.toFixed(0), 'ms, beat after landing:', glowAfterLanded, 'ms');

  console.log('\n=== 5. Same kick, non-skip: baseline pace + proves no glow ever ===');
  await page.evaluate(() => window.__setupGame(['human', 'human', 'cpu', 'cpu']));
  move = await page.evaluate(() => window.__rigKick(0, 1));
  await page.evaluate(({ move }) => window.__startMove(0, move, false, false), { move });
  r = await trackMove(page, ['tee-0-0', 'tee-1-0']);
  ok(!r.err, 'kick (human, non-skip): no JS error - ' + r.err);
  ok(r.seenGlow.every((v) => !v), 'kick (human, non-skip): glow class NEVER appears in normal play');
  const nonSkipKickMs = r.elapsed;
  console.log('  elapsed:', nonSkipKickMs.toFixed(0), 'ms (normal-speed baseline, includes the extra beat only in skip mode so this is a bit shorter by design)');
  const kickRatio = humanSkipKickMs / nonSkipKickMs;
  ok(kickRatio > 0.5 && kickRatio < 1.6, `kick skip pace is near-normal (ratio ${kickRatio.toFixed(2)} incl. the added stable beat, want roughly normal-ish, not a 30x blur)`);

  console.log('\n=== 6. CPU-vs-CPU SKIP kick: no glow, no beat, old fast 2x pace ===');
  await page.evaluate(() => window.__setupGame(['human', 'human', 'cpu', 'cpu']));
  move = await page.evaluate(() => window.__rigKick(2, 3)); // both CPU seats
  await page.evaluate(({ move }) => window.__startMove(2, move, true, false), { move });
  r = await trackMove(page, ['tee-2-0', 'tee-3-0']);
  ok(!r.err, 'kick (CPU-vs-CPU, skip): no JS error - ' + r.err);
  ok(r.seenGlow.every((v) => !v), 'kick (CPU-vs-CPU, skip): NO glow');
  const cpuSkipKickMs = r.elapsed;
  console.log('  elapsed:', cpuSkipKickMs.toFixed(0), 'ms');
  ok(cpuSkipKickMs < humanSkipKickMs * 0.85, `CPU-vs-CPU skip kick (${cpuSkipKickMs.toFixed(0)}ms) is meaningfully faster than the human-involved skip kick (${humanSkipKickMs.toFixed(0)}ms) - no extra beat, old 2x pace`);

  console.log('\n=== 7. INSTANT reconnect catch-up: zero visible animation, no glow, untouched ===');
  await page.evaluate(() => window.__setupGame(['human', 'human', 'cpu', 'cpu']));
  move = await page.evaluate(() => window.__rigSwap(0, 1));
  await page.evaluate(({ move }) => window.__startMove(0, move, false, true), { move });
  r = await trackMove(page, ['tee-0-1', 'tee-1-1'], 4);
  ok(!r.err, 'swap (INSTANT): no JS error - ' + r.err);
  ok(r.seenGlow.every((v) => !v), 'swap (INSTANT): no glow');
  ok(r.elapsed < 60, `swap (INSTANT): near-zero elapsed (${r.elapsed.toFixed(1)}ms) - no visible animation`);

  await page.evaluate(() => window.__setupGame(['human', 'human', 'cpu', 'cpu']));
  move = await page.evaluate(() => window.__rigKick(0, 1));
  await page.evaluate(({ move }) => window.__startMove(0, move, false, true), { move });
  r = await trackMove(page, ['tee-0-0', 'tee-1-0'], 4);
  ok(!r.err, 'kick (INSTANT): no JS error - ' + r.err);
  ok(r.seenGlow.every((v) => !v), 'kick (INSTANT): no glow');
  ok(r.elapsed < 60, `kick (INSTANT): near-zero elapsed (${r.elapsed.toFixed(1)}ms) - no visible animation`);

  console.log('\n=== 8. Screenshots for eyeballing (mid-swap glow, mid-kick glow, stable-beat glow) ===');
  await page.evaluate(() => window.__setupGame(['human', 'human', 'cpu', 'cpu']));
  move = await page.evaluate(() => window.__rigSwap(0, 1));
  await page.evaluate(({ move }) => window.__startMove(0, move, true, false), { move });
  for (;;) {
    const snap = await page.evaluate((ids) => window.__glowSnap(ids), ['tee-0-1', 'tee-1-1']);
    if (snap.state.every(Boolean)) { await page.screenshot({ path: '/tmp/v024_swap_glow.png' }); break; }
    if (snap.done) break;
    await new Promise((res) => setTimeout(res, 8));
  }
  await page.waitForFunction(() => window.__done);
  console.log('  saved /tmp/v024_swap_glow.png');

  await page.evaluate(() => window.__setupGame(['human', 'human', 'cpu', 'cpu']));
  move = await page.evaluate(() => window.__rigKick(0, 1));
  await page.evaluate(({ move }) => window.__startMove(0, move, true, false), { move });
  let shotKick = false, shotBeat = false;
  for (;;) {
    const snap = await page.evaluate(
      (a) => ({
        done: window.__done,
        atk: document.getElementById(a.atk).classList.contains('spotlightGlow'),
        vic: document.getElementById(a.vic).classList.contains('spotlightGlow'),
        atBase: window.__nearBase(a.vic, 1, 0),
      }),
      { atk: 'tee-0-0', vic: 'tee-1-0' }
    );
    if (!shotKick && snap.atk && snap.vic && !snap.atBase) {
      await page.screenshot({ path: '/tmp/v024_kick_glow.png' }); shotKick = true;
    }
    if (!shotBeat && snap.vic && snap.atBase) {
      await page.screenshot({ path: '/tmp/v024_kick_stable_beat_glow.png' }); shotBeat = true;
    }
    if (snap.done) break;
    await new Promise((res) => setTimeout(res, 6));
  }
  console.log('  saved /tmp/v024_kick_glow.png (mid-flight), /tmp/v024_kick_stable_beat_glow.png (stable beat) -', shotKick, shotBeat);
  ok(shotKick, 'kick: caught a mid-flight glow screenshot');
  ok(shotBeat, 'kick: caught a stable-beat glow screenshot');

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
