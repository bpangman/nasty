// v0.15 protocol-surface re-verification checklist - runs the FULL existing protocol surface
// against a private server instance. Usage:
//   node protocol_checklist.js node     (server/server.js on private NASTY_PORT/NASTY_ROOMS_DIR)
//   node protocol_checklist.js deno     (server/cloud/server.ts on private NASTY_PORT/NASTY_KV_PATH)
// Never touches prod.
const { spawn } = require("child_process");
const WebSocket = require("/Users/jarvis/nasty-game/server/node_modules/ws");
const path = require("path");
const fs = require("fs");
const os = require("os");

const KIND = process.argv[2] || "node";
const PORT = 17200 + Math.floor(Math.random() * 700);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-proto-${KIND}-`));
const ADMIN_TOKEN = "proto-admin-token-xyz";
const BASE = `http://localhost:${PORT}`;

function log(...a) { console.log("[chk]", ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK ", label); } else { FAIL++; log("FAIL", label); } }

function startServer() {
  let child;
  if (KIND === "deno") {
    child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
      cwd: "/Users/jarvis/nasty-game/server/cloud",
      env: Object.assign({}, process.env, { NASTY_PORT: String(PORT), NASTY_KV_PATH: path.join(SCRATCH, "t.kv"), NASTY_ADMIN_TOKEN: ADMIN_TOKEN }),
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
  child.stderr.on("data", () => {});
  return child;
}
async function waitHealthy() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + "/health"); if (r.ok) return await r.json(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("server never became healthy");
}
function wsConnect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
function nextMsg(ws, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { ws.removeListener("message", onMsg); reject(new Error("timeout")); }, timeoutMs);
    function onMsg(raw) {
      const m = JSON.parse(raw.toString());
      if (!predicate || predicate(m)) { clearTimeout(to); ws.removeListener("message", onMsg); resolve(m); }
    }
    ws.on("message", onMsg);
  });
}
const sendJ = (ws, obj) => ws.send(JSON.stringify(obj));

