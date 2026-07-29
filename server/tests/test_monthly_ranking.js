"use strict";
/*
 * 2026-07-28 § MONTHLY RANKING - proves the numbered claims in HANDOFF.md's "Monthly Ranking"
 * entry against BOTH servers: dated per-result history recorded from BOTH the online
 * (finishGame) and offline (/solo-result) paths, the exact GET /leaderboard/monthly contract
 * shape, the empty-month 200 (never 404), that GET /leaderboard's own output is untouched, and
 * that a month rollover changes the VIEW without deleting anything (lifetime totals survive).
 *
 * Never touches production - private port, scratch rooms dir / KV / leaderboard files,
 * throwaway admin token.
 *
 * Usage:
 *   node test_monthly_ranking.js node
 *   node test_monthly_ranking.js deno
 */
const { spawn } = require("child_process");
const WebSocket = require("/Users/jarvis/nasty-game/server/node_modules/ws");
const { createEngine } = require("../engine.js");
const path = require("path");
const fs = require("fs");
const os = require("os");

const KIND = process.argv[2] || "node";
const SERVER_DIR = "/Users/jarvis/nasty-game/server";
const CLOUD_DIR = "/Users/jarvis/nasty-game/server/cloud";

let PASS = 0, FAIL = 0;
function log(...a) { console.log("[monthly]", ...a); }
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
function randPort() { return 31400 + Math.floor(Math.random() * 300); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeScratch(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `nasty-${tag}-`)); }

function envFor(scratch, port, adminToken, extra) {
  const base = { NASTY_PORT: String(port) };
  if (KIND === "deno") {
    Object.assign(base, { NASTY_KV_PATH: path.join(scratch, "test.kv"), NASTY_ADMIN_TOKEN: adminToken });
  } else {
    fs.writeFileSync(path.join(scratch, "admin-token.txt"), adminToken + "\n");
    Object.assign(base, {
      NASTY_ROOMS_DIR: path.join(scratch, "rooms"),
      NASTY_ADMIN_TOKEN_FILE: path.join(scratch, "admin-token.txt"),
      NASTY_LEADERBOARD_FILE: path.join(scratch, "leaderboard.json"),
      NASTY_LEADERBOARD_EPOCH_FILE: path.join(scratch, "leaderboard-epoch.json"),
      NASTY_SOLO_IDS_FILE: path.join(scratch, "solo-ids.json"),
      NASTY_MONTHLY_HISTORY_FILE: path.join(scratch, "monthly-leaderboard.json"),
    });
  }
  return Object.assign({}, process.env, base, extra || {});
}
function startServer(env) {
  let child;
  if (KIND === "deno") {
    child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"],
      { cwd: CLOUD_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  } else {
    child = spawn(process.execPath, ["server.js"], { cwd: SERVER_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  }
  if (process.env.MONTHLY_VERBOSE) {
    child.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
    child.stderr.on("data", (d) => process.stderr.write("[srv-err] " + d));
  }
  return child;
}
async function waitHealthy(base, tries) {
  for (let i = 0; i < (tries || 50); i++) {
    try { const r = await fetch(base + "/health"); if (r.ok) return true; } catch (e) {}
    await sleep(300);
  }
  throw new Error("server never became healthy at " + base);
}
async function stopServer(child) {
  if (!child) return;
  child.kill("SIGTERM");
  await sleep(600);
  try { child.kill("SIGKILL"); } catch (e) {}
}

let gid = 0;
async function seed(base, name, delta) {
  const r = await fetch(base + "/solo-result", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ gameId: `monthly-${KIND}-${Date.now()}-${gid++}`, entries: [{ name, delta }] }),
  });
  return { status: r.status, body: await r.json() };
}
async function board(base) { return await (await fetch(base + "/leaderboard")).json(); }
async function monthly(base, month) {
  const r = await fetch(base + "/leaderboard/monthly" + (month ? `?month=${month}` : ""));
  return { status: r.status, body: await r.json() };
}
/* The server broadcasts a game's winning action to clients BEFORE it finishes its own
   record-the-result write (see commitAndBroadcast() in both servers - broadcast happens first,
   the leaderboard/monthly write is awaited AFTER, so the room isn't held open waiting on it).
   That means a client that resolves the instant it SEES game-over (as this suite's shadow-engine
   driver deliberately does, to prove the broadcast stream itself is correct) can genuinely poll
   /leaderboard/monthly a few milliseconds before the server-side write lands - the exact same
   eventual-consistency window the LIFETIME board has always had. This is a short poll standing
   in for "check again shortly," not a retry-away-a-bug - it fails for real if the data never
   shows up within a generous budget. */
