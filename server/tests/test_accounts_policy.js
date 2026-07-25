"use strict";
/*
 * 2026-07-25 § ACCOUNTS - BLAKE'S TWO POLICY DECISIONS.
 *
 * Both of these reverse what the original design recommended. They are implemented because Blake
 * decided them, and this suite is what pins them down, identically on BOTH servers.
 *
 *   DECISION 1 - the name claim is a ONE-TIME MIGRATION WINDOW.
 *     Blake: "only have that be for this very next update... if they don't [claim], then the
 *     leaderboard claim no longer exists going forward."
 *     Part Y proves: while the window is open, an existing name row can be claimed exactly as it
 *     always could; once it closes (by flag OR by deadline) /account/claim answers 410 in plain
 *     language and /account/name stops offering it at all; a claim that already completed is
 *     still idempotent afterwards; and - the part that matters most - NO UNCLAIMED ROW IS EVER
 *     DELETED. Blake's family's real history from before accounts stays on the board as a frozen
 *     historical entry, forever.
 *
 *   DECISION 2 - the leaderboard is ACCOUNT-ONLY going forward.
 *     Blake: "I like the idea of making the account creation optional and saying it's the only
 *     way you can get your name on the leaderboard tracker."
 *     Part Z proves: with the switch OFF (production today) absolutely nothing changes; with it
 *     ON, a signed-in player's result is credited to their ACCOUNT, a guest's result is quietly
 *     not posted to the shared board (still a plain 200, so nothing retries forever), the old
 *     name rows are still SERVED but never grow, an account's own claimed history is not shown
 *     twice, and /leaderboard's body is still the flat shape every shipped build renders.
 *
 * Nothing here contacts any provider. Never touches production.
 *
 * Usage:
 *   node test_accounts_policy.js node
 *   node test_accounts_policy.js deno
 */
const K = require("./test_accounts_kit.js");

const KIND = process.argv[2] || "node";
const ADMIN_TOKEN = "accounts-policy-admin-token";
const AUD = "com.pangman.nasty";
const ISSUER = "https://appleid.test.local";

let PASS = 0, FAIL = 0;
function log(...a) { console.log("[acct-policy]", ...a); }
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
function randPort() { return 29400 + Math.floor(Math.random() * 400); }

