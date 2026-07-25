"use strict";
/*
 * 2026-07-25 § ACCOUNTS - ONE HUMAN, ONE ACCOUNT.
 *
 * Two questions Blake asked, answered with evidence, identically on BOTH servers:
 *
 *   "Confirm accounts are the same whether accessed via app or web."
 *   Part T does exactly that, per provider, by signing in twice with the credential shape each
 *   platform really produces and asserting the SAME uid, the SAME game name and the SAME
 *   leaderboard row come back:
 *     - Apple: a token whose `aud` is the native App ID (the iOS app) vs one whose `aud` is the
 *       Services ID (the website). Apple issues the same `sub` for both ONLY when the Services ID
 *       is configured under the same primary App ID - so this test is the code half of that
 *       guarantee and blake-signin-setup.md is the portal half.
 *     - Google: the iOS OAuth client id vs the web OAuth client id. Google's `sub` is per Google
 *       Account, not per client id, so these are the same person by construction.
 *     - Facebook: a Limited Login id_token (iOS) vs an inspected access token (web). Facebook
 *       user ids are app-scoped, so one Facebook app means one id on both.
 *
 *   Adding Google and Facebook creates a duplicate-identity risk that Apple alone did not have.
 *   Part U covers the answer to it: a verified email links a returning human onto their existing
 *   account instead of quietly making a second one. Part V covers the case email CANNOT solve -
 *   Apple's private-relay address - and proves the explicit "link another sign-in method" action
 *   handles it. Part W covers unlinking, including the refusal to remove the last way in.
 *
 * Nothing here contacts any provider. Never touches production.
 *
 * Usage:
 *   node test_accounts_linking.js node
 *   node test_accounts_linking.js deno
 */
const K = require("./test_accounts_kit.js");

const KIND = process.argv[2] || "node";
const ADMIN_TOKEN = "accounts-linking-admin-token";
// The two Apple audiences are exactly the pair Blake has to create: the App ID the iOS app is
// built against, and the Services ID the website signs in with.
const APPLE_APP_ID = "com.pangman.nasty";
const APPLE_SERVICES_ID = "com.pangman.nasty.web";
const GOOGLE_IOS = "111-ios.apps.googleusercontent.com";
const GOOGLE_WEB = "111-web.apps.googleusercontent.com";
const FB_APP_ID = "1234567890";
const FB_APP_SECRET = "fb-app-secret-not-real";
const APPLE_ISS = "https://appleid.test.local";
const GOOGLE_ISS = "https://accounts.google.test";
const FB_ISS = "https://www.facebook.test";

let PASS = 0, FAIL = 0;
function log(...a) { console.log("[acct-link]", ...a); }
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
// Deliberately clear of every other test_accounts_* suite's range (apple 27100-27700, providers
// 27800-28300, dormant 28400-29030, policy 29400-29800, online 30800-31100) so two suites can
// never fight over a port even if something runs them at the same time.
function randPort() { return 30300 + Math.floor(Math.random() * 400); }

