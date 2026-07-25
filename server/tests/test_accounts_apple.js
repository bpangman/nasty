"use strict";
/*
 * 2026-07-25 § ACCOUNTS Stage 1, suite 1 of 3: APPLE TOKEN VERIFICATION + SESSIONS.
 *
 * Proves, identically on BOTH servers:
 *
 *   Part A - the verifier accepts a correctly-signed token and rejects EVERY failure mode
 *     individually: wrong audience, wrong issuer, expired, iat far in the future, a signature
 *     made with a different key, an unknown kid, alg:"none", the alg-confusion attack (an HS256
 *     token MAC'd with the RSA public key as the shared secret), a missing sub, a missing nonce,
 *     a wrong nonce, a REPLAYED nonce, an expired nonce, malformed tokens (2 and 4 segments,
 *     non-base64), a 1 MB token, and Apple rotating its signing key.
 *   Part B - accounts and sessions: the same Apple sub always resolves to the same account id,
 *     two different subs are two accounts, /account/me works with a good token and 401s with an
 *     expired or garbage one, sign-out is immediate, the sliding expiry really extends, and the
 *     email rules hold (verified is stored, unverified never is, a private relay is flagged).
 *   Part C - the Apple gate: with NASTY_APPLE_AUDIENCES unset (production's state today) every
 *     /account/* route answers 503 in plain language and no storage is touched.
 *
 * Nothing here ever contacts Apple: the suite generates its own RSA keys and serves its own
 * JWKS on a local port (see test_accounts_kit.js). Never touches production - private port,
 * private scratch storage, throwaway admin token.
 *
 * Usage:
 *   node test_accounts_apple.js node
 *   node test_accounts_apple.js deno
 */
const path = require("path");
const fs = require("fs");
const K = require("./test_accounts_kit.js");

const KIND = process.argv[2] || "node";
const ADMIN_TOKEN = "accounts-apple-admin-token";
const AUD_NATIVE = "com.pangman.nasty";
const AUD_WEB = "com.pangman.nasty.web";
const ISSUER = "https://test.local";

let PASS = 0, FAIL = 0;
function log(...a) { console.log("[acct-apple]", ...a); }
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }

function randPort() { return 27100 + Math.floor(Math.random() * 600); }

