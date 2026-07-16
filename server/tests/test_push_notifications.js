// v0.16 item 5 ("It's your turn in NASTY" push notifications) tests against a private server
// instance. Usage:
//   node test_push_notifications.js node     (server/server.js on a private NASTY_PORT/NASTY_ROOMS_DIR)
//   node test_push_notifications.js deno     (server/cloud/server.ts on a private NASTY_PORT/NASTY_KV_PATH)
// Never touches prod. Follows the exact same helper shape as test_v16_features.js on purpose.
//
// No real APNs key exists on this Mac (see server/apns-key.p8 / server/apns-key-id.txt - both
// intentionally absent until Blake creates one, see PLANNING.md), so every push in this whole
// test suite goes through the NO-OP LOG PATH ("would send push to token <token> for player
// <name>") - that log line, captured from the child process's stdout, IS the observable proof
// the trigger logic ran correctly. Once a real key exists, server/apns.js's own real-send path
// activates automatically (see that file's header) - nothing here changes.
const { spawn } = require("child_process");
const WebSocket = require("/Users/jarvis/nasty-game/server/node_modules/ws");
const path = require("path");
const fs = require("fs");
const os = require("os");

const KIND = process.argv[2] || "node";
const PORT = 18900 + Math.floor(Math.random() * 700);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-push-${KIND}-`));
const ADMIN_TOKEN = "push-test-admin-token-xyz";
const BASE = `http://localhost:${PORT}`;

function log(...a) { console.log("[push]", ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK ", label); } else { FAIL++; log("FAIL", label); } }

let stdoutBuf = "";
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
  child.stdout.on("data", (d) => { stdoutBuf += d.toString(); });
  child.stderr.on("data", (d) => { stdoutBuf += d.toString(); });
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
const sendJ = (ws, obj) => ws.send(JSON.stringify(obj));
async function waitForLog(re, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const m = stdoutBuf.match(re);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}
function countMatches(re) {
  const m = stdoutBuf.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
  return m ? m.length : 0;
}

async function main() {
  const child = startServer();
  await waitHealthy();

  /* =====================================================================================
   * A. Registration plumbing: registerPush is accepted and stored on the player identity.
   *    Node: verified directly by reading the persisted room JSON off disk (the same file
   *    roomToDisk()/roomFromDisk() round-trip through). Deno's equivalent (KV) is exercised
   *    indirectly by scenario B below (the close-triggered push carries the SAME token that
   *    was registered here, which is only possible if it was actually stored on the player
   *    record touchRoom() committed to KV).
   * =================================================================================== */
  let code, playerId, token;
  const PUSH_TOKEN = "TEST-DEVICE-TOKEN-" + Date.now();
  {
    const ws = await wsConnect();
    const seats = [
      { name: "Pusher", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    sendJ(ws, { type: "host", protocolVersion: 2, name: "Pusher", n: 4, teams: false, seats });
    const created = await nextMsg(ws, (m) => m.type === "created");
    code = created.code; playerId = created.playerId; token = created.token;

    sendJ(ws, { type: "registerPush", token: PUSH_TOKEN, platform: "ios" });
    const regLog = await waitForLog(new RegExp(`push token registered ${code} playerId=${playerId}`));
    check(!!regLog, "registerPush is accepted - server logs receipt tied to this exact room+playerId");

    if (KIND === "node") {
      await new Promise((r) => setTimeout(r, 900)); // clear the 800ms persist debounce
      const onDisk = JSON.parse(fs.readFileSync(path.join(SCRATCH, code + ".json"), "utf8"));
      const p = onDisk.players.find((pp) => pp.id === playerId);
      check(!!p && p.pushToken === PUSH_TOKEN, "the registered token is actually PERSISTED on disk (roomToDisk/roomFromDisk round-trip), not just held in memory");
    }

    /* ===================================================================================
     * B. Trigger logic, connected case: the instant the deal lands, this seat's turn starts
     *    (it's the only human - every CPU seat auto-plays through, so the loop is GUARANTEED
     *    to stop here) while the socket is STILL open - no push should fire yet.
     * ================================================================================= */
    sendJ(ws, { type: "start", protocolVersion: 2 });
    await nextMsg(ws, (m) => m.type === "readyCheck");
    sendJ(ws, { type: "readyUp" });
    await nextMsg(ws, (m) => m.type === "gameAction" && m.action.kind === "start");
    await new Promise((r) => setTimeout(r, 700)); // let driveTurnLoop's deal+turn-stop settle
    check(countMatches(/would send push to token/) === 0, "no push is sent/logged while the on-turn seat's socket is still open and connected");

    /* ===================================================================================
     * C. Trigger logic, disconnected case: close the socket while it is genuinely this
     *    seat's turn (the only human seat - it can be no one else's) - the close handler's
     *    push check (server.js/server.ts's "close" handler addition) must fire exactly once,
     *    with exactly the token registered in part A and this seat's real player name.
     * ================================================================================= */
    ws.close();
    const pushLog = await waitForLog(new RegExp(`would send push to token ${PUSH_TOKEN} for player Pusher`));
    check(!!pushLog, "closing the on-turn seat's socket triggers the exact would-send-push no-op log line, with the right token and player name");
    await new Promise((r) => setTimeout(r, 1500)); // let any (incorrect) extra pushes have time to appear
    check(countMatches(new RegExp(`would send push to token ${PUSH_TOKEN}`)) === 1, "exactly ONE push is logged for this turn - no spam on subsequent loop activity");
  }

  /* =====================================================================================
   * D. Negative case: a seat with NO registered push token never gets a push attempt, even
   *    when it's disconnected on its own turn - proves the "if (!player.pushToken) return"
   *    guard actually gates delivery, not just a coincidence of the earlier test's ordering.
   * =================================================================================== */
  {
    const beforeCount = countMatches(/would send push to token/);
    const ws = await wsConnect();
    const seats = [
      { name: "NoTokenPlayer", type: "human", diff: "medium" },
      { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    sendJ(ws, { type: "host", protocolVersion: 2, name: "NoTokenPlayer", n: 4, teams: false, seats });
    await nextMsg(ws, (m) => m.type === "created");
    // Deliberately never send registerPush.
    sendJ(ws, { type: "start", protocolVersion: 2 });
    await nextMsg(ws, (m) => m.type === "readyCheck");
    sendJ(ws, { type: "readyUp" });
    await nextMsg(ws, (m) => m.type === "gameAction" && m.action.kind === "start");
    await new Promise((r) => setTimeout(r, 500));
    ws.close();
    await new Promise((r) => setTimeout(r, 1500));
    check(countMatches(/would send push to token/) === beforeCount, "a seat that never registered a push token gets no push attempt at all, even disconnected on its own turn");
  }

  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 400));
  log(`\n[${KIND}] ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
