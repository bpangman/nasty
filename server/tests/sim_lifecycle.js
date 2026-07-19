"use strict";
/*
 * v0.22 Layer-2 lifecycle test - real WebKit in the real iOS Simulator, driven with simctl.
 * Usage:
 *   node sim_lifecycle.js node     (server/server.js)
 *   node sim_lifecycle.js deno     (server/cloud/server.ts)
 * SKIPS cleanly (exit 0, "SKIP" lines) when no iOS Simulator is available on this machine.
 *
 * What this layer is for (per the reconnect research doc): the Simulator does NOT faithfully
 * reproduce true suspension/socket teardown - Layer 1 (test_freeze_recovery.js) covers those
 * semantics at the network layer. THIS layer verifies the EVENT and RELOAD plumbing on real
 * iOS WebKit (mobile Safari - the same engine the Capacitor shell wraps):
 *   1. A phone with a stored session for a LIVE room, launched cold, silently rejoins straight
 *      to the board (the P2 cold-reload path) - verified server-side: player connected, room
 *      NEVER paused (no reunion auto-pause - one phone's relaunch must not pause the family).
 *   2. Backgrounding (foregrounding Settings over Safari) then returning keeps/regains the
 *      connection, room still never paused.
 *   3. terminate + cold relaunch (the memory-kill shape): plain URL, no params - localStorage
 *      alone gets the player back to the table, still no pause.
 *   4. The gate holds: with the room PAUSED, a cold relaunch does NOT silently sit down at the
 *      table - the client backs out to its menu (server sees it disconnect again), the room
 *      stays paused and untouched.
 * Never touches production: private server + private static file server, both on localhost
 * (the Simulator shares the host's loopback), plus the ?testseed= boot hook (index.html).
 */
const http = require("http");
const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const WebSocket = require("/Users/jarvis/nasty-game/server/node_modules/ws");

const KIND = process.argv[2] || "node";
const USE_DENO = KIND === "deno";
const PORT = 23200 + Math.floor(Math.random() * 700);
const HTTP_PORT = PORT + 1000;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-sim-${KIND}-`));
const SAFARI = "com.apple.mobilesafari";

function log(...a) { console.log("[sim]", new Date().toISOString(), ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickSimulator() {
  let out;
  try { out = execSync("xcrun simctl list devices available -j", { encoding: "utf8" }); }
  catch (e) { return null; }
  let data;
  try { data = JSON.parse(out); } catch (e) { return null; }
  const phones = [];
  for (const [rt, devs] of Object.entries(data.devices || {})) {
    for (const d of devs) if (/iPhone/.test(d.name)) phones.push({ ...d, runtime: rt });
  }
  if (!phones.length) return null;
  return phones.find((p) => p.state === "Booted") || phones[0];
}
function simctl(args, opts) { return execSync(`xcrun simctl ${args}`, { encoding: "utf8", ...opts }); }

function startServer(port) {
  let child;
  if (USE_DENO) {
    child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
      cwd: "/Users/jarvis/nasty-game/server/cloud",
      env: Object.assign({}, process.env, { NASTY_PORT: String(port), NASTY_KV_PATH: path.join(SCRATCH, "sim.kv"), NASTY_ADMIN_TOKEN: "sim-admin-token" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    child = spawn(process.execPath, ["server.js"], {
      cwd: "/Users/jarvis/nasty-game/server",
      env: Object.assign({}, process.env, {
        NASTY_PORT: String(port), NASTY_ROOMS_DIR: SCRATCH,
        NASTY_ADMIN_TOKEN_FILE: path.join(SCRATCH, "admin-token.txt"),
        NASTY_LEADERBOARD_FILE: path.join(SCRATCH, "leaderboard.json"),
        NASTY_LEADERBOARD_EPOCH_FILE: path.join(SCRATCH, "leaderboard-epoch.json"),
        NASTY_SOLO_IDS_FILE: path.join(SCRATCH, "solo-ids.json"),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  child.stderr.on("data", (d) => { if (process.env.NASTY_TEST_VERBOSE) process.stderr.write("[server-err] " + d); });
  return child;
}
async function waitHealthy(port) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://localhost:${port}/health`); if (r.ok) return await r.json(); } catch (e) {}
    await sleep(400);
  }
  throw new Error("server never became healthy");
}

// Tiny static server: index.html (current working tree) + a wsurl.json pointing at the private
// game server - so a COLD Safari relaunch (sessionStorage ws-override gone) still resolves the
// private server via the page-origin wsurl.json fetch, never anything public.
function startStaticServer(httpPort, wsPort) {
  const html = fs.readFileSync("/Users/jarvis/nasty-game/index.html");
  const srv = http.createServer((req, res) => {
    const p = req.url.split("?")[0];
    if (p === "/" || p === "/index.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); return; }
    if (p === "/wsurl.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ url: `ws://127.0.0.1:${wsPort}` })); return; }
    res.writeHead(404); res.end("nope");
  });
  return new Promise((resolve) => srv.listen(httpPort, "127.0.0.1", () => resolve(srv)));
}

function wsConnect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
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
const sendJ = (ws, obj) => ws.send(JSON.stringify(obj));

async function roomInfo(code) {
  const adminToken = USE_DENO ? "sim-admin-token" : fs.readFileSync(path.join(SCRATCH, "admin-token.txt"), "utf8").trim();
  const r = await fetch(`http://localhost:${PORT}/admin/rooms`, { headers: { "x-admin-token": adminToken } });
  const list = await r.json();
  return list.find((x) => x.code === code) || null;
}
async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return Date.now() - t0;
    await sleep(500);
  }
  log("timeout waiting for:", label);
  return -1;
}

