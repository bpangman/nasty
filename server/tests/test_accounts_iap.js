"use strict";
/*
 * 2026-07-30 § REAL-MONEY CREDIT PACKS - Apple In-App Purchase verification, replay protection,
 * and refund handling. Blake's ask, verbatim: "please add functionality for people to purchase
 * things outright with real money (CC transaction) ... Make 10 credits be $1". This suite proves
 * the server half of that against BOTH servers, with NO Apple involvement anywhere: the signed
 * transactions are minted locally against a throwaway certificate chain, and the server under
 * test is booted with NASTY_IAP_ROOT_CA_B64 pointed at the throwaway root - the exact same
 * convention every sign-in suite uses with NASTY_APPLE_JWKS_URL. The chain carries Apple's real
 * marker OIDs (1.2.840.113635.100.6.11.1 on the leaf, 1.2.840.113635.100.6.2.1 on the
 * intermediate, added via openssl extfile when it was generated) so the production OID checks
 * stay switched on under test instead of being silently skipped.
 *
 *   I1  /shop lists the credit packs, every pack AND every catalog cost is divisible by 10
 *       (Blake's "always divideable by 10" rule, locked in as a test), and the base pack is the
 *       10-credits-per-dollar anchor (50 credits / $4.99)
 *   I2  a valid signed sandbox transaction credits the wallet - and ONLY purchasedCredits moves;
 *       lifetimeEarned (the leaderboard's number) stays exactly where it was
 *   I3  REPLAY - the case that must not be wrong. The same transaction resubmitted answers
 *       alreadyProcessed with zero new credits; two CONCURRENT submissions of one transaction
 *       credit exactly once; a replay against a DIFFERENT account is refused outright
 *   I4  a forged transaction - validly signed, but by a chain rooted OUTSIDE the pinned root -
 *       is rejected and credits nothing
 *   I5  a tampered transaction (payload swapped under a real signature; a good chain presented
 *       with a signature from the wrong key; alg:none) is rejected and credits nothing
 *   I6  a wrong-product-id transaction (validly signed, not a credit pack) is rejected
 *   I7  a wrong-bundle-id transaction (someone else's app) is rejected
 *   I8  bought credits spend through the exact same /account/purchase path as earned ones -
 *       nothing about spending is forked, and the leaderboard never hears about any of it
 *   I9  App Store Server Notifications V2: a signed REFUND claws the pack's credits back off
 *       purchasedCredits, a REPLAYED refund deducts nothing twice, and when credits were
 *       already spent the deduction floors at what is left (shortfall recorded, balance 0)
 *   I10 a guest gets a clean 401; garbage input gets a clean 400; nothing ever crashes
 *   I11 the environment gate is real: a server booted with NASTY_IAP_ALLOW_SANDBOX=0 refuses
 *       the same sandbox transaction the main server accepted
 *
 * Usage:
 *   node test_accounts_iap.js node
 *   node test_accounts_iap.js deno
 */
const crypto = require("crypto");
const path = require("path");
const K = require("./test_accounts_kit.js");

const KIND = process.argv[2] || "node";
const ADMIN_TOKEN = "accounts-iap-admin-token";
const AUD = "com.pangman.nasty";
const ISSUER = "https://test.local";

let PASS = 0, FAIL = 0;
function log(...a) { console.log("[acct-iap]", ...a); }
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
function randPort() { return 29200 + Math.floor(Math.random() * 600); }

/* --- the throwaway chains, generated once with openssl (P-256, 20-year validity, Apple's
 * marker OIDs included - see the file header). "GOOD" is the chain the server is booted to
 * trust; "EVIL" is a completely separate chain used to prove the pinned-root check. Only the
 * LEAF private keys are needed at runtime (to mint/tamper signatures); the CA keys stayed in
 * the scratch directory they were born in and are gone. --- */
