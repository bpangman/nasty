"use strict";
/*
 * 2026-07-28 § POINTS WALLET ADMIN GRANT - proves POST /admin/wallet/grantall against BOTH
 * servers, on a scratch account, BEFORE this is ever run against Blake's real production
 * "Baker Sr." account: grants every non-consumable catalog item plus a namechange credit count,
 * WITHOUT moving lifetime earned or spent, and is fully reversible.
 *
 * Never touches production - private port, scratch KV/account files, throwaway admin token.
 *
 * Usage:
 *   node test_admin_wallet_grant.js node
 *   node test_admin_wallet_grant.js deno
 */
const K = require("./test_accounts_kit.js");

const KIND = process.argv[2] || "node";
const ADMIN_TOKEN = "grantall-admin-token";
const AUD = "com.pangman.nasty";
const ISSUER = "https://test.local";

let PASS = 0, FAIL = 0;
function log(...a) { console.log("[grantall]", ...a); }
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
function randPort() { return 31900 + Math.floor(Math.random() * 300); }

async function main() {
  const key = K.makeKeyPair("grantall-key");
  const scratch = K.makeScratch(`grantall-${KIND}`);
  const port = randPort();
  const base = `http://localhost:${port}`;
  const jwks = await K.startJwksServer([key]);
  const env = K.serverEnv(KIND, scratch, port, ADMIN_TOKEN, {
    NASTY_APPLE_ISSUER: ISSUER, NASTY_APPLE_AUDIENCES: AUD, NASTY_ACCOUNT_RATE_LIMIT: "4000",
    NASTY_APPLE_JWKS_URL: jwks.url,
  });
  const srv = K.startServer(KIND, env, "GRANTALL_VERBOSE");
  await K.waitHealthy(base);
  const c = K.makeClient(base);

  async function admin(pathname, body) {
    const r = await fetch(base + pathname, {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
      body: JSON.stringify(body || {}),
    });
    return { status: r.status, body: await r.json() };
  }
  async function wallet(auth) { return await c.post("/account/wallet", { auth }); }
  async function shop() { return (await c.get("/shop")).body.items; }

  try {
    const signedR = await c.signIn(key, { sub: "001333.bakersr.0001" });
    check(signedR.status === 200, "setup: sign-in succeeded: " + JSON.stringify(signedR.body));
    const signed = signedR.body;
    const authTok = signed.sessionToken;
    const named = await c.post("/account/name", { auth: authTok, name: "Baker Sr." });
    check(named.status === 200, "setup: Baker Sr. test double named successfully");

    // Give the test account a real earned/spent history via a normal solo result + a normal
    // purchase, so the grant's "must not move earned or spent" claim has something real to
    // prove itself against, and so the leaderboard-row invariant is checkable too.
    await fetch(base + "/solo-result", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: `grantall-seed-${KIND}`, entries: [{ name: "Baker Sr.", delta: { hg4s: 3, hw4s: 1, hptsS: 30 } }] }),
    });
    const items = await shop();
    const cheapest = items.filter((it) => !it.consumable).sort((a, b) => a.cost - b.cost)[0];
    const purchased = await c.post("/account/purchase", { auth: authTok, itemId: cheapest.id });
    check(purchased.status === 200, "setup: a real purchase landed first, so grantall must not disturb it: " + JSON.stringify(purchased.body));

    const lbBefore = await (await fetch(base + "/leaderboard")).json();
    const walletBefore = (await wallet(authTok)).body;
    check(walletBefore.owned.includes(cheapest.id), "setup: the real purchase is reflected before granting");
    const spentBefore = walletBefore.spent;
    const earnedBefore = walletBefore.lifetimeEarned;

    /* ===================== the grant itself, by name (Blake's own words: "nickname on account
       is Baker Sr.") ===================== */
    const g = await admin("/admin/wallet/grantall", { name: "Baker Sr." });
    check(g.status === 200 && g.body.ok === true, "G1 grantall succeeds by name lookup: " + JSON.stringify(g.body));
    check(g.body.grantedItems === items.filter((it) => !it.consumable).length - 1,
      "G2 grants every non-consumable item EXCEPT the one already owned from the real purchase: " + g.body.grantedItems);
    check(g.body.grantedCredits === 2, "G3 default grant is 2 namechange credits ('a couple', per the ask): " + g.body.grantedCredits);

    const walletAfter = (await wallet(authTok)).body;
    check(walletAfter.owned.length === items.filter((it) => !it.consumable).length,
      "G4 every non-consumable catalog item is now owned: " + walletAfter.owned.length + " vs " + items.filter((it) => !it.consumable).length);
    check(items.filter((it) => !it.consumable).every((it) => walletAfter.owned.includes(it.id)),
      "G5 specifically every catalog id is present, not just the right COUNT");
    check(walletAfter.namechangeCredits === 2, "G6 namechange credits are now 2: " + walletAfter.namechangeCredits);

    /* ===================== the headline invariant: earned/spent/leaderboard untouched ===================== */
    check(walletAfter.spent === spentBefore, "G7 `spent` did NOT move - a grant is not a purchase: " + walletAfter.spent + " vs " + spentBefore);
    check(walletAfter.lifetimeEarned === earnedBefore, "G8 `lifetimeEarned` did NOT move: " + walletAfter.lifetimeEarned + " vs " + earnedBefore);
    const lbAfter = await (await fetch(base + "/leaderboard")).json();
    check(JSON.stringify(lbAfter["Baker Sr."]) === JSON.stringify(lbBefore["Baker Sr."]),
      "G9 the leaderboard row is BYTE-IDENTICAL before and after the grant: before=" +
      JSON.stringify(lbBefore["Baker Sr."]) + " after=" + JSON.stringify(lbAfter["Baker Sr."]));
    check(JSON.stringify(lbAfter) === JSON.stringify(lbBefore), "G10 the WHOLE /leaderboard body is byte-identical, not just this one row");

    /* ===================== a second grantall call is a safe no-op on ownership, still tops up credits as asked ===================== */
    const g2 = await admin("/admin/wallet/grantall", { name: "Baker Sr." });
    check(g2.body.grantedItems === 0, "G11 a second call grants 0 NEW items (everything already owned): " + g2.body.grantedItems);
    check(g2.body.wallet.owned.length === items.filter((it) => !it.consumable).length, "G12 ownership count unchanged by the repeat call");
    check(g2.body.wallet.namechangeCredits === 4, "G13 credits keep stacking on repeat calls (2 -> 4), exactly like a real repeated purchase would: " + g2.body.wallet.namechangeCredits);

    /* ===================== uid form works too, for scripting ===================== */
    const g3 = await admin("/admin/wallet/grantall", { uid: signed.uid, namechangeCredits: 0 });
    check(g3.status === 200 && g3.body.grantedItems === 0, "G14 grant-by-uid also works, and namechangeCredits:0 grants none: " + JSON.stringify(g3.body));

    /* ===================== reversal ===================== */
    const rv = await admin("/admin/wallet/grantall", { name: "Baker Sr.", revoke: true, namechangeCredits: 4 });
    check(rv.status === 200 && rv.body.ok === true, "G15 revoke succeeds: " + JSON.stringify(rv.body));
    const walletRevoked = rv.body.wallet;
    check(walletRevoked.owned.length === 1 && walletRevoked.owned[0] === cheapest.id,
      "G16 revoke removes exactly the GRANTED items, leaving the genuinely PURCHASED one alone: " + JSON.stringify(walletRevoked.owned));
    check(walletRevoked.namechangeCredits === 0, "G17 revoke subtracts the credits back off to zero: " + walletRevoked.namechangeCredits);
    check(walletRevoked.spent === spentBefore && walletRevoked.lifetimeEarned === earnedBefore,
      "G18 revoke ALSO never touches earned/spent: " + JSON.stringify(walletRevoked));
    const lbAfterRevoke = await (await fetch(base + "/leaderboard")).json();
    check(JSON.stringify(lbAfterRevoke) === JSON.stringify(lbBefore), "G19 leaderboard is STILL byte-identical after the revoke round-trip");

    /* ===================== error paths ===================== */
    const noAuth = await fetch(base + "/admin/wallet/grantall", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    check(noAuth.status === 401, "G20 no admin token -> 401, never a free grant: " + noAuth.status);
    const noSuch = await admin("/admin/wallet/grantall", { name: "Nobody Here At All" });
    check(noSuch.status === 404, "G21 an unknown name -> 404, not a crash: " + JSON.stringify(noSuch.body));
  } finally {
    await K.stopServer(srv);
  }

  log(`${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
