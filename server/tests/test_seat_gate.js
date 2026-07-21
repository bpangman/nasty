"use strict";
/*
 * v0.22 P0b seat-gate suite - the regression test for Blake's "we only had four cards in our
 * initial deal" report: the server used to deal hand 1 the instant the host started, while
 * the humans were still reading the pre-game popups - their turns arrived with no legal move,
 * they were auto-bowed-out, the CPUs played the whole hand and hand 2 was dealt before anyone
 * looked at the board. The fix holds the FIRST deal until every player who promised a
 * {type:'seated'} signal (a guest's readyUp / the host's start with willSeat:true) has sent it, with a
 * server-side cap and early release on disconnect; old clients never promise and get the
 * exact pre-v0.22 behavior. Usage:
 *   node test_seat_gate.js node     (server/server.js)
 *   node test_seat_gate.js deno     (server/cloud/server.ts)
 * The spawned server runs with NASTY_SEAT_GATE_CAP_MS=8000 so the cap scenario is fast.
 * Raw ws clients only - never Playwright, never production.
 */
const WebSocket = require("/Users/jarvis/nasty-game/server/node_modules/ws");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const KIND = process.argv[2] || "node";
const USE_DENO = KIND === "deno";
const PORT = 24200 + Math.floor(Math.random() * 700);
const CAP_MS = 8000;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-gate-${KIND}-`));

function log(...a) { console.log("[gate]", new Date().toISOString(), ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port) {
  const extra = { NASTY_SEAT_GATE_CAP_MS: String(CAP_MS) };
  let child;
  if (USE_DENO) {
    child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
      cwd: "/Users/jarvis/nasty-game/server/cloud",
      env: Object.assign({}, process.env, extra, { NASTY_PORT: String(port), NASTY_KV_PATH: path.join(SCRATCH, "gate.kv"), NASTY_ADMIN_TOKEN: "gate-admin-token" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    child = spawn(process.execPath, ["server.js"], {
      cwd: "/Users/jarvis/nasty-game/server",
      env: Object.assign({}, process.env, extra, {
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

// One tracked client: records every message with a timestamp, exposes helpers.
let xffCounter = 1;
function connect(port, xff) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`, { headers: { "x-forwarded-for": xff } });
    ws.msgs = [];
    ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); ws.msgs.push({ t: Date.now(), m }); });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
const sendJ = (ws, obj) => ws.send(JSON.stringify(obj));
function waitMsg(ws, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const seen = ws.msgs.find((e) => predicate(e.m));
    if (seen) { resolve(seen); return; }
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = ws.msgs.find((e) => predicate(e.m));
      if (hit) { clearInterval(iv); resolve(hit); return; }
      if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error("timeout waiting for message")); }
    }, 50);
  });
}
const isDeal = (m) => m.type === "gameAction" && m.action && m.action.kind === "deal";
const isPass = (m) => m.type === "gameAction" && m.action && m.action.kind === "pass";
const isStart = (m) => m.type === "gameAction" && m.action && m.action.kind === "start";

/* Builds a 4-human room, readies everyone up (per-player willSeat flags), and returns
 * {clients:[host,g1,g2,g3], startAt} the moment the start action lands everywhere. */
async function buildRoom(port, willSeatFlags) {
  const xff = `10.99.${xffCounter++}.1`;   // per-room source IP - keeps the host-create rate limit honest without ever tripping it
  const host = await connect(port, xff);
  sendJ(host, { type: "host", protocolVersion: 5, name: "P0", n: 4, teams: true, seats: [
    { name: "P0", type: "human", diff: "medium" }, { name: "P1", type: "human", diff: "medium" },
    { name: "P2", type: "human", diff: "medium" }, { name: "P3", type: "human", diff: "medium" },
  ] });
  const created = (await waitMsg(host, (m) => m.type === "created")).m;
  const code = created.code;
  const clients = [host];
  for (let i = 1; i <= 3; i++) {
    const c = await connect(port, xff);
    sendJ(c, { type: "join", protocolVersion: 5, code, name: "P" + i });
    await waitMsg(c, (m) => m.type === "joined");
    sendJ(c, { type: "claimSeat", seatIndex: i, name: "P" + i });
    clients.push(c);
  }
  await sleep(300);
  // v0.25 item 1: readiness is LOBBY state now - each GUEST readies up on the seat screen
  // (their willSeat promise rides that message); the HOST's Start carries their own willSeat.
  clients.forEach((c, i) => { if (i > 0) sendJ(c, willSeatFlags[i] ? { type: "readyUp", willSeat: true } : { type: "readyUp" }); });
  await sleep(300);
  sendJ(host, willSeatFlags[0] ? { type: "start", protocolVersion: 5, willSeat: true } : { type: "start", protocolVersion: 5 });
  await Promise.all(clients.map((c) => waitMsg(c, isStart)));
  return { clients, code, startAt: Date.now() };
}
function firstDealDelayMs(ws, startAt) {
  const e = ws.msgs.find((x) => isDeal(x.m));
  return e ? e.t - startAt : -1;
}
function closeAll(clients) { for (const c of clients) { try { c.close(); } catch (e) {} } }

