// v0.15 raw-WebSocket smoke test against the DENO authoritative server (server/cloud/server.ts).
// Same checks as smoke_server.js (Node), same private-instance rules (NASTY_PORT + NASTY_KV_PATH
// scratch file, never prod/default KV).
const { spawn } = require("child_process");
const WebSocket = require("/Users/jarvis/nasty-game/server/node_modules/ws");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PORT = 18200 + Math.floor(Math.random() * 400);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "nasty-deno-test-"));
const KV_PATH = path.join(SCRATCH, "test.kv");

function log(...a) { console.log("[test]", ...a); }

function startServer() {
  const child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
    cwd: "/Users/jarvis/nasty-game/server/cloud",
    env: Object.assign({}, process.env, {
      NASTY_PORT: String(PORT), NASTY_KV_PATH: KV_PATH, NASTY_ADMIN_TOKEN: "test-admin-token-123",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write("[deno] " + d));
  child.stderr.on("data", (d) => process.stderr.write("[deno-err] " + d));
  return child;
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
    const to = setTimeout(() => { ws.removeListener("message", onMsg); reject(new Error("timeout waiting for message")); }, timeoutMs);
    function onMsg(raw) {
      const m = JSON.parse(raw.toString());
      if (!predicate || predicate(m)) { clearTimeout(to); ws.removeListener("message", onMsg); resolve(m); }
    }
    ws.on("message", onMsg);
  });
}
function collectAll(ws, onEach) { ws.on("message", (raw) => { onEach(JSON.parse(raw.toString())); }); }

