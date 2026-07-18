// v0.21 leaderboard Solo/Teams tab UI verification (client-side). Against a private Node
// server instance (never prod) - same startup shape as test_leaderboard_scenarios.js. Covers:
//   (A) tab math + empty state, driven directly through renderLb()/setLbTab() the same way
//       v0.19.1's own verification called renderLb(loadStats()) directly - bypasses the network
//       fetch, exercises the exact render path Blake sees, no server round trip needed for pure
//       rendering-logic checks.
//   (B) the v0.19.1 fixed-layout table still fits at 320px width with zero horizontal scroll
//       and zero wrapped cells, for BOTH tabs, using the same verification method that release
//       used (document.documentElement.scrollWidth === window.innerWidth, and
//       Range.getClientRects().length === 1 per cell - not just a height heuristic).
//   (C) end-to-end against the real global leaderboard: open the overlay (default tab must be
//       Solo), switch tabs, confirm each tab shows only that mode's numbers, confirm reopening
//       the overlay resets back to Solo, then the admin panel's split-points editor (unlock,
//       edit both split inputs, save, confirm reflected back in the tabs).
const { chromium } = require('/Users/jarvis/clawd/node_modules/playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 17300 + Math.floor(Math.random() * 300);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'nasty-lbui-'));
const WS_URL = `ws://localhost:${PORT}`;
const BASE = `http://localhost:${PORT}`;
const ADMIN_TOKEN = 'lbui-admin-token';

let PASS = 0, FAIL = 0;
function log(...a) { console.log('[lbui]', ...a); }
function check(cond, label) { if (cond) { PASS++; log('OK ', label); } else { FAIL++; log('FAIL', label); } }

function startServer() {
  fs.writeFileSync(path.join(SCRATCH, 'admin-token.txt'), ADMIN_TOKEN + '\n');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: '/Users/jarvis/nasty-game/server',
    env: Object.assign({}, process.env, {
      NASTY_PORT: String(PORT), NASTY_ROOMS_DIR: SCRATCH,
      NASTY_ADMIN_TOKEN_FILE: path.join(SCRATCH, 'admin-token.txt'),
      NASTY_LEADERBOARD_FILE: path.join(SCRATCH, 'leaderboard.json'),
      NASTY_LEADERBOARD_EPOCH_FILE: path.join(SCRATCH, 'leaderboard-epoch.json'),
      NASTY_SOLO_IDS_FILE: path.join(SCRATCH, 'solo-ids.json'),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write('[srv-err] ' + d));
  return child;
}
async function waitHealthy() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) return; } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('server never healthy');
}
async function postSoloResult(gameId, entries) {
  const r = await fetch(BASE + '/solo-result', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gameId, entries }),
  });
  if (!r.ok) throw new Error('solo-result POST failed: ' + r.status);
}

// Checks the currently-rendered #lbTable (whichever tab is active) fits at the page's current
// viewport with zero horizontal scroll and zero wrapped cells - the exact v0.19.1 verification
// method (a height-only heuristic falsely flags the clamp() font growing taller as "wrapped").
async function checkTableFits(page, label) {
  const result = await page.evaluate(() => {
    const noScroll = document.documentElement.scrollWidth === window.innerWidth;
    const cells = Array.from(document.querySelectorAll('.lbTable th, .lbTable td'));
    let wrapped = 0;
    for (const cell of cells) {
      const range = document.createRange();
      range.selectNodeContents(cell);
      if (range.getClientRects().length > 1) wrapped++;
    }
    return { noScroll, wrapped, cellCount: cells.length };
  });
  check(result.noScroll, `${label}: zero horizontal scroll at this viewport`);
  check(result.cellCount > 0, `${label}: table actually rendered (nonzero cells)`);
  check(result.wrapped === 0, `${label}: zero wrapped cells (${result.wrapped} of ${result.cellCount})`);
}

