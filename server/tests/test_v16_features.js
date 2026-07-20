// v0.16 feature tests: item 2 ("Leave for good" -> CPU takeover) and item 4 (ready-up gate)
// against a private server instance. Also folds in a dedicated item 6 re-verification (any
// NON-host player can pause for everyone). Usage:
//   node test_v16_features.js node     (server/server.js on a private NASTY_PORT/NASTY_ROOMS_DIR)
//   node test_v16_features.js deno     (server/cloud/server.ts on a private NASTY_PORT/NASTY_KV_PATH)
// Never touches prod. Follows the exact same helper shape as protocol_checklist.js on purpose.
const { spawn } = require("child_process");
const WebSocket = require("/Users/jarvis/nasty-game/server/node_modules/ws");
const path = require("path");
const fs = require("fs");
const os = require("os");

const KIND = process.argv[2] || "node";
const PORT = 17900 + Math.floor(Math.random() * 700);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-v16-${KIND}-`));
const ADMIN_TOKEN = "v16-admin-token-xyz";
const BASE = `http://localhost:${PORT}`;

function log(...a) { console.log("[v16]", ...a); }
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
    const to = setTimeout(() => { ws.removeListener("message", onMsg); reject(new Error("timeout waiting for message" + (predicate ? " matching predicate" : ""))); }, timeoutMs);
    function onMsg(raw) {
      const m = JSON.parse(raw.toString());
      if (!predicate || predicate(m)) { clearTimeout(to); ws.removeListener("message", onMsg); resolve(m); }
    }
    ws.on("message", onMsg);
  });
}
function collectAll(ws, onEach) { ws.on("message", (raw) => onEach(JSON.parse(raw.toString()))); }
const sendJ = (ws, obj) => ws.send(JSON.stringify(obj));

