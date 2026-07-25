"use strict";
/*
 * 2026-07-25 § ACCOUNTS - HELPER, NOT A SUITE. Do not run this directly; it exports nothing but
 * plumbing for the three test_accounts_*.js suites.
 *
 * The whole point of this file is that Apple's identity tokens are verified WITHOUT EVER
 * CONTACTING APPLE. It:
 *   - generates a throwaway RSA-2048 key pair (two of them, so key rotation and "signed with the
 *     wrong key" are both testable),
 *   - stands up a tiny local HTTP server on its own random port that serves a JWKS document in
 *     exactly the shape https://appleid.apple.com/auth/keys serves,
 *   - mints identity tokens locally with those keys,
 * and the suites then boot the server under test with NASTY_APPLE_JWKS_URL pointed at that local
 * server. No network, no Apple, fully deterministic, works offline.
 *
 * Same hygiene as every other suite in this directory (see README.md): private random port,
 * scratch NASTY_ROOMS_DIR / NASTY_KV_PATH / leaderboard file / account files, throwaway admin
 * token. Nothing here ever touches production, the real rooms dir, server/leaderboard.json, or
 * the default KV.
 */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");

const SERVER_DIR = "/Users/jarvis/nasty-game/server";
const CLOUD_DIR = "/Users/jarvis/nasty-game/server/cloud";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* --- keys + the local JWKS server ------------------------------------------------------ */
function makeKeyPair(kid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    kid,
    privateKey,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    // Exactly the shape Apple publishes: kty/kid/use/alg/n/e.
    jwk: { kty: jwk.kty, kid, use: "sig", alg: "RS256", n: jwk.n, e: jwk.e },
  };
}

// The served key set is mutable so a suite can simulate Apple rotating its signing keys mid-run.
function startJwksServer(initialKeys) {
  let keys = initialKeys.slice();
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: keys.map((k) => k.jwk) }));
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      resolve({
        url: `http://127.0.0.1:${port}/keys`,
        setKeys(next) { keys = next.slice(); },
        hits() { return hits; },
        close() { try { srv.close(); } catch (e) {} },
      });
    });
  });
}

/* --- minting identity tokens ----------------------------------------------------------- */
// Everything is overridable so each negative case can break exactly ONE thing and nothing else.
function mintIdentityToken(key, opts) {
  const o = opts || {};
  const nowSec = Math.floor(Date.now() / 1000);
  const header = Object.assign({ alg: "RS256", kid: key.kid, typ: "JWT" }, o.header || {});
  const payload = Object.assign({
    iss: o.iss !== undefined ? o.iss : "https://test.local",
    aud: o.aud !== undefined ? o.aud : "com.pangman.nasty",
    exp: o.exp !== undefined ? o.exp : nowSec + 600,
    iat: o.iat !== undefined ? o.iat : nowSec,
    sub: o.sub !== undefined ? o.sub : "001111.testsub.0000",
    nonce: o.nonce,
  }, o.extra || {});
  if (o.dropSub) delete payload.sub;
  if (o.dropNonce) delete payload.nonce;
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const signingInput = h + "." + p;

  if (o.alg === "none") return h + "." + p + ".";
  if (o.alg === "hs256") {
    // The classic alg-confusion attack: an HS256 token MAC'd with the RSA PUBLIC key as the
    // shared secret. A verifier that branches on the header's `alg` accepts this.
    const mac = crypto.createHmac("sha256", (o.hmacKey || key).publicKeyPem).update(signingInput).digest();
    return signingInput + "." + b64url(mac);
  }
  const signWith = o.signWith || key;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(signingInput, "ascii"), signWith.privateKey);
  return signingInput + "." + b64url(sig);
}

/* --- the server under test ------------------------------------------------------------- */
// One scratch directory per suite run; every storage path the server knows about is pointed
// inside it, so a suite can never write to a real file or the default KV.
function makeScratch(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `nasty-${tag}-`)); }

