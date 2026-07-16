// v0.15 leaderboard exactly-once verification (item 4 of the follow-up brief).
// Scenarios:
//   a) solo (offline vs-CPU) game finishes with the test server REACHABLE - the merged
//      leaderboard shows the game exactly once (no local+global double count).
//   b) solo game finishes with the server UNREACHABLE - shows once from the local queue;
//      then, after connectivity returns and the queue drains, STILL exactly once.
//   c) full ONLINE game to G.over on the new server - GET /leaderboard shows the human
//      winner's deltas exactly once, and a client reconnect after the win does not double them.
// All against a private Node server instance (never prod).
const { chromium } = require('/Users/jarvis/clawd/node_modules/playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 16800 + Math.floor(Math.random() * 300);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'nasty-lbtest-'));
const WS_URL = `ws://localhost:${PORT}`;
const BASE = `http://localhost:${PORT}`;

let PASS = 0, FAIL = 0;
function log(...a) { console.log('[lb]', ...a); }
function check(cond, label) { if (cond) { PASS++; log('OK ', label); } else { FAIL++; log('FAIL', label); } }

function startServer() {
  fs.writeFileSync(path.join(SCRATCH, 'admin-token.txt'), 'tok\n');
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
  child.stdout.on('data', (d) => { const s = String(d); if (/error|Error|finished/.test(s)) process.stdout.write('[srv] ' + s); });
  child.stderr.on('data', (d) => process.stderr.write('[srv-err] ' + d));
  child.on('exit', (code, sig) => log('SERVER EXITED', code, sig));
  return child;
}
async function waitHealthy() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) return; } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('server never healthy');
}

