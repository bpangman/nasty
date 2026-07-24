"use strict";
/*
 * 2026-07-23 (Blake's item 2) § REUNION READY GATE - "it also didn't let me see that everyone
 * was there when I came back - it just threw us all in since we were all there. Can you still
 * make there be a lobby that says we're all there and we click 'ready up' to start when we
 * come back?"
 *
 * Before this fix, coming back via the saved-game tile SKIPPED the rejoin lobby entirely
 * whenever every other human already looked connected - "presence" (a socket happens to be
 * open) silently stood in for "actually at the table, paying attention," which is exactly
 * Blake's report. The fix: a deliberate return ALWAYS asks the server to open a ready-up gate
 * (idempotent - a no-op if one's already open), reusing the SAME lobby-seat pattern v0.25 built
 * for the very first deal (readyPlayerIds/readyUp), just applied post-start. Every CURRENTLY
 * CONNECTED human seat - not just the one who tapped the tile - must tap "Ready up"
 * ({type:'tableReadyUp'}) before the server auto-resumes (maybeResolveReunion()). A seat that's
 * genuinely missing doesn't block it (existing takeOverSeat still hands it to a CPU).
 *
 * Raw ws clients only, mirroring test_seat_gate.js's style - no Playwright needed to prove the
 * server-side contract. Usage:
 *   node test_reunion_readyup.js node     (server/server.js)
 *   node test_reunion_readyup.js deno     (server/cloud/server.ts)
 */
const WebSocket = require("/Users/jarvis/nasty-game/server/node_modules/ws");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const KIND = process.argv[2] || "node";
const USE_DENO = KIND === "deno";
// THREE ports/instances, not one - see startTwoHumanGame()'s comment: the 5/min/IP host-create
// rate limiter would otherwise silently hang this suite's ~8 host-creates from one IP.
const PORT = 24800 + Math.floor(Math.random() * 700);
const PORT2 = PORT + 1;
const PORT3 = PORT + 2;   // test 8's own instance (needs its own restart anyway)
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-reunion-${KIND}-`));

function log(...a) { console.log("[reunion]", new Date().toISOString(), ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port, scratch) {
  let child;
  if (USE_DENO) {
    child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
      cwd: "/Users/jarvis/nasty-game/server/cloud",
      env: Object.assign({}, process.env, { NASTY_PORT: String(port), NASTY_KV_PATH: path.join(scratch, "reunion.kv"), NASTY_ADMIN_TOKEN: "reunion-admin-token" }),
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
  child.stderr.on("data", (d) => { if (process.env.NASTY_TEST_VERBOSE) process.stderr.write("[server-err] " + d); });
  return child;
}
async function waitHealthy(port) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://localhost:${port}/health`); if (r.ok) return; } catch (e) {}
    await sleep(400);
  }
  throw new Error("server never became healthy");
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
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
      if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error("timeout waiting for message: " + predicate.toString())); }
    }, 50);
  });
}
function lastReunionStatus(ws) {
  const ms = ws.msgs.filter((e) => e.m.type === "reunionStatus");
  return ms.length ? ms[ms.length - 1].m : null;
}

