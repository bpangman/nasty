// THE JACK BUG (Blake's 2026-07-23 item 13, found + fixed 2026-07-24).
//
// Root cause: server.js's / server.ts's sameMove() - the function that matches a submitted
// human move against the server's own independently-computed legal-move list - never checked
// `pi` (WHICH of the owner's own pieces is doing the swapping) for a Jack ('swap') move, only
// `ts`/`tpi` (the TARGET tee). legalMoves() generates one swap candidate per (owner's own
// track piece) x (every other track tee on the board), so the instant an owner has 2+ of
// their own tees on the track, several legal moves share the exact same {ci,type,owner,ts,tpi}
// and differ ONLY in `pi`. `legal.find(lm => sameMove(lm, submitted))` always returns the
// FIRST such match - and legalMoves() builds its array with `pi` as the OUTER loop, so that
// first match is always whichever of the owner's track pieces happens to sit at the lowest
// array index, regardless of which piece the player actually tapped in the real two-stage
// Jack UI. The server (authoritative for every online game) then applied THAT wrong piece's
// swap - a tee that can be anywhere on the board, "nowhere near" the one actually clicked -
// exactly Blake's report. Because online moves are only ever applied locally after the
// server's own echo (see index.html's commitMove()), this corrupted the TAPPING PLAYER's own
// phone too, not just everyone else's.
//
// This is a real end-to-end reproduction against the ACTUAL running server (not a mocked
// stand-in): one WS client plays a real human seat, three CPU seats are driven by the server
// itself exactly as in a real game. A local shadow copy of the rules engine (engine.js/
// cloud/engine.js - the exact extracted § ENGINE, never a re-implementation) is kept in
// lockstep purely by replaying the broadcast action stream (deal/move/pass), the same
// technique index.html's own client uses - so this test always has ground truth on what
// SHOULD happen without ever peeking at server internals. The moment the human seat's hand
// contains a Jack AND has 2+ of its own tees on the track (a scenario that will happen many
// times over a handful of real games), the test deliberately submits a swap using the
// piece that is NOT the lowest-indexed eligible one - exactly what a real player tapping
// their "other" Jack-able tee would send - and asserts the server's echoed move is that exact
// piece, not the lowest-indexed one it would have silently substituted pre-fix.
//
// Usage: node test_jack_swap_index.js node     (server/server.js)
//        node test_jack_swap_index.js deno     (server/cloud/server.ts)
const WebSocket = require('/Users/jarvis/nasty-game/server/node_modules/ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const KIND = process.argv[2] || 'node';
const USE_DENO = KIND === 'deno';
// The shadow always uses the Node copy (server/engine.js) regardless of which server is under
// test - byte-identical rules logic either way (test-engine-sync.js guarantees parity), so
// it's a faithful ground truth for either server's real § ENGINE.
const { createEngine } = require('../engine.js');

let PORT = 19900 + Math.floor(Math.random() * 600);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-jack-${KIND}-`));

function log(...a) { console.log('[jack]', ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log('OK  ', label); } else { FAIL++; log('FAIL', label); } }

function startServer(port) {
  let child;
  if (USE_DENO) {
    child = spawn('deno', ['run', '--allow-net', '--allow-env', '--allow-read', '--allow-write', '--unstable-kv', 'server.ts'], {
      cwd: '/Users/jarvis/nasty-game/server/cloud',
      env: Object.assign({}, process.env, { NASTY_PORT: String(port), NASTY_KV_PATH: path.join(SCRATCH, 'jack.kv'), NASTY_ADMIN_TOKEN: 'jack-admin-token' }),
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
    try { const r = await fetch(`http://localhost:${port}/health`); if (r.ok) return; } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('server never became healthy');
}
function wsConnect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// A simple async FIFO queue of every message this socket receives, so the driver loop can
// process the broadcast stream strictly in arrival order (same guarantee the real client
// relies on for lockstep).
function makeQueue(ws) {
  const buf = []; const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (waiters.length) waiters.shift()(m); else buf.push(m);
  });
  return {
    next(timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        if (buf.length) return resolve(buf.shift());
        const to = setTimeout(() => reject(new Error('timeout waiting for next message')), timeoutMs);
        waiters.push((m) => { clearTimeout(to); resolve(m); });
      });
    },
  };
}

