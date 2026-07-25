"use strict";
/*
 * 2026-07-25 § NO-FAULT EXIT MUST NOT EAT KNOCKOUT STATS (bug 5) - reproduced here first, then
 * proved fixed, on BOTH servers.
 *
 * v0.27.1 gave every human AFTER the first conceder a free, no-fault exit: once anyone has
 * conceded an unfinished game, nobody else's departure records a loss. That is exactly right
 * competitively. But `case "surrender"`'s no-fault branch RETURNED before building any delta at
 * all, so the second-and-later conceder's already-accrued hkoDealt/hkoTaken were lost
 * permanently - their seat becomes a CPU, so finishGame() skips it too, and nothing ever writes
 * them. That contradicts the handler's own adjacent comment ("a knockout isn't gated on how the
 * game eventually ends") and diverges from the offline twin recordOfflineSurrenderLoss(), which
 * always records them.
 *
 * The fix (identical in both servers): the no-fault branch still writes a delta containing ONLY
 * the knockout keys - no hg<mode>, no loss. The free exit stays competitively free; the fun stat
 * survives.
 *
 * How this suite proves it: a real 4-player FFA game against a real private server instance,
 * two real human seats driven by the test (both preferring kick moves so knockouts actually
 * happen), with the test independently counting every knockout off the SAME broadcast action
 * stream the server tallies from. Once the second human has accrued knockouts, human A concedes
 * (the genuine first surrender), then human B concedes (the no-fault exit) - and the global
 * board is checked for both.
 *
 * Usage:
 *   node test_nofault_knockout_stats.js node
 *   node test_nofault_knockout_stats.js deno
 */
const WebSocket = require("/Users/jarvis/nasty-game/server/node_modules/ws");
const { createEngine } = require("/Users/jarvis/nasty-game/server/engine.js");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const KIND = process.argv[2] || "node";
const USE_DENO = KIND === "deno";
const PORT = 27200 + Math.floor(Math.random() * 700);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-nofault-${KIND}-`));
const ADMIN_TOKEN = "nofault-admin-token";
const BASE = `http://localhost:${PORT}`;

function log(...a) { console.log("[nofault]", new Date().toISOString(), ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  let child;
  if (USE_DENO) {
    child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
      cwd: "/Users/jarvis/nasty-game/server/cloud",
      env: Object.assign({}, process.env, { NASTY_PORT: String(PORT), NASTY_KV_PATH: path.join(SCRATCH, "nofault.kv"), NASTY_ADMIN_TOKEN: ADMIN_TOKEN }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    fs.writeFileSync(path.join(SCRATCH, "admin-token.txt"), ADMIN_TOKEN + "\n");
    child = spawn(process.execPath, ["server.js"], {
      cwd: "/Users/jarvis/nasty-game/server",
      env: Object.assign({}, process.env, {
        NASTY_PORT: String(PORT), NASTY_ROOMS_DIR: SCRATCH,
        NASTY_ADMIN_TOKEN_FILE: path.join(SCRATCH, "admin-token.txt"),
        NASTY_LEADERBOARD_FILE: path.join(SCRATCH, "leaderboard.json"),
        NASTY_LEADERBOARD_EPOCH_FILE: path.join(SCRATCH, "leaderboard-epoch.json"),
        NASTY_SOLO_IDS_FILE: path.join(SCRATCH, "solo-ids.json"),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { if (process.env.NOFAULT_VERBOSE) process.stderr.write("[srv-err] " + d); });
  return child;
}
async function waitHealthy() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + "/health"); if (r.ok) return; } catch (e) {}
    await sleep(400);
  }
  throw new Error("server never became healthy");
}
// ONE permanent 'message' listener per socket for the whole suite. It always records into
// ws.msgs and, once ws.driver is set, also hands the message to the game driver. An earlier
// draft attached the setup listener, removed it, and attached a driver listener afterwards -
// which raced with the very first broadcast (the 'start' action) and, against the slower Deno
// server, reliably lost it, leaving the shadow engine uninitialized and the suite stalling out
// on its time budget. Never detach a listener mid-game.
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.msgs = [];
    ws.driver = null;
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      ws.msgs.push(m);
      // ANSWER THE SERVER'S PING. The Deno server has no protocol-level ping/pong (Deno's
      // native WebSocket does not expose one), so it uses an app-level {type:'ping'} and
      // force-closes any socket that has not said anything for SOCKET_STALE_MS. A raw ws client
      // that ignores it gets hung up on mid-game - which is exactly what stalled the Deno leg of
      // this suite before this line existed: the server logged "seat gate cleared (unseated
      // player disconnected)" and the game went on without either test client ever hearing
      // another action. Node's ws library answers protocol-level pings by itself, which is why
      // only the Deno leg was affected.
      if (m.type === "ping") { try { ws.send(JSON.stringify({ type: "pong", t: m.t })); } catch (e) {} }
      if (ws.driver) ws.driver(m);
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
const sendJ = (ws, obj) => ws.send(JSON.stringify(obj));
function waitFor(ws, predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const hit = ws.msgs.find((m) => predicate(m));
    if (hit) { resolve(hit); return; }
    const t0 = Date.now();
    const iv = setInterval(() => {
      const h = ws.msgs.find((m) => predicate(m));
      if (h) { clearInterval(iv); resolve(h); return; }
      if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error("timeout: " + predicate.toString())); }
    }, 40);
  });
}
async function getLeaderboard() { return await (await fetch(BASE + "/leaderboard")).json(); }