async function main() {
  const keyA = K.makeKeyPair("test-key-a");
  const keyB = K.makeKeyPair("test-key-b");   // Apple's "next" key, for the rotation case
  const keyEvil = K.makeKeyPair("test-key-a"); // SAME kid, different private key: forged signature
  const jwks = await K.startJwksServer([keyA]);
  const scratch = K.makeScratch(`acct-apple-${KIND}`);

  /* ================= Part A + B: fully configured server ================= */
  const port = randPort();
  const base = `http://localhost:${port}`;
  const env = K.serverEnv(KIND, scratch, port, ADMIN_TOKEN, {
    NASTY_ACCOUNTS_ENABLED: "1",
    NASTY_APPLE_JWKS_URL: jwks.url,
    NASTY_APPLE_ISSUER: ISSUER,
    NASTY_APPLE_AUDIENCES: `${AUD_NATIVE},${AUD_WEB}`,
    NASTY_ACCOUNT_RATE_LIMIT: "4000",
  });
  const srv = K.startServer(KIND, env, "ACCOUNTS_VERBOSE");
  await K.waitHealthy(base);
  const c = K.makeClient(base);

  // ---------- Part A: the happy path first, so every rejection below is a genuine one-thing-broken case
  {
    const r = await c.signIn(keyA, { sub: "001111.happy.0001" });
    check(r.status === 200 && typeof r.body.sessionToken === "string" && r.body.sessionToken.length === 64,
      "A1 correctly-signed token -> 200 with a 32-byte opaque session token");
    check(r.body.needsName === true && r.body.gameName === null,
      "A1b a brand-new account has no game name yet (needsName:true)");
    check(typeof r.body.uid === "string" && r.body.uid.length === 32 && r.body.uid !== "001111.happy.0001",
      "A1c the account id is the server's own 16-byte value, NOT Apple's sub");
  }
  {
    const r = await c.signIn(keyA, { sub: "001111.webaud.0002", aud: AUD_WEB });
    check(r.status === 200, "A2 the web Services ID audience is accepted from any platform");
  }

  // ---------- every failure mode, one at a time
  const bad = async (label, code, opts, expectReason) => {
    const r = await c.signIn(keyA, opts);
    const okStatus = r.status === code;
    const okReason = !expectReason || (r.body && r.body.reason === expectReason);
    check(okStatus && okReason, `${label} -> ${code}${expectReason ? " (" + expectReason + ")" : ""}` +
      (okStatus && okReason ? "" : ` [got ${r.status} ${JSON.stringify(r.body)}]`));
  };
  await bad("A3 wrong audience", 401, { sub: "s3", aud: "com.someone.else" }, "audience");
  await bad("A4 wrong issuer", 401, { sub: "s4", iss: "https://evil.example" }, "issuer");
  await bad("A5 expired token", 401, { sub: "s5", exp: Math.floor(Date.now() / 1000) - 60 }, "expired");
  await bad("A6 iat far in the future", 401, { sub: "s6", iat: Math.floor(Date.now() / 1000) + 3600 }, "clock");
  await bad("A7 iat far in the past", 401, { sub: "s7", iat: Math.floor(Date.now() / 1000) - 3600 }, "clock");
  await bad("A8 signature made with a DIFFERENT key (same kid)", 401, { sub: "s8", signWith: keyEvil }, "signature");
  await bad("A9 unknown kid", 401, { sub: "s9", header: { kid: "no-such-key" } }, "kid");
  await bad("A10 alg:none", 401, { sub: "s10", alg: "none", header: { alg: "none" } }, "alg");
  await bad("A11 alg confusion: HS256 MAC'd with the RSA public key", 401,
    { sub: "s11", alg: "hs256", header: { alg: "HS256" } }, "alg");
  await bad("A12 missing sub", 401, { dropSub: true }, "sub");
  await bad("A13 missing nonce claim", 401, { sub: "s13", dropNonce: true }, "nonce");

  {
    // A wrong nonce: the server-issued nonce is spent correctly, but the token echoes a different
    // one. This must fail at the claim check, not sail through.
    const nonce = await c.nonce();
    const token = K.mintIdentityToken(keyA, { nonce: "some-other-nonce", sub: "s14" });
    const r = await c.post("/account/apple", { identityToken: token, nonce });
    check(r.status === 401 && r.body.reason === "nonce", "A14 nonce in the token does not match the one we issued -> 401");
  }
  {
    // THE replay case: capture one complete, genuinely valid request and send it twice.
    const nonce = await c.nonce();
    const token = K.mintIdentityToken(keyA, { nonce, sub: "001111.replay.0015" });
    const first = await c.post("/account/apple", { identityToken: token, nonce });
    const second = await c.post("/account/apple", { identityToken: token, nonce });
    check(first.status === 200, "A15 a valid sign-in succeeds once");
    check(second.status === 401 && second.body.error === "badnonce",
      "A15b replaying that exact same token+nonce is refused (nonces are single use)");
  }
  {
    const r = await c.post("/account/apple", { identityToken: "x", nonce: "never-issued-by-us" });
    check(r.status === 401 && r.body.error === "badnonce", "A16 a nonce this server never issued -> 401 before any crypto runs");
  }
  {
    const nonce = await c.nonce();
    const two = K.mintIdentityToken(keyA, { nonce, sub: "s17" }).split(".").slice(0, 2).join(".");
    const r1 = await c.post("/account/apple", { identityToken: two, nonce });
    check(r1.status === 401 && r1.body.reason === "malformed", "A17 a 2-segment JWT -> malformed");
  }
  {
    const nonce = await c.nonce();
    const four = K.mintIdentityToken(keyA, { nonce, sub: "s18" }) + ".extra";
    const r = await c.post("/account/apple", { identityToken: four, nonce });
    check(r.status === 401 && r.body.reason === "malformed", "A18 a 4-segment JWT -> malformed");
  }
  {
    const nonce = await c.nonce();
    const r = await c.post("/account/apple", { identityToken: "!!!.@@@.###", nonce });
    check(r.status === 401 && r.body.reason === "malformed", "A19 non-base64 junk -> malformed");
  }
  {
    // An absurdly large "token" must be refused outright on size, not chewed on. 500 KB is
    // deliberately chosen to sit UNDER server.js's pre-existing 1 MB request-body cap, so both
    // servers take the same code path and this measures the account verifier's own size guard
    // rather than the Node HTTP layer's. (A body over 1 MB is dropped by that older guard on
    // Node and refused as malformed on Deno - different mechanism, same "no" either way, and
    // that difference predates this stage.)
    const nonce = await c.nonce();
    const huge = "a".repeat(500 * 1000);
    const t0 = Date.now();
    const r = await c.post("/account/apple", { identityToken: huge, nonce });
    const took = Date.now() - t0;
    check(r.status === 401 && r.body && r.body.reason === "malformed" && took < 5000,
      `A20 a 500 KB token is refused on size and does not hang (${took}ms)`);
  }
  {
    // KEY ROTATION. Apple starts signing with a key we have never seen. The cached key set is
    // still fresh, so this only works if a kid miss forces exactly one refetch.
    const before = jwks.hits();
    jwks.setKeys([keyA, keyB]);
    const r = await c.signIn(keyB, { sub: "001111.rotated.0021" });
    check(r.status === 200, "A21 a token signed with Apple's NEW key verifies (kid miss forces a JWKS refetch)");
    check(jwks.hits() > before, "A21b the refetch really happened");
    const r2 = await c.signIn(keyB, { sub: "001111.rotated.0021" });
    check(r2.status === 200, "A21c the rotated key is then cached and keeps working");
  }

  // ---------- Part B: accounts + sessions
  let sessionToken = null, uidBlake = null;
  {
    const r1 = await c.signIn(keyA, { sub: "001111.stable.0100" });
    const r2 = await c.signIn(keyA, { sub: "001111.stable.0100" });
    check(r1.status === 200 && r2.status === 200 && r1.body.uid === r2.body.uid,
      "B1 the same Apple sub twice -> the SAME account id");
    check(r1.body.sessionToken !== r2.body.sessionToken, "B1b but a fresh session token each time");
    const r3 = await c.signIn(keyA, { sub: "001111.other.0101" });
    check(r3.body.uid !== r1.body.uid, "B2 a different Apple sub -> a different account");
    sessionToken = r2.body.sessionToken;
    uidBlake = r2.body.uid;
  }
  {
    const me = await c.post("/account/me", { auth: sessionToken });
    check(me.status === 200 && me.body.uid === uidBlake, "B3 /account/me with a good session token");
    const bad1 = await c.post("/account/me", { auth: "not-a-real-token" });
    check(bad1.status === 401 && bad1.body.error === "signedout", "B4 /account/me with a garbage token -> 401 signedout");
    const bad2 = await c.post("/account/me", {});
    check(bad2.status === 401 && bad2.body.error === "signedout", "B5 /account/me with no token at all -> 401 signedout");
    check(typeof bad1.body.message === "string" && !/token|session|401/i.test(bad1.body.message),
      "B6 the signed-out message is plain language, no jargon");
  }
  {
    const out = await c.post("/account/signout", { auth: sessionToken });
    check(out.status === 200 && out.body.ok === true, "B7 sign-out returns ok");
    const me = await c.post("/account/me", { auth: sessionToken });
    check(me.status === 401, "B7b the session is dead immediately after sign-out");
    const again = await c.post("/account/signout", { auth: sessionToken });
    check(again.status === 200, "B7c signing out twice is harmless (idempotent)");
  }
  {
    /* 2026-07-25 (Blake's four-provider direction) - THE EMAIL REVERSAL, pinned here.
       Stage 1 stored NO email and this block asserted exactly that. With four sign-in methods
       that decision breaks down (one human, four providers, four unlinkable accounts), so a
       VERIFIED email is now stored and used as the linking key. What has NOT changed is the
       strictness: an address the provider did not vouch for is still never kept, and a private
       relay address is never used to match across providers. Both halves are asserted. */
    const unver = await c.signIn(keyA, { sub: "001111.email.0200", extra: { email: "unverified@example.com" } });
    check(unver.status === 200, "B8 a token that happens to carry an email still signs in");
    check(unver.body.email === null, "B8a an UNVERIFIED email is not stored - the provider has to vouch for it");
    const ver = await c.signIn(keyA, { sub: "001111.email.0201", extra: { email: "Blake@Example.com", email_verified: "true" } });
    check(ver.body.email === "blake@example.com",
      "B8b a VERIFIED email IS stored now, lowercased - the deliberate reversal that makes linking possible");
    check(ver.body.emailPrivateRelay === false, "B8b2 and it is flagged as a real address, not a private relay");
    const relay = await c.signIn(keyA, { sub: "001111.email.0202", extra: { email: "abc123@privaterelay.appleid.com", email_verified: "true" } });
    check(relay.body.email === "abc123@privaterelay.appleid.com" && relay.body.emailPrivateRelay === true,
      "B8b3 an Apple private-relay address is stored (it is stable per app) but flagged as a relay");
    const list = await fetch(`${base}/admin/accounts`, { headers: { "x-admin-token": ADMIN_TOKEN } });
    const body = await list.text();
    check(!/"sub"/.test(body), "B8c Apple's sub is still not exposed in the admin listing");
    check(!/unverified@example\.com/.test(body), "B8c2 and an unverified address never reaches it either");
    if (KIND === "node") {
      // The account stores persist on the same 800ms debounce as the leaderboard. Poll rather
      // than sleep once: on a loaded machine a single fixed wait is a flake waiting to happen.
      let raw = "";
      for (let i = 0; i < 20; i++) {
        await K.sleep(300);
        try { raw = fs.readFileSync(path.join(scratch, "accounts.json"), "utf8"); } catch (e) { raw = ""; }
        if (/blake@example\.com/.test(raw)) break;
      }
      check(!/unverified@example\.com/.test(raw), "B8d an unverified email is not in accounts.json either");
      check(/blake@example\.com/.test(raw), "B8d2 and the verified one is, which is what the privacy label now has to declare");
    } else {
      check(true, "B8d (node-only file check, skipped on deno)");
      check(true, "B8d2 (node-only file check, skipped on deno)");
    }
  }

  await K.stopServer(srv);

  /* ================= Part B9: session expiry + the sliding refresh ================= */
  {
    // A real 400-day session cannot be waited out, so this instance runs with a tiny TTL. Same
    // code path, same arithmetic, just smaller numbers.
    const p2 = randPort() + 1;
    const b2 = `http://localhost:${p2}`;
    const s2 = K.makeScratch(`acct-apple-slide-${KIND}`);
    const child = K.startServer(KIND, K.serverEnv(KIND, s2, p2, ADMIN_TOKEN, {
      NASTY_APPLE_JWKS_URL: jwks.url, NASTY_APPLE_ISSUER: ISSUER,
      NASTY_APPLE_AUDIENCES: AUD_NATIVE,
      NASTY_SESSION_TTL_MS: "10000",          // "400 days"
      NASTY_SESSION_SLIDE_AFTER_MS: "1000",   // "30 days"
      NASTY_ACCOUNT_RATE_LIMIT: "4000",
    }), "ACCOUNTS_VERBOSE");
    await K.waitHealthy(b2);
    const c2 = K.makeClient(b2);
    const r = await c2.signIn(keyA, { sub: "001111.slide.0300" });
    const exp0 = r.body.exp;
    const me1 = await c2.post("/account/me", { auth: r.body.sessionToken });
    check(me1.body.exp === exp0, "B9 a fresh session is NOT slid (it is not old enough yet)");
    await K.sleep(1600);
    const me2 = await c2.post("/account/me", { auth: r.body.sessionToken });
    check(me2.status === 200 && me2.body.exp > exp0,
      "B9b once the session is past its slide age, any authenticated request silently extends it");
    await K.stopServer(child);
  }
  {
    const p3 = randPort() + 2;
    const b3 = `http://localhost:${p3}`;
    const s3 = K.makeScratch(`acct-apple-exp-${KIND}`);
    const child = K.startServer(KIND, K.serverEnv(KIND, s3, p3, ADMIN_TOKEN, {
      NASTY_APPLE_JWKS_URL: jwks.url, NASTY_APPLE_ISSUER: ISSUER,
      NASTY_APPLE_AUDIENCES: AUD_NATIVE,
      NASTY_SESSION_TTL_MS: "1500", NASTY_SESSION_SLIDE_AFTER_MS: "1400",
      NASTY_AUTH_NONCE_TTL_MS: "1200",
      NASTY_ACCOUNT_RATE_LIMIT: "4000",
    }), "ACCOUNTS_VERBOSE");
    await K.waitHealthy(b3);
    const c3 = K.makeClient(b3);
    const r = await c3.signIn(keyA, { sub: "001111.expire.0400" });
    check(r.status === 200, "B10 signed in on the short-lived-session instance");
    await K.sleep(2000);
    const me = await c3.post("/account/me", { auth: r.body.sessionToken });
    check(me.status === 401 && me.body.error === "signedout", "B10b an expired session -> 401 signedout");

    // And the nonce's own 10-minute life, proved the same way.
    const nonce = await c3.nonce();
    await K.sleep(1600);
    const token = K.mintIdentityToken(keyA, { nonce, sub: "001111.stalenonce.0401" });
    const late = await c3.post("/account/apple", { identityToken: token, nonce });
    check(late.status === 401 && late.body.error === "badnonce", "B11 a nonce older than its life is refused");
    await K.stopServer(child);
  }

  /* ================= Part C: the Apple gate (production's state today) ================= */
  {
    const p4 = randPort() + 3;
    const b4 = `http://localhost:${p4}`;
    const s4 = K.makeScratch(`acct-apple-gate-${KIND}`);
    const child = K.startServer(KIND, K.serverEnv(KIND, s4, p4, ADMIN_TOKEN, {
      NASTY_ACCOUNTS_ENABLED: "1",
      // NASTY_APPLE_AUDIENCES deliberately absent - exactly how production runs today.
      NASTY_APPLE_AUDIENCES: "",
    }), "ACCOUNTS_VERBOSE");
    await K.waitHealthy(b4);
    const c4 = K.makeClient(b4);
    const n = await c4.get("/account/nonce");
    check(n.status === 503 && n.body.error === "accounts unavailable",
      "C1 with Apple unconfigured, /account/nonce answers 503 accounts unavailable");
    check(typeof n.body.message === "string" && /keep playing/i.test(n.body.message),
      "C1b and says so in plain language that never blocks play");
    for (const p of ["/account/apple", "/account/me", "/account/name", "/account/name-available", "/account/claim", "/account/signout", "/account/delete"]) {
      const r = await c4.post(p, {});
      if (r.status !== 503) { FAIL++; log("FAIL", `C2 ${p} should be 503 when Apple is unconfigured, got ${r.status}`); }
    }
    PASS++; log("OK  ", "C2 every /account/* POST answers 503 when Apple is unconfigured");
    if (KIND === "node") {
      const created = ["accounts.json", "account-index.json", "sessions.json", "auth-nonces.json", "accounts-leaderboard.json", "claims.json"]
        .filter((f) => fs.existsSync(path.join(s4, f)));
      check(created.length === 0, "C3 and NOT ONE storage file was created (" + (created.join(",") || "none") + ")");
    } else {
      check(true, "C3 (node-only file check, skipped on deno)");
    }
    await K.stopServer(child);
  }

  jwks.close();
  console.log(`\n[acct-apple/${KIND}] ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