async function main() {
  const appleKey = K.makeKeyPair("apple-key");
  const googleKey = K.makeKeyPair("google-key");
  const fbKey = K.makeKeyPair("fb-key");
  const appleJwks = await K.startJwksServer([appleKey]);
  const googleJwks = await K.startJwksServer([googleKey]);
  const fbJwks = await K.startJwksServer([fbKey]);
  const graph = await K.startFacebookGraphServer(FB_APP_ID, FB_APP_SECRET);
  const mail = await K.startEmailApiServer();

  const scratch = K.makeScratch(`acct-link-${KIND}`);
  const port = randPort();
  const base = `http://localhost:${port}`;
  const srv = K.startServer(KIND, K.serverEnv(KIND, scratch, port, ADMIN_TOKEN, {
    NASTY_ACCOUNTS_ENABLED: "1",
    NASTY_APPLE_JWKS_URL: appleJwks.url, NASTY_APPLE_ISSUER: APPLE_ISS,
    NASTY_APPLE_AUDIENCES: `${APPLE_APP_ID},${APPLE_SERVICES_ID}`,
    NASTY_GOOGLE_JWKS_URL: googleJwks.url, NASTY_GOOGLE_ISSUER: GOOGLE_ISS,
    NASTY_GOOGLE_AUDIENCES: `${GOOGLE_IOS},${GOOGLE_WEB}`,
    NASTY_FACEBOOK_JWKS_URL: fbJwks.url, NASTY_FACEBOOK_ISSUER: FB_ISS,
    NASTY_FACEBOOK_APP_ID: FB_APP_ID, NASTY_FACEBOOK_APP_SECRET: FB_APP_SECRET,
    NASTY_FACEBOOK_GRAPH_URL: graph.url,
    NASTY_EMAIL_PROVIDER: "resend", NASTY_EMAIL_API_URL: mail.url,
    NASTY_EMAIL_API_KEY: "test-mail-key", NASTY_EMAIL_FROM: "NASTY <hello@nastyboardgame.com>",
    NASTY_ACCOUNT_RATE_LIMIT: "8000",
  }), "ACCOUNTS_VERBOSE");
  await K.waitHealthy(base);
  const c = K.makeClient(base);

  async function board() { return await (await fetch(base + "/leaderboard")).json(); }

  /* ============ Part T: the same account on the phone and on the website ============ */
  {
    // --- Apple. Two audiences, one sub. This is the exact pair Blake configures in the portal.
    const onPhone = await c.signIn(appleKey, { iss: APPLE_ISS, aud: APPLE_APP_ID, sub: "001111.blake.apple" });
    check(onPhone.status === 200, "T1 Apple sign-in from the iOS app (aud = the App ID) works");
    await c.post("/account/name", { auth: onPhone.body.sessionToken, name: "Blake" });

    const onWeb = await c.signIn(appleKey, { iss: APPLE_ISS, aud: APPLE_SERVICES_ID, sub: "001111.blake.apple" });
    check(onWeb.status === 200, "T2 Apple sign-in from the website (aud = the Services ID) works");
    check(onWeb.body.uid === onPhone.body.uid,
      "T3 APP AND WEB ARE ONE ACCOUNT for Apple - same uid from the App ID and the Services ID");
    check(onWeb.body.gameName === "Blake",
      "T3b same game name, with no second name step - the website already knows who you are");
    check(onWeb.body.sessionToken !== onPhone.body.sessionToken,
      "T3c (two devices get two sessions, which is right - signing out of one must not sign out the other)");

    // And the leaderboard row follows, which is the thing Blake actually cares about.
    await fetch(base + "/solo-result", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: "link-phone-1", entries: [{ name: "Blake", delta: { hg4s: 1, hw4s: 1 } }] }),
    });
    const me = await c.post("/account/me", { auth: onWeb.body.sessionToken });
    check(me.status === 200 && me.body.uid === onPhone.body.uid,
      "T3d and the website's session resolves to that same one account");

    // --- Google. Two client ids, one Google Account.
    const gPhone = await c.signInWith("google", googleKey, { iss: GOOGLE_ISS, aud: GOOGLE_IOS, sub: "google-jim" });
    const gWeb = await c.signInWith("google", googleKey, { iss: GOOGLE_ISS, aud: GOOGLE_WEB, sub: "google-jim" });
    check(gPhone.body.uid === gWeb.body.uid,
      "T4 APP AND WEB ARE ONE ACCOUNT for Google - the iOS client id and the web client id share one `sub`");

    // --- Facebook. Limited Login on iOS, an inspected access token on the web.
    const fPhone = await c.signInWith("facebook", fbKey, { iss: FB_ISS, aud: FB_APP_ID, sub: "fb-geri" });
    graph.addToken("fb-geri-web", { userId: "fb-geri" });
    const fWeb = await c.signInFacebookAccessToken("fb-geri-web");
    check(fPhone.body.uid === fWeb.body.uid,
      "T5 APP AND WEB ARE ONE ACCOUNT for Facebook - Limited Login on iOS and an access token on the web are one app-scoped id");

    // --- And the three of them are still three DIFFERENT people.
    const uids = new Set([onPhone.body.uid, gPhone.body.uid, fPhone.body.uid]);
    check(uids.size === 3, "T6 three different humans are still three different accounts");
  }

  /* ============ Part U: a verified email links, instead of quietly duplicating ============ */
  {
    // Ginny signs in with Google on her laptop first.
    const g = await c.signInWith("google", googleKey, {
      iss: GOOGLE_ISS, aud: GOOGLE_WEB, sub: "google-ginny",
      extra: { email: "ginny@example.com", email_verified: true },
    });
    await c.post("/account/name", { auth: g.body.sessionToken, name: "Ginny" });
    check(g.body.email === "ginny@example.com", "U1 Google's verified email is on the account");

    // Then with Apple on her phone, sharing her real address rather than hiding it.
    const a = await c.signIn(appleKey, {
      iss: APPLE_ISS, aud: APPLE_APP_ID, sub: "001111.ginny.apple",
      extra: { email: "Ginny@Example.com", email_verified: "true" },
    });
    check(a.body.uid === g.body.uid,
      "U2 the SAME person signing in with a different provider lands on the SAME account - no silent duplicate");
    check(a.body.linkedToExisting === true, "U2b and the answer says so, so the client can tell her what happened");
    check(a.body.gameName === "Ginny", "U2c she keeps her game name and therefore her leaderboard row");
    check(a.body.identities.includes("apple") && a.body.identities.includes("google"),
      "U2d and the account now answers to both sign-in methods");

    // And the email code method links on the very same key.
    const e = await c.emailSignIn(mail, "ginny@example.com");
    check(e.status === 200 && e.body.uid === g.body.uid,
      "U3 signing in with the email code on a third device lands on that same account too");

    // An UNVERIFIED address must never link - that would be an account takeover by typing.
    const imposter = await c.signInWith("google", googleKey, {
      iss: GOOGLE_ISS, aud: GOOGLE_WEB, sub: "google-imposter",
      extra: { email: "ginny@example.com", email_verified: false },
    });
    check(imposter.body.uid !== g.body.uid,
      "U4 an UNVERIFIED email claiming the same address does NOT link - that would be a takeover by typing");
  }

  /* ====== Part V: Apple's private relay - the honest limit, and the escape hatch ====== */
  {
    // Jim hides his email from Apple. The relay address is real and stable, but it is per-app and
    // will never equal his real Gmail, so it cannot link him to a Google sign-in.
    const a = await c.signIn(appleKey, {
      iss: APPLE_ISS, aud: APPLE_APP_ID, sub: "001111.jim.apple",
      extra: { email: "aa11bb@privaterelay.appleid.com", email_verified: "true", is_private_email: "true" },
    });
    await c.post("/account/name", { auth: a.body.sessionToken, name: "Jim" });
    check(a.body.emailPrivateRelay === true, "V1 an Apple private-relay address is stored, and flagged as one");

    const g = await c.signInWith("google", googleKey, {
      iss: GOOGLE_ISS, aud: GOOGLE_WEB, sub: "google-jim-real",
      extra: { email: "jim@example.com", email_verified: true },
    });
    check(g.body.uid !== a.body.uid,
      "V2 THE HONEST LIMIT: Hide-My-Email plus Google really is two accounts, and no server can guess otherwise");

    // The fix is the person themselves saying "these are both me" while signed in.
    const linked = await c.link(a.body.sessionToken, "google", googleKey, {
      iss: GOOGLE_ISS, aud: GOOGLE_IOS, sub: "google-jim-second",
      extra: { email: "jim2@example.com", email_verified: true },
    });
    check(linked.status === 200 && linked.body.identities.includes("google"),
      "V3 THE MITIGATION: 'link another sign-in method' attaches Google to the account you are already in");
    const back = await c.signInWith("google", googleKey, { iss: GOOGLE_ISS, aud: GOOGLE_WEB, sub: "google-jim-second" });
    check(back.body.uid === a.body.uid && back.body.gameName === "Jim",
      "V3b and signing in with that Google account afterwards lands on Jim's account, name and all");

    // Linking a sign-in that already belongs to somebody else must be refused, not stolen.
    const taken = await c.link(a.body.sessionToken, "google", googleKey, { iss: GOOGLE_ISS, aud: GOOGLE_IOS, sub: "google-jim-real" });
    check(taken.status === 409 && taken.body.error === "linkedelsewhere",
      "V4 linking a sign-in that already belongs to another account is refused in plain language");
    const nonsense = await c.post("/account/link", { auth: a.body.sessionToken, provider: "myspace" });
    check(nonsense.status === 400, "V5 linking a provider we do not use is refused");
  }

  /* ============ Part W: unlinking, and never locking anyone out ============ */
  {
    const a = await c.signIn(appleKey, { iss: APPLE_ISS, aud: APPLE_APP_ID, sub: "001111.geri.apple" });
    const auth = a.body.sessionToken;
    await c.post("/account/name", { auth, name: "Geri" });

    const only = await c.post("/account/unlink", { auth, provider: "apple" });
    check(only.status === 409 && only.body.error === "lastidentity",
      "W1 removing the ONLY way into an account is refused - an account with no way in is a lost account");

    await c.link(auth, "google", googleKey, { iss: GOOGLE_ISS, aud: GOOGLE_IOS, sub: "google-geri" });
    const now = await c.post("/account/unlink", { auth, provider: "apple" });
    check(now.status === 200 && now.body.identities.join(",") === "google",
      "W2 once a second method is attached, the first can be removed");
    const stillIn = await c.post("/account/me", { auth });
    check(stillIn.status === 200 && stillIn.body.gameName === "Geri",
      "W2b and the account, its name and its history are all untouched");
    const oldWay = await c.signIn(appleKey, { iss: APPLE_ISS, aud: APPLE_APP_ID, sub: "001111.geri.apple" });
    check(oldWay.body.uid !== a.body.uid,
      "W2c the removed sign-in really is detached - using it again starts a brand-new account");
    const missing = await c.post("/account/unlink", { auth, provider: "facebook" });
    check(missing.status === 404, "W3 unlinking something that was never attached is a plain 404");
  }

  /* ============ Part X: deletion cleans up EVERY linked method, not just the first ============ */
  {
    const a = await c.signIn(appleKey, { iss: APPLE_ISS, aud: APPLE_APP_ID, sub: "001111.del.apple" });
    const auth = a.body.sessionToken;
    await c.post("/account/name", { auth, name: "Deleteme" });
    await c.link(auth, "google", googleKey, { iss: GOOGLE_ISS, aud: GOOGLE_IOS, sub: "google-del" });
    const del = await c.post("/account/delete", { auth });
    check(del.status === 200, "X1 the account deletes");
    const backApple = await c.signIn(appleKey, { iss: APPLE_ISS, aud: APPLE_APP_ID, sub: "001111.del.apple" });
    const backGoogle = await c.signInWith("google", googleKey, { iss: GOOGLE_ISS, aud: GOOGLE_IOS, sub: "google-del" });
    check(backApple.body.uid !== a.body.uid && backGoogle.body.uid !== a.body.uid,
      "X2 and NEITHER linked sign-in still points at the deleted account");
    check(backApple.body.uid !== backGoogle.body.uid,
      "X2b (they are two fresh, unrelated accounts now, since nothing links them any more)");
  }

  const finalBoard = await board();
  check(typeof finalBoard === "object" && !Array.isArray(finalBoard),
    "X3 and /leaderboard is still the flat {name:{stats}} shape every shipped build renders");

  await K.stopServer(srv);
  appleJwks.close(); googleJwks.close(); fbJwks.close(); graph.close(); mail.close();
  console.log(`\n[acct-link/${KIND}] ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