const HUMANS = ["Blakey", "Sydney"];   // seats 0 and 1; seats 2/3 are CPUs

/*
 * Plays a real online 4P FFA game far enough that BOTH human seats have accrued knockouts, then
 * stops (deliberately mid-game - the whole point of this suite is an UNFINISHED game). Returns
 * the independently-counted knockout totals per seat.
 *
 * Both human seats prefer a kick move whenever one is legal, and both CPU seats are Nasty
 * (kick-hungry) - so knockouts show up within a hand or two in practice. The counting mirrors
 * server.js's tallyKnockout() exactly: human-on-human credits BOTH sides, a CPU-involved kick
 * credits only the human side, and (FFA here, so vacuously) a forced partner-kick is excluded.
 */
async function playUntilKnockouts() {
  const host = await connect();
  sendJ(host, { type: "host", protocolVersion: 5, name: HUMANS[0], n: 4, teams: false, seats: [
    { name: HUMANS[0], type: "human" }, { name: HUMANS[1], type: "human" },
    { name: "Cpu1", type: "cpu", diff: "hard" }, { name: "Cpu2", type: "cpu", diff: "hard" },
  ] });
  const created = await waitFor(host, (m) => m.type === "created");
  const code = created.code;
  const guest = await connect();
  sendJ(guest, { type: "join", protocolVersion: 5, code, name: HUMANS[1] });
  await waitFor(guest, (m) => m.type === "joined");
  sendJ(guest, { type: "claimSeat", seatIndex: 1, name: HUMANS[1] });
  await waitFor(host, (m) => m.type === "lobby");
  sendJ(guest, { type: "readyUp", willSeat: true });
  await sleep(200);

  const conns = [{ ws: host, seat: 0 }, { ws: guest, seat: 1 }];
  const shadows = conns.map(() => createEngine());
  const dealt = [0, 0, 0, 0], taken = [0, 0, 0, 0];
  let gameOver = false;
  let actionCount = 0;   // NOFAULT_DEBUG progress only

  // Twin of server.js's tallyKnockout(), driven off the SAME broadcast stream. Runs for
  // connection index 0 only - both connections receive identical broadcasts, so tallying per
  // connection would double-count every kick.
  function tally(E, action) {
    const m = action.m;
    if (!m || !m.kick) return;
    const G = E.getG();
    if (E.sameTeam(m.owner, m.kick.seat)) return;
    if (G.seats[m.owner] && G.seats[m.owner].type === "human") dealt[m.owner]++;
    if (G.seats[m.kick.seat] && G.seats[m.kick.seat].type === "human") taken[m.kick.seat]++;
  }
  function applyToShadow(E, action, doTally) {
    if (action.kind === "start") {
      E.setLAY(E.buildLayout(action.n));
      E.newGame({ n: action.n, teams: action.teams, seats: action.seats }, { deck: [], dealer: action.dealer });
    } else if (action.kind === "deal") {
      const G = E.getG();
      G.dealer = action.dealer; G.bowedOut = G.seats.map(() => false);
      for (let s = 0; s < G.n; s++) G.hands[s] = (action.hands[s] || []).slice();
      G.turn = action.turn;
    } else if (action.kind === "move") {
      if (doTally) tally(E, action);
      E.applyMove(action.seat, action.m);
      E.getG().turn = action.turn;
    } else if (action.kind === "pass") {
      const G = E.getG();
      if (action.newlyBowedOut) G.bowedOut[action.seat] = true;
      if (action.threwIn) for (const h of G.hands) h.length = 0;
      G.turn = action.turn;
    } else if (action.kind === "seatToCpu") {
      const G = E.getG();
      if (G.seats[action.seat]) { G.seats[action.seat].type = "cpu"; G.seats[action.seat].diff = action.diff; }
    }
  }
  function pickMove(E, seat) {
    const legal = E.legalMoves(seat);
    if (!legal.length) return null;
    return legal.find((m) => m.kick) || legal[Math.floor(Math.random() * legal.length)];
  }

  const t0 = Date.now();
  const done = new Promise((resolve, reject) => {
    let settled = false;
    // Generous - Deno does a real KV commit per action, so a human-driven game is slow.
    const budget = setTimeout(() => finish(new Error("seat 1 never accrued a knockout inside the time budget")), 170000);
    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(budget);
      for (const c of conns) c.ws.driver = null;   // stop driving; the collector listener stays
      if (err) reject(err); else resolve();
    }
    conns.forEach((c, ci) => {
      c.ws.driver = (msg) => {
        if (settled) return;
        if (msg.type !== "gameAction") return;
        try {
          if (ci === 0) {
            actionCount++;
            if (process.env.NOFAULT_DEBUG && actionCount % 20 === 0) {
              log(`progress: ${actionCount} actions, dealt=${JSON.stringify(dealt)} taken=${JSON.stringify(taken)}`);
            }
          }
          applyToShadow(shadows[ci], msg.action, ci === 0);
          const G = shadows[ci].getG();
          if (G.over) { gameOver = true; finish(); return; }
          // Stop as soon as the SECOND human (seat 1, the no-fault conceder in the scenario
          // below) has something worth losing. Ideally the FIRST human has some too - that
          // makes the "the first conceder is unaffected" leg meaningful rather than vacuous -
          // so give that a grace window, but never let it hold the suite up: the Deno server
          // commits to KV per action and is genuinely slower at a human-driven game.
          if (ci === 0 && (dealt[1] + taken[1]) > 0 &&
              ((dealt[0] + taken[0]) > 0 || Date.now() - t0 > 45000)) { finish(); return; }
          if (G.turn === c.seat && !G.bowedOut[c.seat] && G.hands[c.seat].length > 0) {
            const m = pickMove(shadows[ci], c.seat);
            if (m) {
              const payload = JSON.stringify({ type: "action", action: { kind: "move", seat: c.seat, m } });
              setTimeout(() => { if (!settled) c.ws.send(payload); }, 15);
            }
          }
        } catch (e) { finish(e); }
      };
    });
    // Everything is wired BEFORE the game is started, so the 'start' broadcast (which is what
    // initializes each shadow engine) can never be missed.
    sendJ(host, { type: "start", protocolVersion: 5, willSeat: true });
  });
  await done;
  return { host, guest, code, dealt, taken, gameOver };
}