const GOOD_ROOT_B64 =
  "MIIBOjCB4AIJANiOTrKtgf6oMAoGCCqGSM49BAMCMCUxIzAhBgNVBAMMGk5BU1RZIElBUCBUZXN0IFJvb3QgKGdvb2QpMB4X" +
  "DTI2MDczMDIxMzIyNVoXDTQ2MDcyNTIxMzIyNVowJTEjMCEGA1UEAwwaTkFTVFkgSUFQIFRlc3QgUm9vdCAoZ29vZCkwWTAT" +
  "BgcqhkjOPQIBBggqhkjOPQMBBwNCAASEhCCnBLGPPGNrbhXLBre9Lw/ha8CcMHGHDwtKSvnMj9iPgUUbfQijSqKtJNHnEMFz" +
  "PNE12Zuqr6N9pfPkeqzLMAoGCCqGSM49BAMCA0kAMEYCIQDpc9oj1/mRzONvxRGDGdHDGJD0Lm3UQGwM9AtppcfAZAIhANrW" +
  "TeWzN+rDZTwgQs/dBHasqJzzpTpL+ZnDgt2y78xb";
const GOOD_INTER_B64 =
  "MIIBeDCCAR6gAwIBAgIJAM79zxWBwxS6MAoGCCqGSM49BAMCMCUxIzAhBgNVBAMMGk5BU1RZIElBUCBUZXN0IFJvb3QgKGdv" +
  "b2QpMB4XDTI2MDczMDIxMzIyNVoXDTQ2MDcyNTIxMzIyNVowLTErMCkGA1UEAwwiTkFTVFkgSUFQIFRlc3QgSW50ZXJtZWRp" +
  "YXRlIChnb29kKTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABOg53sa1kLVKvxEnl0o1aycVX7AVo4PvXVyRpJdKgBSoCSY+" +
  "HqoHkVZDxz2ymA+xDwTxFnH5WCQm9xDMWiGtms+jLzAtMAwGA1UdEwQFMAMBAf8wCwYDVR0PBAQDAgIEMBAGCiqGSIb3Y2QG" +
  "AgEEAgUAMAoGCCqGSM49BAMCA0gAMEUCIF52cKgjVXQaPDCCEnLeplrH22HvL3jD2ZTTGNc7jjdpAiEA+jy+2mvAJIWtu2Kt" +
  "A6EOPpyZ3gqkcB6TRcMZtznrnqQ=";
const GOOD_LEAF_B64 =
  "MIIBajCCARGgAwIBAgIJAK8RG+YB30fyMAoGCCqGSM49BAMCMC0xKzApBgNVBAMMIk5BU1RZIElBUCBUZXN0IEludGVybWVk" +
  "aWF0ZSAoZ29vZCkwHhcNMjYwNzMwMjEzMjI1WhcNNDYwNzI1MjEzMjI1WjAoMSYwJAYDVQQDDB1OQVNUWSBJQVAgVGVzdCBT" +
  "aWduaW5nIChnb29kKTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABJiWrRsUEb0oCZDQAiMCiKxPf0VV/VxIDlBhwYPct6W9" +
  "rtGg0i8SteJPn7WDIn81NWkcblQpUWwX0Py5Ch2yrvOjHzAdMAkGA1UdEwQCMAAwEAYKKoZIhvdjZAYLAQQCBQAwCgYIKoZI" +
  "zj0EAwIDRwAwRAIgKUcmwIiFyKoJ6YqMxWPRllDS2zRtbNUeSX6JqZhbbGECIC7/P1EakuvHddwsjkvijro+JpJ/SiQOfm7L" +
  "AS2hkb9z";