async function main() {
  let pass = 0, fail = 0;
  const assert = (cond, label) => { if (cond) { pass++; log("OK", label); } else { fail++; log("FAIL", label); } };
  const child = startServer();
  // deno cold start is slower than node
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/health`); if (r.ok) break; } catch (e) {}
    await new Promise((r) => setTimeout(r, 500));
  }

  // ---- 1: protocol version rejection ----
  {
    const ws = await wsConnect();
    ws.send(JSON.stringify({ type: "host", name: "Old", n: 4, teams: false, seats: [] }));
    const m = await nextMsg(ws, (x) => x.type === "protocolMismatch" || x.type === "created");
    assert(m.type === "protocolMismatch" && typeof m.message === "string" && !/[—–]/.test(m.message), "old/missing protocolVersion rejected, plain-language dash-free message");
    ws.close();
  }

  // ---- 2: all-CPU game, server drives everything unattended ----
  {
    const host = await wsConnect();
    const seats = [0,1,2,3].map(i => ({ name: "P"+i, type: "cpu", diff: "medium" }));
    host.send(JSON.stringify({ type: "host", protocolVersion: 2, name: "Host", n: 4, teams: false, seats }));
    const created = await nextMsg(host, (m) => m.type === "created");
    assert(created.code && created.code.length === 4, "room created with a 4-letter code");
    let actionCount = 0, sawDeal = false, sawMove = false, sawPass = false, sawCheck = 0;
    collectAll(host, (m) => {
      if (m.type === "gameAction") { actionCount++; if (m.action.kind==="deal") sawDeal=true; if (m.action.kind==="move") sawMove=true; if (m.action.kind==="pass") sawPass=true; }
      if (m.type === "stateCheck") sawCheck++;
    });
    host.send(JSON.stringify({ type: "start", protocolVersion: 2 }));
    await new Promise((r) => setTimeout(r, 6000));
    log("actions:", actionCount, "deal:", sawDeal, "move:", sawMove, "pass:", sawPass, "stateChecks:", sawCheck);
    assert(actionCount > 5, "server produced a real action stream unattended (all-CPU)");
    assert(sawDeal && sawMove, "stream includes deal + move actions");
    assert(sawCheck > 0, "server-originated stateCheck digests broadcast");
    host.close();
  }

  // ---- 3: human seat, illegal-move rejection + resync, table speed ----
  {
    const host = await wsConnect();
    const guest = await wsConnect();
    const seats = [{name:"H",type:"human",diff:"medium"},{name:"G1",type:"human",diff:"medium"},{name:"C2",type:"cpu",diff:"easy"},{name:"C3",type:"cpu",diff:"easy"}];
    host.send(JSON.stringify({ type: "host", protocolVersion: 2, name: "H", n: 4, teams: false, seats }));
    const created = await nextMsg(host, (m) => m.type === "created");
    guest.send(JSON.stringify({ type: "join", protocolVersion: 2, code: created.code, name: "G1" }));
    const joined = await nextMsg(guest, (m) => m.type === "joined");
    guest.send(JSON.stringify({ type: "claimSeat", seatIndex: 1, name: "G1" }));
    await new Promise((r) => setTimeout(r, 400));
    // v0.16 item 4: both seats are human here (host + guest) - both must ready up before the
    // ready-check gate clears and the server actually deals.
    host.send(JSON.stringify({ type: "start", protocolVersion: 2 }));
    await nextMsg(host, (m) => m.type === "readyCheck");
    host.send(JSON.stringify({ type: "readyUp" }));
    guest.send(JSON.stringify({ type: "readyUp" }));
    await nextMsg(host, (m) => m.type === "gameAction" && m.action.kind === "start");
    // illegal move from host seat
    host.send(JSON.stringify({ type: "action", action: { kind: "move", seat: 0, m: { ci: 999, type: "move", owner: 0, pi: 0, to: 999, kick: null } } }));
    const rej = await nextMsg(host, (m) => m.type === "sync", 8000);
    assert(rej.G && typeof rej.appliedSeq === "number" && typeof rej.tableSpeed === "number", "illegal move -> snapshot sync (G + appliedSeq + tableSpeed) sent, room not crashed");
    host.send(JSON.stringify({ type: "ping", t: 1 }));
    const pong = await nextMsg(host, (m) => m.type === "pong" && m.t === 1);
    assert(pong.type === "pong", "server still responsive after rejection");
    // guest cannot set table speed
    let guestSaw = null;
    collectAll(guest, (m) => { if (m.type === "tableSpeed") guestSaw = m.speed; });
    guest.send(JSON.stringify({ type: "setTableSpeed", speed: 99 }));
    await new Promise((r) => setTimeout(r, 400));
    assert(guestSaw === null, "guest's setTableSpeed silently ignored");
    host.send(JSON.stringify({ type: "setTableSpeed", speed: 2.6 }));
    await new Promise((r) => setTimeout(r, 500));
    assert(guestSaw === 2.6, "host's setTableSpeed broadcast to guest");
    // rejoin returns a snapshot (no log array)
    const g2 = await wsConnect();
    g2.send(JSON.stringify({ type: "rejoin", protocolVersion: 2, code: created.code, playerId: joined.playerId, token: joined.token }));
    const sync = await nextMsg(g2, (m) => m.type === "sync");
    assert(sync.G && sync.log === undefined && typeof sync.appliedSeq === "number", "rejoin returns snapshot-based sync (G + appliedSeq, no log replay)");
    host.close(); guest.close(); g2.close();
  }

  // ---- 4: G serialized size check (6P worst case) ----
  {
    const { createEngine } = require("/Users/jarvis/nasty-game/server/engine.js");
    const E = createEngine();
    E.setLAY(E.buildLayout(6));
    E.newGame({ n: 6, teams: true, seats: [0,1,2,3,4,5].map(i=>({name:"Player"+i,type:"cpu",diff:"hard"})) }, { deck: E.freshDeck(), dealer: 0 });
    E.dealDecision({});
    const size = Buffer.byteLength(JSON.stringify(E.getG()), "utf8");
    log("6P serialized G size:", size, "bytes");
    assert(size < 64 * 1024 * 0.5, "6P G snapshot comfortably under half of KV's 64KiB per-value limit");
  }

  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 400));
  log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
