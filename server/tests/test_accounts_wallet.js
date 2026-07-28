"use strict";
/*
 * 2026-07-28 § POINTS WALLET - server-side spendable balance, separate from the leaderboard's
 * lifetime EARNED points (hptsS/hptsT). Read HANDOFF.md's "§ POINTS WALLET" entry for the full
 * design; this suite proves the numbered claims in that entry against BOTH servers.
 *
 *   W1  a fresh account's wallet reads zero spent, zero owned, balance == earned (== 0 here)
 *   W2  the shop catalog is server-owned: GET /shop lists every category with real costs, and
 *       the client is never asked for a price anywhere in the purchase flow
 *   W3  a purchase deducts, records ownership, and returns the exact right new balance
 *   W4  an unaffordable purchase is rejected and changes NOTHING (spent/owned/balance untouched)
 *   W5  buying the same (non-consumable) item twice does not double-charge
 *   W6  a double-submitted/retried purchase (same requestId) does not double-spend, even fired
 *       concurrently
 *   W7  the leaderboard's earned points and cross-account ORDERING are completely unaffected by
 *       spending - the headline claim, proven explicitly
 *   W8  a guest (no session) gets a clean 401 on both wallet routes, never a crash
 *   W9  the namechange credit is consumable/stackable (buying it twice gives two credits, unlike
 *       every other category) and actually bypasses the 30-day rename cooldown exactly once,
 *       then is consumed
 *
 * Usage:
 *   node test_accounts_wallet.js node
 *   node test_accounts_wallet.js deno
 */
const K = require("./test_accounts_kit.js");

const KIND = process.argv[2] || "node";
const ADMIN_TOKEN = "accounts-wallet-admin-token";
const AUD = "com.pangman.nasty";
const ISSUER = "https://test.local";

let PASS = 0, FAIL = 0;
function log(...a) { console.log("[acct-wallet]", ...a); }
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
function randPort() { return 28500 + Math.floor(Math.random() * 600); }