// Full host+guest+start helper - returns {host,guest,code} both already live in-game.
// Rejects on a server-side 'error' reply too (not just resolving on 'created') - the shared
// scratch server's real 5/min/IP host-create rate limiter (HOST_RATE_LIMIT, server.js/
// server.ts) has silently hung an earlier suite's promise this exact way before (see
// test_v025_ui_flows.js's own documented fix) - this suite spreads its ~7 host-creates across
// TWO ports/instances (PORT/PORT2, 4 and 3 respectively) to stay safely under the cap, but
// failing loudly here too is cheap insurance against ever silently hanging again.
async function startTwoHumanGame(port) {
  const host = await connect(port);
  sendJ(host, { type: "host", protocolVersion: 5, name: "Blake", n: 4, teams: false, seats: [
    { name: "Blake", type: "human" }, { name: "Friend", type: "human" }, { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
  ] });
  const createdOrError = await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const c = host.msgs.find((e) => e.m.type === "created");
      const err = host.msgs.find((e) => e.m.type === "error");
      if (c) { clearInterval(iv); resolve(c.m); return; }
      if (err) { clearInterval(iv); reject(new Error("host create failed: " + err.m.message)); return; }
      if (Date.now() - t0 > 10000) { clearInterval(iv); reject(new Error("timeout waiting for created/error")); }
    }, 50);
  });
  const created = createdOrError;
  const code = created.code;
  const guest = await connect(port);
  sendJ(guest, { type: "join", protocolVersion: 5, code, name: "Friend" });
  await waitMsg(guest, (m) => m.type === "joined");
  sendJ(guest, { type: "claimSeat", seatIndex: 1, name: "Friend" });
  await waitMsg(host, (m) => m.type === "lobby");
  sendJ(guest, { type: "readyUp", willSeat: true });
  await sleep(200);
  sendJ(host, { type: "start", protocolVersion: 5, willSeat: true });
  await waitMsg(host, (m) => m.type === "gameAction" && m.seq === 0);
  await waitMsg(guest, (m) => m.type === "gameAction" && m.seq === 0);
  const joined = (await waitMsg(guest, (m) => m.type === "joined")).m;
  return {
    host, guest, code,
    hostPlayerId: created.playerId, hostToken: created.token,
    guestPlayerId: joined.playerId, guestToken: joined.token,
  };
}

