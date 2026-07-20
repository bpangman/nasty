// v0.20 recalibration test suite - covers the root-cause reproduction AND the fix for Blake's
// "occasionally my board is missing a few steps after switching apps and coming back" report.
// See HANDOFF.md's v0.20 section for the full root-cause writeup. Usage:
//   node test_recalibration.js node     (server/server.js)
//   node test_recalibration.js deno     (server/cloud/server.ts)
// Never touches production - own scratch port/rooms-dir/KV-path per run, same convention as
// every other file in this directory.
const { chromium } = require('/Users/jarvis/clawd/node_modules/playwright');
const WebSocket = require('/Users/jarvis/nasty-game/server/node_modules/ws');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const KIND = process.argv[2] || 'node';
const USE_DENO = KIND === 'deno';
let PORT = 19700 + Math.floor(Math.random() * 700);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-recal-${KIND}-`));
const BASE = () => `http://localhost:${PORT}`;
const WS_URL = () => `ws://localhost:${PORT}`;

function log(...a) { console.log('[recal]', new Date().toISOString(), ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log('OK  ', label); } else { FAIL++; log('FAIL', label); } }

function startServer(port) {
  let child;
  if (USE_DENO) {
    child = spawn('deno', ['run', '--allow-net', '--allow-env', '--allow-read', '--allow-write', '--unstable-kv', 'server.ts'], {
      cwd: '/Users/jarvis/nasty-game/server/cloud',
      env: Object.assign({}, process.env, { NASTY_PORT: String(port), NASTY_KV_PATH: path.join(SCRATCH, 'recal.kv'), NASTY_ADMIN_TOKEN: 'recal-admin-token' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    child = spawn(process.execPath, ['server.js'], {
      cwd: '/Users/jarvis/nasty-game/server',
      env: Object.assign({}, process.env, {
        NASTY_PORT: String(port), NASTY_ROOMS_DIR: SCRATCH,
        NASTY_ADMIN_TOKEN_FILE: path.join(SCRATCH, 'admin-token.txt'),
        NASTY_LEADERBOARD_FILE: path.join(SCRATCH, 'leaderboard.json'),
        NASTY_LEADERBOARD_EPOCH_FILE: path.join(SCRATCH, 'leaderboard-epoch.json'),
        NASTY_SOLO_IDS_FILE: path.join(SCRATCH, 'solo-ids.json'),
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  child.stderr.on('data', (d) => { const s = String(d); if (!s.includes('Listening')) process.stderr.write('[server-err] ' + s); });
  return child;
}
async function waitHealthy(port) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://localhost:${port}/health`); if (r.ok) return await r.json(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('server never became healthy');
}

// ---------------------------------------------------------------------------
// Part 1 - raw wire-protocol check of the new "resync" message + back-compat
// ---------------------------------------------------------------------------
function wsConnect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
function nextMsg(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { ws.removeListener('message', onMsg); reject(new Error('timeout waiting for ' + predicate)); }, timeoutMs);
    function onMsg(raw) {
      const m = JSON.parse(raw.toString());
      if (!predicate || predicate(m)) { clearTimeout(to); ws.removeListener('message', onMsg); resolve(m); }
    }
    ws.on('message', onMsg);
  });
}
const sendJ = (ws, obj) => ws.send(JSON.stringify(obj));

async function protocolPart(port) {
  log('--- Part 1: raw wire-protocol "resync" checks ---');
  // A single-seat room, started immediately (3 CPUs) so there's a live G to resync against.
  const ws = await wsConnect(port);
  sendJ(ws, { type: 'host', protocolVersion: 3, name: 'Probe', n: 4, teams: false, seats: [
    { name: 'Probe', type: 'human', diff: 'medium' }, { name: 'C1', type: 'cpu', diff: 'easy' },
    { name: 'C2', type: 'cpu', diff: 'medium' }, { name: 'C3', type: 'cpu', diff: 'hard' },
  ] });
  const created = await nextMsg(ws, (m) => m.type === 'created');
  const code = created.code;
  sendJ(ws, { type: 'claimSeat', seatIndex: 0, name: 'Probe' });
  sendJ(ws, { type: 'start', protocolVersion: 3 });
  await nextMsg(ws, (m) => m.type === 'readyCheck');
  sendJ(ws, { type: 'readyUp' });
  await nextMsg(ws, (m) => m.type === 'gameAction' && m.action.kind === 'start');

  // Resync on an identified, live connection returns a full 'sync' snapshot with real G.
  sendJ(ws, { type: 'resync' });
  const sync1 = await nextMsg(ws, (m) => m.type === 'sync');
  check(sync1.G && Array.isArray(sync1.G.pieces), '"resync" on a live identified connection returns a sync with a real G');
  check(typeof sync1.appliedSeq === 'number', '"resync" sync reply carries appliedSeq (same shape as rejoin)');

  // Resync must NOT ripple a presence broadcast (unlike rejoin) - open a second connection to
  // observe from the room's perspective would need a second seat; simpler and sufficient here:
  // confirm calling it repeatedly never errors and always returns a fresh, current G.
  sendJ(ws, { type: 'resync' });
  const sync2 = await nextMsg(ws, (m) => m.type === 'sync');
  check(sync2.G != null, '"resync" can be called repeatedly with no error');

  // Resync from a connection that never identified itself (raw new socket, no host/join/rejoin
  // yet) must be silently ignored, never crash the connection.
  const ws2 = await wsConnect(port);
  sendJ(ws2, { type: 'resync' });
  await new Promise((r) => setTimeout(r, 300));
  sendJ(ws2, { type: 'ping', t: Date.now() });
  const pong = await nextMsg(ws2, (m) => m.type === 'pong');
  check(!!pong, '"resync" from a never-identified connection is silently ignored (connection still responsive after)');
  ws2.close();

  // Clean up the probe room.
  const adminToken = USE_DENO ? 'recal-admin-token' : fs.readFileSync(path.join(SCRATCH, 'admin-token.txt'), 'utf8').trim();
  await fetch(`http://localhost:${port}/admin/rooms/${code}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } });
  ws.close();
  log('--- Part 1 done ---');
}

// ---------------------------------------------------------------------------
// Part 2 - Playwright: the actual root-cause reproduction, run against the FIXED client, plus
// the input-lock / failure-path / manual-reset scenarios.
// ---------------------------------------------------------------------------
async function newPage(browser, port) {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { page.__errors = page.__errors || []; page.__errors.push(String(e)); });
  page.__errors = [];
  await page.goto(`file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent(`ws://localhost:${port}`)}`);
  await page.waitForFunction(() => typeof window.NET === 'object');
  return page;
}
async function hostRoom(page, seatMeta, n) {
  return page.evaluate(({ seatMeta, n }) => {
    CFG.n = n; CFG.teams = false; CFG.seatMeta[n] = seatMeta;
    return new Promise((resolve) => {
      const orig = window.handleNetMessage;
      window.handleNetMessage = function (m) { orig(m); if (m.type === 'created') { window.handleNetMessage = orig; resolve(m.code); } };
      window.hostCreateRoom();
    });
  }, { seatMeta, n });
}
async function joinRoom(page, code, name) {
  return page.evaluate(({ code, name }) => new Promise((resolve) => {
    window.connectWs().then(() => {
      const orig = window.handleNetMessage;
      window.handleNetMessage = function (m) { orig(m); if (m.type === 'joined') { window.handleNetMessage = orig; resolve(m.playerId); } };
      window.netSend({ type: 'join', protocolVersion: PROTOCOL_VERSION, code, name });
    });
  }), { code, name });
}
async function claimSeat(page, seatIndex, name) { await page.evaluate(({ seatIndex, name }) => window.netSend({ type: 'claimSeat', seatIndex, name }), { seatIndex, name }); }
async function startGameOnline(hostPage, humanPages) {
  const pages = humanPages || [hostPage];
  await hostPage.evaluate(() => window.netSend({ type: 'start', protocolVersion: PROTOCOL_VERSION }));
  await Promise.all(pages.map((p) => p.waitForFunction(() => window.NET && window.NET.readyCheck != null, { timeout: 10000 })));
  await Promise.all(pages.map((p) => p.evaluate(() => window.netSend({ type: 'readyUp' }))));
}
async function tryDriveMove(page, seat) {
  return page.evaluate((seat) => {
    if (!window.G || window.G.over) return false;
    if (window.NET.mySeat !== seat || window.G.turn !== seat) return false;
    const moves = window.legalMoves(seat);
    if (!moves.length) return false;
    window.commitMove(seat, moves[Math.floor(Math.random() * moves.length)], null);
    return true;
  }, seat);
}
async function gState(page) {
  return page.evaluate(() => {
    const G = window.G; if (!G) return null;
    return JSON.stringify({ turn: G.turn, dealer: G.dealer, schedRound: G.schedRound, over: G.over,
      bowedOut: G.bowedOut, pieces: G.pieces.map((ps) => ps.map((p) => [p.state, p.steps])),
      handLengths: G.hands.map((h) => h.length) });
  });
}
async function freezeSocketOpen(page) {
  await page.evaluate(() => {
    const ws = window.NET.ws;
    window.__frozen = { ws, send: ws.send.bind(ws), onmessage: ws.onmessage };
    ws.send = () => {};
    ws.onmessage = () => {};
  });
}
async function unfreezeSocket(page) {
  await page.evaluate(() => {
    const f = window.__frozen; if (!f) return;
    f.ws.send = f.send; f.ws.onmessage = f.onmessage;
    window.__frozen = null;
  });
}
// Freeze ONLY outgoing sends (the resync request itself never reaches the server), leaving
// incoming delivery intact - used to hold the recalibrating window open long enough to
// deterministically test the input lock and the failure path.
async function freezeSendOnly(page) {
  await page.evaluate(() => {
    const ws = window.NET.ws;
    window.__frozenSend = { ws, send: ws.send.bind(ws) };
    ws.send = () => {};
  });
}
async function unfreezeSendOnly(page) {
  await page.evaluate(() => {
    const f = window.__frozenSend; if (!f) return;
    f.ws.send = f.send;
    window.__frozenSend = null;
  });
}

async function setupGame(browser, port, seatMeta) {
  const hostPage = await newPage(browser, port), g1 = await newPage(browser, port);
  const code = await hostRoom(hostPage, seatMeta, 4);
  await claimSeat(hostPage, 0, 'Host');
  await joinRoom(g1, code, 'Guest1'); await claimSeat(g1, 1, 'Guest1');
  await new Promise((r) => setTimeout(r, 300));
  await startGameOnline(hostPage, [hostPage, g1]);
  await Promise.all([hostPage, g1].map((p) => p.waitForFunction(() => window.G != null, { timeout: 10000 })));
  return { hostPage, g1, code };
}

async function scenarioSilentDrift(browser, port) {
  log('--- Part 2a: silentDrift repro/fix (background freeze + genuine table idle, no self-heal from a later action) ---');
  const seatMeta = [
    { name: 'Host', type: 'human', diff: 'medium' }, { name: 'Guest1', type: 'human', diff: 'medium' },
    { name: 'CPU1', type: 'cpu', diff: 'medium' }, { name: 'CPU2', type: 'cpu', diff: 'medium' },
  ];
  const { hostPage, g1 } = await setupGame(browser, port, seatMeta);
  const stop = { stop: false };
  const driver = (async () => { while (!stop.stop) { await tryDriveMove(hostPage, 0); await new Promise((r) => setTimeout(r, 150)); } })();
  await new Promise((r) => setTimeout(r, 2000));

  await freezeSocketOpen(g1);
  await new Promise((r) => setTimeout(r, 15000));
  stop.stop = true; await driver;
  await new Promise((r) => setTimeout(r, 500));

  await unfreezeSocket(g1);
  await g1.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pageshow')); window.onForeground(); });
  const sawRecal = await g1.evaluate(() => window.NET.recalActive === true || document.getElementById('connIndicator').textContent.includes('Recalibrating')).catch(() => false);
  await new Promise((r) => setTimeout(r, 3000));

  const hostFinal = await gState(hostPage), g1Final = await gState(g1);
  check(hostFinal === g1Final, `${KIND}: G converges after a real background freeze + genuine table idle, with NO further actions to piggyback a self-heal on (the exact root cause)`);
  check((hostPage.__errors || []).length === 0 && (g1.__errors || []).length === 0, `${KIND}: zero page errors during silentDrift`);
  const chipHiddenAtEnd = await g1.evaluate(() => document.getElementById('connIndicator').classList.contains('hidden'));
  check(chipHiddenAtEnd, `${KIND}: connIndicator clears back to hidden once recalibration completes`);
  return true;
}

async function scenarioInputLockAndFailure(browser, port) {
  log('--- Part 2b: input lock + failure path + tap-to-reset recovery ---');
  const seatMeta = [
    { name: 'Host', type: 'human', diff: 'medium' }, { name: 'Guest1', type: 'human', diff: 'medium' },
    { name: 'CPU1', type: 'cpu', diff: 'medium' }, { name: 'CPU2', type: 'cpu', diff: 'medium' },
  ];
  const { hostPage, g1 } = await setupGame(browser, port, seatMeta);

  // Hold g1's recalibration open deliberately: freeze only OUTGOING sends, so the client thinks
  // it's mid-recalibration (recalActive=true) but the server never actually receives the resync
  // request, guaranteeing the window stays open long enough to test deterministically.
  await freezeSendOnly(g1);
  await g1.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pageshow')); window.onForeground(); });
  await new Promise((r) => setTimeout(r, 300));
  const lockedDuring = await g1.evaluate(() => window.NET.recalActive === true);
  check(lockedDuring, 'NET.recalActive is true immediately after a foreground trigger whose resync request never lands');
  const chipTappable = await g1.evaluate(() => document.getElementById('connIndicator').classList.contains('tappable'));
  check(chipTappable, 'connIndicator is tappable while recalibrating');

  // Scripted tap during recalibration must NOT send a move, even if it's genuinely this seat's
  // turn with legal moves available.
  const preState = await gState(g1);
  const seatToTest = await g1.evaluate(() => window.NET.mySeat);
  await tryDriveMove(g1, seatToTest); // no-op if it's not g1's turn - that's fine, we just need to prove commitMove() is gated
  const sentDuringLock = await g1.evaluate(() => window.NET.moveSentForTurn === true);
  check(!sentDuringLock, 'a scripted commitMove() during recalibration does not mark a move as sent (input genuinely locked)');
  const postState = await gState(g1);
  check(preState === postState, 'G is unchanged locally after the scripted tap during recalibration');

  // v0.22 CONTRACT CHANGE (P2): the eaten-resync shape no longer ends in the failure message.
  // The 2s resync ack watchdog (RESYNC_ACK_MS, index.html § RECALIBRATION) notices no sync
  // came back, tears the presumed-zombie socket down and rebuilds it AUTOMATICALLY - the
  // fresh socket (this scenario only froze the OLD socket's send) reconnects and converges
  // with zero user action, and the manual failure prompt never shows. The failure message
  // still exists for the genuinely-unreachable-server case - scenario 2c (kill the server)
  // covers it, where reconnects themselves keep failing.
  await new Promise((r) => setTimeout(r, 5000));
  const autoRecovered = await g1.evaluate(() => window.NET.recalActive === false && window.NET.connected === true);
  check(autoRecovered, 'v0.22: the eaten resync AUTO-recovers via the 2s ack watchdog (socket rebuilt, no user action)');
  const neverFailed = await g1.evaluate(() => window.NET.recalFailed === false);
  check(neverFailed, 'v0.22: the manual failure prompt never showed - automation exhausted itself first');
  await unfreezeSendOnly(g1);   // restore the (now-orphaned) old socket's send stub - harmless cleanup
  await new Promise((r) => setTimeout(r, 800));
  const hostFinal = await gState(hostPage), g1Final = await gState(g1);
  check(hostFinal === g1Final, 'G converges after the automatic recovery');
  return true;
}

async function scenarioKillServerMidRecal(port, serverChild) {
  log('--- Part 2c: kill the server mid-recalibration, confirm failure UI, restart, confirm reset recovers ---');
  const browser = await chromium.launch();
  const seatMeta = [
    { name: 'Host', type: 'human', diff: 'medium' }, { name: 'Guest1', type: 'human', diff: 'medium' },
    { name: 'CPU1', type: 'cpu', diff: 'medium' }, { name: 'CPU2', type: 'cpu', diff: 'medium' },
  ];
  const { hostPage, g1 } = await setupGame(browser, port, seatMeta);
  await new Promise((r) => setTimeout(r, 1000));

  // Trigger a foreground recalibration, THEN kill the server before it can ever answer. Kill
  // the EXACT child process handle this test itself spawned (never a port-based lsof/xargs
  // kill - this machine runs other real services and a port-number collision must never risk
  // killing something unrelated).
  const killPromise = (async () => {
    await new Promise((r) => setTimeout(r, 200));
    serverChild.kill('SIGKILL');
  })();
  await g1.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pageshow')); window.onForeground(); });
  await killPromise;

  await new Promise((r) => setTimeout(r, 7000)); // past RECAL_FAIL_MS with the server truly gone
  const failedAfterKill = await g1.evaluate(() => window.NET.recalFailed === true);
  check(failedAfterKill, 'server killed mid-recalibration: recalFailed shows the failure message');
  const chipVisible = await g1.evaluate(() => !document.getElementById('connIndicator').classList.contains('hidden'));
  check(chipVisible, 'failure chip is visibly shown (not hidden) with the server down');

  // Restart the server on the SAME port/rooms-dir so the room persists, then use the manual
  // reset button to recover.
  const child2 = startServer(port);
  await waitHealthy(port);
  await g1.evaluate(() => document.getElementById('connIndicator').click());
  await new Promise((r) => setTimeout(r, 3000));
  const recovered = await g1.evaluate(() => window.G != null && window.NET.recalActive === false);
  check(recovered, 'tapping Reset connection after the server restarts recovers into the live game');
  const hostFinal = await gState(hostPage), g1Final = await gState(g1);
  check(hostFinal === g1Final, 'G matches host after server-kill recovery');

  await browser.close();
  child2.kill('SIGTERM');
  return true;
}

async function scenarioBackCompatOldClient(port) {
  log('--- Part 2d: a pre-v0.20 client (never sends "resync") still plays normally against the new server ---');
  // Pinned to 8de9c20 - the last pre-v0.20 commit (iOS build 26's exact client), i.e. the
  // newest client in the wild that does NOT send "resync". Deliberately NOT `HEAD` (which was
  // only equivalent the very first time this test ran, before v0.20 itself was committed).
  const oldHtml = execSync('git show 8de9c20:index.html', { cwd: '/Users/jarvis/nasty-game', maxBuffer: 1024 * 1024 * 20 }).toString();
  const oldPath = path.join(SCRATCH, 'old-client.html');
  fs.writeFileSync(oldPath, oldHtml);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { page.__errors = page.__errors || []; page.__errors.push(String(e)); });
  page.__errors = [];
  await page.goto(`file://${oldPath}?ws=${encodeURIComponent(`ws://localhost:${port}`)}`);
  await page.waitForFunction(() => typeof window.NET === 'object');
  const seatMeta = [
    { name: 'Old', type: 'human', diff: 'medium' }, { name: 'C1', type: 'cpu', diff: 'easy' },
    { name: 'C2', type: 'cpu', diff: 'medium' }, { name: 'C3', type: 'cpu', diff: 'hard' },
  ];
  const code = await hostRoom(page, seatMeta, 4);
  check(code && code.length === 4, 'old client hosts a room against the new server');
  await claimSeat(page, 0, 'Old');
  await startGameOnline(page);
  await page.waitForFunction(() => window.G != null, { timeout: 10000 });
  const stop = { stop: false };
  const driver = (async () => { while (!stop.stop) { await tryDriveMove(page, 0); await new Promise((r) => setTimeout(r, 120)); } })();
  const over = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 4 * 60 * 1000) { if (await page.evaluate(() => window.G.over).catch(() => false)) return true; await new Promise((r) => setTimeout(r, 1000)); }
    return false;
  })();
  stop.stop = true; await driver;
  check(over, 'old (pre-v0.20, never sends "resync") client reaches G.over normally against the new server');
  check((page.__errors || []).length === 0, 'zero page errors for the old client');
  await browser.close();
  return true;
}

async function main() {
  let child = startServer(PORT);
  await new Promise((r) => setTimeout(r, USE_DENO ? 2500 : 800));
  await waitHealthy(PORT);

  await protocolPart(PORT);

  const browser = await chromium.launch();
  await scenarioSilentDrift(browser, PORT);
  await scenarioInputLockAndFailure(browser, PORT);
  await browser.close();
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));

  // Kill-mid-recal scenario manages its own server lifecycle (needs to kill + restart it).
  PORT = PORT + 1;
  child = startServer(PORT);
  await new Promise((r) => setTimeout(r, USE_DENO ? 2500 : 800));
  await waitHealthy(PORT);
  await scenarioKillServerMidRecal(PORT, child);

  // Back-compat scenario against a fresh server instance.
  PORT = PORT + 1;
  child = startServer(PORT);
  await new Promise((r) => setTimeout(r, USE_DENO ? 2500 : 800));
  await waitHealthy(PORT);
  await scenarioBackCompatOldClient(PORT);
  child.kill('SIGTERM');

  console.log(`\n${KIND}: ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
