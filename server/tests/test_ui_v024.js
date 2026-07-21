// v0.24 UI regression suite - item 1 (rules panel dealing text, both game sizes) and item 2
// (the seat-list rename affordance, offline menu + online lobby). Item 3 (spotlight glow) has
// its own suite, test_spotlight_v024.js.
//
// Part C spins up a PRIVATE server.js instance (random port, scratch rooms dir) exactly like
// smoke_server.js/chaos_v15.js - never touches prod. Parts A/B are fully offline (file://).
//
// Run: node test_ui_v024.js

const { chromium } = require('/Users/jarvis/clawd/node_modules/playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const URL = 'file:///Users/jarvis/nasty-game/index.html';
let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  OK  ', label); }
  else { fail++; console.log('  FAIL ', label); }
}
const EMDASH = /[–—]/;

async function newPage(browser, viewport) {
  const page = await browser.newPage({ viewport: viewport || { width: 320, height: 640 } });
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e)));
  return page;
}

async function partA_rulesPanel(browser) {
  console.log('\n=== Part A: Rules panel dealing text (item 1) ===');
  const page = await newPage(browser, { width: 320, height: 640 });
  await page.goto(URL);
  await page.waitForFunction(() => typeof CFG === 'object');
  await page.click('#btnRules');
  await page.waitForSelector('#rulesOverlay:not(.hidden)');
  await page.screenshot({ path: '/tmp/v024_rules_320.png', fullPage: false });
  const text320 = await page.evaluate(() => document.getElementById('rulesOverlay').innerText);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/v024_rules_phone.png', fullPage: false });
  const textPhone = await page.evaluate(() => document.getElementById('rulesOverlay').innerText);

  ok(text320 === textPhone, 'rules panel text identical at 320px and phone width (only layout should differ)');
  ok(/4 players/i.test(text320), 'rules panel mentions the 4-player dealing shape');
  ok(/6 players/i.test(text320), 'rules panel mentions the 6-player dealing shape');
  ok(/5.*then 4.*then 4|5, then 4, then 4/i.test(text320), 'rules panel states 4P: 5 then 4 then 4');
  ok(/4, then 4|4.*then 4.*48/i.test(text320), 'rules panel states 6P: 4 then 4 (48 used)');
  ok(/48 of 52|48/.test(text320), 'rules panel mentions 48 (of 52) for 6P');
  ok(/dealer.*pile|leftover/i.test(text320), 'rules panel mentions the leftover cards sit in the dealer\'s pile');
  ok(!EMDASH.test(text320), 'rules panel text has NO em/en dashes (hard rule)');

  await page.click('#btnRulesClose');
  await page.close();
}