async function main() {
  const server = startServer(PORT);
  await waitHealthy(PORT);

  // --- Scenario 1: all four promise seated; two are slow (readers). The deal must WAIT. ---
  log("--- scenario 1: gate holds for slow readers, nobody bowed out, hand 1 is 5 cards ---");
  {
    const { clients, startAt } = await buildRoom(PORT, [true, true, true, true]);
    sendJ(clients[0], { type: "seated" });
    sendJ(clients[1], { type: "seated" });
    await sleep(4000);   // the two "readers" are still on the popup
    const dealEarly = clients.some((c) => c.msgs.some((e) => isDeal(e.m)));
    check(!dealEarly, `${KIND}: 4s after start, with two players still reading, the first deal has NOT happened`);
    const passEarly = clients.some((c) => c.msgs.some((e) => isPass(e.m)));
    check(!passEarly, `${KIND}: nobody was bowed out / auto-passed during the wait`);
    const lastSeatedAt = Date.now();
    sendJ(clients[2], { type: "seated" });
    sendJ(clients[3], { type: "seated" });
    await Promise.all(clients.map((c) => waitMsg(c, isDeal, 8000)));
    const dealDelays = clients.map((c) => firstDealDelayMs(c, lastSeatedAt));
    check(dealDelays.every((d) => d >= 0 && d < 3000), `${KIND}: the deal landed promptly once the LAST reader sat down (${dealDelays.map((d) => d + "ms").join(", ")} after last seated)`);
    const dealActions = clients.map((c) => c.msgs.find((e) => isDeal(e.m)).m.action);
    check(dealActions.every((a) => a.k === 5), `${KIND}: hand 1 is the rules-correct 5-card deal on every client (k=${dealActions[0].k})`);
    check(dealActions.every((a) => [0, 1, 2, 3].every((s) => (a.hands[s] || a.hands[String(s)] || []).length === 5)),
      `${KIND}: every seat received exactly 5 real cards in hand 1`);
    // And nobody was bowed out by the time the deal landed either.
    const passBeforeDeal = clients.some((c) => {
      const dealT = c.msgs.find((e) => isDeal(e.m)).t;
      return c.msgs.some((e) => isPass(e.m) && e.t < dealT);
    });
    check(!passBeforeDeal, `${KIND}: zero pass/bow-out actions anywhere before the first deal`);
    closeAll(clients);
  }

  // --- Scenario 2: old clients (no willSeat anywhere) - immediate deal, pre-v0.22 behavior. ---
  log("--- scenario 2: an all-old-client table deals immediately ---");
  {
    const { clients, startAt } = await buildRoom(PORT, [false, false, false, false]);
    await Promise.all(clients.map((c) => waitMsg(c, isDeal, 5000)));
    // The deal can land in the same broadcast burst as (or even before) this client's copy of
    // the start action - "immediate" here just means well under a second either side of it.
    const d = firstDealDelayMs(clients[0], startAt);
    check(d < 2500, `${KIND}: with no willSeat promises the first deal came immediately (${d}ms relative to start landing)`);
    closeAll(clients);
  }

  // --- Scenario 3: one promised client never sends seated - the cap fires, table starts anyway. ---
  log("--- scenario 3: the cap - a broken client can never hold the table hostage ---");
  {
    const { clients, startAt } = await buildRoom(PORT, [true, true, true, true]);
    sendJ(clients[0], { type: "seated" });
    sendJ(clients[1], { type: "seated" });
    sendJ(clients[2], { type: "seated" });
    // clients[3] never sends seated and never disconnects (the pathological case)
    await sleep(CAP_MS - 2500);
    const dealEarly = clients[0].msgs.some((e) => isDeal(e.m));
    check(!dealEarly, `${KIND}: before the cap the deal was still held`);
    await Promise.all(clients.map((c) => waitMsg(c, isDeal, CAP_MS)));
    const d = firstDealDelayMs(clients[0], startAt);
    check(d >= CAP_MS - 1500 && d < CAP_MS + 4000, `${KIND}: the deal fired at the ~${CAP_MS}ms cap despite the silent client (${d}ms after start)`);
    closeAll(clients);
  }

  // --- Scenario 4: a promised client DISCONNECTS instead - released early, no cap wait. ---
  log("--- scenario 4: disconnect releases the slot early ---");
  {
    const { clients, startAt } = await buildRoom(PORT, [true, true, true, true]);
    sendJ(clients[0], { type: "seated" });
    sendJ(clients[1], { type: "seated" });
    sendJ(clients[2], { type: "seated" });
    await sleep(500);
    clients[3].close();   // phone died mid-popup
    await Promise.all(clients.slice(0, 3).map((c) => waitMsg(c, isDeal, 6000)));
    const d = firstDealDelayMs(clients[0], startAt);
    check(d >= 0 && d < CAP_MS - 1500, `${KIND}: the deal fired promptly on the disconnect, well before the cap (${d}ms after start)`);
    closeAll(clients);
  }

  // --- Scenario 5: mixed table - only the NEW client's promise is waited for. ---
  log("--- scenario 5: mixed old + new clients ---");
  {
    const { clients, startAt } = await buildRoom(PORT, [true, false, false, false]);
    await sleep(2000);
    const dealEarly = clients[0].msgs.some((e) => isDeal(e.m));
    check(!dealEarly, `${KIND}: the one new client's pending seated still held the deal`);
    sendJ(clients[0], { type: "seated" });
    await Promise.all(clients.map((c) => waitMsg(c, isDeal, 5000)));
    const d = firstDealDelayMs(clients[0], startAt);
    check(d >= 2000, `${KIND}: mixed table dealt only after the new client sat down (${d}ms after start)`);
    closeAll(clients);
  }

  server.kill("SIGKILL");
  log(`RESULT: ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
