"use strict";
/*
 * Paused-room seat gate - real WebKit in the real iOS Simulator, driven with simctl.
 * (Was server/tests/sim_lifecycle.js. Renamed and cut down on 2026-07-25 - see "History" below.)
 *
 * Usage:
 *   node sim_paused_room_gate.js node     (server/server.js)
 *   node sim_paused_room_gate.js deno     (server/cloud/server.ts)
 * SKIPS cleanly (exit 0, "SKIP" lines) when no iOS Simulator is available on this machine.
 *
 * WHAT THIS PROVES (the one thing, and it is still worth proving):
 *   A phone that holds a perfectly valid stored session for a room that is currently PAUSED
 *   must NOT silently sit down at that table when it is cold-launched. The room has to stay
 *   paused and untouched, and the returning player has to stay disconnected until a human
 *   deliberately taps the resume tile.
 *
 *   Why it matters: the family pauses a game and walks away. Somebody's phone wakes up, or
 *   gets relaunched by iOS, and quietly rejoins. From the table's point of view a player just
 *   appeared out of nowhere in a game nobody meant to restart. That is the failure this suite
 *   exists to catch, and only a real iOS WebKit run can catch it, because it depends on how
 *   mobile Safari restores a cold page.
 *
 *   To make sure a PASS is meaningful and not just "the token was junk", the run finishes with
 *   a control step: a raw websocket client rejoins with the exact same credentials the phone
 *   was holding. If that control succeeds, then the phone staying out was a deliberate client
 *   decision, not a broken session.
 *
 * HISTORY - why the other three legs are gone (read before "restoring" them):
 *   Through v0.24 this file was sim_lifecycle.js and had four legs. Legs 1-3 asserted that a
 *   cold app launch SILENTLY auto-rejoined a live room (seeded launch, background-and-return,
 *   and terminate-then-relaunch). That behavior was DELIBERATELY REMOVED in v0.25: every
 *   rejoin is now an intentional tile tap, because silent auto-rejoin is exactly the thing
 *   Blake asked to get rid of. Legs 1-3 were therefore asserting behavior the product no
 *   longer has, and an agent told to "make the tests green" would have re-introduced it.
 *   They were deleted on 2026-07-25 rather than left failing or skipped. Do not write them
 *   back. If you need coverage of the network-layer freeze/resume semantics, that lives in
 *   test_freeze_recovery.js (Layer 1); the deliberate-tile-tap rejoin flows live in
 *   test_v025_ui_flows.js and test_reconnect_retry.js.
 *
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
    // Echo the server's app-level pings like a real client does - the Deno server force-closes
    // any socket that stays app-level silent past its staleness window (§ HEARTBEAT), which
    // would otherwise kill this harness's long-lived host connection halfway through the test.
    ws.on("message", (raw) => {
      try { const m = JSON.parse(raw.toString()); if (m.type === "ping") ws.send(JSON.stringify({ type: "pong", t: m.t })); } catch (e) { /* ignore */ }
    });
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
  // seats. Then the Sim identity's raw socket closes - the PHONE holds that identity via the
  // ?testseed= boot hook.
  const hostWs = await wsConnect(PORT);
  sendJ(hostWs, { type: "host", protocolVersion: 5, name: "Host", n: 4, teams: false, seats: [
    { name: "Host", type: "human", diff: "medium" }, { name: "Sim", type: "human", diff: "medium" },
    { name: "C1", type: "cpu", diff: "medium" }, { name: "C2", type: "cpu", diff: "medium" },
  ] });
  const created = await nextMsg(hostWs, (m) => m.type === "created");
  const code = created.code;
  const simWs = await wsConnect(PORT);
  sendJ(simWs, { type: "join", protocolVersion: 5, code, name: "Sim" });
  const joined = await nextMsg(simWs, (m) => m.type === "joined");
  sendJ(simWs, { type: "claimSeat", seatIndex: 1, name: "Sim" });
  await sleep(300);
  // v0.25 item 1: readiness lives in the lobby now - the guest (Sim) readies up on the seat
  // screen BEFORE the host's Start, which is the host's own ready and deals directly.
  sendJ(simWs, { type: "readyUp", willSeat: true });
  await sleep(300);
  sendJ(hostWs, { type: "start", protocolVersion: 5, willSeat: true });
  await nextMsg(hostWs, (m) => m.type === "gameAction" && m.action.kind === "start");
  log("room started:", code, "sim identity playerId", joined.playerId);
  simWs.close();
  await sleep(500);

  const seedUrl = `http://127.0.0.1:${HTTP_PORT}/index.html?ws=${encodeURIComponent(`ws://127.0.0.1:${PORT}`)}&testseed=${code}:${joined.playerId}:${joined.token}`;
  const plainUrl = `http://127.0.0.1:${HTTP_PORT}/index.html`;

  // --- Setup (NOT an assertion): put a genuine stored session on the phone. -------------
  // The ?testseed= hook only writes localStorage ('nasty-net-<CODE>' + 'nasty-last-room') and
  // then falls through to the normal boot. Since v0.25 that boot does NOT auto-rejoin, so all
  // this step does is leave the phone holding real credentials for a real live room - exactly
  // the state a family member's phone is in after they pause and put it in their pocket.
  simctl(`openurl ${UD} "${seedUrl}"`);
  await sleep(8000);
  log("phone seeded with a valid stored session for room", code);

  // --- THE GATE: pause the room, then cold-relaunch the phone. ---------------------------
  sendJ(hostWs, { type: "pauseToggle", paused: true });
  const pausedLanded = await waitFor(async () => { const rr = await roomInfo(code); return rr && rr.paused === true; }, 8000, "pause request landed");
  check(pausedLanded >= 0, `${KIND}: precondition - the harness's pause actually landed server-side`);

  try { simctl(`terminate ${UD} ${SAFARI}`); } catch (e) { /* already dead is fine */ }
  await sleep(2000);
  simctl(`openurl ${UD} "${plainUrl}"`);   // plain URL, no params - localStorage alone
  await sleep(12000);                      // ample time to boot, check, and back out

  let r = await roomInfo(code);
  const simP = r && r.players.find((p) => p.id === joined.playerId);
  check(r && r.paused === true, `${KIND}: the paused room STAYED paused through the cold relaunch`);
  check(!simP || simP.connected === false, `${KIND}: the phone did NOT silently sit down at the paused table (the deliberate resume tile is the only way in)`);

  // --- Control: prove the session the phone was holding was actually usable. --------------
  // Without this, "the phone stayed out" could just mean the credentials were junk. A raw ws
  // client rejoining with the SAME playerId/token proves the gate above was a deliberate
  // client-side decision, not a broken token.
  let controlOk = false;
  try {
    const ctlWs = await wsConnect(PORT);
    sendJ(ctlWs, { type: "rejoin", protocolVersion: 5, code, playerId: joined.playerId, token: joined.token });
    // A successful token rejoin is answered with a snapshot `sync` (see server.js's
    // `case "rejoin"`), NOT a "rejoined"/"joined" message - those do not exist on this wire.
    const res = await nextMsg(ctlWs,
      (m) => m.type === "sync" || m.type === "rejoinError" || m.type === "kicked" || m.type === "protocolMismatch",
      8000).catch(() => null);
    controlOk = !!(res && res.type === "sync");
    if (!controlOk) log("control rejoin got:", res ? res.type : "(nothing within 8s)");
    ctlWs.close();
  } catch (e) { /* controlOk stays false */ }
  check(controlOk, `${KIND}: control - the very same stored credentials DO still work over a raw socket, so the phone's abstention was deliberate`);

  try { simctl(`terminate ${UD} ${SAFARI}`); } catch (e) { /* fine */ }
  hostWs.close();
  staticSrv.close();
  server.kill("SIGKILL");
  log(`RESULT: ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