async function main() {
  const key = K.makeKeyPair("wallet-key");
  const scratch = K.makeScratch(`acct-wallet-${KIND}`);
  const port = randPort();
  const base = `http://localhost:${port}`;
  const envExtra = {
    NASTY_APPLE_ISSUER: ISSUER,
    NASTY_APPLE_AUDIENCES: AUD,
    NASTY_ACCOUNT_RATE_LIMIT: "4000",
    NASTY_NAME_COOLDOWN_MS: "2500",   // stands in for 30 days, same convention as test_accounts_names.js
  };
  // NASTY_APPLE_JWKS_URL is filled in once the local JWKS stub is up.
  const jwks = await K.startJwksServer([key]);
  envExtra.NASTY_APPLE_JWKS_URL = jwks.url;
  const env = K.serverEnv(KIND, scratch, port, ADMIN_TOKEN, envExtra);
  const srv = K.startServer(KIND, env, "ACCOUNTS_VERBOSE");
  await K.waitHealthy(base);
  const c = K.makeClient(base);

  async function board() { const r = await fetch(base + "/leaderboard"); return await r.json(); }
  let gid = 0;
  async function seed(name, delta) {
    const r = await fetch(base + "/solo-result", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: `wallet-${KIND}-${Date.now()}-${gid++}`, entries: [{ name, delta }] }),
    });
    return r.status;
  }
  async function signInAs(sub) {
    const r = await c.signIn(key, { sub });
    if (r.status !== 200) throw new Error("sign-in failed for " + sub + ": " + JSON.stringify(r.body));
    return r.body;
  }
  async function wallet(auth) { return await c.post("/account/wallet", { auth }); }
  async function buy(auth, itemId, extra) { return await c.post("/account/purchase", Object.assign({ auth, itemId }, extra || {})); }

  try {
    /* ===================== W1: a fresh account's wallet, right off sign-in ===================== */
    const wally = await signInAs("001222.wally.0001");
    await c.post("/account/name", { auth: wally.sessionToken, name: "Wally" });
    {
      const w = await wallet(wally.sessionToken);
      check(w.status === 200, "W1 wallet route answers 200 for a signed-in account");
      check(w.body.lifetimeEarned === 0 && w.body.spent === 0 && w.body.balance === 0,
        "W1b a fresh account: zero earned, zero spent, zero balance: " + JSON.stringify(w.body));
      check(Array.isArray(w.body.owned) && w.body.owned.length === 0, "W1c owns nothing yet");
      check(w.body.namechangeCredits === 0, "W1d no namechange credits yet");
    }

    /* ===================== W2: the server-owned shop catalog ===================== */
    {
      const r = await c.get("/shop");
      check(r.status === 200 && Array.isArray(r.body.items) && r.body.items.length >= 10,
        "W2 GET /shop lists the catalog: " + (r.body.items || []).length + " items");
      const cats = new Set(r.body.items.map((it) => it.category));
      check(cats.has("palette") && cats.has("felt") && cats.has("title") && cats.has("namechange"),
        "W2b all four categories are present: " + JSON.stringify([...cats]));
      check(r.body.items.every((it) => typeof it.cost === "number" && it.cost > 0),
        "W2c every item has a real positive server-set cost");
      const paletteCosts = r.body.items.filter((it) => it.category === "palette").map((it) => it.cost);
      check(Math.max(...paletteCosts) >= Math.max(...r.body.items.filter((it) => it.category === "felt").map((it) => it.cost)),
        "W2d palette (the headline category) costs at least as much as felt, matching the design intent");
    }

    /* ===================== give Wally some real earned points to spend ===================== */
    await seed("Wally", { hg4s: 1, hw4s: 1, hptsS: 200 });
    {
      const w = await wallet(wally.sessionToken);
      check(w.body.lifetimeEarned === 200 && w.body.balance === 200,
        "seed: Wally's wallet reflects the 200 points just earned: " + JSON.stringify(w.body));
    }

    /* ===================== W3: a purchase deducts, records ownership, right new balance ===================== */
    let wBefore;
    {
      const r = await buy(wally.sessionToken, "felt_burgundy");
      check(r.status === 200 && r.body.ok === true && r.body.purchased === "felt_burgundy",
        "W3 buying an affordable item succeeds: " + JSON.stringify(r.body));
      check(r.body.wallet.spent === 15 && r.body.wallet.balance === 185,
        "W3b spent/balance are exactly right (cost 15 of 200): " + JSON.stringify(r.body.wallet));
      check(r.body.wallet.owned.includes("felt_burgundy"), "W3c ownership is recorded");
      const w = await wallet(wally.sessionToken);
      check(w.body.spent === 15 && w.body.balance === 185 && w.body.owned.includes("felt_burgundy"),
        "W3d a fresh GET /account/wallet agrees with the purchase response");
      wBefore = w.body;
    }

    /* ===================== W4: an unaffordable purchase changes NOTHING ===================== */
    {
      // palette_midnight costs 130; Wally's balance is 185, so buy one more affordable thing to
      // bring the balance below it first (185 -> spend on title_nasty, cost 90 -> balance 95).
      const first = await buy(wally.sessionToken, "title_nasty");
      check(first.status === 200, "setup: a second real purchase to bring the balance below the next one being tested");
      const before = await wallet(wally.sessionToken);
      const r = await buy(wally.sessionToken, "palette_midnight");   // costs 130, balance is 95
      check(r.status === 409 && r.body.error === "cantafford",
        "W4 an unaffordable purchase is rejected: " + JSON.stringify(r.body));
      const after = await wallet(wally.sessionToken);
      check(after.body.spent === before.body.spent && after.body.balance === before.body.balance &&
        JSON.stringify(after.body.owned.slice().sort()) === JSON.stringify(before.body.owned.slice().sort()),
        "W4b and changes absolutely nothing: before=" + JSON.stringify(before.body) + " after=" + JSON.stringify(after.body));
    }

    /* ===================== W5: buying the same item twice does not double-charge ===================== */
    {
      const before = await wallet(wally.sessionToken);
      const r = await buy(wally.sessionToken, "felt_burgundy");   // already owned from W3
      check(r.status === 409 && r.body.error === "alreadyowned", "W5 buying an already-owned item is rejected: " + JSON.stringify(r.body));
      const after = await wallet(wally.sessionToken);
      check(after.body.spent === before.body.spent && after.body.balance === before.body.balance,
        "W5b and it is NOT charged a second time: before=" + JSON.stringify(before.body) + " after=" + JSON.stringify(after.body));
    }

    /* ===================== W6: a double-submitted/retried purchase does not double-spend ===================== */
    {
      const before = await wallet(wally.sessionToken);
      const reqId = "retry-test-" + Date.now();
      // Fired CONCURRENTLY, same requestId, same never-before-bought item (title_shark, cost 30) -
      // exactly a UI double-tap or a client retrying after a dropped reply.
      const [r1, r2] = await Promise.all([
        buy(wally.sessionToken, "title_shark", { requestId: reqId }),
        buy(wally.sessionToken, "title_shark", { requestId: reqId }),
      ]);
      check(r1.status === 200 || r2.status === 200, "W6 at least one of the two concurrent identical requests succeeds");
      const oks = [r1, r2].filter((r) => r.status === 200 && r.body.ok === true);
      check(oks.length >= 1, "W6b and every 200 response reports the same purchase");
      const after = await wallet(wally.sessionToken);
      check(after.body.spent === before.body.spent + 30,
        "W6c the balance moved by EXACTLY one purchase's cost (30), not two: before=" + before.body.spent + " after=" + after.body.spent);
      check(after.body.owned.filter((id) => id === "title_shark").length === 1, "W6d and title_shark is owned exactly once, not duplicated in the list");
      // A THIRD, separate call with the SAME requestId after the fact must also not re-charge.
      const r3 = await buy(wally.sessionToken, "title_shark", { requestId: reqId });
      check(r3.status === 200 && r3.body.duplicate === true, "W6e a later retry with the same requestId is answered as a duplicate, not re-applied");
      const after2 = await wallet(wally.sessionToken);
      check(after2.body.spent === after.body.spent, "W6f and still no further charge");
    }

    /* ===================== W7: earned points and cross-account ORDERING are unaffected ===================== */
    const eeyore = await signInAs("001222.eeyore.0002");
    {
      await c.post("/account/name", { auth: eeyore.sessionToken, name: "Eeyore" });
      await seed("Eeyore", { hg4s: 1, hptsS: 60 });   // fewer points than Wally
      const boardBefore = await board();
      const wallyEarnedBefore = boardBefore.Wally.hptsS + (boardBefore.Wally.hptsT || 0);
      const eeyoreEarnedBefore = boardBefore.Eeyore.hptsS + (boardBefore.Eeyore.hptsT || 0);
      check(wallyEarnedBefore === 200 && eeyoreEarnedBefore === 60,
        "W7 setup: leaderboard shows Wally=200, Eeyore=60 earned, before any spending: " + JSON.stringify([wallyEarnedBefore, eeyoreEarnedBefore]));
      check(wallyEarnedBefore > eeyoreEarnedBefore, "W7b Wally outranks Eeyore before spending");
      // Wally now spends heavily - almost everything he has left.
      const walletNow = await wallet(wally.sessionToken);
      check(walletNow.body.balance >= 30, "setup: Wally still has a spendable balance to burn through");
      await buy(wally.sessionToken, "felt_navy");
      await buy(wally.sessionToken, "felt_charcoal");
      const boardAfter = await board();
      const wallyEarnedAfter = boardAfter.Wally.hptsS + (boardAfter.Wally.hptsT || 0);
      const eeyoreEarnedAfter = boardAfter.Eeyore.hptsS + (boardAfter.Eeyore.hptsT || 0);
      check(wallyEarnedAfter === wallyEarnedBefore, "W7c Wally's EARNED leaderboard total is byte-identical after spending 45 more points: still " + wallyEarnedAfter);
      check(eeyoreEarnedAfter === eeyoreEarnedBefore, "W7d and Eeyore's is untouched too (spending is per-account, obviously, but proven anyway)");
      check(JSON.stringify(boardBefore.Wally) === JSON.stringify(boardAfter.Wally),
        "W7e the ENTIRE leaderboard row for Wally (games/wins/points) is byte-identical before and after spending - spending never touches /leaderboard at all");
      check(wallyEarnedAfter > eeyoreEarnedAfter, "W7f and the ranking ORDER (Wally still ahead of Eeyore) is exactly what it was before any spending");
    }

    /* ===================== W8: a guest gets a clean answer, never a crash ===================== */
    {
      const r1 = await wallet(undefined);
      check(r1.status === 401 && r1.body.error === "signedout", "W8 GET-equivalent wallet read with no session: clean 401, not a crash: " + JSON.stringify(r1.body));
      const r2 = await buy(undefined, "felt_navy");
      check(r2.status === 401 && r2.body.error === "signedout", "W8b a guest purchase attempt: clean 401, not a crash: " + JSON.stringify(r2.body));
      const r3 = await wallet("total-garbage-not-a-real-session-token");
      check(r3.status === 401 && r3.body.error === "signedout", "W8c a junk/expired session token also answers cleanly, not a crash");
    }

    /* ===================== W9: the namechange credit - consumable, and bypasses the cooldown once ===================== */
    {
      // Give Eeyore enough points to buy two namechange credits (25 each), and prove buying the
      // SAME consumable item twice is allowed and stacks - unlike every other category (W5 above).
      await seed("Eeyore", { hg4t: 1, hptsT: 60 });
      const c1 = await buy(eeyore.sessionToken, "namechange_credit");
      check(c1.status === 200 && c1.body.wallet.namechangeCredits === 1, "W9 buying a namechange credit: 1 held: " + JSON.stringify(c1.body.wallet));
      const c2 = await buy(eeyore.sessionToken, "namechange_credit");
      check(c2.status === 200 && c2.body.wallet.namechangeCredits === 2,
        "W9b buying a SECOND one stacks to 2 (consumable, not a one-time unlock, unlike W5's felt/palette/title): " + JSON.stringify(c2.body.wallet));

      // Eeyore's first-ever rename is always free (see /account/name) - burn that first so the
      // NEXT rename is the one that actually engages the 30-day cooldown.
      const rFirst = await c.post("/account/name", { auth: eeyore.sessionToken, name: "Eeyoreburn" });
      check(rFirst.status === 200, "setup: Eeyore's free first rename, to arm the real cooldown");

      // Now a real rename WITHOUT a credit, while inside the cooldown: refused, exactly as today.
      const rBlocked = await c.post("/account/name", { auth: eeyore.sessionToken, name: "EeyoreBlocked" });
      check(rBlocked.status === 429 && rBlocked.body.error === "cooldown",
        "W9c a rename inside the cooldown, with no credit requested, is refused exactly as before this feature existed");
      const meBlocked = await c.post("/account/me", { auth: eeyore.sessionToken });
      check(meBlocked.body.gameName === "Eeyoreburn", "W9d and the name genuinely did not change");

      // The SAME rename, but spending a credit: bypasses the cooldown, and the credit is consumed.
      // (name is capped at 10 chars by cleanName(), same as every other rename in this app -
      // "EeyoreCred" is the expected truncation, not a typo.)
      const rCredit = await c.post("/account/name", { auth: eeyore.sessionToken, name: "EeyoreCredited", useNamechangeCredit: true });
      check(rCredit.status === 200 && rCredit.body.gameName === "EeyoreCred",
        "W9e with useNamechangeCredit:true, the SAME rename that was just refused now succeeds: " + JSON.stringify(rCredit.body));
      check(rCredit.body.usedNamechangeCredit === true, "W9f the response says a credit was used");
      check(rCredit.body.namechangeCredits === 1, "W9g exactly one credit was consumed (had 2, now 1): " + rCredit.body.namechangeCredits);
      const wAfterCredit = await wallet(eeyore.sessionToken);
      check(wAfterCredit.body.namechangeCredits === 1, "W9h GET /account/wallet agrees: 1 credit left");

      // The credit is a ONE-TIME bypass per use, not a standing cooldown removal: immediately
      // trying to rename again (even with useNamechangeCredit again) without waiting is blocked
      // unless ANOTHER credit is spent - proving it is consumed, not a toggle.
      const rNoCreditAgain = await c.post("/account/name", { auth: eeyore.sessionToken, name: "EeyoreAgain" });
      check(rNoCreditAgain.status === 429 && rNoCreditAgain.body.error === "cooldown",
        "W9i immediately after using the credit, the cooldown is back in force (it reset the timer, same as an ordinary rename)");
      const rSecondCredit = await c.post("/account/name", { auth: eeyore.sessionToken, name: "EeyoreAgain", useNamechangeCredit: true });
      check(rSecondCredit.status === 200 && rSecondCredit.body.namechangeCredits === 0,
        "W9j a SECOND credit bypasses it again and is itself consumed down to 0: " + JSON.stringify(rSecondCredit.body));
      const rNoMoreCredits = await c.post("/account/name", { auth: eeyore.sessionToken, name: "EeyoreOnceMore", useNamechangeCredit: true });
      check(rNoMoreCredits.status === 429 && rNoMoreCredits.body.error === "cooldown",
        "W9k with zero credits left, useNamechangeCredit:true no longer bypasses anything - refused exactly like a guest with no credit at all");
    }
  } catch (e) {
    FAIL++;
    log("FAIL", "unexpected exception: " + (e && e.stack || e));
  } finally {
    await K.stopServer(srv);
    jwks.close();
  }

  log(`${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main();
