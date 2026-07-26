/*
 * test_push_audit_native_registration.js - the test that WOULD have caught Blake's
 * "I never get push notifications still" (2026-07-26 push audit). Usage:
 *   node test_push_audit_native_registration.js node
 *   node test_push_audit_native_registration.js deno
 * Never touches prod. Private port + private rooms dir / KV, same shape as the other suites.
 *
 * WHY THIS EXISTS - read this before touching it.
 *
 * test_push_notifications.js was 9/9 green the entire time push was 100% dead in the field.
 * It is not a bad suite; it is a suite that tests the half that worked. It injects
 * {type:'registerPush', token:...} straight down the WebSocket, so it proves the SERVER
 * stores a token, persists it, attaches it to the right player, survives a rejoin, and fires
 * exactly one push on the right trigger. All of that was genuinely correct.
 *
 * What no test covered was where the token is supposed to COME FROM. On iOS the chain is:
 *
 *   index.html registerPushIfGranted()
 *     -> PushNotifications.register()                        (Capacitor JS)
 *     -> UIApplication.shared.registerForRemoteNotifications()  (plugin, native)
 *     -> iOS asks APNs, gets a device token, and hands it to the APP DELEGATE via
 *        application(_:didRegisterForRemoteNotificationsWithDeviceToken:)
 *     -> the app delegate must POST it on NotificationCenter as
 *        .capacitorDidRegisterForRemoteNotifications
 *     -> only THEN does the plugin fire its 'registration' listener
 *     -> only then does index.html have a token to send as {type:'registerPush'}
 *
 * Capacitor does NOT swizzle the app delegate to do that post for you (grep its Capacitor/
 * sources: the only swizzles are keyboard and status-bar-tap). Adding those two methods is a
 * documented, MANDATORY setup step in @capacitor/push-notifications' README. It had never
 * been done - AppDelegate.swift was still the stock template `npx cap add ios` generated.
 *
 * So the token was never produced, index.html's PUSH_TOKEN stayed null forever, every
 * sendPushToken() was a silent no-op, every player record was tokenless, and every push
 * attempt took maybeSendTurnPush()'s "no token registered" early return. Everything
 * downstream (key, JWT, team id, topic, production host) verified fine against Apple - the
 * chain simply had nothing to send.
 *
 * Part A below is therefore a STATIC check of the native link, because that is the link that
 * broke and the one no runtime server test can ever reach. It is deliberately grep-shaped:
 * if someone regenerates the iOS project (`npx cap add ios` writes a fresh stock
 * AppDelegate.swift) this suite goes red immediately instead of shipping another build that
 * silently cannot receive a push.
 *
 * Part B covers the second defect: this feature failed SILENTLY. Every outcome was log-only,
 * on a Deno Deploy instance whose logs nobody reads. /admin/push (added in the same audit)
 * makes "is push actually working" a single GET, so the next failure is visible.
 */
const { spawn } = require("child_process");
const WebSocket = require("/Users/jarvis/nasty-game/server/node_modules/ws");
const path = require("path");
const fs = require("fs");
const os = require("os");

const REPO = "/Users/jarvis/nasty-game";
const KIND = process.argv[2] || "node";
const PORT = 19600 + Math.floor(Math.random() * 300);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-pushaudit-${KIND}-`));
const ADMIN_TOKEN = "push-audit-admin-token-xyz";
const BASE = `http://localhost:${PORT}`;