// Applies one broadcast gameAction to a SHADOW engine instance kept purely from the wire -
// exactly the discipline index.html's own client follows (deal/move/pass, never peeking at
// anything the server didn't actually broadcast).
function applyToShadow(E, action) {
  const kind = action.kind;
  if (kind === 'start') {
    E.setLAY(E.buildLayout(action.n));
    E.newGame({ n: action.n, teams: action.teams, seats: action.seats }, { deck: [], dealer: action.dealer });
  } else if (kind === 'deal') {
    const G = E.getG();
    G.dealer = action.dealer;
    G.bowedOut = G.seats.map(() => false);
    for (let s = 0; s < G.n; s++) G.hands[s] = (action.hands[s] || []).slice();
    G.turn = action.turn;
  } else if (kind === 'move') {
    E.applyMove(action.seat, action.m);
    E.getG().turn = action.turn;
  } else if (kind === 'pass') {
    const G = E.getG();
    if (action.newlyBowedOut) G.bowedOut[action.seat] = true;
    if (action.threwIn) for (const h of G.hands) h.length = 0;
    G.turn = action.turn;
  }
  // 'reshuffleWait'/others (if any future kind appears): intentionally ignored - none of them
  // touch hands/pieces/turn, the only fields legalMoves()/applyMove() need.
}

// Look for a Jack (card index `ci`) in seat 0's shadow hand offering 2+ DISTINCT `pi` values
// (the human's OWN pieces) that can swap with the exact same (ts,tpi) target - the precise
// shape of the bug. Returns {ci, ts, tpi, pis:[...]} or null.
function findAmbiguousSwapGroup(E) {
  const legal = E.legalMoves(0);
  const groups = new Map();
  for (const m of legal) {
    if (m.type !== 'swap') continue;
    const key = m.ci + '|' + m.ts + '|' + m.tpi;
    if (!groups.has(key)) groups.set(key, { ci: m.ci, ts: m.ts, tpi: m.tpi, pis: [] });
    groups.get(key).pis.push(m.pi);
  }
  for (const g of groups.values()) if (g.pis.length >= 2) return g;
  return null;
}

