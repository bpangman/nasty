"use strict";
/*
 * 2026-07-25 § REUNION GATE HARDENING - three confirmed server-side bugs in the 2026-07-23
 * reunion ready-up gate, reproduced here first and then proved fixed. Companion suite to
 * test_reunion_readyup.js (which proves the gate's HAPPY path); this one only covers the ways
 * the gate could previously be bypassed, wedged, or opened by the wrong person.
 *
 * Bug 1 - pauseToggle bypassed AND permanently wedged the gate.
 *   `case "pauseToggle"` set room.paused unconditionally and never looked at reunionActive.
 *   So ANY unpause while the ready-up gate was open resumed play with nobody having readied
 *   AND left reunionActive stuck true forever - after which requestReunion's
 *   `if (!room.reunionActive)` made every LATER reunion a silent no-op, killing the feature
 *   for the rest of that room's life. Reachable with zero old builds: player A opens the
 *   Pause/Save sheet (PAUSED_BY_SHEET=true), player B returns via the tile and opens the gate,
 *   player A taps Cancel -> releaseSheetPause() -> requestPause(false). It is also the real
 *   protocol-5 compatibility hole (a build-38 client's tap-to-resume sends the same message).
 *   Fix: an unpause is REFUSED while a reunion gate is open, with a plain-language reason.
 *
 * Bug 2 - a connected player who never taps "Ready up" wedged the table forever.
 *   maybeResolveReunion() required every currently-connected human seat to ready up, with no
 *   timeout at all - unlike the pre-start seat gate, which has SEAT_GATE_CAP_MS precisely so
 *   "a broken client can never hold the table hostage". The gate also pauses the table, and
 *   currentAwayTarget() bails on room.paused, so the away ladder and its CPU-takeover escape
 *   were disabled for the whole (unbounded) duration. Fix: REUNION_GATE_CAP_MS.
 *
 * Bug 7 - requestReunion was missing the seat check its sibling tableReadyUp has.
 *   requestReunion only checked `room.started && room.engine`, so a guest who joined the
 *   lobby but never claimed a seat could pause the whole table - and then could not clear it,
 *   because tableReadyUp DOES check seatOwners. Fix: the same seatOwners guard on both.
 *
 * Raw ws clients only, same style as test_reunion_readyup.js / test_seat_gate.js. Usage:
 *   node test_reunion_gate_hardening.js node     (server/server.js)
 *   node test_reunion_gate_hardening.js deno     (server/cloud/server.ts)
 */