async function partB_offlineSeatList(browser) {
  console.log('\n=== Part B: Offline seat list rename affordance (item 2) ===');
  const page = await newPage(browser, { width: 320, height: 700 });
  await page.goto(URL);
  await page.waitForFunction(() => typeof CFG === 'object');

  // fresh device - hint should show
  const hint0 = await page.evaluate(() => document.getElementById('nameHint').textContent);
  ok(hint0.toLowerCase().includes('tap a name'), `fresh device shows the rename hint ("${hint0}")`);
  ok(!EMDASH.test(hint0), 'rename hint has no em/en dash');

  const rowShape = await page.evaluate(() => {
    const row = document.querySelector('#seatList .seatRow');
    return {
      hasWrap: !!row.querySelector('.nameWrap'),
      hasPencil: row.querySelector('.nameWrap .editPencil') ? row.querySelector('.nameWrap .editPencil').textContent : null,
      inputInsideWrap: !!row.querySelector('.nameWrap input'),
    };
  });
  ok(rowShape.hasWrap, '4P seat row: name input wrapped in .nameWrap');
  ok(rowShape.inputInsideWrap, '4P seat row: input lives inside the wrap');
  ok(rowShape.hasPencil === '✏️', `4P seat row: pencil glyph present (got "${rowShape.hasPencil}")`);
  await page.screenshot({ path: '/tmp/v024_seatlist_4p.png' });

  // 6P
  await page.click('#p6');
  const count6 = await page.evaluate(() => document.querySelectorAll('#seatList .seatRow').length);
  ok(count6 === 6, `6P shows exactly 6 seat rows (got ${count6})`);
  const allHavePencil6 = await page.evaluate(() =>
    [...document.querySelectorAll('#seatList .seatRow .editPencil')].every((s) => s.textContent === '✏️')
  );
  ok(allHavePencil6, 'all 6 seat rows have the pencil affordance (no clutter regression)');
  await page.screenshot({ path: '/tmp/v024_seatlist_6p.png' });
  await page.click('#p4'); // back to 4P for the rest

  // functional rename: type a normal name, assert it saves and the hint retires
  const firstName0 = await page.evaluate(() => CFG.seatMeta[4][0].name);
  const input0 = page.locator('#seatList .seatRow input').first();
  await input0.click();
  await input0.fill('Ace');
  await page.waitForTimeout(50);
  const afterRename = await page.evaluate(() => ({
    val: document.querySelector('#seatList .seatRow input').value,
    cfgName: CFG.seatMeta[4][0].name,
    hint: document.getElementById('nameHint').textContent,
    persisted: JSON.parse(localStorage.getItem('nasty-setup')).seatMeta['4'][0].name,
  }));
  ok(afterRename.val === 'Ace', `rename UI reflects typed value ("${afterRename.val}")`);
  ok(afterRename.cfgName === 'Ace' && afterRename.cfgName !== firstName0, `CFG.seatMeta updated to the new name (was "${firstName0}", now "${afterRename.cfgName}")`);
  ok(afterRename.persisted === 'Ace', 'new name persisted to localStorage (survives reload)');
  ok(afterRename.hint === '', 'rename hint retires after the first real edit');

  // 10-char limit
  const input0b = page.locator('#seatList .seatRow input').first();
  await input0b.fill('SupercalifragilisticExpi');
  await page.waitForTimeout(50);
  const capped = await page.evaluate(() => document.querySelector('#seatList .seatRow input').value);
  ok(capped.length <= 10, `10-char limit enforced (got "${capped}", length ${capped.length})`);

  // profanity block on a different seat, reverts to the previous good value
  const seat1Before = await page.evaluate(() => CFG.seatMeta[4][1].name);
  const input1 = page.locator('#seatList .seatRow input').nth(1);
  await input1.fill('fuck');
  await page.waitForTimeout(50);
  const afterBad = await page.evaluate(() => ({
    val: document.querySelectorAll('#seatList .seatRow input')[1].value,
    warn: document.getElementById('nameWarn').textContent,
    cfgName: CFG.seatMeta[4][1].name,
  }));
  ok(afterBad.val === seat1Before, `profanity is rejected, input reverts to the previous good value ("${seat1Before}")`);
  ok(afterBad.warn.length > 0, `friendly warning shown ("${afterBad.warn}")`);
  ok(!EMDASH.test(afterBad.warn), 'profanity warning has no em/en dash');
  ok(afterBad.cfgName === seat1Before, 'CFG never saved the rejected name');

  await page.close();
}

// ---- Part C: online lobby, needs a private server ----
const PORT = 18960 + Math.floor(Math.random() * 500);
const ROOMS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nasty-ui-test-rooms-'));
function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: '/Users/jarvis/nasty-game/server',
    env: Object.assign({}, process.env, {
      NASTY_PORT: String(PORT), NASTY_ROOMS_DIR: ROOMS_DIR,
      NASTY_ADMIN_TOKEN_FILE: path.join(ROOMS_DIR, 'admin-token.txt'),
      NASTY_LEADERBOARD_FILE: path.join(ROOMS_DIR, 'leaderboard.json'),
      NASTY_LEADERBOARD_EPOCH_FILE: path.join(ROOMS_DIR, 'leaderboard-epoch.json'),
      NASTY_SOLO_IDS_FILE: path.join(ROOMS_DIR, 'solo-ids.json'),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => { const s = String(d); if (!s.includes('Listening')) process.stderr.write('[server-err] ' + s); });
  return child;
}
async function hostRoom(page, seatMeta, n) {
  return page.evaluate(({ seatMeta, n }) => {
    CFG.n = n; CFG.teams = false;
    CFG.seatMeta[n] = seatMeta;
    return new Promise((resolve) => {
      const origHandler = window.handleNetMessage;
      window.handleNetMessage = function (m) {
        origHandler(m);
        if (m.type === 'created') { window.handleNetMessage = origHandler; resolve(m.code); }
      };
      window.hostCreateRoom();
    });
  }, { seatMeta, n });
}