async function main() {
  const child = startServer();
  await waitHealthy();
  const browser = await chromium.launch();

  // ================= (A) tab math + empty state - direct renderLb()/setLbTab(), no network =================
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => log('pageerror(A):', String(e)));
    await page.goto(`file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent(WS_URL)}`);
    await page.waitForFunction(() => typeof window.NET === 'object');

    // Solo-only stats (no team keys at all for either player) - exercises the Solo tab's numbers
    // AND proves the Teams tab is the correct kind of empty (not just "no players anywhere").
    await page.evaluate(() => {
      localStorage.setItem('nasty-stats', JSON.stringify({
        SoloOne: { hg4s: 5, hw4s: 2, hptsS: 14 },
        SoloTwo: { hg6s: 3, hw6s: 1, hptsS: 6 },
      }));
      lbTab = 'solo';
      renderLb(loadStats());
    });
    let html = await page.evaluate(() => document.getElementById('lbBody').innerHTML);
    check(/SoloOne/.test(html) && /SoloTwo/.test(html), 'A: Solo tab shows both solo-only players');
    let row = await page.evaluate(() => {
      const tr = Array.from(document.querySelectorAll('.lbTable tr')).find((r) => r.textContent.includes('SoloOne'));
      return tr ? Array.from(tr.children).map((td) => td.textContent) : null;
    });
    check(row && row[1] === '5' && row[2] === '2' && row[3] === '40%' && row[4] === '14', `A: SoloOne row values correct (games/wins/win%/points) - got ${JSON.stringify(row)}`);

    await page.evaluate(() => setLbTab('teams'));
    html = await page.evaluate(() => document.getElementById('lbBody').innerHTML);
    check(html.trim() === '<p>No team games yet - go play one!</p>', `A: Teams tab empty-state copy exact match - got "${html.trim()}"`);
    check(!/–|—/.test(html), 'A: Teams empty-state has no em/en dashes (plain hyphens are fine and expected)');

    await page.evaluate(() => setLbTab('solo'));
    html = await page.evaluate(() => document.getElementById('lbBody').innerHTML);
    check(/SoloOne/.test(html), 'A: switching back to Solo re-renders the same players (lbLastStats reused, no re-fetch needed)');

    // Now the reverse shape - team-only stats - to exercise the Solo tab's empty state text too.
    await page.evaluate(() => {
      localStorage.setItem('nasty-stats', JSON.stringify({ TeamOne: { hg4t: 4, hw4t: 1, hptsT: 3 } }));
      lbTab = 'solo';
      renderLb(loadStats());
    });
    html = await page.evaluate(() => document.getElementById('lbBody').innerHTML);
    check(html.trim() === '<p>No solo games yet - go play one!</p>', `A: Solo tab empty-state copy exact match - got "${html.trim()}"`);
    await page.evaluate(() => setLbTab('teams'));
    html = await page.evaluate(() => document.getElementById('lbBody').innerHTML);
    check(/TeamOne/.test(html), 'A: Teams tab shows the team-only player once switched');

    await ctx.close();
  }

  // ================= (B) 320px fixed-layout fit, both tabs, digits + a full 10-char name =================
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => log('pageerror(B):', String(e)));
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent(WS_URL)}`);
    await page.waitForFunction(() => typeof window.NET === 'object');
    await page.evaluate(() => {
      // Whitmore/Maximilian mirror v0.19.1's own stress values (3-digit games/points, a full
      // 10-character name) - reused here per mode so BOTH tabs get the same stress test.
      localStorage.setItem('nasty-stats', JSON.stringify({
        Whitmore: { hg4s: 100, hw4s: 60, hptsS: 999, hg4t: 80, hw4t: 40, hptsT: 777 },
        Maximilian: { hg6s: 28, hw6s: 9, hptsS: 114, hg6t: 22, hw6t: 7, hptsT: 88 },
        Alice: { hg4s: 12, hw4s: 4, hptsS: 30, hg6t: 9, hw6t: 2, hptsT: 15 },
      }));
      lbTab = 'solo';
      renderLb(loadStats());
    });
    await checkTableFits(page, 'B(solo@320px)');
    await page.evaluate(() => setLbTab('teams'));
    await checkTableFits(page, 'B(teams@320px)');
    await ctx.close();
  }

  // ================= (C) end-to-end: real global board, open/switch tabs, reopen resets to Solo, admin edit =================
  {
    await postSoloResult('lbui-casey-1', [{ name: 'Casey', delta: { hg4s: 1, hw4s: 1, hptsS: 9 } }]);
    await postSoloResult('lbui-drew-1', [{ name: 'Drew', delta: { hg6t: 1, hw6t: 1, hptsT: 12 } }]);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => log('pageerror(C):', String(e)));
    await page.goto(`file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent(WS_URL)}`);
    await page.waitForFunction(() => typeof window.NET === 'object');

    await page.click('#btnLb');
    await new Promise((r) => setTimeout(r, 1500)); // let the global fetch land, same wait style as test_leaderboard_scenarios.js
    let soloOn = await page.evaluate(() => document.getElementById('lbTabSolo').classList.contains('on'));
    let teamsOn = await page.evaluate(() => document.getElementById('lbTabTeams').classList.contains('on'));
    check(soloOn && !teamsOn, 'C: leaderboard opens with Solo as the active/default tab');
    let html = await page.evaluate(() => document.getElementById('lbBody').innerHTML);
    check(/Casey/.test(html) && !/Drew/.test(html), 'C: Solo tab shows the solo winner only, not the team winner');

    await page.click('#lbTabTeams');
    await new Promise((r) => setTimeout(r, 200));
    soloOn = await page.evaluate(() => document.getElementById('lbTabSolo').classList.contains('on'));
    teamsOn = await page.evaluate(() => document.getElementById('lbTabTeams').classList.contains('on'));
    check(!soloOn && teamsOn, 'C: clicking Teams swaps the active tab styling');
    html = await page.evaluate(() => document.getElementById('lbBody').innerHTML);
    check(/Drew/.test(html) && !/Casey/.test(html), 'C: Teams tab shows the team winner only, not the solo winner');

    // Close and reopen - must reset back to Solo (the spec'd default-on-open behavior), not
    // remember the last tab that was showing when it closed.
    await page.click('#btnLbClose');
    await page.click('#btnLb');
    await new Promise((r) => setTimeout(r, 1200));
    soloOn = await page.evaluate(() => document.getElementById('lbTabSolo').classList.contains('on'));
    teamsOn = await page.evaluate(() => document.getElementById('lbTabTeams').classList.contains('on'));
    check(soloOn && !teamsOn, 'C: reopening the leaderboard resets to Solo even after Teams was last shown');
    html = await page.evaluate(() => document.getElementById('lbBody').innerHTML);
    check(/Casey/.test(html), 'C: reopened Solo tab shows the solo winner again');
    await page.click('#btnLbClose');

    // ---- admin panel: unlock, edit both split-point inputs for Casey, save, confirm reflected ----
    await page.evaluate((token) => { localStorage.setItem('nasty-admin-token', token); }, ADMIN_TOKEN);
    for (let i = 0; i < 7; i++) await page.click('#verTap');
    await page.waitForSelector('#adminUnlocked:not(.hidden)', { timeout: 5000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('.adminPtsInput[data-name="Casey"][data-field="hptsS"]');
      return el && el.value === '9';
    }, { timeout: 5000 });
    check(true, 'C(admin): admin panel unlocked and shows Casey\'s current split points (hptsS=9)');
    await page.fill('.adminPtsInput[data-name="Casey"][data-field="hptsS"]', '25');
    // Click the Save button that sits in the SAME row as Casey's inputs.
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.adminSavePts')).find((b) => b.dataset.name === 'Casey');
      btn.click();
    });
    await new Promise((r) => setTimeout(r, 800));
    const patched = await (await fetch(BASE + '/leaderboard')).json();
    check(patched.Casey && patched.Casey.hptsS === 25, `C(admin): admin edit PATCHed the real server value to 25 - got ${JSON.stringify(patched.Casey)}`);
    await page.click('#btnAdminClose2'); // unlocked panel's own Close button (btnAdminClose is the locked-state one)
    await page.click('#btnLb');
    await new Promise((r) => setTimeout(r, 1200));
    html = await page.evaluate(() => document.getElementById('lbBody').innerHTML);
    check(/Casey/.test(html) && /25/.test(html), 'C(admin): the Solo tab reflects the admin-edited points after reopening');

    await ctx.close();
  }

  await browser.close();
  child.kill('SIGTERM');
  console.log(`\n${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