async function main() {
  const child = startServer();
  await waitHealthy();

  const g = await playUntilKnockouts();
  check(!g.gameOver, "setup: the game is genuinely still UNFINISHED when the concessions happen (this bug only exists pre-finish)");
  log(`setup: independently counted knockouts - dealt=${JSON.stringify(g.dealt)} taken=${JSON.stringify(g.taken)}`);
  check((g.dealt[1] + g.taken[1]) > 0, "setup: the SECOND conceder has genuinely accrued knockout stats to lose");

  // 1) The genuine FIRST surrender: records the loss AND the knockouts (existing v0.27 behavior,
  //    guarded here so the fix below cannot regress it).
  sendJ(g.host, { type: "surrender" });
  await sleep(1200);
  {
    const lb = await getLeaderboard();
    const row = lb[HUMANS[0]] || {};
    check(row.hg4s === 1, `1: the FIRST conceder still records their loss (hg4s=${row.hg4s}, want 1)`);
    check((row.hkoDealt || 0) === g.dealt[0] && (row.hkoTaken || 0) === g.taken[0],
      `1: the FIRST conceder's knockouts are recorded exactly (got ${row.hkoDealt || 0}/${row.hkoTaken || 0}, want ${g.dealt[0]}/${g.taken[0]})`);
  }

  // 2) THE BUG: the second conceder's no-fault exit. Free competitively (no loss) - but their
  //    knockouts must survive.
  await waitFor(g.guest, (m) => m.type === "surrenderOccurred", 8000).catch(() => {});
  sendJ(g.guest, { type: "surrender" });
  await sleep(1500);
  {
    const lb = await getLeaderboard();
    const row = lb[HUMANS[1]] || {};
    check((row.hg4s || 0) === 0, `2: the no-fault exit is still competitively FREE - no loss recorded (hg4s=${row.hg4s || 0}, want 0)`);
    check((row.hw4s || 0) === 0 && (row.hptsS || 0) === 0, "2: ...and no disguised win/points either");
    check((row.hkoDealt || 0) === g.dealt[1],
      `2: the no-fault conceder's knockouts DEALT survive (got ${row.hkoDealt || 0}, want ${g.dealt[1]})`);
    check((row.hkoTaken || 0) === g.taken[1],
      `2: the no-fault conceder's knockouts TAKEN survive (got ${row.hkoTaken || 0}, want ${g.taken[1]})`);
  }

  // 3) A repeated surrender from the same, now-CPU seat must not double-count the knockouts.
  sendJ(g.guest, { type: "surrender" });
  await sleep(1200);
  {
    const lb = await getLeaderboard();
    const row = lb[HUMANS[1]] || {};
    check((row.hkoDealt || 0) === g.dealt[1] && (row.hkoTaken || 0) === g.taken[1],
      "3: conceding twice from the same seat does not double-count the knockouts (the seat is already a CPU)");
  }

  g.host.close(); g.guest.close();
  child.kill("SIGKILL");
  console.log(`\n[${KIND}] ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}
const WATCHDOG_MS = 240000;
const watchdog = setTimeout(() => {
  console.error(`[nofault] WATCHDOG: suite did not finish within ${WATCHDOG_MS}ms - forcing exit`);
  process.exit(1);
}, WATCHDOG_MS);
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => clearTimeout(watchdog));
