// Blake's item 10 (2026-07-23 list): "please make it randomized for who deals first to start
// a brand new game." Verifies (rather than assumes) that a genuinely brand-new game randomizes
// the first dealer across every seat, on every path that can start one:
//   Part 1 - offline: index.html's own newGame() (§ STATE), exercised through the extracted
//            engine.js (byte-identical, guaranteed by test-engine-sync.js) for n=4 and n=6.
//   Part 2 - online host: server.js's actuallyStartGame() (the real "host taps Start" path),
//            hosting MANY fresh rooms rapidly and reading the dealer straight off the real
//            'start' gameAction broadcast - not a mocked stand-in.
//   Part 2b - same, against the Deno cloud server (server.ts), if `deno` is on PATH.
// For each case: run N fresh games, tally which seat dealt first, and assert (a) every seat
// 0..n-1 shows up at least once and (b) no seat is grossly over/under-represented (a uniform
// distribution's expected count is N/n; a seat pinned to 0 or to the host would show up as
// ~100% and every other seat at 0%, nowhere close to these bounds).
//
// Usage: node test_dealer_random.js            (offline only, no server)
//        node test_dealer_random.js node        (+ server.js)
//        node test_dealer_random.js deno        (+ server.ts, if `deno` is installed)
//        node test_dealer_random.js all          (offline + both servers)
const { createEngine } = require("../engine.js");

