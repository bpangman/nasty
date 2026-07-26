"use strict";
/*
 * NASTY push notifications (Node/dev server) - v0.16 item 5: "It's your turn in NASTY."
 *
 * Sends a real APNs push over HTTP/2 with a short-lived ES256 JWT, using ONLY Node's built-in
 * http2/crypto modules - no new dependency, matches this file's "core modules only" style.
 *
 * Blake's Apple Developer account does not have an APNs Auth Key yet (creating one needs a
 * human clicking through the Apple Developer portal - see PLANNING.md/HANDOFF.md for the exact
 * click-by-click steps), so this whole module is built to NO-OP GRACEFULLY when the key files
 * are missing: it logs exactly what it would have sent, at exactly the moment it would have
 * sent it, and does nothing else. The moment server/apns-key.p8 + server/apns-key-id.txt exist
 * on disk, the real send path activates automatically on the next server restart - no code
 * change needed, see loadKey() below.
 *
 * Key ID:   server/apns-key-id.txt (plain text - the 10-character Key ID Apple shows once on
 *           the key's creation page)
 * Key file: server/apns-key.p8 (the .p8 file Apple lets you download exactly once)
 * Team ID:  YJU5U6VX8V (Blake's Apple Developer Team ID - fixed, not a secret)
 * Topic:    com.pangman.nasty (the app's bundle id - APNs requires this on every request)
 * Host:     api.push.apple.com (production - matches the "production" aps-environment
 *           entitlement this app ships for App Store distribution, see app/ios/App/App/
 *           App.entitlements)
 *
 * Secrets hygiene (standing repo rule): NEVER log the key file's contents or a generated JWT.
 * A device push token is logged in full on the no-op line (it's an opaque per-install
 * identifier scoped to this one app, not a secret - same sensitivity as a room code), but
 * never alongside key material.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http2 = require("http2");

const KEY_PATH = path.join(__dirname, "apns-key.p8");
const KEY_ID_PATH = path.join(__dirname, "apns-key-id.txt");
const TEAM_ID = "YJU5U6VX8V";
const TOPIC = "com.pangman.nasty";
const APNS_HOST = "https://api.push.apple.com";
const JWT_MAX_AGE_MS = 45 * 60 * 1000; // Apple allows reusing a token up to ~60 min; refresh early

function log(...a) { console.log(new Date().toISOString(), "[apns]", ...a); }

/* ---------------------------------------------------------------------------------------
 * OUTCOME COUNTERS (2026-07-26 push audit). Everything in this module used to be log-only,
 * and nobody reads Deno Deploy logs - so for a week "push is live" was believed while ZERO
 * real pushes had ever been sent, and a revoked key or an Apple-rejected token would have
 * been equally invisible. These counters are the cheap fix: they turn "did a push actually
 * get delivered" into a single admin GET (/admin/push) instead of a log archaeology dig.
 * In-memory and per-process on purpose - this is a live health signal, not an audit trail,
 * and it must never add I/O to a gameplay path.
 * ------------------------------------------------------------------------------------- */
const stats = {
  attempts: 0,        // sendTurnPush() calls that had a token to send to
  delivered: 0,       // APNs answered 2xx
  rejected: 0,        // APNs answered non-2xx (bad token, bad key, bad topic...)
  failed: 0,          // never reached APNs (network/TLS/crypto threw)
  skippedNoKey: 0,    // no key material - the graceful no-op path
  lastStatus: null,   // HTTP status of the most recent APNs answer
  lastReason: null,   // Apple's `reason` string (or the thrown message) from the last failure
  lastAttemptAt: null,
  lastDeliveredAt: null,
  lastFailureAt: null,
};
function getApnsStats() {
  const k = loadKey();
  return Object.assign({
    keyLoaded: !!k,
    keyId: k ? k.keyId : null,   // an identifier, not a secret - already logged in plaintext above
    teamId: TEAM_ID,
    topic: TOPIC,
    host: APNS_HOST,
  }, stats);
}
// Apple's error body is {"reason":"BadDeviceToken"} - pull just that word out, never echo a
// whole response body into a diagnostic surface.
function reasonOf(body) {
  try { const r = JSON.parse(body).reason; return typeof r === "string" ? r : null; } catch (e) { return null; }
}

