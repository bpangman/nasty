// NASTY push notifications (Deno/cloud) - v0.16 item 5 twin of ../apns.js. See that file's
// header for the full design rationale (no-op-until-key-exists, ES256 JWT, secrets hygiene).
// This port uses `fetch` (Deno negotiates HTTP/2 automatically over TLS when the remote offers
// it via ALPN, which api.push.apple.com does - APNs requires HTTP/2, no HTTP/1.1 fallback
// exists) and `crypto.subtle` for the ES256 signature instead of Node's http2/crypto modules.
//
// Key material on Deno Deploy: unlike the Node/Mac-Mini server, the cloud deploy has no
// writable/bundlable local file for a secret (server/apns-key.p8 lives OUTSIDE server/cloud/,
// so a `deno deploy .` source-local deploy from server/cloud never uploads it anyway - by
// construction, not an oversight). Real production key material comes from TWO Deno Deploy
// SECRET env vars instead, the exact same pattern this file already uses for
// NASTY_ADMIN_TOKEN (see HANDOFF.md's "Admin token" note and the "deno deploy env add" recipe):
//   NASTY_APNS_KEY     - the FULL CONTENTS of the .p8 key file
//   NASTY_APNS_KEY_ID  - the Key ID string
// For local dev/testing (a plain `deno run` against a private test port, never prod) this also
// falls back to reading ../apns-key.p8 / ../apns-key-id.txt directly, so a local test server
// behaves identically to server.js without needing env vars set.
const TEAM_ID = "YJU5U6VX8V";
const TOPIC = "com.pangman.nasty";
const APNS_HOST = "https://api.push.apple.com";
const JWT_MAX_AGE_MS = 45 * 60 * 1000; // Apple allows reusing a token up to ~60 min; refresh early

function log(...a: unknown[]) { console.log(new Date().toISOString(), "[apns]", ...a); }

type KeyInfo = { key: string; keyId: string };
// undefined = not checked yet, null = confirmed unavailable, KeyInfo = loaded and cached.
let cached: KeyInfo | null | undefined = undefined;
function loadKey(): KeyInfo | null {
  if (cached !== undefined) return cached;
  const envKey = Deno.env.get("NASTY_APNS_KEY");
  const envKeyId = Deno.env.get("NASTY_APNS_KEY_ID");
  if (envKey && envKeyId) {
    cached = { key: envKey, keyId: envKeyId.trim() };
    log("APNs key loaded from NASTY_APNS_KEY env - real push delivery is ACTIVE (key id " + cached.keyId + ")");
    return cached;
  }
  try {
    const key = Deno.readTextFileSync(new URL("../apns-key.p8", import.meta.url));
    const keyId = Deno.readTextFileSync(new URL("../apns-key-id.txt", import.meta.url)).trim();
    if (key && keyId) {
      cached = { key, keyId };
      log("APNs key loaded from local file - real push delivery is ACTIVE (key id " + keyId + ")");
      return cached;
    }
  } catch (_e) { /* not present - the expected state until Blake adds the key/secret */ }
  cached = null;
  return cached;
}
export function apnsKeyAvailable(): boolean { return !!loadKey(); }

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pemToPkcs8Der(pem: string): Uint8Array {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
let cachedCryptoKey: CryptoKey | null = null;
async function getSigningKey(pem: string): Promise<CryptoKey> {
  if (cachedCryptoKey) return cachedCryptoKey;
  const der = pemToPkcs8Der(pem);
  cachedCryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    der as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return cachedCryptoKey;
}
let cachedJwt: string | null = null, cachedJwtAt = 0;
async function buildJwt(): Promise<string | null> {
  const now = Date.now();
  if (cachedJwt && now - cachedJwtAt < JWT_MAX_AGE_MS) return cachedJwt;
  const k = loadKey();
  if (!k) return null;
  const header = { alg: "ES256", kid: k.keyId };
  const payload = { iss: TEAM_ID, iat: Math.floor(now / 1000) };
  const enc = new TextEncoder();
  const signingInput = base64url(enc.encode(JSON.stringify(header))) + "." +
    base64url(enc.encode(JSON.stringify(payload)));
  const cryptoKey = await getSigningKey(k.key);
  // ES256 JWTs need the raw r||s signature (64 bytes) - Web Crypto's ECDSA sign already
  // produces that raw form (unlike Node's default DER encoding, which needed an explicit
  // dsaEncoding override in ../apns.js - no equivalent flag needed here).
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, cryptoKey, enc.encode(signingInput));
  cachedJwt = signingInput + "." + base64url(new Uint8Array(sig));
  cachedJwtAt = now;
  return cachedJwt;
}

/*
 * sendTurnPush({token, playerName, title, body}) - the one function server.ts calls when a
 * human seat's turn starts and that seat's socket is dead. No-ops (loud log line, no network
 * call) until the key is available; sends a real APNs alert push once it is. Never throws.
 */
export async function sendTurnPush(
  opts: { token: string; playerName: string; title: string; body: string },
): Promise<{ ok: boolean }> {
  const { token, playerName, title, body } = opts;
  if (!apnsKeyAvailable()) {
    log(`would send push to token ${token} for player ${playerName}`);
    return { ok: false };
  }
  try {
    const jwt = await buildJwt();
    if (!jwt) { log(`would send push to token ${token} for player ${playerName}`); return { ok: false }; }
    const res = await fetch(`${APNS_HOST}/3/device/${token}`, {
      method: "POST",
      headers: {
        "authorization": "bearer " + jwt,
        "apns-topic": TOPIC,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
      },
      body: JSON.stringify({ aps: { alert: { title, body }, sound: "default" } }),
    });
    if (res.ok) { log("push sent", "player=" + playerName, "status=" + res.status); return { ok: true }; }
    const text = await res.text().catch(() => "");
    log("push rejected by APNs", "player=" + playerName, "status=" + res.status, text);
    return { ok: false };
  } catch (e) {
    log("push send failed", "player=" + playerName, (e as Error).message);
    return { ok: false };
  }
}