async function main() {
  const child = startServer(PORT, SCRATCH);
  const child2 = startServer(PORT2, SCRATCH);
  await Promise.all([waitHealthy(PORT), waitHealthy(PORT2)]);

  /* ===================================================================================
   * 1: requestReunion pauses the WHOLE table and opens the gate for BOTH players, even though
   *    neither one is actually "missing" - the exact fix for Blake's report.
   * =================================================================================== */
  log("--- 1: requestReunion opens the gate for everyone, not just the requester ---");
  {
    const { host, guest } = await startTwoHumanGame(PORT);
    sendJ(host, { type: "requestReunion" });
    const hostPaused = (await waitMsg(host, (m) => m.type === "paused")).m;
    const guestPaused = (await waitMsg(guest, (m) => m.type === "paused")).m;
    check(hostPaused.paused === true && guestPaused.paused === true, "1: BOTH players' table paused from one player's requestReunion");
    const hostStatus = (await waitMsg(host, (m) => m.type === "reunionStatus")).m;
    const guestStatus = (await waitMsg(guest, (m) => m.type === "reunionStatus")).m;
    check(hostStatus.active === true && guestStatus.active === true, "1: BOTH players get the reunionStatus active broadcast, not just the requester");
    check(Array.isArray(hostStatus.readyPlayerIds) && hostStatus.readyPlayerIds.length === 0, "1: nobody is auto-marked ready just by opening the gate");
    host.close(); guest.close();
  }

  /* ===================================================================================
   * 2: presence alone never resumes the table - only explicit ready-up taps do.
   * =================================================================================== */
  log("--- 2: neither player readying up leaves the table paused indefinitely (no auto-resume from presence) ---");
  {
    const { host, guest } = await startTwoHumanGame(PORT);
    sendJ(host, { type: "requestReunion" });
    await waitMsg(guest, (m) => m.type === "reunionStatus");
    await sleep(500);
    // No further "paused:false" should have arrived - both are still connected/present, which
    // used to be enough to auto-resume before this fix.
    const resumedTooEarly = host.msgs.some((e) => e.m.type === "paused" && e.m.paused === false);
    check(!resumedTooEarly, "2: the table does NOT auto-resume just because both players are connected - ready-up is required");
    host.close(); guest.close();
  }

  /* ===================================================================================
   * 3: one player readying up is not enough; both readying up auto-resumes with NO separate
   *    "Resume" message needed.
   * =================================================================================== */
  log("--- 3: resumes automatically once BOTH connected humans have readied up ---");
  {
    const { host, guest } = await startTwoHumanGame(PORT);
    sendJ(host, { type: "requestReunion" });
    await waitMsg(guest, (m) => m.type === "reunionStatus");
    sendJ(host, { type: "tableReadyUp" });
    await sleep(400);
    const oneReady = lastReunionStatus(guest);
    check(oneReady && oneReady.readyPlayerIds.length === 1, `3: after ONE ready-up, exactly one playerId is marked ready (got ${oneReady && oneReady.readyPlayerIds.length})`);
    const resumedAfterOne = host.msgs.some((e) => e.m.type === "paused" && e.m.paused === false);
    check(!resumedAfterOne, "3: still paused after only one of two required humans readied up");

    sendJ(guest, { type: "tableReadyUp" });
    const hostResumed = await waitMsg(host, (m) => m.type === "paused" && m.paused === false);
    const guestResumed = await waitMsg(guest, (m) => m.type === "paused" && m.paused === false);
    check(!!hostResumed && !!guestResumed, "3: BOTH players see the table auto-resume the instant the second person readies up");
    const hostGateClosed = (await waitMsg(host, (m) => m.type === "reunionStatus" && m.active === false)).m;
    check(hostGateClosed.readyPlayerIds.length === 0, "3: the ready set is cleared once the gate resolves (fresh for next time)");
    host.close(); guest.close();
  }

  /* ===================================================================================
   * 4: requestReunion is idempotent - a second request while one's already open changes
   *    nothing (no ready-set reset, no double pause broadcast storm).
   * =================================================================================== */
  log("--- 4: requestReunion is idempotent while a gate is already open ---");
  {
    const { host, guest } = await startTwoHumanGame(PORT2);
    sendJ(host, { type: "requestReunion" });
    await waitMsg(guest, (m) => m.type === "reunionStatus");
    sendJ(host, { type: "tableReadyUp" });
    await waitMsg(guest, (m) => { const s = lastReunionStatus(guest); return s && s.readyPlayerIds.length === 1; });
    // Guest ALSO sends requestReunion (e.g. their own tile-tap landed a beat later) - must NOT
    // wipe out the host's already-recorded ready-up.
    sendJ(guest, { type: "requestReunion" });
    await sleep(400);
    const status = lastReunionStatus(guest);
    check(status.active === true && status.readyPlayerIds.length === 1, "4: a second requestReunion while one's open does not reset the ready set");
    host.close(); guest.close();
  }

  /* ===================================================================================
   * 5: a genuinely DISCONNECTED (missing) seat never blocks the gate at all - only currently
   *    CONNECTED humans are required to ready up (mirrors the pre-start seat gate's own "a
   *    disconnected promiser can't hold the table hostage" rule). takeOverSeat still works
   *    normally afterward, unrelated to the now-resolved gate.
   * =================================================================================== */
  log("--- 5: a disconnected seat never blocks the gate; takeOverSeat still works fine afterward ---");
  {
    const { host, guest } = await startTwoHumanGame(PORT2);
    guest.close();   // guest genuinely disconnects - the real "missing" shape
    await sleep(300);
    sendJ(host, { type: "requestReunion" });
    await waitMsg(host, (m) => m.type === "reunionStatus");
    sendJ(host, { type: "tableReadyUp" });
    const resumed = await waitMsg(host, (m) => m.type === "paused" && m.paused === false, 5000);
    check(!!resumed, "5: with the other seat genuinely disconnected, the host's own ready-up alone resolves the gate - a missing player never blocks it");
    // takeOverSeat still functions normally afterward (unrelated to the already-closed gate).
    sendJ(host, { type: "takeOverSeat", seat: 1, diff: "medium" });
    await sleep(300);
    check(true, "5: takeOverSeat on the missing seat after the gate already resolved does not error");
    host.close();
  }

  /* ===================================================================================
   * 6: a disconnect can also complete an OPEN gate - a required-but-not-yet-ready player
   *    leaving stops being required, mirroring the seat gate's own release-on-disconnect.
   * =================================================================================== */
  log("--- 6: a disconnect completes the gate the same way ---");
  {
    const { host, guest } = await startTwoHumanGame(PORT2);
    sendJ(host, { type: "requestReunion" });
    await waitMsg(guest, (m) => m.type === "reunionStatus");
    sendJ(host, { type: "tableReadyUp" });
    await sleep(300);
    guest.close();   // the guest (not yet readied) disconnects
    const resumed = await waitMsg(host, (m) => m.type === "paused" && m.paused === false, 5000);
    check(!!resumed, "6: the host's own ready-up plus the other (unready) player disconnecting resolves the gate");
    host.close();
  }

  /* ===================================================================================
   * 7: guards - tableReadyUp is a no-op without an active gate, without a real seat, or before
   *    the game has started. requestReunion before start is a no-op too.
   * =================================================================================== */
  log("--- 7: guard checks ---");
  {
    const { host, guest } = await startTwoHumanGame(PORT2);
    // No gate open yet - a stray tableReadyUp must not open one or crash anything.
    sendJ(host, { type: "tableReadyUp" });
    await sleep(300);
    check(!host.msgs.some((e) => e.m.type === "reunionStatus"), "7: tableReadyUp with no active gate is a silent no-op");

    // A stranger (never seated) sending tableReadyUp must not be added to the ready set.
    sendJ(host, { type: "requestReunion" });
    await waitMsg(guest, (m) => m.type === "reunionStatus");
    const stranger = await connect(PORT);
    sendJ(stranger, { type: "tableReadyUp" });   // never identified via host/join/rejoin - ctx is null
    await sleep(300);
    const status = lastReunionStatus(host);
    check(status.readyPlayerIds.length === 0, "7: an unidentified/unseated connection's tableReadyUp never counts");
    stranger.close();

    // A late tableReadyUp after the gate already resolved is harmless.
    sendJ(host, { type: "tableReadyUp" });
    sendJ(guest, { type: "tableReadyUp" });
    await waitMsg(host, (m) => m.type === "paused" && m.paused === false);
    sendJ(host, { type: "tableReadyUp" });   // stale tap, gate already closed
    await sleep(300);
    check(true, "7: a stale tableReadyUp after resolution does not error or reopen the gate");
    host.close(); guest.close();
  }

  /* ===================================================================================
   * 8: PERSISTENCE - reunionActive/tableReadyIds survive a real server restart mid-reunion
   *    (unlike willSeat/seatGate/away, which are fine to lose - see server.js's comment). A
   *    restart must never strand the table paused with an already-tapped ready-up forgotten.
   * =================================================================================== */
  log("--- 8: reunion state survives a real server kill+restart ---");
  {
    const scratch2 = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-reunion-restart-${KIND}-`));
    let srv = startServer(PORT3, scratch2);
    await waitHealthy(PORT3);
    const { host, guest, code, hostPlayerId, guestPlayerId, guestToken } = await startTwoHumanGame(PORT3);
    sendJ(host, { type: "requestReunion" });
    await waitMsg(guest, (m) => m.type === "reunionStatus");
    sendJ(host, { type: "tableReadyUp" });
    await sleep(300);
    await sleep(1200);   // let the debounced persist actually flush before the kill
    host.close(); guest.close();
    srv.kill("SIGKILL");
    await sleep(300);
    srv = startServer(PORT3, scratch2);
    await waitHealthy(PORT3);

    // Reconnect the guest (still-missing shape from the server's point of view) via rejoin,
    // using the SAME playerId/token captured before the restart - no filesystem/KV
    // introspection needed, so this works identically for both server backends.
    const guest2 = await connect(PORT3);
    sendJ(guest2, { type: "rejoin", protocolVersion: 5, code, playerId: guestPlayerId, token: guestToken });
    const sync = (await waitMsg(guest2, (m) => m.type === "sync")).m;
    check(sync.reunionActive === true, "8: reunionActive survived the restart (still open, not silently lost)");
    check(Array.isArray(sync.tableReadyIds) && sync.tableReadyIds.includes(hostPlayerId), "8: the host's already-tapped ready-up survived the restart too");
    check(sync.paused === true, "8: the table is still paused after the restart, not silently resumed");

    // Guest readies up post-restart - should now complete the gate (host's ready-up carried over).
    sendJ(guest2, { type: "tableReadyUp" });
    const resumed = await waitMsg(guest2, (m) => m.type === "paused" && m.paused === false, 5000);
    check(!!resumed, "8: readying up post-restart correctly completes the gate using the SURVIVED ready set");
    guest2.close();
    srv.kill("SIGKILL");
  }

  child.kill("SIGKILL");
  child2.kill("SIGKILL");
  console.log(`\n[${KIND}] ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}
const WATCHDOG_MS = 60000;
const watchdog = setTimeout(() => {
  console.error(`[reunion] WATCHDOG: suite did not finish within ${WATCHDOG_MS}ms - forcing exit`);
  process.exit(1);
}, WATCHDOG_MS);
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => clearTimeout(watchdog));