const EVIL_ROOT_B64 =
  "MIIBOjCB4AIJALtzUcHvqrh4MAoGCCqGSM49BAMCMCUxIzAhBgNVBAMMGk5BU1RZIElBUCBUZXN0IFJvb3QgKGV2aWwpMB4X" +
  "DTI2MDczMDIxMzIyNVoXDTQ2MDcyNTIxMzIyNVowJTEjMCEGA1UEAwwaTkFTVFkgSUFQIFRlc3QgUm9vdCAoZXZpbCkwWTAT" +
  "BgcqhkjOPQIBBggqhkjOPQMBBwNCAAQG36UiLAawYlqw16ggd6GGXSmA626PSSxM7/U3MCG+0QxBFgMRZ0GkX4h9muOMlg1W" +
  "pDkUvwPhN0W2Aaa5STS0MAoGCCqGSM49BAMCA0kAMEYCIQC1QlcyNR5jlVl5KEgHLE7LxNFQtY1VaaGfGuSP9XpNSwIhAO0q" +
  "LvpJHsLUS6C948I2qWhY5t8wA3TjW69MGpJ+1O/L";
const EVIL_INTER_B64 =
  "MIIBeDCCAR6gAwIBAgIJAIfh3NpErN+/MAoGCCqGSM49BAMCMCUxIzAhBgNVBAMMGk5BU1RZIElBUCBUZXN0IFJvb3QgKGV2" +
  "aWwpMB4XDTI2MDczMDIxMzIyNVoXDTQ2MDcyNTIxMzIyNVowLTErMCkGA1UEAwwiTkFTVFkgSUFQIFRlc3QgSW50ZXJtZWRp" +
  "YXRlIChldmlsKTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABHHe/LZkjSKUwuJiTdBz+SJiJWFGqHVzPO48MbU/QC07/519" +
  "jWtQ5+Zw43gFog4pkTuKvcJG9DI/GkxOCWjkprGjLzAtMAwGA1UdEwQFMAMBAf8wCwYDVR0PBAQDAgIEMBAGCiqGSIb3Y2QG" +
  "AgEEAgUAMAoGCCqGSM49BAMCA0gAMEUCICcY6LZpxa616U/A8i39xcHOSmJEYYhYyCfTZH5rlP0YAiEAm8AGwd6EcYmgpJsH" +
  "7MXMyyWzyx2YQbWD9fOEKCDEhQ0=";
const EVIL_LEAF_B64 =
  "MIIBazCCARGgAwIBAgIJALySdGEKiOhfMAoGCCqGSM49BAMCMC0xKzApBgNVBAMMIk5BU1RZIElBUCBUZXN0IEludGVybWVk" +
  "aWF0ZSAoZXZpbCkwHhcNMjYwNzMwMjEzMjI1WhcNNDYwNzI1MjEzMjI1WjAoMSYwJAYDVQQDDB1OQVNUWSBJQVAgVGVzdCBT" +
  "aWduaW5nIChldmlsKTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABL+EpWR0MpLp4MS8iO6fPCnw4d48LRni37vTUU+UVjXS" +
  "6ZP9lfBmaEq4Ipb5KAVAE17S2HKeQo0LCcnOUXbokzOjHzAdMAkGA1UdEwQCMAAwEAYKKoZIhvdjZAYLAQQCBQAwCgYIKoZI" +
  "zj0EAwIDSAAwRQIgPC6khkl9HvaTZITGtlghbIys+uYYJvGvmb1AKmcwaLcCIQCip3uRfXRP7TjY/vCdg4NnAn3QWwSvW6fv" +
  "vqDDXpE4ow==";