async function playOneAttempt(ws, q) {
  const E = createEngine();
  let lastSeq = -1;
  let found = null; // {submittedPi, wrongPi, ci, ts, tpi}

  for (;;) {
    const msg = await q.next(20000);
    if (msg.type === 'gameAction') {
      if (msg.seq != null) {
        if (msg.seq <= lastSeq) continue; // already applied (shouldn't happen, belt+braces)
        lastSeq = msg.seq;
      }
      applyToShadow(E, msg.action);
      const G = E.getG();
      if (G.over) return { over: true, found };
      if (msg.action.kind === 'move' && msg.action.seat === 0 && found && found.awaitingEcho) {
        // this is the echo of our deliberately-crafted swap
        check(msg.action.m.type === 'swap', 'echoed action is a swap');
        check(msg.action.m.pi === found.submittedPi, `echoed swap uses the TAPPED piece (pi=${found.submittedPi}), not silently substituted`);
        check(msg.action.m.pi !== found.wrongPi, `echoed swap did NOT fall back to the other/lower-index piece (pi=${found.wrongPi})`);
        check(msg.action.m.ts === found.ts && msg.action.m.tpi === found.tpi, 'echoed swap target unchanged (ts/tpi match what was submitted)');
        return { over: false, found, resolved: true };
      }
      // Is it seat 0's turn with a hand to act on?
      if (G.turn === 0 && !G.over && !G.bowedOut[0] && G.hands[0].length > 0) {
        const legal = E.legalMoves(0);
        if (legal.length === 0) {
          // Nothing playable this hand - the server auto-detects this itself (driveTurnLoop's
          // moves.length===0 branch) and will bow this seat out + broadcast a 'pass' WITHOUT
          // ever waiting for a client action. Submitting anything here would just be a bogus
          // move the server correctly rejects - don't send anything, just keep waiting.
        } else {
          const group = findAmbiguousSwapGroup(E);
          let m;
          if (group) {
            const sortedPis = group.pis.slice().sort((a, b) => a - b);
            const wrongPi = sortedPis[0];              // what the pre-fix bug would have picked (array order == ascending pi)
            const submittedPi = sortedPis[sortedPis.length - 1]; // deliberately NOT the lowest - simulates tapping the "other" tee
            found = { submittedPi, wrongPi, ci: group.ci, ts: group.ts, tpi: group.tpi, awaitingEcho: true };
            m = { ci: group.ci, type: 'swap', owner: 0, pi: submittedPi, ts: group.ts, tpi: group.tpi };
            log('ambiguous swap group found: pis=', group.pis, '-> submitting pi=', submittedPi, '(expect NOT', wrongPi, ')');
          } else {
            m = E.chooseAI(0, legal); // any legit legal move - we just need the game to keep moving
          }
          ws.send(JSON.stringify({ type: 'action', action: { kind: 'move', seat: 0, m } }));
        }
      }
    } else if (msg.type === 'sync') {
      if (process.env.JACK_DEBUG) {
        const realG = msg.G;
        const shadowG = E.getG();
        console.error('REAL  turn', realG.turn, 'hands', realG.hands.map(h=>h.length), 'bowedOut', realG.bowedOut);
        console.error('SHDW  turn', shadowG.turn, 'hands', shadowG.hands.map(h=>h.length), 'bowedOut', shadowG.bowedOut);
        console.error('REAL  pieces', JSON.stringify(realG.pieces));
        console.error('SHDW  pieces', JSON.stringify(shadowG.pieces));
        console.error('REAL  hand0', JSON.stringify(realG.hands[0]));
        console.error('SHDW  hand0', JSON.stringify(shadowG.hands[0]));
      }
      throw new Error('server resynced us - our submitted move was rejected as illegal (test bug or real regression)');
    }
    // other message types (lobby/presence/stateCheck/pong/etc.) are irrelevant here - ignored.
  }
}

async function main() {
  const child = startServer(PORT);
  await waitHealthy(PORT);

  const MAX_GAMES = 20;
  let resolved = false;
  for (let g = 0; g < MAX_GAMES && !resolved; g++) {
    const ws = await wsConnect(PORT);
    const q = makeQueue(ws);
    const seats = [
      { name: 'Human', type: 'human', diff: 'medium' },
      { name: 'C1', type: 'cpu', diff: 'medium' },
      { name: 'C2', type: 'cpu', diff: 'medium' },
      { name: 'C3', type: 'cpu', diff: 'medium' },
    ];
    ws.send(JSON.stringify({ type: 'host', protocolVersion: 5, name: 'Human', n: 4, teams: false, seats }));
    await q.next();
    ws.send(JSON.stringify({ type: 'start', protocolVersion: 5, willSeat: true }));
    // first gameAction (kind:start) is consumed inside playOneAttempt via applyToShadow
    ws.send(JSON.stringify({ type: 'seated' }));
    log(`game ${g + 1}/${MAX_GAMES}...`);
    try {
      const result = await playOneAttempt(ws, q);
      if (result.resolved) resolved = true;
      else log('  game finished (G.over) without an ambiguous swap opportunity arising - trying another game');
    } catch (e) {
      log('  attempt error:', e.message);
    } finally {
      ws.close();
    }
  }
  check(resolved, `an ambiguous-swap scenario was found and correctly resolved within ${MAX_GAMES} games`);

  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  log(`\n${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