async function pollMonthlyUntil(base, month, predicate, budgetMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < (budgetMs || 3000)) {
    last = await monthly(base, month);
    if (predicate(last.body)) return last;
    await sleep(25);
  }
  return last;
}

function wsConnect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
/* One human seat (shadow-driven from a local engine, same technique test_accounts_online.js and
   test_knockout_leaderboard.js already use), three CPUs, played to a REAL finish - the server
   drives everything itself, this just supplies seat 0's moves and answers the app-level ping. */
async function playOnlineGame(port, hostName) {
  const seats = [
    { name: hostName, type: "human", diff: "medium" },
    { name: "CPU1", type: "cpu", diff: "easy" },
    { name: "CPU2", type: "cpu", diff: "easy" },
    { name: "CPU3", type: "cpu", diff: "easy" },
  ];
  const ws = await wsConnect(port);
  const E = createEngine();
  return await new Promise((resolve, reject) => {
    let settled = false;
    const hard = setTimeout(() => finish(new Error("online game did not finish within its budget")), 180000);
    function finish(err, val) {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      try { ws.close(); } catch (e) {}
      if (err) reject(err); else resolve(val);
    }
    ws.on("message", (raw) => {
      if (settled) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      try {
        if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong", t: msg.t })); return; }
        if (msg.type === "created") {
          ws.send(JSON.stringify({ type: "start", protocolVersion: 5, willSeat: true }));
          ws.send(JSON.stringify({ type: "seated" }));
          return;
        }
        if (msg.type === "gameAction") {
          const a = msg.action;
          if (a.kind === "start") {
            E.setLAY(E.buildLayout(a.n));
            E.newGame({ n: a.n, teams: a.teams, seats: a.seats }, { deck: [], dealer: a.dealer });
          } else if (a.kind === "deal") {
            const G = E.getG();
            G.dealer = a.dealer; G.bowedOut = G.seats.map(() => false);
            for (let s = 0; s < G.n; s++) G.hands[s] = (a.hands[s] || []).slice();
            G.turn = a.turn;
          } else if (a.kind === "move") {
            E.applyMove(a.seat, a.m);
            E.getG().turn = a.turn;
          } else if (a.kind === "pass") {
            const G = E.getG();
            if (a.newlyBowedOut) G.bowedOut[a.seat] = true;
            if (a.threwIn) for (const h of G.hands) h.length = 0;
            G.turn = a.turn;
          }
          const G = E.getG();
          if (G.over) { finish(null, { winners: G.winners.slice() }); return; }
          if (G.turn === 0 && !G.bowedOut[0] && G.hands[0].length > 0) {
            const legal = E.legalMoves(0);
            if (legal.length) {
              const m = legal[Math.floor(Math.random() * legal.length)];
              setTimeout(() => { if (!settled) ws.send(JSON.stringify({ type: "action", action: { kind: "move", seat: 0, m } })); }, 10);
            }
          }
          return;
        }
        if (msg.type === "sync") { finish(new Error("got resynced - a submitted move was rejected")); return; }
        if (msg.type === "kicked" || msg.type === "error") { finish(new Error("server said: " + (msg.message || msg.type))); return; }
      } catch (e) { finish(e); }
    });
    ws.send(JSON.stringify({ type: "host", protocolVersion: 5, name: hostName, n: 4, teams: false, seats }));
  });
}