const GOOD_LEAF_KEY_PEM = [
  "-----BEGIN EC PRIVATE KEY-----",
  "MHcCAQEEILcFESoTRCZSf+i+fDzMeM4YADXSarW/aLISqBLk0WI4oAoGCCqGSM49",
  "AwEHoUQDQgAEmJatGxQRvSgJkNACIwKIrE9/RVX9XEgOUGHBg9y3pb2u0aDSLxK1",
  "4k+ftYMifzU1aRxuVClRbBfQ/LkKHbKu8w==",
  "-----END EC PRIVATE KEY-----",
].join("\n");
const EVIL_LEAF_KEY_PEM = [
  "-----BEGIN EC PRIVATE KEY-----",
  "MHcCAQEEINxee7vQ8b/5ZIw5EnYEBlgv1eTu8OA5Iqgk9usssBKcoAoGCCqGSM49",
  "AwEHoUQDQgAEv4SlZHQykungxLyI7p88KfDh3jwtGeLfu9NRT5RWNdLpk/2V8GZo",
  "SrgilvkoBUATXtLYcp5CjQsJyc5RduiTMw==",
  "-----END EC PRIVATE KEY-----",
].join("\n");
const GOOD_LEAF_KEY = crypto.createPrivateKey(GOOD_LEAF_KEY_PEM);
const EVIL_LEAF_KEY = crypto.createPrivateKey(EVIL_LEAF_KEY_PEM);
const GOOD_X5C = [GOOD_LEAF_B64, GOOD_INTER_B64, GOOD_ROOT_B64];
const EVIL_X5C = [EVIL_LEAF_B64, EVIL_INTER_B64, EVIL_ROOT_B64];

/* --- minting signed transactions, exactly the shape StoreKit 2's jwsRepresentation has.
 * Everything is overridable so each negative case can break exactly ONE thing - the same
 * philosophy as mintIdentityToken in the kit. --- */
let txnCounter = 0;
function signJws(headerObj, payloadObj, key) {
  const input = K.b64url(JSON.stringify(headerObj)) + "." + K.b64url(JSON.stringify(payloadObj));
  const sig = crypto.sign("sha256", Buffer.from(input, "ascii"), { key, dsaEncoding: "ieee-p1363" });
  return input + "." + K.b64url(sig);
}
function mintTransaction(opts) {
  const o = opts || {};
  const payload = Object.assign({
    transactionId: o.transactionId !== undefined ? o.transactionId : "9" + Date.now() + "" + (txnCounter++),
    originalTransactionId: "9000000000",
    bundleId: o.bundleId !== undefined ? o.bundleId : "com.pangman.nasty",
    productId: o.productId !== undefined ? o.productId : "com.pangman.nasty.credits50",
    purchaseDate: Date.now(),
    quantity: o.quantity !== undefined ? o.quantity : 1,
    type: "Consumable",
    environment: o.environment !== undefined ? o.environment : "Sandbox",
  }, o.extra || {});
  const header = Object.assign({ alg: "ES256", x5c: o.x5c || GOOD_X5C }, o.header || {});
  if (o.alg === "none") {
    return { jws: K.b64url(JSON.stringify(Object.assign({}, header, { alg: "none" }))) + "." + K.b64url(JSON.stringify(payload)) + ".", payload };
  }
  return { jws: signJws(header, payload, o.signWith || GOOD_LEAF_KEY), payload };
}
// An App Store Server Notification V2 envelope: {signedPayload} whose verified payload carries
// the transaction as its OWN signed JWS in data.signedTransactionInfo.
function mintNotification(type, txnJws, opts) {
  const o = opts || {};
  const payload = {
    notificationType: type,
    subtype: o.subtype || "",
    notificationUUID: "test-" + Date.now() + "-" + (txnCounter++),
    data: { bundleId: "com.pangman.nasty", environment: o.environment || "Sandbox", signedTransactionInfo: txnJws },
    version: "2.0",
    signedDate: Date.now(),
  };
  return signJws({ alg: "ES256", x5c: o.x5c || GOOD_X5C }, payload, o.signWith || GOOD_LEAF_KEY);
}