function log(...a) { console.log("[dealer]", ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }

// Generous bounds on purpose: this is a randomness smoke test, not a strict statistical test -
// it must never flake on legitimate variance, while still catching the actual bug shape (a
// pinned seat, which shows up as ~0% or ~100%, nowhere near these bounds). With N=4000/n=4
// (expected 1000/seat) or N=3000/n=6 (expected 500/seat) the true binomial std-dev is small
// enough that a healthy uniform draw essentially never comes close to tripping these.
function checkDistribution(counts, n, total, label) {
  const expected = total / n;
  for (let s = 0; s < n; s++) {
    check(counts[s] > 0, `${label}: seat ${s} dealt first at least once`);
  }
  const lo = expected * 0.5, hi = expected * 1.5;
  let allInBand = true;
  for (let s = 0; s < n; s++) if (counts[s] < lo || counts[s] > hi) allInBand = false;
  check(allInBand, `${label}: every seat's share is within 50%-150% of uniform (expected ~${expected.toFixed(0)}/seat, got [${counts.join(",")}])`);
}

// ---------------------------------------------------------------------------
// Part 1: offline newGame() - no seed -> Math.floor(Math.random()*cfg.n)
// ---------------------------------------------------------------------------
function testOffline(n, teams, trials) {
  const counts = new Array(n).fill(0);
  const seats = Array.from({ length: n }, (_, i) => ({ name: "P" + i, type: "cpu", diff: "medium" }));
  for (let i = 0; i < trials; i++) {
    const E = createEngine();
    E.setLAY(E.buildLayout(n));
    // index.html's real startGame() calls newGame({n,teams,seats}) with NO second argument at
    // all - seed is fully undefined, which also skips the (unrelated) gameId assignment's
    // genGameId() call, a client-UI helper that isn't part of § ENGINE and so was never
    // extracted into engine.js (confirmed benign by test-engine-sync.js - gameId is bookkeeping,
    // not a rule). Passing `{deck:E.freshDeck()}` here (seed truthy, but no `dealer` field)
    // exercises the EXACT SAME `(seed&&seed.dealer!=null)?seed.dealer:Math.floor(Math.random()*cfg.n)`
    // branch index.html's real no-seed call reaches, without tripping over that unrelated gap.
    E.newGame({ n, teams, seats }, { deck: E.freshDeck() });
    const dealer = E.getG().dealer;
    counts[dealer]++;
  }
  checkDistribution(counts, n, trials, `offline ${n}P${teams ? " teams" : " FFA"}`);
  return counts;
}

// ---------------------------------------------------------------------------
// Part 2: online host - server.js / server.ts's actuallyStartGame(), read straight off the
// real 'start' gameAction. One human seat (never actually played) + the rest CPU: this makes
// the server's seat gate skip waiting (no `willSeat` promise sent) so driveTurnLoop() only
// needs to run forward to the human seat's very first turn before the "start" action is
// already broadcast and this test can disconnect - fast, no need to play a whole game out.
// ---------------------------------------------------------------------------
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

function startServer(kind, port, scratch) {
  let child;
  if (kind === "deno") {
    child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
      cwd: "/Users/jarvis/nasty-game/server/cloud",
      env: Object.assign({}, process.env, { NASTY_PORT: String(port), NASTY_KV_PATH: path.join(scratch, "dealer.kv"), NASTY_ADMIN_TOKEN: "dealer-admin-token" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    child = spawn(process.execPath, ["server.js"], {
      cwd: "/Users/jarvis/nasty-game/server",
      env: Object.assign({}, process.env, {
        NASTY_PORT: String(port), NASTY_ROOMS_DIR: scratch,
        NASTY_ADMIN_TOKEN_FILE: path.join(scratch, "admin-token.txt"),
        NASTY_LEADERBOARD_FILE: path.join(scratch, "leaderboard.json"),
        NASTY_LEADERBOARD_EPOCH_FILE: path.join(scratch, "leaderboard-epoch.json"),
        NASTY_SOLO_IDS_FILE: path.join(scratch, "solo-ids.json"),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  child.stderr.on("data", (d) => { const s = String(d); if (!s.includes("Listening")) process.stderr.write("[server-err] " + s); });
  return child;
}
async function waitHealthy(port) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://localhost:${port}/health`); if (r.ok) return; } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("server never became healthy");
}
const WebSocket = require("/Users/jarvis/nasty-game/server/node_modules/ws");
// The server's host-rate-limit (5 rooms/minute per IP - see server.js's underHostRateLimit())
// is keyed off x-forwarded-for when present, exactly as it would be behind a real reverse
// proxy in production. This test intentionally hosts far more than 5 rooms in well under a
// minute FROM ONE MACHINE - unlike production (where each room is a different real player,
// each on their own IP), so it gives each trial its own fake x-forwarded-for to accurately
// simulate "many different players hosting many different games", not to bypass a limit that
// would ever throttle a real user.
let fakeIpCounter = 1;
function wsConnect(port) {
  const fakeIp = `10.77.${(fakeIpCounter >> 8) & 0xff}.${fakeIpCounter & 0xff}`;
  fakeIpCounter++;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`, { headers: { "x-forwarded-for": fakeIp } });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
function nextMsg(ws, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { ws.removeListener("message", onMsg); reject(new Error("timeout waiting for message")); }, timeoutMs);
    function onMsg(raw) {
      const m = JSON.parse(raw.toString());
      if (!predicate || predicate(m)) { clearTimeout(to); ws.removeListener("message", onMsg); resolve(m); }
    }
    ws.on("message", onMsg);
  });
}

async function hostOneRoomAndGetDealer(port, n) {
  const ws = await wsConnect(port);
  const seats = Array.from({ length: n }, (_, i) => ({ name: "P" + i, type: i === 0 ? "human" : "cpu", diff: "medium" }));
  ws.send(JSON.stringify({ type: "host", protocolVersion: 5, name: "P0", n, teams: false, seats }));
  await nextMsg(ws, (m) => m.type === "created");
  // Deliberately no willSeat - the seat gate then has nothing to wait for, so driveTurnLoop()
  // runs forward on its own until it reaches seat 0's first turn, at which point the 'start'
  // gameAction (broadcast BEFORE driveTurnLoop even runs) is already sitting in our queue.
  ws.send(JSON.stringify({ type: "start", protocolVersion: 5 }));
  const started = await nextMsg(ws, (m) => m.type === "gameAction" && m.action.kind === "start");
  ws.close();
  return started.action.dealer;
}

async function testOnline(kind, n, trials) {
  const PORT = 19100 + Math.floor(Math.random() * 800);
  const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-dealer-${kind}-`));
  const child = startServer(kind, PORT, SCRATCH);
  await waitHealthy(PORT);
  const counts = new Array(n).fill(0);
  for (let i = 0; i < trials; i++) {
    const dealer = await hostOneRoomAndGetDealer(PORT, n);
    counts[dealer]++;
  }
  checkDistribution(counts, n, trials, `online-${kind} ${n}P host`);
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 400));
  return counts;
}

async function main() {
  const mode = process.argv[2] || "offline";

  log("Part 1: offline newGame() - no seed, brand-new game");
  testOffline(4, false, 4000);
  testOffline(6, true, 3000);

  if (mode === "node" || mode === "all") {
    log("Part 2: online host (server.js) - real 'start' gameAction");
    await testOnline("node", 4, 240);
    await testOnline("node", 6, 240);
  }
  if (mode === "deno" || mode === "all") {
    log("Part 2b: online host (server.ts / Deno) - real 'start' gameAction");
    await testOnline("deno", 4, 240);
    await testOnline("deno", 6, 240);
  }

  log(`\n${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
