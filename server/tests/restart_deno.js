// v0.15 Deno server restart test: kill the deno process mid-game, restart on the SAME KV path,
// confirm a client reconnects and the game continues from the KV snapshot (the KV-restore
// path's only real proof).
const { spawn } = require("child_process");
const WebSocket = require("/Users/jarvis/nasty-game/server/node_modules/ws");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PORT = 18650 + Math.floor(Math.random() * 300);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "nasty-deno-restart-"));
const KV_PATH = path.join(SCRATCH, "test.kv");
function log(...a) { console.log("[test]", ...a); }

function startServer() {
  const child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
    cwd: "/Users/jarvis/nasty-game/server/cloud",
    env: Object.assign({}, process.env, { NASTY_PORT: String(PORT), NASTY_KV_PATH: KV_PATH, NASTY_ADMIN_TOKEN: "t123" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => { const s = String(d); if (s.includes("Listening")) log("(server listening)"); });
  return child;
}
async function waitHealthy() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/health`); if (r.ok) return; } catch (e) {}
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
function nextMsg(ws, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { ws.removeListener("message", onMsg); reject(new Error("timeout")); }, timeoutMs);
    function onMsg(raw) {
      const m = JSON.parse(raw.toString());
      if (!predicate || predicate(m)) { clearTimeout(to); ws.removeListener("message", onMsg); resolve(m); }
    }
    ws.on("message", onMsg);
  });
}

async function main() {
  let pass = 0, fail = 0;
  const assert = (cond, label) => { if (cond) { pass++; log("OK", label); } else { fail++; log("FAIL", label); } };

  let child = startServer();
  await waitHealthy();

  // Host a game: 1 human (this client) + 3 CPU. Play a couple of validated human moves so the
  // game has real progress in KV before the kill.
  const host = await wsConnect();
  const seats = [{name:"H",type:"human",diff:"medium"},{name:"C1",type:"cpu",diff:"easy"},{name:"C2",type:"cpu",diff:"easy"},{name:"C3",type:"cpu",diff:"easy"}];
  host.send(JSON.stringify({ type: "host", protocolVersion: 5, name: "H", n: 4, teams: false, seats }));
  const created = await nextMsg(host, (m) => m.type === "created");
  const code = created.code, playerId = created.playerId, token = created.token;
  // Track latest known G via applying nothing - just watch the actions and record last seq seen.
  let lastSeq = -1, lastTurnFromAction = null, moveCount = 0;
  host.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "gameAction") { lastSeq = m.seq; if (typeof m.action.turn === "number") lastTurnFromAction = m.action.turn; if (m.action.kind === "move") moveCount++; }
  });
  // v0.25 item 1: readiness lives in the lobby now, not a post-Start readyCheck gate. This
  // seat is the host and the ONLY human at the table (3 CPU seats) - a host with no guests
  // starts directly and deals immediately.
  host.send(JSON.stringify({ type: "start", protocolVersion: 5 }));
  await nextMsg(host, (m) => m.type === "gameAction" && m.action.kind === "start");
  await new Promise((r) => setTimeout(r, 2500));
  assert(lastSeq > 0, `game progressed before the kill (lastSeq=${lastSeq}, moves=${moveCount})`);
  const seqBeforeKill = lastSeq;

  // KILL the server mid-game (SIGKILL - the harshest case; nothing gets to flush).
  log("killing deno server (SIGKILL) at seq", seqBeforeKill);
  child.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 800));
  try { host.close(); } catch (e) {}

  // Restart on the SAME KV path.
  child = startServer();
  await waitHealthy();
  log("server restarted on same KV path");

  // Reconnect with the saved token -> expect a snapshot sync restored from KV.
  const re = await wsConnect();
  re.send(JSON.stringify({ type: "rejoin", protocolVersion: 5, code, playerId, token }));
  const sync = await nextMsg(re, (m) => m.type === "sync");
  assert(!!sync.G, "rejoin after restart returned a G snapshot restored from KV");
  const G = sync.G;
  assert(typeof sync.appliedSeq === "number" && sync.appliedSeq <= seqBeforeKill + 2, `appliedSeq sane after restore (${sync.appliedSeq} vs pre-kill ${seqBeforeKill})`);
  log("restored G: turn=", G.turn, "dealSeq=", G.dealSeq, "actionSeq=", G.actionSeq);

  // The game must CONTINUE: it's the human's turn (or will be); submit a legal move computed
  // from the restored snapshot using the same engine code.
  const { createEngine } = require("/Users/jarvis/nasty-game/server/engine.js");
  const E = createEngine();
  E.setLAY(E.buildLayout(G.n));
  E.setG(G);
  let continued = false;
  let localG = G;
  re.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "gameAction") continued = true;
  });
  // Drive human moves whenever it's our turn, for up to 20s, and confirm actions flow.
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && !continued) {
    if (localG.turn === 0 && !localG.over) {
      const moves = E.legalMoves(0);
      if (moves.length) {
        re.send(JSON.stringify({ type: "action", action: { kind: "move", seat: 0, m: moves[0] } }));
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  assert(continued, "game continued after restart (new actions broadcast from the restored state)");

  re.close();
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