const WebSocket = require("/Users/jarvis/nasty-game/server/node_modules/ws");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const KIND = process.argv[2] || "node";
const USE_DENO = KIND === "deno";
// TWO ports/instances so the real 5-host-creates-per-minute-per-IP limiter never silently
// hangs this suite (same reasoning as test_reunion_readyup.js's own three-instance split).
const PORT = 25600 + Math.floor(Math.random() * 700);
const PORT2 = PORT + 1;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-rgh-${KIND}-`));
// Short cap so the suite can prove the expiry in seconds instead of the 75s production value.
const CAP_MS = 6000;

function log(...a) { console.log("[reunion-gate]", new Date().toISOString(), ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port, scratch) {
  let child;
  if (USE_DENO) {
    child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
      cwd: "/Users/jarvis/nasty-game/server/cloud",
      env: Object.assign({}, process.env, {
        // One KV file PER INSTANCE. Deno's SQLite KV takes an exclusive lock, so two local
        // isolates pointed at the same file just spin on "database is locked" and never
        // become healthy - found the hard way while writing this suite.
        NASTY_PORT: String(port), NASTY_KV_PATH: path.join(scratch, `rgh-${port}.kv`),
        NASTY_ADMIN_TOKEN: "rgh-admin-token",
        NASTY_REUNION_GATE_CAP_MS: String(CAP_MS),
        NASTY_AWAY_SWEEP_MS: "500",
      }),
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
        NASTY_REUNION_GATE_CAP_MS: String(CAP_MS),
        NASTY_AWAY_SWEEP_MS: "500",
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
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      ws.msgs.push({ t: Date.now(), m });
      // Answer the server's app-level ping. The Deno server force-closes a socket that has said
      // nothing for SOCKET_STALE_MS (it has no protocol-level ping/pong to lean on the way
      // Node's ws library does), and this suite deliberately sits idle for the length of the
      // reunion cap - long enough to be hung up on without this.
      if (m.type === "ping") { try { ws.send(JSON.stringify({ type: "pong", t: m.t })); } catch (e) {} }
    });
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
// Resolves to the matching message, or null on timeout - for "this must NOT arrive" assertions.
async function maybeMsg(ws, predicate, timeoutMs) {
  try { return (await waitMsg(ws, predicate, timeoutMs)).m; } catch (e) { return null; }
}
// Same, but only ever looks at messages that arrived AFTER `mark` (= ws.msgs.length captured
// earlier). Load-bearing in this suite: several assertions here are about a SECOND gate/pause
// in the same socket's history, and a whole-history scan would happily match the FIRST one and
// resolve instantly - which is exactly how an early draft of this file reported a false
// failure. Every "did this new thing happen" wait below goes through here.
async function maybeMsgFrom(ws, mark, predicate, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const hit = ws.msgs.slice(mark).find((e) => predicate(e.m));
    if (hit) return hit.m;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(50);
  }
}
function lastReunionStatus(ws) {
  const ms = ws.msgs.filter((e) => e.m.type === "reunionStatus");
  return ms.length ? ms[ms.length - 1].m : null;
}

// opts.spectator: also connect a THIRD client that joins the lobby and never claims a seat,
// BEFORE the game starts (a started room refuses new joins, so bug 7's "unseated lobby guest"
// shape can only be built here). Returned as `spec` when asked for.
async function startTwoHumanGame(port, opts) {
  opts = opts || {};
  const host = await connect(port);
  sendJ(host, { type: "host", protocolVersion: 5, name: "Blake", n: 4, teams: false, seats: [
    { name: "Blake", type: "human" }, { name: "Friend", type: "human" }, { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
  ] });
  const created = await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const c = host.msgs.find((e) => e.m.type === "created");
      const err = host.msgs.find((e) => e.m.type === "error");
      if (c) { clearInterval(iv); resolve(c.m); return; }
      if (err) { clearInterval(iv); reject(new Error("host create failed: " + err.m.message)); return; }
      if (Date.now() - t0 > 10000) { clearInterval(iv); reject(new Error("timeout waiting for created/error")); }
    }, 50);
  });
  const code = created.code;
  const guest = await connect(port);
  sendJ(guest, { type: "join", protocolVersion: 5, code, name: "Friend" });
  await waitMsg(guest, (m) => m.type === "joined");
  sendJ(guest, { type: "claimSeat", seatIndex: 1, name: "Friend" });
  await waitMsg(host, (m) => m.type === "lobby");
  sendJ(guest, { type: "readyUp", willSeat: true });
  let spec = null;
  if (opts.spectator) {
    spec = await connect(port);
    sendJ(spec, { type: "join", protocolVersion: 5, code, name: "Nosy" });
    await waitMsg(spec, (m) => m.type === "joined");
    // deliberately NO claimSeat and NO readyUp - guestsAllReady() only looks at CLAIMED seats,
    // so this player never blocks Start, which is exactly the real-world shape (someone opened
    // the invite link to watch).
  }
  await sleep(200);
  sendJ(host, { type: "start", protocolVersion: 5, willSeat: true });
  await waitMsg(host, (m) => m.type === "gameAction" && m.seq === 0);
  await waitMsg(guest, (m) => m.type === "gameAction" && m.seq === 0);
  const joined = (await waitMsg(guest, (m) => m.type === "joined")).m;
  return {
    host, guest, spec, code,
    hostPlayerId: created.playerId, hostToken: created.token,
    guestPlayerId: joined.playerId, guestToken: joined.token,
  };
}

async function main() {
  const child = startServer(PORT, SCRATCH);
  const child2 = startServer(PORT2, SCRATCH);
  await Promise.all([waitHealthy(PORT), waitHealthy(PORT2)]);

  /* ===================================================================================
   * BUG 1a: the exact Pause/Save-sheet Cancel sequence. Player A has the sheet open (their
   * own pause), player B's return opens the gate, player A taps Cancel -> pauseToggle:false.
   * Before the fix that unpaused the table with NOBODY readied. After: refused, still paused.
   * =================================================================================== */
  log("--- 1a: an unpause while the ready-up gate is open must NOT resume the table ---");
  {
    const { host, guest } = await startTwoHumanGame(PORT);
    // Player A (host) opens the Pause/Save sheet: that's a plain pauseToggle:true.
    sendJ(host, { type: "pauseToggle", paused: true });
    await waitMsg(host, (m) => m.type === "paused" && m.paused === true);
    // Player B comes back via the tile -> the gate opens for everyone.
    sendJ(guest, { type: "requestReunion" });
    await waitMsg(host, (m) => m.type === "reunionStatus" && m.active === true);
    const beforeCancel = host.msgs.length;
    // Player A taps Cancel on the sheet -> releaseSheetPause() -> requestPause(false).
    sendJ(host, { type: "pauseToggle", paused: false });
    await sleep(600);
    const resumed = host.msgs.slice(beforeCancel).some((e) => e.m.type === "paused" && e.m.paused === false);
    check(!resumed, "1a: cancelling the Pause/Save sheet does NOT bypass an open ready-up gate");
    const stillOpen = lastReunionStatus(guest);
    check(stillOpen && stillOpen.active === true, "1a: the gate is still open after the refused unpause");
    const told = host.msgs.slice(beforeCancel).find((e) => e.m.type === "error" && typeof e.m.message === "string");
    check(!!told, "1a: the player who tried to unpause is told plainly why it did not happen");
    if (told) check(!/[–—]/.test(told.m.message), "1a: that message contains no em/en dashes");
    // And the gate still resolves normally afterward.
    const mark2 = host.msgs.length;
    sendJ(host, { type: "tableReadyUp" });
    sendJ(guest, { type: "tableReadyUp" });
    const ok = await maybeMsgFrom(host, mark2, (m) => m.type === "paused" && m.paused === false, 5000);
    check(!!ok, "1a: the gate still resolves normally once both players ready up");
    host.close(); guest.close();
  }

  /* ===================================================================================
   * BUG 1b: the WEDGE. After the bypass above, reunionActive stayed true forever, so every
   * LATER requestReunion was a silent no-op - the feature was dead for that room's life.
   * The invariant: the table can never be unpaused with reunionActive still true, and a later
   * genuine return must always be able to open a FRESH gate.
   * =================================================================================== */
  log("--- 1b: an unpause can never leave the gate stuck open (the permanent wedge) ---");
  {
    const { host, guest } = await startTwoHumanGame(PORT);
    sendJ(guest, { type: "requestReunion" });
    await waitMsg(host, (m) => m.type === "reunionStatus" && m.active === true);
    sendJ(host, { type: "pauseToggle", paused: false });   // the bypass attempt
    await sleep(600);
    // Resolve the gate the legitimate way so the table is genuinely back in play.
    const markResolve = host.msgs.length;
    sendJ(host, { type: "tableReadyUp" });
    sendJ(guest, { type: "tableReadyUp" });
    await maybeMsgFrom(host, markResolve, (m) => m.type === "paused" && m.paused === false, 5000);
    await sleep(300);
    const afterFirst = lastReunionStatus(host);
    check(afterFirst && afterFirst.active === false, "1b: after the gate resolves, reunionActive is false (not stuck true)");
    // Now a SECOND genuine return must open a brand-new gate.
    const mark = host.msgs.length;
    sendJ(guest, { type: "requestReunion" });
    const second = await maybeMsgFrom(host, mark, (m) => m.type === "reunionStatus" && m.active === true, 5000);
    check(!!second, "1b: a LATER genuine return still opens a fresh gate (the feature is not dead for this room)");
    const secondPause = await maybeMsgFrom(host, mark, (m) => m.type === "paused" && m.paused === true, 3000);
    check(!!secondPause, "1b: that fresh gate pauses the table again, exactly like the first one");
    host.close(); guest.close();
  }

  /* ===================================================================================
   * BUG 1c: a plain pause/unpause with NO gate open is completely untouched - the whole point
   * of the 2026-07-23 design note ("cancelling YOUR OWN sheet-initiated pause must never
   * require a ready-up dance"). Regression guard for the fix itself.
   * =================================================================================== */
  log("--- 1c: ordinary pause/unpause with no gate open is unchanged ---");
  {
    const { host, guest } = await startTwoHumanGame(PORT2);
    sendJ(host, { type: "pauseToggle", paused: true });
    await waitMsg(guest, (m) => m.type === "paused" && m.paused === true);
    sendJ(host, { type: "pauseToggle", paused: false });
    const back = await maybeMsg(guest, (m) => m.type === "paused" && m.paused === false, 4000);
    check(!!back, "1c: an ordinary Pause then Cancel still resumes instantly for everyone");
    const noError = !host.msgs.some((e) => e.m.type === "error");
    check(noError, "1c: no spurious error message on the ordinary path");
    host.close(); guest.close();
  }

  /* ===================================================================================
   * BUG 2: the hostage case. Both clients alive and answering pings; only ONE ever taps
   * Ready up. Before the fix the table stayed paused forever with no escape at all. After:
   * REUNION_GATE_CAP_MS expires, the table resumes cleanly and the gate closes.
   * =================================================================================== */
  log(`--- 2: a never-readying connected player cannot hold the table hostage (cap ${CAP_MS}ms) ---`);
  {
    const { host, guest } = await startTwoHumanGame(PORT2);
    sendJ(guest, { type: "requestReunion" });
    await waitMsg(host, (m) => m.type === "reunionStatus" && m.active === true);
    const markGate = host.msgs.length;
    sendJ(guest, { type: "tableReadyUp" });   // guest readies, host never does
    await sleep(400);
    const halfway = await maybeMsgFrom(host, markGate, (m) => m.type === "paused" && m.paused === false, Math.floor(CAP_MS / 2));
    check(!halfway, "2: the gate is still holding well before the cap (it is a cap, not an instant bypass)");
    const expired = await maybeMsgFrom(host, markGate, (m) => m.type === "paused" && m.paused === false, CAP_MS * 2);
    check(!!expired, "2: the gate auto-resolves once the cap expires - the table is never held hostage");
    const closed = await maybeMsgFrom(host, markGate, (m) => m.type === "reunionStatus" && m.active === false, 3000);
    check(!!closed, "2: the expired gate broadcasts reunionStatus active:false (no stale overlay left up)");
    check(closed && Array.isArray(closed.readyPlayerIds) && closed.readyPlayerIds.length === 0, "2: the expired gate clears the ready set");
    // ...and the room is genuinely usable again: a fresh return opens a brand-new gate.
    const markFresh = host.msgs.length;
    sendJ(guest, { type: "requestReunion" });
    const fresh = await maybeMsgFrom(host, markFresh, (m) => m.type === "reunionStatus" && m.active === true, 5000);
    check(!!fresh, "2: after an expired gate, a later return still opens a fresh one (clean resume, no stale state)");
    const freshPause = await maybeMsgFrom(host, markFresh, (m) => m.type === "paused" && m.paused === true, 3000);
    check(!!freshPause, "2: ...and that fresh gate pauses the table again (the expiry left no stale paused state)");
    host.close(); guest.close();
  }

  /* ===================================================================================
   * BUG 7: an unseated lobby guest could pause the whole table with requestReunion and then
   * could not clear it (tableReadyUp correctly checks seatOwners; requestReunion did not).
   * =================================================================================== */
  log("--- 7: an unseated lobby guest cannot open a reunion gate ---");
  {
    const { host, guest, spec } = await startTwoHumanGame(PORT2, { spectator: true });
    const mark = host.msgs.length;
    sendJ(spec, { type: "requestReunion" });
    await sleep(1000);
    const paused = host.msgs.slice(mark).some((e) => e.m.type === "paused" && e.m.paused === true);
    check(!paused, "7: a guest who never claimed a seat cannot pause the table with requestReunion");
    const gate = host.msgs.slice(mark).some((e) => e.m.type === "reunionStatus" && e.m.active === true);
    check(!gate, "7: ...and no ready-up gate is opened by them either");
    // A genuinely seated player still can, unchanged.
    const mark2 = host.msgs.length;
    sendJ(guest, { type: "requestReunion" });
    const realGate = await maybeMsgFrom(host, mark2, (m) => m.type === "reunionStatus" && m.active === true, 5000);
    check(!!realGate, "7: a genuinely SEATED player still opens the gate normally (guard is not over-tight)");
    spec.close(); host.close(); guest.close();
  }

  child.kill("SIGKILL");
  child2.kill("SIGKILL");
  console.log(`\n[${KIND}] ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}
const WATCHDOG_MS = 120000;
const watchdog = setTimeout(() => {
  console.error(`[reunion-gate] WATCHDOG: suite did not finish within ${WATCHDOG_MS}ms - forcing exit`);
  process.exit(1);
}, WATCHDOG_MS);
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => clearTimeout(watchdog));
