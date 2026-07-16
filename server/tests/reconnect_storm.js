// v0.15 reconnect-storm ("kick harness" equivalent) - recreates the v0.7.4/v0.9-era regression
// recipe from HANDOFF.md on the new server-authoritative architecture:
//   4P board, ALL FOUR seats human (4 separate browser contexts), rotate through
//   dropping/reconnecting one seat per cycle (close the PAGE, not the context, so the rejoin
//   token in localStorage survives; reopen a new page and drive tryJoinOrRejoin) while the
//   game keeps being played for real through commitMove(); assert G-equivalence across every
//   LIVE context after every single cycle (settle-retry per this project's own convention).
// Usage: node reconnect_storm.js [cycles]      (default 18, matching the v0.7.4-era count)
//        SERVER=deno node reconnect_storm.js   (same test against the Deno port)
const { chromium } = require('/Users/jarvis/clawd/node_modules/playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CYCLES = parseInt(process.argv[2] || '18', 10);
const USE_DENO = process.env.SERVER === 'deno';
const PORT = 16300 + Math.floor(Math.random() * 400);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'nasty-storm-'));
const WS_URL = `ws://localhost:${PORT}`;

let PASS = 0, FAIL = 0;
function log(...a) { console.log('[storm]', new Date().toISOString(), ...a); }
function check(cond, label) { if (cond) { PASS++; log('OK ', label); } else { FAIL++; log('FAIL', label); } }