async function partC_onlineLobby(browser) {
  console.log('\n=== Part C: Online lobby rename affordance (item 2) ===');
  const WS_URL = `ws://localhost:${PORT}`;
  const page = await newPage(browser, { width: 320, height: 700 });
  await page.goto(`${URL}?ws=${encodeURIComponent(WS_URL)}`);
  await page.waitForFunction(() => typeof window.NET === 'object');
  const seatMeta = [
    { name: 'Ginny', type: 'human', diff: 'medium' },
    { name: 'Geri', type: 'cpu', diff: 'medium' },
    { name: 'J.B.', type: 'cpu', diff: 'medium' },
    { name: 'Jim', type: 'cpu', diff: 'medium' },
  ];
  await hostRoom(page, seatMeta, 4);
  await page.waitForSelector('#roomOverlay:not(.hidden)');
  await page.waitForTimeout(150);
  await page.screenshot({ path: '/tmp/v024_online_lobby_320.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/v024_online_lobby_phone.png' });
  await page.setViewportSize({ width: 320, height: 700 });

  const renameBtnText = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#roomSeatList .lobbySeat')];
    const mine = rows.find((r) => r.classList.contains('mine'));
    const btn = mine ? [...mine.querySelectorAll('button')].find((b) => b.textContent.includes('Rename')) : null;
    return btn ? btn.textContent : null;
  });
  ok(renameBtnText === '✏️ Rename', `host's own seat has the pencil-prefixed Rename button (got "${renameBtnText}")`);

  // click Rename, type a new name, Save - verify it round-trips through the server
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#roomSeatList .lobbySeat')];
    const mine = rows.find((r) => r.classList.contains('mine'));
    [...mine.querySelectorAll('button')].find((b) => b.textContent.includes('Rename')).click();
  });
  await page.waitForSelector('#roomSeatList .lobbySeat.mine input');
  await page.fill('#roomSeatList .lobbySeat.mine input', 'Ginnycakes');
  await page.evaluate(() => {
    const mine = document.querySelector('#roomSeatList .lobbySeat.mine');
    [...mine.querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
  });
  await page.waitForFunction(() => {
    const s = (window.NET.lobby.seats || []).find((s) => s.claimedBy === window.NET.playerId);
    return s && s.name === 'Ginnycakes';
  }, { timeout: 5000 });
  ok(true, 'online rename round-tripped through the server (host seat name updated to "Ginnycakes")');

  // profanity block on the online rename path too
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#roomSeatList .lobbySeat')];
    const mine = rows.find((r) => r.classList.contains('mine'));
    [...mine.querySelectorAll('button')].find((b) => b.textContent.includes('Rename')).click();
  });
  await page.waitForSelector('#roomSeatList .lobbySeat.mine input');
  await page.fill('#roomSeatList .lobbySeat.mine input', 'asshole');
  await page.evaluate(() => {
    const mine = document.querySelector('#roomSeatList .lobbySeat.mine');
    [...mine.querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
  });
  await page.waitForTimeout(300);
  const stillGood = await page.evaluate(() => {
    const s = (window.NET.lobby.seats || []).find((s) => s.claimedBy === window.NET.playerId);
    return s ? s.name : null;
  });
  ok(stillGood === 'Ginnycakes', `online profanity rename rejected, name unchanged (got "${stillGood}")`);

  await page.close();
}

async function main() {
  const browser = await chromium.launch();
  await partA_rulesPanel(browser);
  await partB_offlineSeatList(browser);

  const server = startServer();
  await new Promise((r) => setTimeout(r, 700));
  try {
    await partC_onlineLobby(browser);
  } finally {
    server.kill();
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