// undefined = not checked yet, null = confirmed unavailable, {key,keyId} = loaded and cached.
let cached = undefined;
function loadKey() {
  if (cached !== undefined) return cached;
  try {
    const key = fs.readFileSync(KEY_PATH, "utf8");
    const keyId = fs.readFileSync(KEY_ID_PATH, "utf8").trim();
    if (!key || !keyId) { cached = null; return cached; }
    cached = { key, keyId };
    log("APNs key loaded - real push delivery is ACTIVE (key id " + keyId + ")");
  } catch (e) {
    cached = null; // one or both files missing - the expected state until Blake adds the key
  }
  return cached;
}
function apnsAvailable() { return !!loadKey(); }

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
let cachedJwt = null, cachedJwtAt = 0;
function buildJwt() {
  const now = Date.now();
  if (cachedJwt && now - cachedJwtAt < JWT_MAX_AGE_MS) return cachedJwt;
  const k = loadKey();
  if (!k) return null;
  const header = { alg: "ES256", kid: k.keyId };
  const payload = { iss: TEAM_ID, iat: Math.floor(now / 1000) };
  const signingInput = base64url(JSON.stringify(header)) + "." + base64url(JSON.stringify(payload));
  // ES256 JWTs need the raw r||s signature (64 bytes), not the DER encoding node's crypto
  // module defaults to for EC keys - dsaEncoding:'ieee-p1363' gives the raw form directly.
  const signature = crypto.sign("sha256", Buffer.from(signingInput), { key: k.key, dsaEncoding: "ieee-p1363" });
  cachedJwt = signingInput + "." + base64url(signature);
  cachedJwtAt = now;
  return cachedJwt;
}

function sendViaHttp2(deviceToken, payloadObj, jwt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payloadObj);
    let client;
    try { client = http2.connect(APNS_HOST); } catch (e) { reject(e); return; }
    client.on("error", (e) => reject(e));
    const req = client.request({
      ":method": "POST",
      ":path": "/3/device/" + deviceToken,
      "authorization": "bearer " + jwt,
      "apns-topic": TOPIC,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    });
    let status = null;
    req.on("response", (headers) => { status = headers[":status"]; });
    let resBody = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { resBody += chunk; });
    req.on("end", () => { try { client.close(); } catch (e) {} resolve({ status, body: resBody }); });
    req.on("error", (e) => { try { client.close(); } catch (e2) {} reject(e); });
    req.end(body);
  });
}

/*
 * sendTurnPush({token, playerName, title, body}) - the one function server.js calls when a
 * human seat's turn starts and that seat's socket is dead. No-ops (loud log line, no network
 * call) until the key files exist; sends a real APNs alert push once they do. Never throws -
 * a push failure/misconfiguration must never be allowed to affect gameplay, so every failure
 * path resolves {ok:false,...} instead of rejecting.
 */
async function sendTurnPush({ token, playerName, title, body }) {
  if (!apnsAvailable()) {
    stats.skippedNoKey++; stats.lastAttemptAt = new Date().toISOString();
    log(`would send push to token ${token} for player ${playerName}`);
    return { ok: false, skipped: true };
  }
  stats.attempts++; stats.lastAttemptAt = new Date().toISOString();
  try {
    const jwt = buildJwt();
    if (!jwt) {
      stats.skippedNoKey++;
      log(`would send push to token ${token} for player ${playerName}`);
      return { ok: false, skipped: true };
    }
    const payload = { aps: { alert: { title, body }, sound: "default" } };
    const res = await sendViaHttp2(token, payload, jwt);
    if (res.status && Number(res.status) >= 200 && Number(res.status) < 300) {
      stats.delivered++; stats.lastStatus = Number(res.status); stats.lastDeliveredAt = new Date().toISOString();
      log("push sent", "player=" + playerName, "status=" + res.status);
      return { ok: true };
    }
    stats.rejected++; stats.lastStatus = Number(res.status) || null;
    stats.lastReason = reasonOf(res.body); stats.lastFailureAt = new Date().toISOString();
    log("push rejected by APNs", "player=" + playerName, "status=" + res.status, res.body);
    return { ok: false, status: res.status };
  } catch (e) {
    stats.failed++; stats.lastReason = e.message; stats.lastFailureAt = new Date().toISOString();
    log("push send failed", "player=" + playerName, e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { apnsAvailable, sendTurnPush, getApnsStats };
