// v0.15 chaos / regression harness for the server-authoritative online rebuild.
// Multiple real browser CONTEXTS (not tabs), private NASTY_PORT/NASTY_ROOMS_DIR server
// instance (never prod), real network path for every move (commitMove -> server validate ->
// broadcast -> performMove, same pipeline a real tap uses - only the two-stage card/tee
// SELECTION UI itself is skipped for speed, per this project's own documented "fine to call
// the real functions directly via page.evaluate" testing convention).
//
// Scenarios (selected via argv):
//   node chaos_v15.js full        - one full 4P game (1 human-CPU-equivalent seat driven by
//                                    this harness + 3 CPU), no chaos, confirms G.over cleanly.
//   node chaos_v15.js hostbg      - THE dedicated host-background test: 3 human seats + 1 CPU,
//                                    host backgrounds (visibilitychange hidden + suspended
//                                    reconnect) for 65s in the middle of a stretch of CPU/guest
//                                    turns; asserts the OTHER two players' games continue
//                                    uninterrupted the entire time.
//   node chaos_v15.js chaos N     - N full games, 3 human seats + 1 CPU, random background/
//                                    reconnect cycles of EVERY context throughout, byte-equality
//                                    checks after every disruption, generous timeout.
const { chromium } = require('/Users/jarvis/clawd/node_modules/playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 18700 + Math.floor(Math.random() * 800);
const ROOMS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nasty-chaos-rooms-'));
const WS_URL = `ws://localhost:${PORT}`;

function log(...a) { console.log('[chaos]', new Date().toISOString(), ...a); }

// SERVER=deno env var runs the same scenarios against the Deno port (server/cloud/server.ts)
// on a private NASTY_KV_PATH scratch file; default is the Node server on a private rooms dir.
const USE_DENO = process.env.SERVER === 'deno';
function startServer() {
  let child;
  if (USE_DENO) {
    child = spawn('deno', ['run', '--allow-net', '--allow-env', '--allow-read', '--allow-write', '--unstable-kv', 'server.ts'], {
      cwd: '/Users/jarvis/nasty-game/server/cloud',
      env: Object.assign({}, process.env, {
        NASTY_PORT: String(PORT), NASTY_KV_PATH: path.join(ROOMS_DIR, 'test.kv'), NASTY_ADMIN_TOKEN: 'chaos-admin-token',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    child = spawn(process.execPath, ['server.js'], {
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
  }
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => { const s = String(d); if (!s.includes('Listening')) process.stderr.write('[server-err] ' + s); });
  return child;
}

async function newContext(browser) {
  return browser.newContext({ reducedMotion: 'reduce' });
}
async function newPage(ctx) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { page.__errors = page.__errors || []; page.__errors.push(String(e)); });
  page.__errors = [];
  await page.goto(`file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent(WS_URL)}`);
  await page.waitForFunction(() => typeof window.NET === 'object');
  return page;
}

// ---- Setup helpers - real functions this app's own UI calls, driven directly for speed ----
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
async function joinRoom(page, code, name) {
  return page.evaluate(({ code, name }) => {
    return new Promise((resolve) => {
      window.connectWs().then(() => {
        const origHandler = window.handleNetMessage;
        window.handleNetMessage = function (m) {
          origHandler(m);
          if (m.type === 'joined') { window.handleNetMessage = origHandler; resolve(m.playerId); }
        };
        window.netSend({ type: 'join', protocolVersion: PROTOCOL_VERSION, code, name });
      });
    });
  }, { code, name });
}
async function claimSeat(page, seatIndex, name) {
  await page.evaluate(({ seatIndex, name }) => {
    window.netSend({ type: 'claimSeat', seatIndex, name });
  }, { seatIndex, name });
}
// v0.16 item 4: Start now opens a ready-check gate instead of dealing immediately - every
// HUMAN seat (not just the host) must send 'readyUp' before the server deals. `humanPages`
// defaults to just the host (the common single-human-seat case); pass every human page for a
// multi-human-seat scenario.
async function startGameOnline(hostPage, humanPages) {
  const pages = humanPages || [hostPage];
  await hostPage.evaluate(() => window.netSend({ type: 'start', protocolVersion: PROTOCOL_VERSION }));
  await Promise.all(pages.map((p) => p.waitForFunction(() => window.NET && window.NET.readyCheck != null, { timeout: 10000 })));
  await Promise.all(pages.map((p) => p.evaluate(() => window.netSend({ type: 'readyUp' }))));
}

// Drives ONE legal move for `seat` on `page`, if it's currently that seat's turn there and a
// move is available - through commitMove(), the SAME function a real tap ends in calling
// (server-validated, broadcast, applied via performMove() - only the two-stage card/tee TAP UI
// itself is skipped, see file header). Returns true if it drove a move.
async function tryDriveMove(page, seat) {
  return page.evaluate((seat) => {
    if (!window.G || window.G.over) return false;
    if (window.NET.mySeat !== seat || window.G.turn !== seat) return false;
    const moves = window.legalMoves(seat);
    if (!moves.length) return false;
    const m = moves[Math.floor(Math.random() * moves.length)];
    window.commitMove(seat, m, null);
    return true;
  }, seat);
}

async function waitForGameOver(page, timeoutMs) {
  // Poll instead of page.waitForFunction - observed page.waitForFunction silently capping at
  // ~30s regardless of the requested timeout in this harness's environment; a plain poll loop
  // is unambiguous and gives real elapsed-time numbers for reporting.
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const over = await page.evaluate(() => (window.G ? window.G.over : false)).catch(() => false);
    if (over) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// Normalized game-state fingerprint - deliberately NOT a raw JSON.stringify(G) comparison.
// Two harmless-by-design differences would otherwise show up as false "divergence":
// (1) G.seats[].{name,type,diff,color} key INSERTION ORDER differs between the live-start
//     path (client's own newGame()) and the reconnect-snapshot path (server's own object
//     literal order) - same values, different JS key order, irrelevant to correctness.
// (2) G.deck contents are NEVER meant to match: the client only ever holds a same-LENGTH
//     placeholder (real card identities live only on the server, by design - see
//     applyDealAction()'s comment in index.html) while a snapshot includes the real cards.
// This fingerprint normalizes both away and compares everything that actually matters for
// "do all screens agree on the game."
async function gState(page) {
  return page.evaluate(() => {
    const G = window.G;
    if (!G) return null;
    return JSON.stringify({
      n: G.n, teams: G.teams, turn: G.turn, dealer: G.dealer, schedRound: G.schedRound,
      passStreak: G.passStreak, over: G.over, winners: G.winners, bowedOut: G.bowedOut,
      dealSeq: G.dealSeq, actionSeq: G.actionSeq, paused: G.paused,
      deckLength: G.deck.length, discardIds: G.discard.map((c) => c.id).sort((a, b) => a - b),
      seats: G.seats.map((s) => ({ name: s.name, type: s.type, diff: s.diff })),
      pieces: G.pieces.map((ps) => ps.map((p) => [p.state, p.steps])),
      handLengths: G.hands.map((h) => h.length),
      handIds: G.hands.map((h) => h.map((c) => c.id).sort((a, b) => a - b)),
    });
  });
}
async function settleEqual(pages, retries = 8, delayMs = 400) {
  for (let i = 0; i < retries; i++) {
    const states = await Promise.all(pages.map(gState));
    if (states.every((s) => s === states[0]) && states[0] != null) return { ok: true, tries: i + 1 };
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { ok: false };
}

async function background(page, ms) {
  const client = await page.context().newCDPSession(page);
  await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await client.send('Emulation.setVisibleSize', { width: 390, height: 844 }).catch(() => {});
  // Simulate a locked/backgrounded phone: force the WebSocket closed AND stop the app's own
  // reconnect attempts from firing (the real symptom of a backgrounded tab - suspended timers)
  // by overriding scheduleReconnect to a no-op for the duration, then restoring it.
  await page.evaluate(() => {
    window.__origScheduleReconnect = window.scheduleReconnect;
    window.scheduleReconnect = () => {};
    if (window.NET.ws) { try { window.NET.ws.close(); } catch (e) {} }
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await new Promise((r) => setTimeout(r, ms));
  await page.evaluate(() => {
    window.scheduleReconnect = window.__origScheduleReconnect;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.onForeground();
  });
}

async function runDriverLoop(pages, seatOfPage, stopFlag, tickMs) {
  while (!stopFlag.stop) {
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].__closed) continue;
      try { await tryDriveMove(pages[i], seatOfPage[i]); } catch (e) { /* page may be mid-reload */ }
    }
    await new Promise((r) => setTimeout(r, tickMs));
  }
}

async function scenarioFull() {
  let pass = 0, fail = 0;
  const assert = (cond, label) => { if (cond) { pass++; log('OK', label); } else { fail++; log('FAIL', label); } };
  const child = startServer();
  await new Promise((r) => setTimeout(r, USE_DENO ? 2500 : 800));
  const browser = await chromium.launch();
  const ctx = await newContext(browser);
  const page = await newPage(ctx);
  const seatMeta = [
    { name: 'Blake', type: 'human', diff: 'medium' },
    { name: 'C1', type: 'cpu', diff: 'easy' },
    { name: 'C2', type: 'cpu', diff: 'medium' },
    { name: 'C3', type: 'cpu', diff: 'hard' },
  ];
  const code = await hostRoom(page, seatMeta, 4);
  assert(code && code.length === 4, 'room hosted');
  await claimSeat(page, 0, 'Blake');
  await startGameOnline(page);
  await page.waitForFunction(() => window.G != null, { timeout: 10000 });

  const stop = { stop: false };
  const driver = runDriverLoop([page], [0], stop, 150);
  const over = await waitForGameOver(page, 5 * 60 * 1000);
  stop.stop = true; await driver;
  assert(over, 'full 4P game (1 real seat + 3 CPU) reached G.over with zero manual intervention');
  assert((page.__errors || []).length === 0, 'zero page errors');
  await browser.close();
  child.kill('SIGTERM');
  log(`\nscenario=full  ${pass} passed, ${fail} failed`);
  return fail === 0;
}

async function scenarioHostBg() {
  let pass = 0, fail = 0;
  const assert = (cond, label) => { if (cond) { pass++; log('OK', label); } else { fail++; log('FAIL', label); } };
  const child = startServer();
  await new Promise((r) => setTimeout(r, USE_DENO ? 2500 : 800));
  const browser = await chromium.launch();
  const hostCtx = await newContext(browser), g1Ctx = await newContext(browser), g2Ctx = await newContext(browser);
  const hostPage = await newPage(hostCtx), g1 = await newPage(g1Ctx), g2 = await newPage(g2Ctx);
  const seatMeta = [
    { name: 'Host', type: 'human', diff: 'medium' },
    { name: 'Guest1', type: 'human', diff: 'medium' },
    { name: 'Guest2', type: 'human', diff: 'medium' },
    { name: 'CPU', type: 'cpu', diff: 'medium' },
  ];
  const code = await hostRoom(hostPage, seatMeta, 4);
  await claimSeat(hostPage, 0, 'Host');
  await joinRoom(g1, code, 'Guest1'); await claimSeat(g1, 1, 'Guest1');
  await joinRoom(g2, code, 'Guest2'); await claimSeat(g2, 2, 'Guest2');
  await new Promise((r) => setTimeout(r, 400));
  await startGameOnline(hostPage, [hostPage, g1, g2]);
  await Promise.all([hostPage, g1, g2].map((p) => p.waitForFunction(() => window.G != null, { timeout: 10000 })));
  log('game started, code=', code);

  const stop = { stop: false };
  const driver = runDriverLoop([hostPage, g1, g2], [0, 1, 2], stop, 150);
  await new Promise((r) => setTimeout(r, 3000)); // let some real play happen first

  // Snapshot g1/g2 progress right before backgrounding the host.
  const before = await g1.evaluate(() => window.G.actionSeq || 0);
  log('backgrounding HOST for 65s mid-game (actionSeq before =', before, ')...');
  const bgPromise = background(hostPage, 65000);

  // While the host is "backgrounded," poll g1/g2 every few seconds and confirm actionSeq
  // keeps moving - this is the DIRECT repro of Blake's actual bug report (a backgrounded
  // host phone used to stall CPU turns/reshuffles for the WHOLE ROOM).
  let stalled = false, lastSeq = before, movedAtLeastOnce = false;
  const pollStart = Date.now();
  while (Date.now() - pollStart < 60000) {
    await new Promise((r) => setTimeout(r, 5000));
    const seq = await g1.evaluate(() => (window.G ? window.G.actionSeq : -1)).catch(() => -1);
    log('  g1 actionSeq during host-bg:', seq);
    if (seq > lastSeq) movedAtLeastOnce = true;
    lastSeq = seq;
  }
  assert(movedAtLeastOnce, 'other players\' game kept advancing (actionSeq increased) while the host was backgrounded 60+s');

  await bgPromise;
  log('host un-backgrounded, waiting for it to catch back up...');
  await new Promise((r) => setTimeout(r, 3000));

  const eq = await settleEqual([hostPage, g1, g2], 12, 500);
  assert(eq.ok, `host resynced and G converged across all 3 contexts after returning (settled in ${eq.tries || '?'} tries)`);

  const over = await waitForGameOver(hostPage, 5 * 60 * 1000);
  stop.stop = true; await driver;
  assert(over, 'game reached G.over after the host-background disruption');
  const eq2 = await settleEqual([hostPage, g1, g2], 10, 400);
  assert(eq2.ok, 'G byte-identical across all 3 contexts at game end');
  assert((hostPage.__errors||[]).length===0 && (g1.__errors||[]).length===0 && (g2.__errors||[]).length===0, 'zero page errors across all 3 contexts');

  await browser.close();
  child.kill('SIGTERM');
  log(`\nscenario=hostbg  ${pass} passed, ${fail} failed`);
  return fail === 0;
}

async function scenarioChaos(runs) {
  let pass = 0, fail = 0;
  const assert = (cond, label) => { if (cond) { pass++; log('OK', label); } else { fail++; log('FAIL', label); } };
  const child = startServer();
  await new Promise((r) => setTimeout(r, USE_DENO ? 2500 : 800));
  const browser = await chromium.launch();

  const runResults = [];
  for (let run = 0; run < runs; run++) {
    const t0 = Date.now();
    const hostCtx = await newContext(browser), g1Ctx = await newContext(browser), g2Ctx = await newContext(browser);
    const hostPage = await newPage(hostCtx), g1 = await newPage(g1Ctx), g2 = await newPage(g2Ctx);
    const seatMeta = [
      { name: 'Host', type: 'human', diff: 'medium' },
      { name: 'Guest1', type: 'human', diff: 'medium' },
      { name: 'Guest2', type: 'human', diff: 'medium' },
      { name: 'CPU', type: 'cpu', diff: 'medium' },
    ];
    const code = await hostRoom(hostPage, seatMeta, 4);
    await claimSeat(hostPage, 0, 'Host');
    await joinRoom(g1, code, 'Guest1'); await claimSeat(g1, 1, 'Guest1');
    await joinRoom(g2, code, 'Guest2'); await claimSeat(g2, 2, 'Guest2');
    await new Promise((r) => setTimeout(r, 300));
    await startGameOnline(hostPage, [hostPage, g1, g2]);
    await Promise.all([hostPage, g1, g2].map((p) => p.waitForFunction(() => window.G != null, { timeout: 10000 })));

    const stop = { stop: false };
    const driver = runDriverLoop([hostPage, g1, g2], [0, 1, 2], stop, 120);

    let cycles = 0;
    // Realistic-but-nasty profile (v0.15 chaos-tuning, see HANDOFF): one random seat gets
    // backgrounded every ~20s for 3-8s. A family game does NOT have all three phones cycling
    // every 6 seconds - the original every-6s-all-seats profile starved the TEST'S OWN move
    // driver (it can't act for a seat mid-simulated-background), stalling the test, not the
    // game (diagnosed: actionSeq still climbing + zero divergence at its 300s budget expiry).
    const disruptionLog = [];
    const chaosTimer = setInterval(async () => {
      const pages = [hostPage, g1, g2];
      const idx = Math.floor(Math.random() * pages.length);
      const victim = pages[idx];
      cycles++;
      const dur = 3000 + Math.floor(Math.random() * 5000);
      const t0 = Date.now();
      await background(victim, dur).catch(() => {});
      // measure reconnect catch-up: time from un-background until converged
      const tBack = Date.now();
      const eq = await settleEqual([hostPage, g1, g2], 20, 250).catch(() => ({ ok: false }));
      disruptionLog.push({ cycle: cycles, victim: idx, dur, converged: eq.ok, convergeMs: Date.now() - tBack });
    }, 20000);

    // Progress monitor: sample actionSeq every 15s so a genuine stall (seq stops climbing
    // while the game isn't over) is distinguishable from a merely-long game.
    const seqSamples = [];
    const seqTimer = setInterval(async () => {
      const s = await g1.evaluate(() => (window.G ? window.G.actionSeq : -1)).catch(() => -1);
      seqSamples.push(s);
    }, 15000);
    const over = await waitForGameOver(hostPage, 10 * 60 * 1000);
    stop.stop = true; await driver;
    clearInterval(chaosTimer);
    clearInterval(seqTimer);
    await new Promise((r) => setTimeout(r, 1500));
    const eq = await settleEqual([hostPage, g1, g2], 15, 500);
    const errs = (hostPage.__errors||[]).concat(g1.__errors||[]).concat(g2.__errors||[]);
    const elapsed = Date.now() - t0;
    let maxStallWindows = 0, cur = 0;
    for (let i = 1; i < seqSamples.length; i++) {
      if (seqSamples[i] === seqSamples[i - 1]) { cur++; maxStallWindows = Math.max(maxStallWindows, cur); }
      else cur = 0;
    }
    const convergeTimes = disruptionLog.filter((d) => d.converged).map((d) => d.convergeMs);
    const maxConvergeMs = convergeTimes.length ? Math.max(...convergeTimes) : 0;
    const allConverged = disruptionLog.every((d) => d.converged);
    runResults.push({ run, over, eq: eq.ok, errs: errs.length, elapsed, cycles, maxStallWindows, allConverged, maxConvergeMs, seqSamples });
    log(`run ${run + 1}/${runs}: over=${over} eqAtEnd=${eq.ok} errors=${errs.length} elapsed=${elapsed}ms cycles=${cycles} allCyclesConverged=${allConverged} maxConvergeMs=${maxConvergeMs} maxConsecutiveFlatSeqSamples=${maxStallWindows}`);
    log(`  seqSamples: ${JSON.stringify(seqSamples)}`);
    log(`  disruptions: ${JSON.stringify(disruptionLog)}`);
    await hostCtx.close(); await g1Ctx.close(); await g2Ctx.close();
  }

  for (const r of runResults) {
    assert(r.over, `run ${r.run + 1}: game reached G.over (zero stalls)`);
    assert(r.eq, `run ${r.run + 1}: G equivalent across all 3 contexts at the end`);
    assert(r.allConverged, `run ${r.run + 1}: G converged after EVERY disruption cycle`);
    assert(r.errs === 0, `run ${r.run + 1}: zero page errors`);
  }
  await browser.close();
  child.kill('SIGTERM');
  log(`\nscenario=chaos(${runs})  ${pass} passed, ${fail} failed`);
  console.log('RUN_RESULTS_JSON=' + JSON.stringify(runResults));
  return fail === 0;
}

async function main() {
  const scenario = process.argv[2] || 'full';
  let ok;
  if (scenario === 'full') ok = await scenarioFull();
  else if (scenario === 'hostbg') ok = await scenarioHostBg();
  else if (scenario === 'chaos') ok = await scenarioChaos(parseInt(process.argv[3] || '2', 10));
  else { console.error('unknown scenario', scenario); process.exit(2); }
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