// Drive a REAL offline solo game (1 human + 3 easy CPUs) to completion through commitMove()
// (the same function a real tap ends in calling). reducedMotion:'reduce' floors SPEED at 6
// (the app's own accessibility behavior), so a full game runs at soak-test speed.
async function playSoloGame(page, playerName) {
  await page.evaluate((name) => {
    CFG.n = 4; CFG.teams = false;
    CFG.seatMeta[4] = [
      { name, type: 'human', diff: 'medium' },
      { name: 'C1', type: 'cpu', diff: 'easy' },
      { name: 'C2', type: 'cpu', diff: 'easy' },
      { name: 'C3', type: 'cpu', diff: 'easy' },
    ];
    window.startGame();
  }, playerName);
  await page.waitForFunction(() => window.G != null, { timeout: 5000 });
  const t0 = Date.now();
  while (Date.now() - t0 < 8 * 60 * 1000) {
    const over = await page.evaluate(() => window.G && window.G.over);
    if (over) return true;
    await page.evaluate(() => {
      if (!window.G || window.G.over) return;
      if (window.G.turn !== 0 || window.G.seats[0].type !== 'human') return;
      const moves = window.legalMoves(0);
      if (!moves.length) return;
      window.commitMove(0, moves[Math.floor(Math.random() * moves.length)], null);
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
// Count how a name renders in the leaderboard overlay's own merge logic (the REAL code path a
// user sees), by calling the same functions btnLb's click handler uses.
async function mergedStatsFor(page, name) {
  return page.evaluate(async (name) => {
    const local = window.loadStats();
    const g = await window.fetchGlobalLeaderboard();
    const merged = g ? window.mergeQueuedIntoGlobal(g, window.loadSoloQueue()) : local;
    return { merged: merged[name] || null, local: local[name] || null, global: (g && g[name]) || null, queueLen: window.loadSoloQueue().length };
  }, name);
}

async function main() {
  const child = startServer();
  await waitHealthy();
  const browser = await chromium.launch();

  // ================= scenario (a): server reachable =================
  {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => log('pageerror(a):', String(e)));
    await page.goto(`file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent(WS_URL)}`);
    await page.waitForFunction(() => typeof window.NET === 'object');
    const t0 = Date.now();
    const finished = await playSoloGame(page, 'SoloA');
    log(`scenario a: game finished=${finished} in ${Math.round((Date.now() - t0) / 1000)}s`);
    check(finished, 'a: real solo game reached G.over');
    await new Promise((r) => setTimeout(r, 1500)); // let the submit land
    const won = await page.evaluate(() => window.G.winners.includes(0));
    const s = await mergedStatsFor(page, 'SoloA');
    log('a: merged=', JSON.stringify(s.merged), 'local=', JSON.stringify(s.local), 'global=', JSON.stringify(s.global), 'queue=', s.queueLen);
    check(s.global && s.global.hg4s === 1, 'a: global board recorded the game exactly once');
    check(s.merged && s.merged.hg4s === 1, 'a: MERGED display shows the game exactly once (no local double count)');
    if (won) check(s.merged.hw4s === 1, 'a: merged shows the win exactly once');
    check(s.queueLen === 0, 'a: nothing left in the offline retry queue');
    await ctx.close();
  }

  // ================= scenario (b): server unreachable at finish, then drains =================
  {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => log('pageerror(b):', String(e)));
    // Point at a DEAD port so the submit fails and queues.
    await page.goto(`file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent('ws://localhost:1')}`);
    await page.waitForFunction(() => typeof window.NET === 'object');
    const finished = await playSoloGame(page, 'SoloB');
    check(finished, 'b: real solo game reached G.over (server unreachable)');
    await new Promise((r) => setTimeout(r, 2000)); // let the submit fail + queue
    const s1 = await page.evaluate(() => ({
      local: window.loadStats().SoloB || null,
      queue: window.loadSoloQueue().length,
    }));
    log('b(offline): local=', JSON.stringify(s1.local), 'queue=', s1.queue);
    check(s1.local && s1.local.hg4s === 1 && s1.queue === 1, 'b: result queued locally, shown once from local');
    // Connectivity "returns": reload the page pointed at the LIVE server (resolveWsUrl()
    // prefers the ?ws= query param over any stored override, so a reload with the live URL is
    // the honest simulation of "reopened the app with the server back"). localStorage (the
    // queue) survives - same browser context. drainSoloQueue() runs automatically at boot.
    await page.goto(`file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent(WS_URL)}`);
    await page.waitForFunction(() => typeof window.NET === 'object');
    await new Promise((r) => setTimeout(r, 2500)); // boot-time drain lands
    const s2 = await mergedStatsFor(page, 'SoloB');
    log('b(drained): merged=', JSON.stringify(s2.merged), 'global=', JSON.stringify(s2.global), 'queue=', s2.queueLen);
    check(s2.queueLen === 0, 'b: queue drained');
    check(s2.global && s2.global.hg4s === 1, 'b: global board has it exactly once after drain');
    check(s2.merged && s2.merged.hg4s === 1, 'b: merged display STILL exactly once after drain (not doubled)');
    // belt-and-suspenders: drain AGAIN (a retry) - server-side gameId dedupe must hold
    await page.evaluate(() => window.drainSoloQueue());
    await new Promise((r) => setTimeout(r, 800));
    const s3 = await mergedStatsFor(page, 'SoloB');
    check(s3.merged && s3.merged.hg4s === 1, 'b: still exactly once after a redundant re-drain');
    await ctx.close();
  }

  // ================= scenario (c): online game, server-side recording, reconnect no-double =================
  {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => log('pageerror(c):', String(e)));
    await page.goto(`file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent(WS_URL)}`);
    await page.waitForFunction(() => typeof window.NET === 'object');
    const code = await page.evaluate(() => {
      CFG.n = 4; CFG.teams = false;
      CFG.seatMeta[4] = [
        { name: 'OnlineWin', type: 'human', diff: 'medium' },
        { name: 'C1', type: 'cpu', diff: 'easy' },
        { name: 'C2', type: 'cpu', diff: 'easy' },
        { name: 'C3', type: 'cpu', diff: 'easy' },
      ];
      return new Promise((resolve) => {
        const orig = window.handleNetMessage;
        window.handleNetMessage = function (m) { orig(m); if (m.type === 'created') { window.handleNetMessage = orig; resolve(m.code); } };
        window.hostCreateRoom();
      });
    });
    await page.evaluate(() => window.netSend({ type: 'start', protocolVersion: PROTOCOL_VERSION }));
    await page.waitForFunction(() => window.G != null, { timeout: 8000 });
    const t0 = Date.now();
    let over = false;
    while (Date.now() - t0 < 6 * 60 * 1000) {
      over = await page.evaluate(() => window.G && window.G.over).catch(() => false);
      if (over) break;
      await page.evaluate(() => {
        if (!window.G || window.G.over) return;
        if (window.NET.mySeat !== window.G.turn) return;
        const moves = window.legalMoves(window.G.turn);
        if (!moves.length) return;
        window.commitMove(window.G.turn, moves[Math.floor(Math.random() * moves.length)], null);
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 250));
    }
    check(over, 'c: online game reached G.over');
    await new Promise((r) => setTimeout(r, 1200));
    const lb1 = await (await fetch(BASE + '/leaderboard')).json();
    log('c: board after win:', JSON.stringify(lb1.OnlineWin));
    check(lb1.OnlineWin && lb1.OnlineWin.hg4s === 1, 'c: server recorded the online game exactly once');
    // reconnect AFTER the win - must not re-record
    await page.evaluate(() => window.netSend({ type: 'rejoin', code: window.NET.code, playerId: window.NET.playerId, token: window.NET.token, protocolVersion: PROTOCOL_VERSION }));
    await new Promise((r) => setTimeout(r, 1500));
    const lb2 = await (await fetch(BASE + '/leaderboard')).json();
    check(lb2.OnlineWin && lb2.OnlineWin.hg4s === 1 && lb2.OnlineWin.hpts === lb1.OnlineWin.hpts, 'c: reconnect after the win did NOT double the record');
    await ctx.close();
  }

  await browser.close();
  child.kill('SIGTERM');
  console.log(`\n${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