async function main() {
  const key = K.makeKeyPair("iap-key");
  const scratch = K.makeScratch(`acct-iap-${KIND}`);
  const port = randPort();
  const base = `http://localhost:${port}`;
  const envExtra = {
    NASTY_APPLE_ISSUER: ISSUER,
    NASTY_APPLE_AUDIENCES: AUD,
    NASTY_ACCOUNT_RATE_LIMIT: "4000",
    // The whole point of this suite: the server trusts the throwaway root, not Apple's.
    NASTY_IAP_ROOT_CA_B64: GOOD_ROOT_B64,
    NASTY_IAP_LEDGER_FILE: path.join(scratch, "iap-ledger.json"),
    NASTY_IAP_EVENTS_FILE: path.join(scratch, "iap-events.json"),
  };
  const jwks = await K.startJwksServer([key]);
  envExtra.NASTY_APPLE_JWKS_URL = jwks.url;
  const env = K.serverEnv(KIND, scratch, port, ADMIN_TOKEN, envExtra);
  const srv = K.startServer(KIND, env, "ACCOUNTS_VERBOSE");
  await K.waitHealthy(base);
  const c = K.makeClient(base);

  async function signInAs(sub) {
    const r = await c.signIn(key, { sub });
    if (r.status !== 200) throw new Error("sign-in failed for " + sub + ": " + JSON.stringify(r.body));
    return r.body;
  }
  async function wallet(auth) { return await c.post("/account/wallet", { auth }); }
  async function verify(auth, jws) { return await c.post("/account/iap/verify", { auth, jws }); }
  async function notify(signedPayload) { return await c.post("/appstore/notifications", { signedPayload }); }

  try {
    const buyer = await signInAs("001333.iapbuyer.0001");
    await c.post("/account/name", { auth: buyer.sessionToken, name: "Buyer" });
    let secondTxn = null;   // minted in I3, refunded in I9

    /* ===================== I1: the packs are listed, and Blake's divisible-by-10 rule holds ===================== */
    {
      const r = await c.get("/shop");
      check(r.status === 200 && Array.isArray(r.body.creditPacks) && r.body.creditPacks.length === 4,
        "I1 GET /shop lists the credit packs: " + JSON.stringify(r.body.creditPacks));
      check(r.body.creditPacks.every((p) => p.credits % 10 === 0 && p.credits > 0 && typeof p.productId === "string"),
        "I1b every pack's credit count is a positive multiple of 10");
      const anchor = r.body.creditPacks.find((p) => p.productId === "com.pangman.nasty.credits50");
      check(!!anchor && anchor.credits === 50 && anchor.usd === 4.99,
        "I1c the base pack is the 10-credits-per-dollar anchor (50 credits / $4.99): " + JSON.stringify(anchor));
      check(r.body.items.every((it) => it.cost % 10 === 0),
        "I1d Blake's rule, locked in: EVERY shop item cost is divisible by 10 after the reprice");
      const online = r.body.items.find((it) => it.id === "online_month");
      check(!!online && online.cost === 50, "I1e Online Access is still exactly 50 credits ($5 at the anchor)");
    }

    /* ===================== I2: a valid transaction credits the wallet - and only the wallet ===================== */
    let firstTxn;
    {
      firstTxn = mintTransaction({});
      const before = await wallet(buyer.sessionToken);
      check(before.body.balance === 0 && before.body.purchasedCredits === 0, "I2 setup: a fresh account holds nothing");
      const r = await verify(buyer.sessionToken, firstTxn.jws);
      check(r.status === 200 && r.body.ok === true && r.body.creditsAdded === 50,
        "I2b a valid signed sandbox transaction credits 50: " + JSON.stringify(r.body));
      check(r.body.transactionId === firstTxn.payload.transactionId && r.body.productId === "com.pangman.nasty.credits50",
        "I2c the response reports the verified transaction, not anything the client claimed");
      check(r.body.wallet.purchasedCredits === 50 && r.body.wallet.balance === 50 && r.body.wallet.lifetimeEarned === 0,
        "I2d ONLY purchasedCredits moved - lifetimeEarned (the leaderboard's number) is untouched: " + JSON.stringify(r.body.wallet));
      const w = await wallet(buyer.sessionToken);
      check(w.body.purchasedCredits === 50 && w.body.balance === 50, "I2e a fresh wallet read agrees");
      const board = await (await fetch(base + "/leaderboard")).json();
      check(!board.Buyer, "I2f and the leaderboard has no row for Buyer at all - money never creates one");
    }

    /* ===================== I3: REPLAY - the case that must not be wrong ===================== */
    {
      const r = await verify(buyer.sessionToken, firstTxn.jws);
      check(r.status === 200 && r.body.ok === true && r.body.alreadyProcessed === true && r.body.creditsAdded === 0,
        "I3 resubmitting the SAME transaction answers alreadyProcessed with zero new credits (so the app can always finish() safely): " + JSON.stringify(r.body));
      check(r.body.wallet.purchasedCredits === 50, "I3b and the balance did not move: " + JSON.stringify(r.body.wallet));

      // Two CONCURRENT submissions of one brand-new transaction - the double-tap/lost-reply
      // shape, fired in parallel. Exactly one may credit.
      const race = mintTransaction({});
      secondTxn = race;   // I9 refunds this same pack later
      const [r1, r2] = await Promise.all([
        verify(buyer.sessionToken, race.jws),
        verify(buyer.sessionToken, race.jws),
      ]);
      check(r1.status === 200 && r2.status === 200, "I3c both concurrent submissions get a clean 200");
      const credited = [r1, r2].filter((x) => x.body.creditsAdded === 50).length;
      const replayed = [r1, r2].filter((x) => x.body.alreadyProcessed === true).length;
      check(credited === 1 && replayed === 1,
        "I3d exactly ONE credited and exactly one was answered as already processed: credited=" + credited + " replayed=" + replayed);
      const w = await wallet(buyer.sessionToken);
      check(w.body.purchasedCredits === 100, "I3e total purchased credits moved by exactly one pack (50+50=100): " + w.body.purchasedCredits);

      // A different account replaying Buyer's receipt gets nothing.
      const thief = await signInAs("001333.iapthief.0002");
      const rT = await verify(thief.sessionToken, firstTxn.jws);
      check(rT.status === 409 && rT.body.error === "alreadyused",
        "I3f replaying someone else's receipt on a second account is refused: " + JSON.stringify(rT.body));
      const wT = await wallet(thief.sessionToken);
      check(wT.body.purchasedCredits === 0 && wT.body.balance === 0, "I3g and the second account was credited nothing");
    }

    /* ===================== I4: forged - right shape, wrong root ===================== */
    {
      const before = await wallet(buyer.sessionToken);
      const forged = mintTransaction({ x5c: EVIL_X5C, signWith: EVIL_LEAF_KEY });
      const r = await verify(buyer.sessionToken, forged.jws);
      check(r.status === 400 && r.body.error === "untrustedroot",
        "I4 a transaction signed by a chain rooted outside the pinned root is rejected: " + JSON.stringify(r.body));
      const after = await wallet(buyer.sessionToken);
      check(after.body.purchasedCredits === before.body.purchasedCredits, "I4b and nothing was credited");
    }

    /* ===================== I5: tampered ===================== */
    {
      const before = await wallet(buyer.sessionToken);
      // (a) real signature, payload swapped underneath it - the classic tamper.
      const real = mintTransaction({});
      const parts = real.jws.split(".");
      const fatPayload = Object.assign({}, real.payload, { productId: "com.pangman.nasty.credits600" });
      const tampered = parts[0] + "." + K.b64url(JSON.stringify(fatPayload)) + "." + parts[2];
      const rA = await verify(buyer.sessionToken, tampered);
      check(rA.status === 400 && rA.body.error === "badsig", "I5 payload swapped under a real signature: rejected: " + JSON.stringify(rA.body));
      // (b) the TRUSTED chain presented, but the signature made with a different key.
      const wrongKey = mintTransaction({ signWith: EVIL_LEAF_KEY });
      const rB = await verify(buyer.sessionToken, wrongKey.jws);
      check(rB.status === 400 && rB.body.error === "badsig", "I5b good chain + wrong signing key: rejected");
      // (c) alg:none - no signature at all.
      const none = mintTransaction({ alg: "none" });
      const rC = await verify(buyer.sessionToken, none.jws);
      check(rC.status === 400 && rC.body.error === "badalg", "I5c alg:none: rejected before any key material is touched");
      const after = await wallet(buyer.sessionToken);
      check(after.body.purchasedCredits === before.body.purchasedCredits, "I5d and none of the three credited anything");
    }

    /* ===================== I6 + I7: validly signed but wrong product / wrong app ===================== */
    {
      const before = await wallet(buyer.sessionToken);
      const wrongProduct = mintTransaction({ productId: "com.pangman.nasty.somefutureproduct" });
      const rP = await verify(buyer.sessionToken, wrongProduct.jws);
      check(rP.status === 400 && rP.body.error === "unknownproduct",
        "I6 a validly signed transaction for a product that is not a credit pack is refused: " + JSON.stringify(rP.body));
      const wrongApp = mintTransaction({ bundleId: "com.somebody.else" });
      const rB2 = await verify(buyer.sessionToken, wrongApp.jws);
      check(rB2.status === 400 && rB2.body.error === "wrongapp",
        "I7 a validly signed transaction for a different app's bundle id is refused: " + JSON.stringify(rB2.body));
      const after = await wallet(buyer.sessionToken);
      check(after.body.purchasedCredits === before.body.purchasedCredits, "I6b/I7b and neither credited anything");
    }

    /* ===================== I8: bought credits spend through the NORMAL purchase path ===================== */
    {
      // Buyer has 100 purchased credits and ZERO earned points. Buying a felt (20) must work
      // through the exact same /account/purchase route earned credits use - no forked path.
      const r = await c.post("/account/purchase", { auth: buyer.sessionToken, itemId: "felt_burgundy" });
      check(r.status === 200 && r.body.ok === true && r.body.purchased === "felt_burgundy",
        "I8 a shop purchase paid entirely with bought credits succeeds through the normal route: " + JSON.stringify(r.body && r.body.wallet));
      check(r.body.wallet.spent === 20 && r.body.wallet.balance === 80 && r.body.wallet.purchasedCredits === 100,
        "I8b spent moved by the item cost exactly like an earned-credit purchase (100-20=80): " + JSON.stringify(r.body.wallet));
      const board = await (await fetch(base + "/leaderboard")).json();
      check(!board.Buyer, "I8c the leaderboard STILL has no Buyer row - neither buying credits nor spending them touches it");
    }

    /* ===================== I9: refunds (App Store Server Notifications V2) ===================== */
    {
      // Refund the FIRST pack. Buyer holds 100 purchased / 20 spent -> claw back the full 50.
      const before = await wallet(buyer.sessionToken);
      const rN = await notify(mintNotification("REFUND", firstTxn.jws));
      check(rN.status === 200, "I9 a signed REFUND notification is accepted: " + rN.status);
      const after = await wallet(buyer.sessionToken);
      check(after.body.purchasedCredits === before.body.purchasedCredits - 50,
        "I9b the refunded pack's 50 credits came back off purchasedCredits: " + before.body.purchasedCredits + " -> " + after.body.purchasedCredits);
      // Replay the SAME refund - recorded, but deducts nothing twice.
      const rN2 = await notify(mintNotification("REFUND", firstTxn.jws));
      check(rN2.status === 200, "I9c a replayed refund notification still answers 200");
      const after2 = await wallet(buyer.sessionToken);
      check(after2.body.purchasedCredits === after.body.purchasedCredits,
        "I9d and deducts NOTHING the second time: " + after2.body.purchasedCredits);
      // The already-spent case: some of the bought credits were spent on real items before the
      // refund lands. Buyer now holds 50 purchased / 20 spent / balance 30 - spend another 20
      // (felt_navy), then refund the remaining pack. The deduction floors at what is left and
      // the BALANCE clamps at 0 rather than ever going negative, even though 40 of the credits
      // that pack's money paid for are already gone into items.
      const spendMore = await c.post("/account/purchase", { auth: buyer.sessionToken, itemId: "felt_navy" });
      check(spendMore.status === 200, "I9e setup: spend more of the bought credits (felt_navy, 20)");
      const rN3 = await notify(mintNotification("REFUND", secondTxn.jws));
      check(rN3.status === 200, "I9f the second pack's refund is accepted");
      const wEnd = await wallet(buyer.sessionToken);
      check(wEnd.body.purchasedCredits === 0 && wEnd.body.balance === 0 && wEnd.body.spent === 40,
        "I9g with everything refunded and 40 already spent, purchasedCredits floors at 0 and balance clamps at 0 - never negative: " + JSON.stringify(wEnd.body));
      check(wEnd.body.owned.includes("felt_burgundy") && wEnd.body.owned.includes("felt_navy"),
        "I9h items bought with since-refunded credits STAY owned - the stated, accepted limit of claw-back");
    }

    /* ===================== I10: guests and garbage ===================== */
    {
      const r1 = await verify(undefined, mintTransaction({}).jws);
      check(r1.status === 401 && r1.body.error === "signedout", "I10 a guest gets the same clean 401 every account route answers");
      const r2 = await verify(buyer.sessionToken, "not-a-jws-at-all");
      check(r2.status === 400 && r2.body.error === "badjws", "I10b garbage input: clean 400, not a crash");
      const r3 = await verify(buyer.sessionToken, undefined);
      check(r3.status === 400 && r3.body.error === "badjws", "I10c missing jws: clean 400, not a crash");
      const r4 = await notify("garbage.notification.payload");
      check(r4.status === 401, "I10d a garbage notification POST is refused with 401 (Apple-signed or nothing)");
    }
  } catch (e) {
    FAIL++;
    log("FAIL", "unexpected exception: " + (e && e.stack || e));
  } finally {
    await K.stopServer(srv);
  }

  /* ===================== I11: the environment gate, on a separately-booted server ===================== */
  try {
    const port2 = randPort() + 700;
    const base2 = `http://localhost:${port2}`;
    const scratch2 = K.makeScratch(`acct-iap-env-${KIND}`);
    const env2 = K.serverEnv(KIND, scratch2, port2, ADMIN_TOKEN, Object.assign({}, {
      NASTY_APPLE_ISSUER: ISSUER,
      NASTY_APPLE_AUDIENCES: AUD,
      NASTY_APPLE_JWKS_URL: jwks.url,
      NASTY_ACCOUNT_RATE_LIMIT: "4000",
      NASTY_IAP_ROOT_CA_B64: GOOD_ROOT_B64,
      NASTY_IAP_LEDGER_FILE: path.join(scratch2, "iap-ledger.json"),
      NASTY_IAP_EVENTS_FILE: path.join(scratch2, "iap-events.json"),
      NASTY_IAP_ALLOW_SANDBOX: "0",   // the launch-day setting - see the server's own comment
    }));
    const srv2 = K.startServer(KIND, env2, "ACCOUNTS_VERBOSE");
    await K.waitHealthy(base2);
    const c2 = K.makeClient(base2);
    const who = await (async () => {
      const r = await c2.signIn(key, { sub: "001333.iapenvcase.0003" });
      if (r.status !== 200) throw new Error("I11 sign-in failed: " + JSON.stringify(r.body));
      return r.body;
    })();
    const sandboxTxn = mintTransaction({});
    const r = await c2.post("/account/iap/verify", { auth: who.sessionToken, jws: sandboxTxn.jws });
    check(r.status === 400 && r.body.error === "badenv",
      "I11 with NASTY_IAP_ALLOW_SANDBOX=0 the exact same sandbox transaction the main server accepted is refused: " + JSON.stringify(r.body));
    const w = await c2.post("/account/wallet", { auth: who.sessionToken });
    check(w.body.purchasedCredits === 0, "I11b and nothing was credited");
    await K.stopServer(srv2);
  } catch (e) {
    FAIL++;
    log("FAIL", "unexpected exception in I11: " + (e && e.stack || e));
  } finally {
    jwks.close();
  }

  log(`${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main();