async function main() {
  const key = K.makeKeyPair("apple-key");
  const jwks = await K.startJwksServer([key]);
  const baseEnv = {
    NASTY_ACCOUNTS_ENABLED: "1",
    NASTY_APPLE_JWKS_URL: jwks.url, NASTY_APPLE_ISSUER: ISSUER, NASTY_APPLE_AUDIENCES: AUD,
    NASTY_ACCOUNT_RATE_LIMIT: "8000",
  };
  let seq = 0;
  // `reuse` lets a case boot a SECOND server over the same scratch storage - which is how the
  // account-only switch is tested honestly: seed the family's real pre-accounts history through
  // the ordinary guest path with the switch OFF, then restart with it ON, exactly the shape of
  // the real rollout.
  async function boot(extra, tag, reuse) {
    const scratch = reuse || K.makeScratch(`acct-policy-${tag}-${KIND}`);
    const port = randPort() + (seq++);
    const base = `http://localhost:${port}`;
    const child = K.startServer(KIND, K.serverEnv(KIND, scratch, port, ADMIN_TOKEN, Object.assign({}, baseEnv, extra)), "ACCOUNTS_VERBOSE");
    await K.waitHealthy(base);
    return {
      base, child, scratch,
      c: K.makeClient(base),
      async board() { return await (await fetch(base + "/leaderboard")).json(); },
      async boardV2() { return await (await fetch(base + "/leaderboard/v2")).json(); },
      // A guest posting an offline/solo result, exactly as every shipped build does.
      async guestResult(id, name, delta) {
        const r = await fetch(base + "/solo-result", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ gameId: id, entries: [{ name, delta }] }),
        });
        return { status: r.status, body: await r.json() };
      },
      // The same thing from a signed-in player.
      async signedResult(id, auth, name, delta) {
        const r = await fetch(base + "/solo-result", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ gameId: id, auth, entries: [{ name, delta }] }),
        });
        return { status: r.status, body: await r.json() };
      },
      stop() { return K.stopServer(child); },
    };
  }
  // Seed the board the way the family's real one looks before any of this ships.
  async function seedHistory(s) {
    await s.guestResult("hist-blake", "Blake", { hg4s: 47, hw4s: 19, hptsS: 60 });
    await s.guestResult("hist-jim", "Jim", { hg4s: 12, hw4s: 4, hptsS: 11 });
    await s.guestResult("hist-kid", "Charlie", { hg4s: 8, hw4s: 2, hptsS: 5 });
  }

  /* ============ Part Y1: the window is OPEN - the claim works, exactly as before ============ */
  {
    const s = await boot({}, "claim-open");
    await seedHistory(s);
    const acct = (await s.c.signIn(key, { iss: ISSUER, aud: AUD, sub: "001111.blake" })).body;
    check(acct.claimWindow && acct.claimWindow.open === true,
      "Y1 the sign-in answer tells the client the one-time claim window is open");
    const named = await s.c.post("/account/name", { auth: acct.sessionToken, name: "Blake" });
    check(named.body.pendingClaim && named.body.pendingClaim.games === 47 && named.body.pendingClaim.wins === 19,
      "Y1b picking a name that already has history offers it: 47 games, 19 wins, exactly as Blake would read it");
    const claimed = await s.c.post("/account/claim", { auth: acct.sessionToken });
    check(claimed.status === 200 && claimed.body.moved.games === 47, "Y1c and claiming moves it onto the account");
    const b = await s.board();
    check(!Object.keys(b).some((k) => k.toLowerCase() === "blake"),
      "Y1d the old name row is gone from the name-keyed board (it lives on the account now)");
    check(b.Jim && b.Jim.hg4s === 12 && b.Charlie && b.Charlie.hg4s === 8,
      "Y1e and NOBODY ELSE'S history was touched");
    await s.stop();
  }

  /* ============ Part Y2: the window CLOSED by flag ============ */
  {
    const s = await boot({ NASTY_CLAIM_WINDOW_OPEN: "0" }, "claim-shut");
    await seedHistory(s);
    const acct = (await s.c.signIn(key, { iss: ISSUER, aud: AUD, sub: "001111.late" })).body;
    check(acct.claimWindow.open === false, "Y2 after the sunset, the sign-in answer says the window is closed");
    const named = await s.c.post("/account/name", { auth: acct.sessionToken, name: "Blake" });
    check(named.status === 200 && named.body.pendingClaim === null,
      "Y2b so somebody picking a name with old history is NOT offered it - the client stops asking");
    const claimed = await s.c.post("/account/claim", { auth: acct.sessionToken });
    check(claimed.status === 410 && claimed.body.error === "claimclosed", "Y2c and the claim endpoint itself refuses");
    check(/history/.test(String(claimed.body.message || "")) && !/error/i.test(String(claimed.body.message || "")),
      "Y2d in a plain sentence that explains what happens to the old name instead of sounding like a failure");

    // THE PART THAT MATTERS MOST. Nothing was destroyed.
    const b = await s.board();
    check(b.Blake && b.Blake.hg4s === 47 && b.Blake.hw4s === 19,
      "Y2e THE UNCLAIMED ROW IS STILL THERE - the family's real history is never deleted, only frozen");
    const v2 = await s.boardV2();
    check(v2.claimWindow.open === false, "Y2f /leaderboard/v2 reports the closed window too");
    await s.stop();
  }

  /* ============ Part Y3: the window closed by DEADLINE, and an in-flight claim ============ */
  {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const s = await boot({ NASTY_CLAIM_DEADLINE: past }, "claim-deadline");
    await seedHistory(s);
    const acct = (await s.c.signIn(key, { iss: ISSUER, aud: AUD, sub: "001111.deadline" })).body;
    check(acct.claimWindow.open === false && acct.claimWindow.closesAt > 0,
      "Y3 a deadline in the past closes the window on its own, with no flag flip needed");
    await s.c.post("/account/name", { auth: acct.sessionToken, name: "Jim" });
    const claimed = await s.c.post("/account/claim", { auth: acct.sessionToken });
    check(claimed.status === 410, "Y3b and the claim refuses");
    const declined = await s.c.post("/account/claim", { auth: acct.sessionToken, decline: true });
    check(declined.status === 410, "Y3c declining is refused too - there is nothing left to decline");
    await s.stop();
  }

  /* ====== Part Y4: an ALREADY-COMPLETED claim stays idempotent after the sunset ====== */
  {
    const future = new Date(Date.now() + 60 * 1000).toISOString();
    const s = await boot({ NASTY_CLAIM_DEADLINE: future }, "claim-idem");
    await seedHistory(s);
    const acct = (await s.c.signIn(key, { iss: ISSUER, aud: AUD, sub: "001111.idem" })).body;
    await s.c.post("/account/name", { auth: acct.sessionToken, name: "Blake" });
    const first = await s.c.post("/account/claim", { auth: acct.sessionToken });
    check(first.status === 200, "Y4 a claim inside the deadline succeeds");
    const second = await s.c.post("/account/claim", { auth: acct.sessionToken });
    check(second.status === 200 && second.body.alreadyDone === true,
      "Y4b and a retry of that same claim is still a clean no-op (a client retry must not error)");
    // The admin undo survives the sunset too - the journal is what makes it reversible.
    const undo = await fetch(s.base + "/admin/claim/undo", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
      body: JSON.stringify({ uid: acct.uid }),
    });
    check(undo.status === 200, "Y4c and Blake can still individually undo a claim afterwards");
    const b = await s.board();
    check(b.Blake && b.Blake.hg4s === 47, "Y4d which puts the historical row back exactly as it was");
    await s.stop();
  }

  /* ====== Part Z1: the account-only switch is OFF by default - nothing changes ====== */
  {
    const s = await boot({}, "board-off");
    await seedHistory(s);
    const acct = (await s.c.signIn(key, { iss: ISSUER, aud: AUD, sub: "001111.offswitch" })).body;
    await s.c.post("/account/name", { auth: acct.sessionToken, name: "Ginny" });
    const r = await s.guestResult("off-1", "Charlie", { hg4s: 1, hw4s: 1 });
    check(r.status === 200 && r.body.ok === true, "Z1 with the switch off, a guest's result is accepted");
    const b = await s.board();
    check(b.Charlie.hg4s === 9, "Z1b and lands on the board exactly as it always has");
    const v2 = await s.boardV2();
    check(v2.accountsOnly === false, "Z1c and /leaderboard/v2 confirms the switch is off");
    check(v2.entries.every((e) => e.frozen === false), "Z1d with nothing marked frozen, because nothing is");
    await s.stop();
  }

  /* ====== Part Z2: the switch ON - accounts accrue, guests do not, history is kept ====== */
  {
    // Seed the family's real history the way it actually got there - ordinary guest results,
    // with the switch still off - then restart with the switch on. That is the real rollout.
    const pre = await boot({}, "board-on");
    await pre.guestResult("hist-blake", "Blake", { hg4s: 47, hw4s: 19, hptsS: 60 });
    await K.sleep(1200);   // let the debounced persist land before the restart
    await pre.stop();
    const s = await boot({ NASTY_LEADERBOARD_ACCOUNTS_ONLY: "1" }, "board-on", pre.scratch);
    const guest = await s.guestResult("on-guest-1", "Charlie", { hg4s: 1, hw4s: 1 });
    check(guest.status === 200 && guest.body.ok === true,
      "Z2 with the switch on, a guest's submission is still answered 200 - nothing retries forever, nothing errors");
    const b1 = await s.board();
    check(!b1.Charlie, "Z2b but it does NOT post to the shared board. Accounts are optional to PLAY, required to appear.");

    const acct = (await s.c.signIn(key, { iss: ISSUER, aud: AUD, sub: "001111.signedin" })).body;
    await s.c.post("/account/name", { auth: acct.sessionToken, name: "Ginny" });
    const mine = await s.signedResult("on-acct-1", acct.sessionToken, "Ginny", { hg4s: 1, hw4s: 1, hptsS: 3 });
    check(mine.status === 200, "Z3 a signed-in player's result is accepted");
    const b2 = await s.board();
    check(b2.Ginny && b2.Ginny.hg4s === 1 && b2.Ginny.hw4s === 1 && b2.Ginny.hptsS === 3,
      "Z3b and appears on the board, credited to the account");
    check(typeof b2 === "object" && !Array.isArray(b2) && typeof b2.Ginny.hg4s === "number",
      "Z3c and /leaderboard is STILL the flat {name:{stats}} shape - no shipped build breaks");

    check(b2.Blake && b2.Blake.hg4s === 47,
      "Z4 the pre-accounts history is STILL SHOWN - frozen, not deleted, which is non-negotiable");
    const v2 = await s.boardV2();
    const blakeRow = v2.entries.find((e) => e.name === "Blake");
    const ginnyRow = v2.entries.find((e) => e.name === "Ginny");
    check(v2.accountsOnly === true, "Z4b /leaderboard/v2 says the switch is on");
    check(blakeRow && blakeRow.frozen === true && blakeRow.account === false,
      "Z4c and marks the old row as frozen history, not attached to an account, so a client can label it");
    check(ginnyRow && ginnyRow.account === true && ginnyRow.frozen === false,
      "Z4d while the account row is marked live");

    // A signed-in player may only credit their OWN name. Somebody else's name on the same
    // submission is a guest result and is not posted.
    const other = await s.signedResult("on-acct-2", acct.sessionToken, "Charlie", { hg4s: 5 });
    check(other.status === 200, "Z5 a submission naming somebody else is still answered 200");
    const b3 = await s.board();
    check(!b3.Charlie, "Z5b but a signed-in session can only ever credit its OWN name, never anyone else's");

    // And an unauthenticated submission cannot credit a signed-in player's account.
    const spoof = await s.guestResult("on-spoof-1", "Ginny", { hg4s: 99 });
    check(spoof.status === 200, "Z6 an unauthenticated submission under a signed-in player's name is answered 200");
    const b4 = await s.board();
    check(b4.Ginny.hg4s === 1, "Z6b and changes nothing - typing somebody's name is no longer enough to score on their row");
    await s.stop();
  }

  /* ====== Part Z3: a claimed row is not shown twice once the switch is on ====== */
  {
    const pre = await boot({}, "board-shadow");
    await pre.guestResult("shadow-hist", "Blake", { hg4s: 47, hw4s: 19 });
    await K.sleep(1200);
    await pre.stop();
    const s = await boot({ NASTY_LEADERBOARD_ACCOUNTS_ONLY: "1" }, "board-shadow", pre.scratch);
    const acct = (await s.c.signIn(key, { iss: ISSUER, aud: AUD, sub: "001111.shadow" })).body;
    await s.c.post("/account/name", { auth: acct.sessionToken, name: "Blake" });
    const before = await s.board();
    check(before.Blake && before.Blake.hg4s === 47,
      "Z7 before claiming, the historical row still shows under that name");
    const v2before = await s.boardV2();
    check(v2before.entries.filter((e) => e.name.toLowerCase() === "blake").length === 1,
      "Z7b and exactly once, not twice - the account has no row of its own yet");
    await s.c.post("/account/claim", { auth: acct.sessionToken });
    await s.signedResult("shadow-1", acct.sessionToken, "Blake", { hg4s: 1 });
    const after = await s.board();
    check(after.Blake && after.Blake.hg4s === 48,
      "Z8 after claiming, the history and the new game are one row of 48 - not two rows and not a reset");
    const v2after = await s.boardV2();
    check(v2after.entries.filter((e) => e.name.toLowerCase() === "blake").length === 1,
      "Z8b still exactly one Blake, now marked as an account row");
    await s.stop();
  }

  jwks.close();
  console.log(`\n[acct-policy/${KIND}] ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