async function main() {
  const sim = pickSimulator();
  if (!sim) { log("SKIP: no iOS Simulator available on this machine"); process.exit(0); }
  if (sim.state !== "Booted") {
    log("booting simulator", sim.name);
    try { simctl(`boot ${sim.udid}`); } catch (e) { log("SKIP: could not boot simulator:", e.message); process.exit(0); }
    await sleep(20000);
  }
  const UD = sim.udid;
  log("using simulator:", sim.name, UD);

  const server = startServer(PORT);
  await waitHealthy(PORT);
  const staticSrv = await startStaticServer(HTTP_PORT, PORT);

  // Build the room: harness holds seat 0 (Host); "Sim" joins as playerId 2 for seat 1; two CPU
  // seats. Then the Sim identity's raw socket closes - the PHONE takes that identity over via
  // the ?testseed= boot hook.
  const hostWs = await wsConnect(PORT);
  sendJ(hostWs, { type: "host", protocolVersion: 2, name: "Host", n: 4, teams: false, seats: [
    { name: "Host", type: "human", diff: "medium" }, { name: "Sim", type: "human", diff: "medium" },
    { name: "C1", type: "cpu", diff: "medium" }, { name: "C2", type: "cpu", diff: "medium" },
  ] });
  const created = await nextMsg(hostWs, (m) => m.type === "created");
  const code = created.code;
  const simWs = await wsConnect(PORT);
  sendJ(simWs, { type: "join", protocolVersion: 2, code, name: "Sim" });
  const joined = await nextMsg(simWs, (m) => m.type === "joined");
  sendJ(simWs, { type: "claimSeat", seatIndex: 1, name: "Sim" });
  await sleep(300);
  sendJ(hostWs, { type: "start", protocolVersion: 2 });
  await nextMsg(hostWs, (m) => m.type === "readyCheck");
  sendJ(hostWs, { type: "readyUp" });
  sendJ(simWs, { type: "readyUp" });
  await nextMsg(hostWs, (m) => m.type === "gameAction" && m.action.kind === "start");
  log("room started:", code, "sim identity playerId", joined.playerId);
  simWs.close();
  await sleep(500);

  const seedUrl = `http://127.0.0.1:${HTTP_PORT}/index.html?ws=${encodeURIComponent(`ws://127.0.0.1:${PORT}`)}&testseed=${code}:${joined.playerId}:${joined.token}`;
  const plainUrl = `http://127.0.0.1:${HTTP_PORT}/index.html`;

  // --- Leg 1: seeded launch -> silent rejoin to the LIVE board, no pause. ---
  simctl(`openurl ${UD} "${seedUrl}"`);
  const t1 = await waitFor(async () => { const r = await roomInfo(code); return r && r.players.find((p) => p.id === joined.playerId)?.connected === true; }, 20000, "sim player connected after seeded launch");
  check(t1 >= 0, `${KIND}: simulator Safari silently rejoined the live room in ${t1}ms (cold-reload path)`);
  let r = await roomInfo(code);
  check(r && r.paused === false, `${KIND}: the table was NOT paused by the silent rejoin (no reunion auto-pause)`);

  // --- Leg 2: background via Settings, then return to Safari. ---
  simctl(`launch ${UD} com.apple.Preferences`);
  await sleep(15000);
  simctl(`launch ${UD} ${SAFARI}`);
  const t2 = await waitFor(async () => { const rr = await roomInfo(code); return rr && rr.players.find((p) => p.id === joined.playerId)?.connected === true; }, 15000, "sim player connected after background+return");
  check(t2 >= 0, `${KIND}: after 15s backgrounded (Settings) + return, the player is (still/again) connected in ${t2}ms`);
  r = await roomInfo(code);
  check(r && r.paused === false, `${KIND}: still never paused after background+return`);

  // --- Leg 3: terminate + cold relaunch with a PLAIN url - localStorage alone rejoins. ---
  try { simctl(`terminate ${UD} ${SAFARI}`); } catch (e) { /* already dead is fine */ }
  await sleep(2000);
  simctl(`openurl ${UD} "${plainUrl}"`);
  const t3 = await waitFor(async () => { const rr = await roomInfo(code); return rr && rr.players.find((p) => p.id === joined.playerId)?.connected === true; }, 25000, "sim player connected after terminate+cold relaunch");
  check(t3 >= 0, `${KIND}: terminate + cold relaunch (plain URL, localStorage only) silently rejoined in ${t3}ms`);
  r = await roomInfo(code);
  check(r && r.paused === false, `${KIND}: still never paused after the memory-kill-shaped relaunch`);

  // --- Leg 4: the gate - a PAUSED room must NOT be silently sat down at. ---
  sendJ(hostWs, { type: "pauseToggle", paused: true });
  await sleep(800);
  try { simctl(`terminate ${UD} ${SAFARI}`); } catch (e) { /* fine */ }
  await sleep(2000);
  simctl(`openurl ${UD} "${plainUrl}"`);
  await sleep(12000);   // give it time to rejoin-check and back out
  r = await roomInfo(code);
  const simP = r && r.players.find((p) => p.id === joined.playerId);
  check(r && r.paused === true, `${KIND}: the paused room STAYED paused through the relaunch attempt`);
  check(simP && simP.connected === false, `${KIND}: the client backed out of the paused game (no silent seat-down; the deliberate resume tile is the way in)`);

  try { simctl(`terminate ${UD} ${SAFARI}`); } catch (e) { /* fine */ }
  hostWs.close();
  staticSrv.close();
  server.kill("SIGKILL");
  log(`RESULT: ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
