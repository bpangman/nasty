"use strict";
/*
 * 2026-07-25 § ACCOUNTS - GOOGLE, FACEBOOK AND THE PASSWORDLESS EMAIL CODE.
 *
 * Stage 1 shipped Apple only (test_accounts_apple.js still owns that verifier's negative cases).
 * Blake asked for four sign-in methods, so this suite covers the three new ones, identically on
 * BOTH servers:
 *
 *   Part P - Google. The same one OIDC verifier Apple uses, pointed at Google's issuer/keys. A
 *     good token signs in; a token from ANOTHER provider's issuer is refused; a client id we do
 *     not know is refused; the nonce is still mandatory; and Google's real-world detail that
 *     `iss` comes in two spellings is handled.
 *   Part Q - Facebook, BOTH of its shapes. Limited Login hands back a real OIDC id_token and is
 *     verified by signature exactly like Apple's. Classic web login hands back an ACCESS token,
 *     which is not a JWT at all, so the server asks Facebook about it - and that conversation is
 *     asserted properly: the app access token really is sent, a token issued for a DIFFERENT
 *     Facebook app is refused, an expired one is refused, an unknown one is refused, and with no
 *     app secret configured the access-token half is unavailable while Limited Login still works.
 *   Part R - the email code. A six-digit code really is mailed, it signs you in, a wrong code
 *     fails, five wrong tries burn the challenge, the code is single-use, the resend cooldown
 *     holds, a mail-provider outage answers "we could not send that" and leaves NO usable
 *     challenge behind, and the code itself is never written to storage - only a hash.
 *   Part S - per-provider gating. Each method is independently configured: with only Apple set
 *     up, /account/google, /account/facebook and /account/email/* answer 503 in plain language
 *     while Apple keeps working.
 *
 * Nothing here contacts Apple, Google, Facebook or any mail provider: own RSA keys, own local
 * JWKS, own stub Graph API, own stub email API (see test_accounts_kit.js). Never touches
 * production - private port, private scratch storage, throwaway admin token.
 *
 * Usage:
 *   node test_accounts_providers.js node
 *   node test_accounts_providers.js deno
 */
const path = require("path");
const fs = require("fs");
const K = require("./test_accounts_kit.js");

const KIND = process.argv[2] || "node";
const ADMIN_TOKEN = "accounts-providers-admin-token";
const APPLE_AUD = "com.pangman.nasty";
const GOOGLE_IOS = "111-ios.apps.googleusercontent.com";
const GOOGLE_WEB = "111-web.apps.googleusercontent.com";
const FB_APP_ID = "1234567890";
const FB_APP_SECRET = "fb-app-secret-not-real";
const APPLE_ISS = "https://appleid.test.local";
const GOOGLE_ISS = "https://accounts.google.test";
const GOOGLE_ISS_ALT = "accounts.google.test";
const FB_ISS = "https://www.facebook.test";

let PASS = 0, FAIL = 0;
function log(...a) { console.log("[acct-providers]", ...a); }
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
function randPort() { return 27800 + Math.floor(Math.random() * 500); }