async function main() {
  const child = startServer();
  const health = await waitHealthy();

  // ---- 0. health ----
  check(health.ok === true, "GET /health ok:true");

  // ---- 1. protocolMismatch for v1/missing-version client, on all 4 entry points ----
  for (const type of ["host", "join", "rejoin", "reclaim"]) {
    const ws = await wsConnect();
    sendJ(ws, { type, name: "X", code: "BCDF", playerId: 1, token: "t", n: 4, teams: false, seats: [] });
    const m = await nextMsg(ws, (x) => x.type === "protocolMismatch" || x.type === "created" || x.type === "joinError" || x.type === "rejoinError" || x.type === "reclaimError");
    check(m.type === "protocolMismatch" && !/[—–]/.test(m.message || ""), `protocolMismatch for versionless '${type}'`);
    ws.close();
  }
  {
    const ws = await wsConnect();
    sendJ(ws, { type: "host", protocolVersion: 1, name: "X", n: 4, teams: false, seats: [] });
    const m = await nextMsg(ws, (x) => x.type === "protocolMismatch" || x.type === "created");
    check(m.type === "protocolMismatch", "protocolMismatch for explicit protocolVersion:1 host");
    ws.close();
  }

  // ---- 2. lobby: host, join, claim, host tap-claim/rename, CPU toggle, unclaimed->CPU at start ----
  const host = await wsConnect();
  const seats = [
    { name: "HostN", type: "human", diff: "medium" },
    { name: "Open1", type: "human", diff: "medium" },   // will stay unclaimed -> becomes CPU at start
    { name: "CpuA", type: "cpu", diff: "easy" },
    { name: "CpuB", type: "cpu", diff: "hard" },
  ];
  sendJ(host, { type: "host", protocolVersion: 2, name: "HostN", n: 4, teams: false, seats });
  const created = await nextMsg(host, (m) => m.type === "created");
  check(created.code && /^[BCDFGHJKMNPQRSTVWXZ]{4}$/.test(created.code), "4-letter no-vowel room code");
  const code = created.code;

  const guest = await wsConnect();
  sendJ(guest, { type: "join", protocolVersion: 2, code, name: "GuestN" });
  const joined = await nextMsg(guest, (m) => m.type === "joined");
  check(joined.playerId != null && joined.token, "guest joined with playerId+token");

  // guest claims the CPU seat (claiming converts it to human) - v0.8 behavior carried forward
  sendJ(guest, { type: "claimSeat", seatIndex: 2, name: "GuestN" });
  const lobby1 = await nextMsg(guest, (m) => m.type === "lobby" && m.lobby.seats[2].claimedBy === joined.playerId);
  check(lobby1.lobby.seats[2].type === "human", "guest claim of a CPU seat converts it to human");

  // host tap-claims a different open seat (v0.14 behavior: host moves like a guest)
  sendJ(host, { type: "claimSeat", seatIndex: 1, name: "HostN" });
  const lobby2 = await nextMsg(host, (m) => m.type === "lobby" && m.lobby.seats[1].claimedBy === created.playerId);
  check(lobby2.lobby.seats[0].claimedBy == null, "host moved seats; old seat freed");

  // host renames own seat via setSeat
  sendJ(host, { type: "setSeat", seatIndex: 1, patch: { name: "Blake" } });
  const lobby3 = await nextMsg(host, (m) => m.type === "lobby" && m.lobby.seats[1].name === "Blake");
  check(!!lobby3, "host rename via setSeat broadcast");

  // host toggles seat 3 cpu->human->cpu
  sendJ(host, { type: "setSeat", seatIndex: 3, patch: { type: "human" } });
  await nextMsg(host, (m) => m.type === "lobby" && m.lobby.seats[3].type === "human");
  sendJ(host, { type: "setSeat", seatIndex: 3, patch: { type: "cpu" } });
  const lobby4 = await nextMsg(host, (m) => m.type === "lobby" && m.lobby.seats[3].type === "cpu");
  check(!!lobby4, "host CPU toggle round-trip");

  // start: seat 0 (open human, unclaimed) must become CPU
  sendJ(host, { type: "start", protocolVersion: 2 });
  const startMsg = await nextMsg(host, (m) => m.type === "gameAction" && m.action.kind === "start");
  check(startMsg.action.seats[0].type === "cpu", "unclaimed human seat became CPU at start");
  check(startMsg.action.seats[1].type === "human" && startMsg.action.seats[2].type === "human", "claimed seats stayed human");
  check(startMsg.action.deck.length === 0, "start action carries no real deck (server holds it)");
  check(typeof startMsg.action.tableSpeed === "number", "start action carries tableSpeed");

  // ---- 3. pause/resume online (server-arbitrated) ----
  sendJ(guest, { type: "pauseToggle", paused: true });
  const paused = await nextMsg(host, (m) => m.type === "paused" && m.paused === true);
  check(!!paused, "any player can pause; server broadcasts paused:true");
  sendJ(host, { type: "pauseToggle", paused: false });
  const unpaused = await nextMsg(guest, (m) => m.type === "paused" && m.paused === false);
  check(!!unpaused, "resume broadcast to everyone");

  // ---- 4. presence + nudge ----
  const presenceP = nextMsg(host, (m) => m.type === "presence" && m.playerId === joined.playerId && m.connected === false, 8000);
  guest.close();
  const pres = await presenceP;
  check(!!pres, "presence broadcast on guest disconnect");

  // reconnect guest with token (rejoin) -> snapshot sync
  const guest2 = await wsConnect();
  sendJ(guest2, { type: "rejoin", protocolVersion: 2, code, playerId: joined.playerId, token: joined.token });
  const sync = await nextMsg(guest2, (m) => m.type === "sync");
  check(!!sync.G && typeof sync.appliedSeq === "number" && sync.log === undefined, "token rejoin -> snapshot sync, no log replay");
  check(sync.presence && typeof sync.presence === "object", "sync carries presence map");

  // nudge: guest2 nudges the host (any seated player may nudge)
  const nudgedP = nextMsg(host, (m) => m.type === "nudged", 5000);
  sendJ(guest2, { type: "nudge", targetPlayerId: created.playerId });
  const nudged = await nudgedP;
  check(nudged.fromName === "GuestN", "nudge relayed with sender name");

  // ---- 5. token-less reclaim: uncontested ----
  guest2.close();
  await new Promise((r) => setTimeout(r, 600)); // let the disconnect land
  const rec1 = await wsConnect();
  sendJ(rec1, { type: "reclaim", protocolVersion: 2, code, name: "GuestN" });
  const reclaimed = await nextMsg(rec1, (m) => m.type === "reclaimed");
  check(reclaimed.playerId === joined.playerId && reclaimed.token && reclaimed.token !== joined.token, "uncontested reclaim: same playerId, FRESH token");
  check(!!reclaimed.G, "reclaimed carries a G snapshot");

  // wrong name rejected
  const recBad = await wsConnect();
  sendJ(recBad, { type: "reclaim", protocolVersion: 2, code, name: "NoSuch" });
  const recErr = await nextMsg(recBad, (m) => m.type === "reclaimError");
  check(!!recErr, "reclaim with unknown name rejected");
  recBad.close();

  // ---- 6. contested reclaim: host approve, then deny ----
  const rec2 = await wsConnect();
  const reqP = nextMsg(host, (m) => m.type === "reclaimRequest", 8000);
  sendJ(rec2, { type: "reclaim", protocolVersion: 2, code, name: "GuestN" }); // rec1 still connected -> contested
  const pendingMsg = await nextMsg(rec2, (m) => m.type === "reclaimPending");
  check(!!pendingMsg, "contested reclaim parks pending");
  const req = await reqP;
  check(req.name === "GuestN" && req.reqId, "host got reclaimRequest");
  const kickedP = nextMsg(rec1, (m) => m.type === "kicked", 8000);
  const approvedP = nextMsg(rec2, (m) => m.type === "reclaimed", 8000);
  sendJ(host, { type: "reclaimApprove", reqId: req.reqId, approve: true });
  const approved = await approvedP;
  check(approved.playerId === joined.playerId, "approved contested reclaim hands over the seat");
  const kicked = await kickedP;
  check(!!kicked, "previous holder got kicked");
  try { rec1.close(); } catch (e) {}
  // now a DENIED contested attempt against rec2 (currently connected)
  const rec3 = await wsConnect();
  const reqP2 = nextMsg(host, (m) => m.type === "reclaimRequest", 8000);
  sendJ(rec3, { type: "reclaim", protocolVersion: 2, code, name: "GuestN" });
  await nextMsg(rec3, (m) => m.type === "reclaimPending");
  const req2 = await reqP2;
  const deniedP = nextMsg(rec3, (m) => m.type === "reclaimError", 8000);
  sendJ(host, { type: "reclaimApprove", reqId: req2.reqId, approve: false });
  const denied = await deniedP;
  check(!!denied, "denied contested reclaim rejected cleanly");
  rec3.close();

  // ---- 7. HTTP: leaderboard, solo-result + epoch, CORS, AASA, /join redirect ----
  {
    const r = await fetch(BASE + "/leaderboard");
    check(r.ok && r.headers.get("x-leaderboard-epoch") != null, "GET /leaderboard + epoch header");
    check(r.headers.get("access-control-allow-origin") === "*", "CORS header on /leaderboard");
  }
  {
    const gid = "proto-test-" + Date.now();
    const r1 = await fetch(BASE + "/solo-result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gameId: gid, entries: [{ name: "ProtoTest", delta: { hg4s: 1, hw4s: 1, hpts: 5 } }] }) });
    const j1 = await r1.json();
    check(r1.ok && j1.ok === true, "POST /solo-result records");
    const r2 = await fetch(BASE + "/solo-result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gameId: gid, entries: [{ name: "ProtoTest", delta: { hg4s: 1 } }] }) });
    const j2 = await r2.json();
    check(j2.duplicate === true, "duplicate gameId is an idempotent no-op");
    const lb = await (await fetch(BASE + "/leaderboard")).json();
    check(lb.ProtoTest && lb.ProtoTest.hg4s === 1 && lb.ProtoTest.hpts === 5, "leaderboard shows the solo result exactly once");
    const r3 = await fetch(BASE + "/solo-result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gameId: "stale-" + Date.now(), epoch: 0, entries: [{ name: "Stale", delta: { hg4s: 1 } }] }) });
    check(r3.status === 409, "stale-epoch solo result rejected 409");
  }
  {
    const r = await fetch(BASE + "/.well-known/apple-app-site-association");
    const body = await r.json();
    check(r.headers.get("content-type").includes("application/json") && body.applinks.details[0].appID === "YJU5U6VX8V.com.pangman.nasty", "AASA served as application/json with the right appID");
  }
  {
    const r = await fetch(BASE + "/join/BCDF");
    const html = await r.text();
    check(r.ok && html.includes("nastyboardgame.com/?join=BCDF"), "/join/:CODE redirect page targets the website join flow");
  }
  {
    const r = await fetch(BASE + "/admin/rooms", { method: "OPTIONS" });
    check(r.status === 204 && (r.headers.get("access-control-allow-methods") || "").includes("PATCH"), "OPTIONS preflight 204 with methods");
  }

  // ---- 8. admin god-mode ----
  {
    const bad = await fetch(BASE + "/admin/rooms", { headers: { "x-admin-token": "wrong" } });
    check(bad.status === 401, "admin: wrong token rejected 401");
    const rooms = await (await fetch(BASE + "/admin/rooms", { headers: { "x-admin-token": ADMIN_TOKEN } })).json();
    check(Array.isArray(rooms) && rooms.some((r) => r.code === code), "admin: rooms list shows the live room");
    const ren = await fetch(BASE + `/admin/rooms/${code}/rename`, { method: "POST", headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ playerId: joined.playerId, name: "Renamed" }) });
    check(ren.ok, "admin: player rename");
    const patch = await fetch(BASE + "/admin/leaderboard/ProtoTest", { method: "PATCH", headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ hpts: 42 }) });
    const pj = await patch.json();
    check(patch.ok && pj.hpts === 42, "admin: leaderboard PATCH sets absolute value");
    const del = await fetch(BASE + "/admin/leaderboard/ProtoTest", { method: "DELETE", headers: { "x-admin-token": ADMIN_TOKEN } });
    check(del.ok, "admin: leaderboard DELETE");
    const lb2 = await (await fetch(BASE + "/leaderboard")).json();
    check(!lb2.ProtoTest, "leaderboard entry gone after DELETE");
    const delRoom = await fetch(BASE + `/admin/rooms/${code}`, { method: "DELETE", headers: { "x-admin-token": ADMIN_TOKEN } });
    check(delRoom.ok, "admin: room DELETE");
    const rooms2 = await (await fetch(BASE + "/admin/rooms", { headers: { "x-admin-token": ADMIN_TOKEN } })).json();
    check(!rooms2.some((r) => r.code === code), "room gone from list after DELETE");
  }

  // ---- 9. host-create rate limit (5/min/IP) ----
  {
    let limited = false;
    for (let i = 0; i < 7; i++) {
      const ws = await wsConnect();
      sendJ(ws, { type: "host", protocolVersion: 2, name: "R" + i, n: 4, teams: false, seats: [{ name: "R" + i, type: "human", diff: "medium" }] });
      const m = await nextMsg(ws, (x) => x.type === "created" || x.type === "error");
      if (m.type === "error" && /Too many rooms/.test(m.message)) limited = true;
      ws.close();
    }
    check(limited, "host-create rate limit kicks in within 7 rapid creates");
  }

  try { host.close(); } catch (e) {}
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 400));
  console.log(`\n[${KIND}] ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