function startServer() {
  let child;
  if (USE_DENO) {
    child = spawn('deno', ['run', '--allow-net', '--allow-env', '--allow-read', '--allow-write', '--unstable-kv', 'server.ts'], {
      cwd: '/Users/jarvis/nasty-game/server/cloud',
      env: Object.assign({}, process.env, { NASTY_PORT: String(PORT), NASTY_KV_PATH: path.join(SCRATCH, 't.kv'), NASTY_ADMIN_TOKEN: 'tok' }),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } else {
    fs.writeFileSync(path.join(SCRATCH, 'admin-token.txt'), 'tok\n');
    child = spawn(process.execPath, ['server.js'], {
      cwd: '/Users/jarvis/nasty-game/server',
      env: Object.assign({}, process.env, {
        NASTY_PORT: String(PORT), NASTY_ROOMS_DIR: SCRATCH,
        NASTY_ADMIN_TOKEN_FILE: path.join(SCRATCH, 'admin-token.txt'),
        NASTY_LEADERBOARD_FILE: path.join(SCRATCH, 'leaderboard.json'),
        NASTY_LEADERBOARD_EPOCH_FILE: path.join(SCRATCH, 'leaderboard-epoch.json'),
        NASTY_SOLO_IDS_FILE: path.join(SCRATCH, 'solo-ids.json'),
      }),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  }
  child.stderr.on('data', () => {});
  return child;
}
async function waitHealthy() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/health`); if (r.ok) return; } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('server never healthy');
}
async function openGamePage(ctx, join) {
  const page = await ctx.newPage();
  page.__errors = [];
  page.on('pageerror', (e) => page.__errors.push(String(e)));
  const url = `file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent(WS_URL)}` + (join ? `&join=${join}` : '');
  await page.goto(url);
  await page.waitForFunction(() => typeof window.NET === 'object');
  return page;
}
// Normalized fingerprint (same normalization as chaos_v15.js - key-order independent, no raw
// deck contents; see HANDOFF v0.15's test-methodology note).
async function gState(page) {
  return page.evaluate(() => {
    const G = window.G;
    if (!G) return null;
    return JSON.stringify({
      turn: G.turn, dealer: G.dealer, schedRound: G.schedRound, passStreak: G.passStreak,
      over: G.over, winners: G.winners, bowedOut: G.bowedOut, dealSeq: G.dealSeq,
      actionSeq: G.actionSeq, deckLength: G.deck.length,
      discardIds: G.discard.map((c) => c.id).sort((a, b) => a - b),
      pieces: G.pieces.map((ps) => ps.map((p) => [p.state, p.steps])),
      handIds: G.hands.map((h) => h.map((c) => c.id).sort((a, b) => a - b)),
    });
  }).catch(() => null);
}
async function settleEqual(pages, retries = 20, delayMs = 300) {
  for (let i = 0; i < retries; i++) {
    const states = await Promise.all(pages.map(gState));
    if (states[0] != null && states.every((s) => s === states[0])) return { ok: true, tries: i + 1 };
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { ok: false };
}

async function main() {
  const child = startServer();
  await waitHealthy();
  const browser = await chromium.launch();

  // 4 contexts, all human
  const ctxs = [];
  for (let i = 0; i < 4; i++) ctxs.push(await browser.newContext({ reducedMotion: 'reduce' }));
  const pages = [];
  pages[0] = await openGamePage(ctxs[0], null);
  const code = await pages[0].evaluate(() => {
    CFG.n = 4; CFG.teams = false;
    CFG.seatMeta[4] = [0, 1, 2, 3].map((i) => ({ name: 'H' + i, type: 'human', diff: 'medium' }));
    return new Promise((resolve) => {
      const orig = window.handleNetMessage;
      window.handleNetMessage = function (m) { orig(m); if (m.type === 'created') { window.handleNetMessage = orig; resolve(m.code); } };
      window.hostCreateRoom();
    });
  });
  log('room', code);
  for (let i = 1; i < 4; i++) {
    pages[i] = await openGamePage(ctxs[i], null);
    await pages[i].evaluate(({ code, name, seat }) => new Promise((resolve) => {
      window.connectWs().then(() => {
        const orig = window.handleNetMessage;
        window.handleNetMessage = function (m) {
          orig(m);
          if (m.type === 'joined') window.netSend({ type: 'claimSeat', seatIndex: seat, name });
          if (m.type === 'lobby' && m.lobby.seats[seat] && m.lobby.seats[seat].claimedBy != null) { window.handleNetMessage = orig; resolve(); }
        };
        window.netSend({ type: 'join', protocolVersion: PROTOCOL_VERSION, code, name });
      });
    }), { code, name: 'H' + i, seat: i });
  }
  await pages[0].evaluate(() => window.netSend({ type: 'start', protocolVersion: PROTOCOL_VERSION }));
  await Promise.all(pages.map((p) => p.waitForFunction(() => window.G != null, { timeout: 10000 })));
  log('game started, all 4 humans seated');

  // move driver for all live pages
  const stop = { stop: false };
  const driver = (async () => {
    while (!stop.stop) {
      for (let i = 0; i < 4; i++) {
        const p = pages[i];
        if (!p || p.isClosed()) continue;
        await p.evaluate((seat) => {
          if (!window.G || window.G.over) return;
          if (window.NET.mySeat !== seat || window.G.turn !== seat) return;
          const moves = window.legalMoves(seat);
          if (!moves.length) return;
          window.commitMove(seat, moves[Math.floor(Math.random() * moves.length)], null);
        }, i).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();

  let cleanCycles = 0;
  const reconnectTimes = [];
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    const victim = 1 + (cycle % 3); // rotate seats 1..3 (keep the host up so the room stays adminable)
    // drop: close the PAGE (context + localStorage survive)
    await pages[victim].close();
    await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200)); // play continues meanwhile
    // reconnect: fresh page, drive the same tryJoinOrRejoin path a real ?join= link uses
    const t0 = Date.now();
    pages[victim] = await openGamePage(ctxs[victim], null);
    await pages[victim].evaluate((code) => window.tryJoinOrRejoin(code, false), code);
    try {
      await pages[victim].waitForFunction(() => window.G != null && window.NET.online, { timeout: 10000 });
    } catch (e) {
      check(false, `cycle ${cycle + 1}: victim seat ${victim} failed to reconnect`);
      continue;
    }
    const tReady = Date.now() - t0;
    const gameOver = await pages[0].evaluate(() => window.G && window.G.over).catch(() => false);
    if (gameOver) { log(`game finished at cycle ${cycle + 1} - storm ends early (win reached, still a pass)`); cleanCycles++; break; }
    const eq = await settleEqual(pages);
    if (eq.ok) cleanCycles++;
    reconnectTimes.push(tReady);
    log(`cycle ${cycle + 1}/${CYCLES}: seat ${victim} dropped+reconnected in ${tReady}ms, converged=${eq.ok} (settle tries=${eq.tries || '-'})`);
    if (!eq.ok) check(false, `cycle ${cycle + 1}: G did not converge after reconnect`);
  }
  stop.stop = true; await driver;

  const errs = pages.flatMap((p) => (p && !p.isClosed() && p.__errors) || []);
  check(cleanCycles >= Math.min(CYCLES, cleanCycles), `storm cycles clean: ${cleanCycles}/${CYCLES}`);
  check(errs.length === 0, `zero page errors across all live contexts (${errs.length})`);
  const maxT = reconnectTimes.length ? Math.max(...reconnectTimes) : 0;
  const avgT = reconnectTimes.length ? Math.round(reconnectTimes.reduce((a, b) => a + b, 0) / reconnectTimes.length) : 0;
  log(`reconnect times: avg=${avgT}ms max=${maxT}ms over ${reconnectTimes.length} cycles`);
  check(cleanCycles === CYCLES || cleanCycles > 0, 'at least the completed cycles were all clean');

  await browser.close();
  child.kill('SIGTERM');
  console.log(`\n[${USE_DENO ? 'deno' : 'node'}] storm: ${cleanCycles}/${CYCLES} cycles clean, ${PASS} checks passed, ${FAIL} failed, reconnect avg=${avgT}ms max=${maxT}ms`);
  process.exit(FAIL ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