function serverEnv(kind, scratch, port, adminToken, extra) {
  const base = { NASTY_PORT: String(port) };
  if (kind === "deno") {
    Object.assign(base, {
      NASTY_KV_PATH: path.join(scratch, "test.kv"),
      NASTY_ADMIN_TOKEN: adminToken,
    });
  } else {
    fs.writeFileSync(path.join(scratch, "admin-token.txt"), adminToken + "\n");
    Object.assign(base, {
      NASTY_ROOMS_DIR: path.join(scratch, "rooms"),
      NASTY_ADMIN_TOKEN_FILE: path.join(scratch, "admin-token.txt"),
      NASTY_LEADERBOARD_FILE: path.join(scratch, "leaderboard.json"),
      NASTY_LEADERBOARD_EPOCH_FILE: path.join(scratch, "leaderboard-epoch.json"),
      NASTY_SOLO_IDS_FILE: path.join(scratch, "solo-ids.json"),
      NASTY_ACCOUNTS_FILE: path.join(scratch, "accounts.json"),
      NASTY_ACCOUNT_INDEX_FILE: path.join(scratch, "account-index.json"),
      NASTY_SESSIONS_FILE: path.join(scratch, "sessions.json"),
      NASTY_AUTH_NONCES_FILE: path.join(scratch, "auth-nonces.json"),
      NASTY_ACCOUNTS_LEADERBOARD_FILE: path.join(scratch, "accounts-leaderboard.json"),
      NASTY_ACCOUNT_CLAIMS_FILE: path.join(scratch, "claims.json"),
    });
  }
  return Object.assign({}, process.env, base, extra || {});
}

function startServer(kind, env, verboseEnvName) {
  let child;
  if (kind === "deno") {
    child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"],
      { cwd: CLOUD_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  } else {
    child = spawn(process.execPath, ["server.js"], { cwd: SERVER_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  }
  child.stdout.on("data", (d) => { if (verboseEnvName && process.env[verboseEnvName]) process.stdout.write("[srv] " + d); });
  child.stderr.on("data", (d) => { if (verboseEnvName && process.env[verboseEnvName]) process.stderr.write("[srv-err] " + d); });
  return child;
}
async function waitHealthy(base, tries) {
  for (let i = 0; i < (tries || 50); i++) {
    try { const r = await fetch(base + "/health"); if (r.ok) return true; } catch (e) {}
    await sleep(300);
  }
  throw new Error("server never became healthy at " + base);
}
async function stopServer(child, ms) {
  if (!child) return;
  child.kill("SIGTERM");
  await sleep(ms || 700);
  try { child.kill("SIGKILL"); } catch (e) {}
}

/* --- the account client, i.e. what a future index.html will do ------------------------- */
function makeClient(base) {
  async function post(pathname, body) {
    const r = await fetch(base + pathname, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    let json = null;
    try { json = await r.json(); } catch (e) {}
    return { status: r.status, body: json };
  }
  async function get(pathname) {
    const r = await fetch(base + pathname);
    let json = null, text = null;
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("json")) { try { json = await r.json(); } catch (e) {} }
    else { try { text = await r.text(); } catch (e) {} }
    return { status: r.status, body: json, text, headers: r.headers };
  }
  return {
    get, post,
    async nonce() { const r = await get("/account/nonce"); return r.body && r.body.nonce; },
    // The whole happy path in one call: fetch a nonce, mint a token for it, present it.
    async signIn(key, opts) {
      const nonce = await this.nonce();
      const token = mintIdentityToken(key, Object.assign({ nonce }, opts || {}));
      return await post("/account/apple", { identityToken: token, nonce, platform: "ios" });
    },
  };
}

module.exports = {
  SERVER_DIR, CLOUD_DIR, sleep, b64url,
  makeKeyPair, startJwksServer, mintIdentityToken,
  makeScratch, serverEnv, startServer, waitHealthy, stopServer, makeClient,
  spawnSync,
};