function log(...a) { console.log("[push-audit]", ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }

const read = (p) => fs.readFileSync(path.join(REPO, p), "utf8");

/* =========================================================================================
 * A. THE NATIVE LINK - the one that was broken, and the one no server test can reach.
 * ======================================================================================= */
function partA() {
  log("--- A. native iOS registration chain (static) ---");

  const appDelegate = read("app/ios/App/App/AppDelegate.swift");

  // A1/A2: the two methods the plugin's README requires. Without the first one, iOS hands the
  // device token to a method that does not exist and it is dropped on the floor - which is
  // exactly what shipped in every build up to and including build 51.
  check(
    /func\s+application\s*\(\s*_\s+\w+\s*:\s*UIApplication\s*,\s*didRegisterForRemoteNotificationsWithDeviceToken/.test(appDelegate),
    "AppDelegate implements didRegisterForRemoteNotificationsWithDeviceToken (WITHOUT THIS NO PUSH CAN EVER ARRIVE)",
  );
  check(
    /func\s+application\s*\(\s*_\s+\w+\s*:\s*UIApplication\s*,\s*didFailToRegisterForRemoteNotificationsWithError/.test(appDelegate),
    "AppDelegate implements didFailToRegisterForRemoteNotificationsWithError",
  );

  // A3/A4: implementing them is not enough - they must POST on the exact NotificationCenter
  // names the plugin observes in its load(). A hand-rolled variant that stores the token
  // somewhere else would compile, run, and still never reach the JS 'registration' listener.
  check(
    /NotificationCenter\.default\.post\(\s*name:\s*\.capacitorDidRegisterForRemoteNotifications/.test(appDelegate),
    "the token is posted as .capacitorDidRegisterForRemoteNotifications (the exact name PushNotificationsPlugin.load() observes)",
  );
  check(
    /NotificationCenter\.default\.post\(\s*name:\s*\.capacitorDidFailToRegisterForRemoteNotifications/.test(appDelegate),
    "registration failures are posted as .capacitorDidFailToRegisterForRemoteNotifications",
  );

  // A5: the plugin really is the one that listens on those names - guards against a Capacitor
  // major bump quietly changing the contract underneath us.
  const pluginSrc = read("app/node_modules/@capacitor/push-notifications/ios/Sources/PushNotificationsPlugin/PushNotificationsPlugin.swift");
  check(
    pluginSrc.includes(".capacitorDidRegisterForRemoteNotifications") && /notifyListeners\("registration"/.test(pluginSrc),
    "the installed plugin still bridges that notification to the JS 'registration' event (contract unchanged)",
  );

  // A6: nothing else supplies the token - Capacitor does not swizzle the app delegate for
  // remote notifications. If a future version ever does, this check is the place to revisit.
  const capDir = path.join(REPO, "app/node_modules/@capacitor/ios/Capacitor/Capacitor");
  const capFiles = fs.existsSync(capDir) ? fs.readdirSync(capDir) : [];
  const capSwizzlesPush = capFiles.some((f) => {
    if (!/\.(swift|m)$/.test(f)) return false;
    const s = fs.readFileSync(path.join(capDir, f), "utf8");
    return s.includes("didRegisterForRemoteNotifications") && /swizzl|method_exchangeImplementations/.test(s);
  });
  check(!capSwizzlesPush, "Capacitor core does NOT swizzle push registration - the AppDelegate methods above are genuinely required");

  // A7: the entitlement. Production APNs host + TestFlight/App Store builds need exactly this.
  const ents = read("app/ios/App/App/App.entitlements");
  check(/<key>aps-environment<\/key>\s*<string>production<\/string>/.test(ents), "App.entitlements declares aps-environment = production (matches api.push.apple.com)");

  // A8: the plugin is actually installed in the native project, not just in package.json.
  check(/pod 'CapacitorPushNotifications'/.test(read("app/ios/App/Podfile")), "CapacitorPushNotifications pod is in the Podfile");

  // A9: the JS half still calls register() and forwards the token. This is READ-ONLY on
  // index.html - the audit must never edit that file, only assert against it.
  const idx = read("index.html");
  check(/PushNotifications\.addListener\('registration'/.test(idx), "index.html listens for the plugin's 'registration' event");
  check(/netSend\(\{type:'registerPush'/.test(idx), "index.html forwards the device token to the server as {type:'registerPush'}");
  check(/registerPushIfGranted\(\)/.test(idx), "index.html re-registers on every launch when permission is already granted");
}

/* =========================================================================================
 * B. THE SILENCE - /admin/push, so the next failure is visible without reading cloud logs.
 * ======================================================================================= */
let stdoutBuf = "";
function startServer() {
  let child;
  if (KIND === "deno") {
    child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
      cwd: path.join(REPO, "server/cloud"),
      env: Object.assign({}, process.env, { NASTY_PORT: String(PORT), NASTY_KV_PATH: path.join(SCRATCH, "t.kv"), NASTY_ADMIN_TOKEN: ADMIN_TOKEN }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    fs.writeFileSync(path.join(SCRATCH, "admin-token.txt"), ADMIN_TOKEN + "\n");
    child = spawn(process.execPath, ["server.js"], {
      cwd: path.join(REPO, "server"),
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
    const to = setTimeout(() => { ws.removeListener("message", onMsg); reject(new Error("timeout waiting for message")); }, timeoutMs);
    function onMsg(raw) {
      const m = JSON.parse(raw.toString());
      if (!predicate || predicate(m)) { clearTimeout(to); ws.removeListener("message", onMsg); resolve(m); }
    }
    ws.on("message", onMsg);
  });
}
const sendJ = (ws, obj) => ws.send(JSON.stringify(obj));
const adminPush = async () => await (await fetch(BASE + "/admin/push", { headers: { "x-admin-token": ADMIN_TOKEN } })).json();

async function partB() {
  log("--- B. /admin/push observability (live server) ---");
  const child = startServer();
  await waitHealthy();

  const unauth = await fetch(BASE + "/admin/push");
  check(unauth.status === 401, "/admin/push refuses an unauthenticated request");

  const before = await adminPush();
  check(typeof before.keyLoaded === "boolean", "/admin/push reports whether APNs key material is loaded at all");
  check(before.host === "https://api.push.apple.com", "/admin/push reports the PRODUCTION APNs host (a sandbox host here would mean TestFlight/App Store pushes silently vanish)");
  check(before.topic === "com.pangman.nasty", "/admin/push reports the bundle id as the APNs topic");
  check(before.playersWithToken === 0, "no player has a push token on a fresh server");
  check(!/BEGIN|PRIVATE KEY/.test(JSON.stringify(before)), "/admin/push leaks no key material");

  // Drive one real turn-start push attempt, exactly as test_push_notifications.js does.
  const ws = await wsConnect();
  const seats = [
    { name: "AuditPusher", type: "human", diff: "medium" },
    { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
  ];
  sendJ(ws, { type: "host", protocolVersion: 5, name: "AuditPusher", n: 4, teams: false, seats });
  await nextMsg(ws, (m) => m.type === "created");
  sendJ(ws, { type: "registerPush", token: "AUDIT-DEVICE-TOKEN-" + Date.now(), platform: "ios" });
  await new Promise((r) => setTimeout(r, 300));

  const withToken = await adminPush();
  check(withToken.playersWithToken === 1, "/admin/push counts a player who has registered a token (this is the number that was ZERO for every real player in prod)");

  sendJ(ws, { type: "start", protocolVersion: 5 });
  await nextMsg(ws, (m) => m.type === "gameAction" && m.action.kind === "start");
  await new Promise((r) => setTimeout(r, 700));
  ws.close();
  await new Promise((r) => setTimeout(r, 2000));

  const after = await adminPush();
  check(
    (after.attempts + after.skippedNoKey) > (before.attempts + before.skippedNoKey),
    "a turn-start push attempt is COUNTED, not just logged",
  );
  check(!!after.lastAttemptAt, "/admin/push records when the last attempt happened");
  if (after.keyLoaded) {
    // With the real key present the attempt reaches Apple, which rejects a fake token. That
    // rejection is itself the proof the key/JWT/team/topic are all valid - but note it is a
    // FAILURE, and the point of this check is that a failure is now VISIBLE and attributable
    // rather than dissolving into an unread log line.
    check(after.rejected + after.failed + after.delivered > 0, "a real send outcome (delivered/rejected/failed) is recorded when the key is present");
    check(after.lastStatus !== null || after.lastReason !== null, "the outcome carries a status and/or Apple's reason word, so a bad key is diagnosable without log access");
  } else {
    check(after.skippedNoKey > 0, "with no key present the no-op path is counted as skippedNoKey");
  }

  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 400));
}

async function main() {
  partA();
  await partB();
  log(`\n[${KIND}] ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