async function main() {
  const child = startServer();
  await waitHealthy();

  /* =====================================================================================
   * ITEM 4 — ready-up gate
   * =================================================================================== */
  {
    const host = await wsConnect(), g1 = await wsConnect(), g2 = await wsConnect();
    const seats = [
      { name: "Host", type: "human", diff: "medium" },
      { name: "G1", type: "human", diff: "medium" },
      { name: "G2", type: "human", diff: "medium" },
      { name: "CpuSeat", type: "cpu", diff: "easy" },
    ];
    sendJ(host, { type: "host", protocolVersion: 4, name: "Host", n: 4, teams: false, seats });
    const created = await nextMsg(host, (m) => m.type === "created");
    const code = created.code;
    sendJ(g1, { type: "join", protocolVersion: 4, code, name: "G1" });
    const j1 = await nextMsg(g1, (m) => m.type === "joined");
    sendJ(g1, { type: "claimSeat", seatIndex: 1, name: "G1" });
    await nextMsg(host, (m) => m.type === "lobby" && m.lobby.seats[1].claimedBy === j1.playerId);
    sendJ(g2, { type: "join", protocolVersion: 4, code, name: "G2" });
    const j2 = await nextMsg(g2, (m) => m.type === "joined");
    sendJ(g2, { type: "claimSeat", seatIndex: 2, name: "G2" });
    await nextMsg(host, (m) => m.type === "lobby" && m.lobby.seats[2].claimedBy === j2.playerId);

    // A brand new joiner mid ready-check must be turned away cleanly (seat list is locked).
    sendJ(host, { type: "start", protocolVersion: 4 });
    const rc0 = await nextMsg(host, (m) => m.type === "readyCheck");
    check(rc0.requiredPlayerIds.length === 3 && rc0.readyPlayerIds.length === 0, "readyCheck opens requiring exactly the 3 human seats, nobody ready yet");
    const late = await wsConnect();
    sendJ(late, { type: "join", protocolVersion: 4, code, name: "Late" });
    const lateErr = await nextMsg(late, (m) => m.type === "joinError");
    check(!!lateErr.message && !/[—–]/.test(lateErr.message), "a new joiner is turned away (plain-language, dash-free) while ready-check is open");
    late.close();

    // Editing seats mid ready-check is locked out too.
    sendJ(host, { type: "setSeat", seatIndex: 3, patch: { type: "human" } });
    let sawLobbyEdit = false;
    const lobbyWatcher = (m) => { if (m.type === "lobby") sawLobbyEdit = true; };
    collectAll(host, lobbyWatcher);
    await new Promise((r) => setTimeout(r, 400));
    check(!sawLobbyEdit, "setSeat is a no-op while ready-check is open (seat list locked)");
    host.removeListener("message", lobbyWatcher);

    // One human readies up - game must NOT start yet (2 of 3 still outstanding).
    sendJ(g1, { type: "readyUp" });
    const rc1 = await nextMsg(host, (m) => m.type === "readyCheck" && m.readyPlayerIds.length === 1);
    check(rc1.readyPlayerIds.includes(j1.playerId), "readyCheck reflects g1 readying up");
    let sawStartEarly = false;
    const earlyWatcher = (m) => { if (m.type === "gameAction" && m.action.kind === "start") sawStartEarly = true; };
    collectAll(host, earlyWatcher);
    await new Promise((r) => setTimeout(r, 500));
    check(!sawStartEarly, "game does not deal until every human has confirmed ready");
    host.removeListener("message", earlyWatcher);

    // Host cancels back to the plain lobby.
    sendJ(host, { type: "cancelReadyCheck" });
    const cancelled = await nextMsg(g2, (m) => m.type === "readyCheckCancelled");
    check(!!cancelled.lobby, "host cancel -> readyCheckCancelled reaches everyone, carries a fresh lobby");
    // Seats are editable again post-cancel.
    sendJ(host, { type: "setSeat", seatIndex: 3, patch: { type: "human" } });
    const afterCancelEdit = await nextMsg(host, (m) => m.type === "lobby" && m.lobby.seats[3].type === "human");
    check(!!afterCancelEdit, "seat editing works again after cancelling the ready check");
    sendJ(host, { type: "setSeat", seatIndex: 3, patch: { type: "cpu" } }); // put it back for a clean re-start
    await nextMsg(host, (m) => m.type === "lobby" && m.lobby.seats[3].type === "cpu");

    // Restart the ready check, get everyone ready this time -> game deals.
    sendJ(host, { type: "start", protocolVersion: 4 });
    await nextMsg(host, (m) => m.type === "readyCheck");
    sendJ(host, { type: "readyUp" });
    sendJ(g1, { type: "readyUp" });
    sendJ(g2, { type: "readyUp" });
    const startMsg = await nextMsg(host, (m) => m.type === "gameAction" && m.action.kind === "start");
    check(!!startMsg, "once everyone confirms ready, the server deals");
    host.close(); g1.close(); g2.close();
  }

  // All-CPU table (host's own seat set to CPU before Start): ready-check must resolve
  // immediately with nobody required, since maybeAdvanceReadyCheck() treats an empty
  // requiredPlayerIds set as vacuously satisfied.
  {
    const host = await wsConnect();
    const seats = [
      { name: "Host", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    sendJ(host, { type: "host", protocolVersion: 4, name: "Host", n: 4, teams: false, seats });
    const created = await nextMsg(host, (m) => m.type === "created");
    sendJ(host, { type: "setSeat", seatIndex: 0, patch: { type: "cpu" } });
    await nextMsg(host, (m) => m.type === "lobby" && m.lobby.seats[0].type === "cpu");
    sendJ(host, { type: "start", protocolVersion: 4 });
    const startMsg = await nextMsg(host, (m) => m.type === "gameAction" && m.action.kind === "start", 5000);
    check(!!startMsg && startMsg.action.seats[0].type === "cpu", "zero-human table: ready check resolves immediately, deal proceeds with no one required");
    host.close();
  }

  /* =====================================================================================
   * ITEM 6 (re-verification) + ITEM 2 (2a) — share ONE room/game to stay under the server's
   * legitimate host-create rate limit (5 rooms/min/IP - see server.js's underHostRateLimit(),
   * intentionally exercised by protocol_checklist.js's own rate-limit check) across this file.
   * First: any NON-host player can pause for everyone. Then, in the SAME game: non-host leaves
   * for good - the OTHER (host) client sees the seat convert, the server keeps driving it, and
   * token rejoin + name reclaim are both invalidated afterward.
   * =================================================================================== */
  {
    const host = await wsConnect(), guest = await wsConnect();
    const seats = [
      { name: "Host", type: "human", diff: "medium" }, { name: "Guest", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
    ];
    sendJ(host, { type: "host", protocolVersion: 4, name: "Host", n: 4, teams: false, seats });
    const created = await nextMsg(host, (m) => m.type === "created");
    const code = created.code;
    sendJ(guest, { type: "join", protocolVersion: 4, code, name: "Guest" });
    const joined = await nextMsg(guest, (m) => m.type === "joined");
    sendJ(guest, { type: "claimSeat", seatIndex: 1, name: "Guest" });
    await nextMsg(host, (m) => m.type === "lobby" && m.lobby.seats[1].claimedBy === joined.playerId);
    sendJ(host, { type: "start", protocolVersion: 4 });
    await nextMsg(host, (m) => m.type === "readyCheck");
    sendJ(host, { type: "readyUp" }); sendJ(guest, { type: "readyUp" });
    await nextMsg(host, (m) => m.type === "gameAction" && m.action.kind === "start");

    // ---- item 6 ----
    const hostSawPause = nextMsg(host, (m) => m.type === "paused" && m.paused === true, 5000);
    const guestSawPause = nextMsg(guest, (m) => m.type === "paused" && m.paused === true, 5000);
    sendJ(guest, { type: "pauseToggle", paused: true });   // GUEST (non-host) toggles pause
    const [hp, gp] = await Promise.all([hostSawPause, guestSawPause]);
    check(!!hp && !!gp, "item 6: a non-host player's pauseToggle reaches BOTH the host's client and the guest's own client");
    sendJ(host, { type: "pauseToggle", paused: false });
    await nextMsg(guest, (m) => m.type === "paused" && m.paused === false);

    // Persistent action-stream watcher from here on - covers the "keeps getting driven" check
    // below without racing a driveTurnLoop() that (with no human seats left) can blast through
    // an entire hand, or even the whole game, synchronously in milliseconds.
    let actionsSeenAfterStart = 0;
    const streamWatcher = (m) => { if (m.type === "gameAction") actionsSeenAfterStart++; };
    collectAll(host, streamWatcher);

    // ---- item 2a ----
    const seatToCpuP = nextMsg(host, (m) => m.type === "gameAction" && m.action.kind === "seatToCpu", 5000);
    const ackP = nextMsg(guest, (m) => m.type === "leftForGood", 5000);
    sendJ(guest, { type: "leaveForGood" });
    const [seatToCpu, ack] = await Promise.all([seatToCpuP, ackP]);
    check(seatToCpu.action.seat === 1 && seatToCpu.action.diff === "medium" && seatToCpu.action.name === "Guest", "leaveForGood broadcasts seatToCpu with the right seat/diff (Tricky)/name");
    check(!!ack, "leaver gets a leftForGood ack");

    // Seat 0 (host) is STILL human here, so driveTurnLoop() may currently be parked waiting on
    // the host's own turn and never reach seat 1 until the host acts. Rather than depend on
    // that timing, have the host ALSO leave for good - a legitimate real scenario (everyone
    // eventually leaves) that makes the WHOLE table CPU and guarantees the server keeps
    // driving the game (every remaining seat, including the newly-converted ones) on its own.
    const actionsBeforeHostLeave = actionsSeenAfterStart;
    sendJ(host, { type: "leaveForGood" });
    await nextMsg(host, (m) => m.type === "leftForGood");
    await new Promise((r) => setTimeout(r, 1500));
    check(actionsSeenAfterStart > actionsBeforeHostLeave, "the table keeps getting driven by the server after both humans left for good (CPU takeover is live, not just cosmetic)");
    host.removeListener("message", streamWatcher);

    // Token rejoin must now be rejected.
    const reGuest = await wsConnect();
    sendJ(reGuest, { type: "rejoin", protocolVersion: 4, code, playerId: joined.playerId, token: joined.token });
    const rejoinErr = await nextMsg(reGuest, (m) => m.type === "rejoinError");
    check(/left that game for good/i.test(rejoinErr.message || "") && !/[—–]/.test(rejoinErr.message), "a token rejoin into a left-for-good seat is rejected with a clear, dash-free message");
    reGuest.close();

    // Name-based reclaim must also be rejected.
    const reclaimer = await wsConnect();
    sendJ(reclaimer, { type: "reclaim", protocolVersion: 4, code, name: "Guest" });
    const reclaimErr = await nextMsg(reclaimer, (m) => m.type === "reclaimError");
    check(/left that game for good/i.test(reclaimErr.message || ""), "a name-based reclaim into a left-for-good seat is rejected too");
    reclaimer.close();

    host.close();
  }

  // 2b: the HOST leaves for good - confirm no host-special room-lifecycle logic fires (the
  // room survives, keeps functioning for the remaining guest, doesn't get torn down).
  {
    const host = await wsConnect(), guest = await wsConnect();
    const seats = [
      { name: "Host", type: "human", diff: "medium" }, { name: "Guest", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
    ];
    sendJ(host, { type: "host", protocolVersion: 4, name: "Host", n: 4, teams: false, seats });
    const created = await nextMsg(host, (m) => m.type === "created");
    const code = created.code;
    sendJ(guest, { type: "join", protocolVersion: 4, code, name: "Guest" });
    const joined = await nextMsg(guest, (m) => m.type === "joined");
    sendJ(guest, { type: "claimSeat", seatIndex: 1, name: "Guest" });
    await nextMsg(host, (m) => m.type === "lobby" && m.lobby.seats[1].claimedBy === joined.playerId);
    sendJ(host, { type: "start", protocolVersion: 4 });
    await nextMsg(host, (m) => m.type === "readyCheck");
    sendJ(host, { type: "readyUp" }); sendJ(guest, { type: "readyUp" });
    await nextMsg(host, (m) => m.type === "gameAction" && m.action.kind === "start");

    const seatToCpuP = nextMsg(guest, (m) => m.type === "gameAction" && m.action.kind === "seatToCpu" && m.action.seat === 0, 5000);
    sendJ(host, { type: "leaveForGood" });
    await nextMsg(host, (m) => m.type === "leftForGood");
    const seatToCpu = await seatToCpuP;
    check(seatToCpu.action.name === "Host", "the HOST leaving for good broadcasts the same seatToCpu event as any other seat (no host-special path)");

    // The room must still be fully responsive to the remaining (non-host) guest - pause,
    // requestStateCheck, and a fresh reconnect (proving the room record itself is intact,
    // not torn down just because the original host is gone).
    const pausedP = nextMsg(guest, (m) => m.type === "paused" && m.paused === true, 5000);
    sendJ(guest, { type: "pauseToggle", paused: true });
    check(!!(await pausedP), "room still honors pauseToggle from the remaining guest after the host left for good");
    sendJ(guest, { type: "pauseToggle", paused: false });
    await nextMsg(guest, (m) => m.type === "paused" && m.paused === false);

    const checkP = nextMsg(guest, (m) => m.type === "stateCheck", 5000);
    sendJ(guest, { type: "requestStateCheck" });
    check(!!(await checkP), "room still answers requestStateCheck after the host left for good");

    const reGuest = await wsConnect();
    sendJ(reGuest, { type: "rejoin", protocolVersion: 4, code, playerId: joined.playerId, token: joined.token });
    const sync = await nextMsg(reGuest, (m) => m.type === "sync");
    check(!!sync.G, "the room itself survives and is still fully joinable/rejoinable - host leaving for good did NOT kill the room");
    reGuest.close();

    host.close(); guest.close();
  }

  // 2c: leaderboard exclusion, end to end. Single human seat (host) leaves for good the
  // instant the game starts, before making any move - the WHOLE table is CPU from then on
  // (host's converted seat + 3 pre-set CPU seats), so the server drives the entire game to
  // completion unattended (same shape as the existing all-CPU smoke test) and finishGame()'s
  // buildResultEntriesServer() must record ZERO leaderboard entries, since every seat.type is
  // "cpu" by the time G.over flips - proving the departed human gets no win/game credit.
  {
    const host = await wsConnect();
    const uniqueName = "LeaveGoodSolo" + Date.now();
    const seats = [
      { name: uniqueName, type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    sendJ(host, { type: "host", protocolVersion: 4, name: uniqueName, n: 4, teams: false, seats });
    const created = await nextMsg(host, (m) => m.type === "created");
    sendJ(host, { type: "start", protocolVersion: 4 });
    await nextMsg(host, (m) => m.type === "readyCheck");
    sendJ(host, { type: "readyUp" });
    await nextMsg(host, (m) => m.type === "gameAction" && m.action.kind === "start");
    sendJ(host, { type: "leaveForGood" });
    await nextMsg(host, (m) => m.type === "leftForGood");

    // Let the now-all-CPU game play itself out.
    await new Promise((r) => setTimeout(r, 6000));
    const lb = await (await fetch(BASE + "/leaderboard")).json();
    check(!lb[uniqueName], "leaderboard has NO entry at all for the human who left for good before the game finished (no win/game credit, ever)");
    host.close();
  }

  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 400));
  log(`\n[${KIND}] ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