async function main() {
  /* ===================== Part A: the ONLINE path writes both lifetime + monthly ===================== */
  {
    const scratch = makeScratch(`monthly-online-${KIND}`);
    const port = randPort();
    const base = `http://localhost:${port}`;
    const env = envFor(scratch, port, "monthly-online-token");
    const srv = startServer(env);
    await waitHealthy(base);
    try {
      const before = await board(base);
      check(!before.Wanda, "setup: Wanda has no prior row");
      const r = await playOnlineGame(port, "Wanda");
      check(Array.isArray(r.winners), "A1 a real online 4P game reached G.over via the server's own action stream");

      const after = await board(base);
      check(after.Wanda && typeof after.Wanda === "object", "A2 the online game's finish wrote Wanda's LIFETIME row (unchanged mechanism)");
      const won = after.Wanda.hw4s === 1;
      const lost = after.Wanda.hg4s === 1 && !after.Wanda.hw4s;
      check(after.Wanda.hg4s === 1, "A3 lifetime hg4s incremented by exactly 1: " + JSON.stringify(after.Wanda));

      const m = await pollMonthlyUntil(base, undefined, (b) => !!b.players.Wanda);
      check(m.status === 200, "A4 GET /leaderboard/monthly is 200 right after an online finish");
      check(m.body.players.Wanda, "A5 the SAME online finish also wrote a dated monthly entry for Wanda (polled briefly - see the broadcast-before-record note): " + JSON.stringify(m.body));
      if (m.body.players.Wanda) {
        const row = m.body.players.Wanda;
        check(row.games === 1, "A6 monthly games=1 for Wanda's one online game: " + JSON.stringify(row));
        check(row.losses === row.games - row.wins, "A7 losses = games - wins: " + JSON.stringify(row));
        check(row.wins === (won ? 1 : 0), "A8 monthly win/loss matches the game's actual outcome: won=" + won + " row=" + JSON.stringify(row));
        const expectedPts = (after.Wanda.hptsS || 0);   // this suite's only game for Wanda, so lifetime pts == this game's pts
        check(row.pts === expectedPts, "A9 monthly pts matches the lifetime points this exact game earned: " + row.pts + " vs " + expectedPts);
      }
    } finally { await stopServer(srv); }
  }

  /* ===================== Part B: the OFFLINE path (/solo-result) writes both ===================== */
  {
    const scratch = makeScratch(`monthly-offline-${KIND}`);
    const port = randPort();
    const base = `http://localhost:${port}`;
    const env = envFor(scratch, port, "monthly-offline-token");
    const srv = startServer(env);
    await waitHealthy(base);
    try {
      // Two games for "Ozzy" this month: one win (hg4s+hw4s+hptsS9), one loss (hg4s only).
      const r1 = await seed(base, "Ozzy", { hg4s: 1, hw4s: 1, hptsS: 9 });
      check(r1.status === 200, "B1 first offline solo result accepted");
      const r2 = await seed(base, "Ozzy", { hg4s: 1 });
      check(r2.status === 200, "B2 second offline solo result (a loss - no hw/hpts key) accepted");

      const lb = await board(base);
      check(lb.Ozzy && lb.Ozzy.hg4s === 2 && lb.Ozzy.hw4s === 1 && lb.Ozzy.hptsS === 9,
        "B3 lifetime counters: 2 games, 1 win, 9 points (unchanged offline mechanism): " + JSON.stringify(lb.Ozzy));

      const m = await monthly(base);
      check(m.body.players.Ozzy, "B4 offline results wrote a dated monthly entry for Ozzy too");
      if (m.body.players.Ozzy) {
        const row = m.body.players.Ozzy;
        check(row.games === 2 && row.wins === 1 && row.losses === 1 && row.pts === 9,
          "B5 monthly totals from TWO offline games are exactly right: " + JSON.stringify(row));
      }

      /* ============= Part C: the exact contract shape ============= */
      check(typeof m.body.month === "string" && /^\d{4}-\d{2}$/.test(m.body.month),
        "C1 top-level `month` is a YYYY-MM string: " + m.body.month);
      check(typeof m.body.players === "object" && m.body.players !== null, "C2 top-level `players` is an object");
      const keys = Object.keys(m.body.players.Ozzy);
      check(keys.sort().join(",") === "games,losses,pts,wins", "C3 each player row has EXACTLY {games,wins,losses,pts}: " + keys.join(","));

      /* ============= Part D: an empty month is 200, not 404, empty players ============= */
      const empty = await monthly(base, "2019-01");
      check(empty.status === 200, "D1 a month with zero data still answers 200, never 404");
      check(empty.body.month === "2019-01", "D2 echoes back the requested month");
      check(Object.keys(empty.body.players).length === 0, "D3 players is genuinely empty: " + JSON.stringify(empty.body.players));

      /* ============= Part E: GET /leaderboard is byte-identical for the same data =============
         Direct proof, not reasoning: run the identical seed sequence against the UNMODIFIED
         server (this session's server.js/server.ts changes stashed out), capture /leaderboard,
         then compare byte-for-byte against what THIS run already captured above. */
      const compareProof = await proveLeaderboardByteIdentical();
      check(compareProof.ran, "E0 byte-identical comparison actually ran (pre-session HEAD copy booted and compared)");
      if (compareProof.ran) {
        check(compareProof.identical, "E1 /leaderboard JSON is byte-identical with vs without this session's monthly-ranking code, same input: " +
          (compareProof.identical ? "identical" : `OLD=${compareProof.oldJson} NEW=${compareProof.newJson}`));
      }
    } finally { await stopServer(srv); }
  }

  /* ===================== Part F: a month rollover changes the VIEW, deletes NOTHING =============
     NASTY_MONTHLY_NOW_MS is the test-only clock override (see server.js/.ts's own comment).
     Games are seeded under a simulated "old" month, the server is restarted with the override
     removed (real "now"), more games are seeded under the real current month, and BOTH months
     plus the full lifetime total are re-checked - proving the old month's data was never
     touched by the new month starting. */
  {
    const scratch = makeScratch(`monthly-rollover-${KIND}`);
    const port = randPort();
    const base = `http://localhost:${port}`;
    // A definitely-past month, far enough back it can never collide with "today" in any timezone.
    const oldMonthMs = Date.UTC(2024, 2, 15, 12, 0, 0); // 2024-03, well over a year before this feature
    let srv = startServer(envFor(scratch, port, "monthly-rollover-token", { NASTY_MONTHLY_NOW_MS: String(oldMonthMs) }));
    await waitHealthy(base);
    let oldMonthKey;
    try {
      const r = await seed(base, "Rollo", { hg4s: 1, hw4s: 1, hptsS: 5 });
      check(r.status === 200, "F1 seeded a game under the simulated old month");
      const m = await monthly(base);
      oldMonthKey = m.body.month;
      check(oldMonthKey === "2024-03", "F2 the simulated month is exactly what was asked for: " + oldMonthKey);
      check(m.body.players.Rollo && m.body.players.Rollo.games === 1, "F3 the old month shows Rollo's one game: " + JSON.stringify(m.body.players));
    } finally { await stopServer(srv); }

    // Restart the SAME server (same scratch/state on disk-or-KV), real clock this time.
    srv = startServer(envFor(scratch, port, "monthly-rollover-token"));
    await waitHealthy(base);
    try {
      const r2 = await seed(base, "Rollo", { hg4s: 1, hptsS: 0 }); // a loss, real "now"
      check(r2.status === 200, "F4 seeded a second game for Rollo under the REAL current month");
      const nowKey = (await monthly(base)).body.month;
      check(nowKey !== oldMonthKey, "F5 the current month key differs from the simulated old one (a real rollover happened)");

      const oldView = await monthly(base, oldMonthKey);
      check(oldView.body.players.Rollo && oldView.body.players.Rollo.games === 1,
        "F6 the OLD month's data is completely untouched by the new month starting: " + JSON.stringify(oldView.body.players));

      const curView = await monthly(base, nowKey);
      check(curView.body.players.Rollo && curView.body.players.Rollo.games === 1,
        "F7 the CURRENT month has its OWN separate one-game total, not merged with the old month: " + JSON.stringify(curView.body.players));

      const lb = await board(base);
      check(lb.Rollo && lb.Rollo.hg4s === 2 && lb.Rollo.hw4s === 1 && lb.Rollo.hptsS === 5,
        "F8 LIFETIME totals accumulated across BOTH months (2 games, 1 win) - nothing was reset or deleted by the rollover: " + JSON.stringify(lb.Rollo));
    } finally { await stopServer(srv); }
  }

  /* ===================== Part G: pruning keeps at least 13 months, deletes only older ones =====
     Node-only (direct, deterministic): pre-seed the monthly-history FILE with 15 fabricated
     months before boot, so the real boot-time loadMonthlyHistory()->pruneMonthlyHistory() path
     runs against real over-the-limit data, then confirm exactly 13 remain and the two oldest
     (and ONLY the two oldest) were dropped. Deno's twin algorithm/constant is identical by
     inspection (same MONTHLY_MAX_MONTHS=13, same "sort keys, drop the oldest" logic) - proving
     it via 13+ real HTTP-driven month rollovers on Deno was not run in this suite; see the
     session report for why. */
  if (KIND === "node") {
    const scratch = makeScratch(`monthly-prune-${KIND}`);
    const port = randPort();
    const base = `http://localhost:${port}`;
    const histFile = path.join(scratch, "monthly-leaderboard.json");
    fs.mkdirSync(scratch, { recursive: true });
    const fabricated = {};
    const months = [];
    for (let i = 0; i < 15; i++) {
      const y = 2024, mo = i + 1; // 2024-01 .. 2025-03
      const key = `${y + Math.floor((mo - 1) / 12)}-${String(((mo - 1) % 12) + 1).padStart(2, "0")}`;
      months.push(key);
      fabricated[key] = { Historic: { games: 1, wins: 1, pts: 3 } };
    }
    fs.writeFileSync(histFile, JSON.stringify(fabricated));
    const srv = startServer(envFor(scratch, port, "monthly-prune-token"));
    await waitHealthy(base);
    try {
      const sortedMonths = months.slice().sort();
      const oldest = sortedMonths[0], secondOldest = sortedMonths[1], keptOldest = sortedMonths[2];
      const droppedView = await monthly(base, oldest);
      check(Object.keys(droppedView.body.players).length === 0, "G1 the single oldest month was pruned at boot: " + JSON.stringify(droppedView.body));
      const droppedView2 = await monthly(base, secondOldest);
      check(Object.keys(droppedView2.body.players).length === 0, "G2 the second-oldest month was ALSO pruned (15 - 13 = 2 dropped): " + JSON.stringify(droppedView2.body));
      const keptView = await monthly(base, keptOldest);
      check(keptView.body.players.Historic && keptView.body.players.Historic.games === 1,
        "G3 the 13th-from-newest month (the new oldest survivor) is intact, untouched: " + JSON.stringify(keptView.body));
      const newestView = await monthly(base, sortedMonths[sortedMonths.length - 1]);
      check(newestView.body.players.Historic && newestView.body.players.Historic.games === 1,
        "G4 the newest fabricated month is intact too: " + JSON.stringify(newestView.body));
    } finally { await stopServer(srv); }
  }

  log(`${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL > 0 ? 1 : 0);
}

/* ---- Part E's helper: run the PRE-THIS-SESSION server code (read straight from git HEAD, never
   the working tree) side by side with the CURRENT code, replay the identical seed sequence
   against each, and diff /leaderboard byte-for-byte. Deliberately does NOT touch the working
   tree at all (no git stash, no checkout) - a parallel session is editing index.html in this
   same repo right now, and this suite must never risk that file. Instead the original
   server.js/server.ts content is read via `git show HEAD:<path>` and written to a THROWAWAY
   sibling file in the same directory (so its own relative `require("./engine.js")`/
   `import ... from "./engine.js"` still resolve), run once, then deleted. */
async function proveLeaderboardByteIdentical() {
  const { execSync } = require("child_process");
  const repoRoot = "/Users/jarvis/nasty-game";
  const relPath = KIND === "deno" ? "server/cloud/server.ts" : "server/server.js";
  const dir = KIND === "deno" ? CLOUD_DIR : SERVER_DIR;
  const tmpName = KIND === "deno" ? `.tmp_orig_${process.pid}.ts` : `.tmp_orig_${process.pid}.js`;
  const tmpPath = path.join(dir, tmpName);
  try {
    let origSource;
    try { origSource = execSync(`git show HEAD:${relPath}`, { cwd: repoRoot, maxBuffer: 1024 * 1024 * 32 }).toString(); }
    catch (e) { return { ran: false, reason: "git show HEAD:" + relPath + " failed: " + e.message }; }
    fs.writeFileSync(tmpPath, origSource);

    async function runOne(fileArg) {
      const scratch = makeScratch(`monthly-compare-${KIND}`);
      const port = randPort();
      const base = `http://localhost:${port}`;
      const env = envFor(scratch, port, "monthly-compare-token");
      let child;
      if (KIND === "deno") {
        child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", fileArg],
          { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
      } else {
        child = spawn(process.execPath, [fileArg], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
      }
      try {
        await waitHealthy(base);
        await seed(base, "Ozzy", { hg4s: 1, hw4s: 1, hptsS: 9 });
        await seed(base, "Ozzy", { hg4s: 1 });
        return JSON.stringify(await board(base));
      } finally { await stopServer(child); }
    }

    const oldJson = await runOne(tmpName);
    const newJson = await runOne(path.basename(relPath));
    return { ran: true, identical: oldJson === newJson, oldJson, newJson };
  } catch (e) {
    log("byte-identical proof errored:", e.message);
    return { ran: false, reason: e.message };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (e) {}
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