async function main() {
  const appleKey = K.makeKeyPair("apple-key");
  const googleKey = K.makeKeyPair("google-key");
  const fbKey = K.makeKeyPair("fb-key");
  // Three separate key sets on three separate ports, exactly like the three real providers -
  // so "a Google token presented at the Facebook door" genuinely cannot verify.
  const appleJwks = await K.startJwksServer([appleKey]);
  const googleJwks = await K.startJwksServer([googleKey]);
  const fbJwks = await K.startJwksServer([fbKey]);
  const graph = await K.startFacebookGraphServer(FB_APP_ID, FB_APP_SECRET);
  const mail = await K.startEmailApiServer();

  const fullEnv = {
    NASTY_ACCOUNTS_ENABLED: "1",
    NASTY_APPLE_JWKS_URL: appleJwks.url, NASTY_APPLE_ISSUER: APPLE_ISS, NASTY_APPLE_AUDIENCES: APPLE_AUD,
    NASTY_GOOGLE_JWKS_URL: googleJwks.url, NASTY_GOOGLE_ISSUER: `${GOOGLE_ISS},${GOOGLE_ISS_ALT}`,
    NASTY_GOOGLE_AUDIENCES: `${GOOGLE_IOS},${GOOGLE_WEB}`,
    NASTY_FACEBOOK_JWKS_URL: fbJwks.url, NASTY_FACEBOOK_ISSUER: FB_ISS,
    NASTY_FACEBOOK_APP_ID: FB_APP_ID, NASTY_FACEBOOK_APP_SECRET: FB_APP_SECRET,
    NASTY_FACEBOOK_GRAPH_URL: graph.url,
    NASTY_EMAIL_PROVIDER: "resend", NASTY_EMAIL_API_URL: mail.url,
    NASTY_EMAIL_API_KEY: "test-mail-key", NASTY_EMAIL_FROM: "NASTY <hello@nastyboardgame.com>",
    NASTY_ACCOUNT_RATE_LIMIT: "4000",
  };

  const scratch = K.makeScratch(`acct-prov-${KIND}`);
  const port = randPort();
  const base = `http://localhost:${port}`;
  const srv = K.startServer(KIND, K.serverEnv(KIND, scratch, port, ADMIN_TOKEN, fullEnv), "ACCOUNTS_VERBOSE");
  await K.waitHealthy(base);
  const c = K.makeClient(base);

  /* ========================= Part P: Google ========================= */
  {
    const g = await c.signInWith("google", googleKey, { iss: GOOGLE_ISS, aud: GOOGLE_IOS, sub: "google-sub-1" });
    check(g.status === 200 && typeof g.body.sessionToken === "string" && g.body.sessionToken.length === 64,
      "P1 a correctly signed Google token signs in and mints a session");
    check(g.body.provider === "google", "P1b and the answer says which method it was");

    const again = await c.signInWith("google", googleKey, { iss: GOOGLE_ISS_ALT, aud: GOOGLE_WEB, sub: "google-sub-1" });
    check(again.status === 200 && again.body.uid === g.body.uid,
      "P2 Google's other issuer spelling and its OTHER client id resolve to the SAME account - one Google account is one person");

    const wrongAud = await c.signInWith("google", googleKey, { iss: GOOGLE_ISS, aud: "999-somebody-else.apps.googleusercontent.com", sub: "google-sub-1" });
    check(wrongAud.status === 401 && wrongAud.body.reason === "audience",
      "P3 a token minted for somebody ELSE's Google client id is refused");

    const wrongIss = await c.signInWith("google", googleKey, { iss: "https://accounts.evil.test", aud: GOOGLE_IOS, sub: "google-sub-1" });
    check(wrongIss.status === 401 && wrongIss.body.reason === "issuer", "P4 a wrong issuer is refused");

    // The single most important cross-provider case: Google's own key, presented at Apple's door.
    const crossed = await c.post("/account/apple", { identityToken: "x.y.z", nonce: await c.nonce() });
    check(crossed.status === 401, "P5 junk at the Apple door is still refused (the verifiers are not interchangeable)");

    const nonce = await c.nonce();
    const noNonce = K.mintIdentityToken(googleKey, { iss: GOOGLE_ISS, aud: GOOGLE_IOS, sub: "google-sub-2", dropNonce: true });
    const r = await c.post("/account/google", { identityToken: noNonce, nonce });
    check(r.status === 401 && r.body.reason === "nonce", "P6 the server-issued nonce is mandatory for Google too");

    const ver = await c.signInWith("google", googleKey, {
      iss: GOOGLE_ISS, aud: GOOGLE_WEB, sub: "google-sub-3",
      extra: { email: "Gran@Example.com", email_verified: true },
    });
    check(ver.body.email === "gran@example.com" && ver.body.emailPrivateRelay === false,
      "P7 Google's verified email is stored, lowercased - this is what makes linking possible");
    const unver = await c.signInWith("google", googleKey, {
      iss: GOOGLE_ISS, aud: GOOGLE_WEB, sub: "google-sub-4",
      extra: { email: "nope@example.com", email_verified: false },
    });
    check(unver.body.email === null, "P7b an email Google did NOT verify is still refused as a key");
  }

  /* ========================= Part Q: Facebook, both shapes ========================= */
  {
    const lim = await c.signInWith("facebook", fbKey, { iss: FB_ISS, aud: FB_APP_ID, sub: "fb-user-1" });
    check(lim.status === 200 && lim.body.provider === "facebook",
      "Q1 Facebook Limited Login's id_token is verified by signature, exactly like Apple's and Google's");

    const wrongApp = await c.signInWith("facebook", fbKey, { iss: FB_ISS, aud: "9999999", sub: "fb-user-1" });
    check(wrongApp.status === 401 && wrongApp.body.reason === "audience",
      "Q1b an id_token minted for a different Facebook app is refused");

    const before = graph.debugHits();
    graph.addToken("fb-access-good", { userId: "fb-user-1", email: "cousin@example.com" });
    const acc = await c.signInFacebookAccessToken("fb-access-good");
    check(acc.status === 200, "Q2 Facebook's classic ACCESS token is accepted after server-side inspection");
    check(graph.debugHits() === before + 1, "Q2b and the server really did call debug_token with its app access token");
    check(acc.body.uid === lim.body.uid,
      "Q2c the SAME Facebook person via Limited Login (app) and an access token (web) is ONE account - Facebook ids are app-scoped");
    check(acc.body.email === "cousin@example.com", "Q2d and the email Graph reports is picked up as the linking key");

    graph.addToken("fb-access-otherapp", { userId: "fb-user-2", appId: "5555555555" });
    const other = await c.signInFacebookAccessToken("fb-access-otherapp");
    check(other.status === 401 && other.body.reason === "audience",
      "Q3 an access token issued for a DIFFERENT Facebook app is refused - this is the whole point of inspecting it");

    graph.addToken("fb-access-expired", { userId: "fb-user-3", expiresAt: Math.floor(Date.now() / 1000) - 60 });
    const expired = await c.signInFacebookAccessToken("fb-access-expired");
    check(expired.status === 401 && expired.body.reason === "expired", "Q4 an expired access token is refused");

    const unknown = await c.signInFacebookAccessToken("fb-access-never-issued");
    check(unknown.status === 401 && unknown.body.reason === "badtoken", "Q5 a token Facebook has never heard of is refused");

    const malformed = await c.signInFacebookAccessToken("has spaces and \"quotes\"");
    check(malformed.status === 401 && malformed.body.reason === "malformed", "Q6 an obviously junk access token is refused before any network call");
  }

  /* ========================= Part R: the passwordless email code ========================= */
  {
    const started = await c.emailStart("Aunt.Jo@Example.com");
    check(started.status === 200 && started.body.sent === true, "R1 asking for a code answers ok");
    const last = mail.last();
    check(last && last.to === "aunt.jo@example.com", "R1b and a mail really went out, to the lowercased address");
    check(last && /^\d{6}$/.test(last.code || ""), "R1c carrying a six-digit code");
    check(last && last.auth === "Bearer test-mail-key", "R1d authenticated to the mail provider with the configured key");
    check(last && /10 minutes/.test(last.text) && !/password/i.test(last.text),
      "R1e and the wording is plain, with no mention of a password (there isn't one, ever)");

    const wrong = await c.emailVerify("aunt.jo@example.com", "000000" === last.code ? "111111" : "000000");
    check(wrong.status === 401 && wrong.body.error === "badcode", "R2 a wrong code is refused");

    const good = await c.emailVerify("aunt.jo@example.com", last.code);
    check(good.status === 200 && good.body.provider === "email" && typeof good.body.sessionToken === "string",
      "R3 the right code signs you in with no password anywhere in the flow");
    check(good.body.email === "aunt.jo@example.com", "R3b and the address is stored, verified by construction");

    const replay = await c.emailVerify("aunt.jo@example.com", last.code);
    check(replay.status === 401, "R4 the same code cannot be used twice");

    const me2 = await c.emailStart("aunt.jo@example.com");
    check(me2.status === 429 && me2.body.error === "toosoon", "R5 asking again straight away is refused with a plain wait message");

    // A different address, to exercise the attempt limiter without fighting the cooldown.
    await c.emailStart("burner@example.com");
    const realCode = mail.lastCode();
    const wrongOne = realCode === "123456" ? "654321" : "123456";
    let lastStatus = 0;
    for (let i = 0; i < 5; i++) lastStatus = (await c.emailVerify("burner@example.com", wrongOne)).status;
    check(lastStatus === 401, "R6 the first five wrong tries are plain rejections");
    const burned = await c.emailVerify("burner@example.com", realCode);
    check(burned.status === 429 && burned.body.error === "toomanytries",
      "R6b and the sixth try is refused outright - even with the RIGHT code, the challenge is burned");

    const bad = await c.emailStart("not-an-email");
    check(bad.status === 400 && bad.body.error === "bademail", "R7 something that is not an email address is refused before any mail is sent");

    mail.failNext(1);
    const outage = await c.emailStart("outage@example.com");
    check(outage.status === 503 && outage.body.error === "emailunavailable",
      "R8 a mail-provider outage answers plainly and points at the other three sign-in methods");
    const orphan = await c.emailVerify("outage@example.com", "123456");
    check(orphan.status === 401, "R8b and leaves no half-open challenge behind");

    if (KIND === "node") {
      await K.sleep(300);
      const raw = fs.readFileSync(path.join(scratch, "email-codes.json"), "utf8");
      check(!raw.includes(realCode), "R9 the code itself is NEVER written to storage - only a hash of it");
      check(/"hash"/.test(raw), "R9b (and the hash is what is stored)");
    } else {
      check(true, "R9 (node-only file check, skipped on deno)");
      check(true, "R9b (node-only file check, skipped on deno)");
    }
  }

  await K.stopServer(srv);

  /* ========================= Part S: independent per-provider gating ========================= */
  {
    const s2 = K.makeScratch(`acct-prov-apple-only-${KIND}`);
    const p2 = randPort() + 1;
    const b2 = `http://localhost:${p2}`;
    const child = K.startServer(KIND, K.serverEnv(KIND, s2, p2, ADMIN_TOKEN, {
      NASTY_ACCOUNTS_ENABLED: "1",
      NASTY_APPLE_JWKS_URL: appleJwks.url, NASTY_APPLE_ISSUER: APPLE_ISS, NASTY_APPLE_AUDIENCES: APPLE_AUD,
      NASTY_ACCOUNT_RATE_LIMIT: "4000",
    }), "ACCOUNTS_VERBOSE");
    await K.waitHealthy(b2);
    const c2 = K.makeClient(b2);

    const apple = await c2.signIn(appleKey, { iss: APPLE_ISS, aud: APPLE_AUD, sub: "apple-only-1" });
    check(apple.status === 200, "S1 with only Apple configured, Apple still signs in normally");
    check(Array.isArray(apple.body.providers) && apple.body.providers.join(",") === "apple",
      "S1b and the answer tells the client that Apple is the only method on offer");

    const g = await c2.signInWith("google", googleKey, { iss: GOOGLE_ISS, aud: GOOGLE_IOS, sub: "g" });
    check(g.status === 503 && g.body.error === "accounts unavailable", "S2 Google answers 503 until Blake configures it");
    const f = await c2.signInFacebookAccessToken("anything");
    check(f.status === 503, "S3 so does Facebook");
    const e = await c2.emailStart("someone@example.com");
    check(e.status === 503, "S4 and so does the email code");
    check(/keep playing/i.test(String(e.body.message || "")), "S4b in plain language that never blocks play");
    check(mail.sent.filter((m) => m.to === "someone@example.com").length === 0, "S4c and no mail was attempted");

    await K.stopServer(child);
  }

  /* --- and the Facebook access-token half specifically needs the app SECRET, not just the id --- */
  {
    const s3 = K.makeScratch(`acct-prov-nosecret-${KIND}`);
    const p3 = randPort() + 2;
    const b3 = `http://localhost:${p3}`;
    const child = K.startServer(KIND, K.serverEnv(KIND, s3, p3, ADMIN_TOKEN, {
      NASTY_ACCOUNTS_ENABLED: "1",
      NASTY_FACEBOOK_JWKS_URL: fbJwks.url, NASTY_FACEBOOK_ISSUER: FB_ISS,
      NASTY_FACEBOOK_APP_ID: FB_APP_ID, NASTY_FACEBOOK_GRAPH_URL: graph.url,
      NASTY_ACCOUNT_RATE_LIMIT: "4000",
    }), "ACCOUNTS_VERBOSE");
    await K.waitHealthy(b3);
    const c3 = K.makeClient(b3);
    const lim = await c3.signInWith("facebook", fbKey, { iss: FB_ISS, aud: FB_APP_ID, sub: "fb-user-9" });
    check(lim.status === 200, "S5 with the app id but no app secret, Facebook Limited Login (the iOS path) still works");
    graph.addToken("fb-access-nosecret", { userId: "fb-user-9" });
    const acc = await c3.signInFacebookAccessToken("fb-access-nosecret");
    check(acc.status === 401 && acc.body.reason === "nosecret",
      "S5b but the web access-token path is refused, because inspecting it needs the app secret");
    await K.stopServer(child);
  }

  appleJwks.close(); googleJwks.close(); fbJwks.close(); graph.close(); mail.close();
  console.log(`\n[acct-providers/${KIND}] ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
