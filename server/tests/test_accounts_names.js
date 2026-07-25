"use strict";
/*
 * 2026-07-25 § ACCOUNTS Stage 1, suite 2 of 3: GAME NAMES, THE ONE-TIME CLAIM, AND DELETION.
 *
 * The claim is the only operation in the whole accounts plan that moves data that already
 * exists, so most of this suite is about proving it is exact, idempotent, crash-safe and
 * individually reversible.
 *
 *   Part D - names: claiming a free one, first-claim-wins on a collision (including a different
 *     capitalization, which is the same person by the leaderboard's own folding rule), the
 *     blocklist, the 10-character cap, the live availability check, the 30-day rename cooldown,
 *     renaming after it with the counters untouched, renaming onto somebody else's name, and the
 *     released old name becoming claimable by a third person.
 *   Part E - the claim: the pending-claim summary, the merge being exact key by key, the source
 *     row disappearing, a second claim being a no-op, a simulated crash after the journal write
 *     AND after the merge both recovering to exactly-once, admin undo restoring the source row
 *     byte-identically, and "no, start fresh" moving nothing.
 *   Part F - deletion: the row converts back to an unclaimed name row by default, the name is
 *     released, every session dies, and the "also erase my games" option really erases.
 *
 * Never contacts Apple (own keys, own local JWKS) and never touches production - private port,
 * private scratch storage, throwaway admin token.
 *
 * Usage:
 *   node test_accounts_names.js node
 *   node test_accounts_names.js deno
 */
const K = require("./test_accounts_kit.js");

const KIND = process.argv[2] || "node";
const ADMIN_TOKEN = "accounts-names-admin-token";
const AUD = "com.pangman.nasty";
const ISSUER = "https://test.local";

let PASS = 0, FAIL = 0;
function log(...a) { console.log("[acct-names]", ...a); }
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
function randPort() { return 27800 + Math.floor(Math.random() * 600); }
function sameNumbers(a, b) {
  const ka = Object.keys(a || {}).sort(), kb = Object.keys(b || {}).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => kb[i] === k && Number(a[k]) === Number(b[k]));
}

async function main() {
  const key = K.makeKeyPair("names-key");
  const jwks = await K.startJwksServer([key]);
  const scratch = K.makeScratch(`acct-names-${KIND}`);
  const port = randPort();
  const base = `http://localhost:${port}`;
  const envExtra = {
    NASTY_ACCOUNTS_ENABLED: "1",
    NASTY_APPLE_JWKS_URL: jwks.url,
    NASTY_APPLE_ISSUER: ISSUER,
    NASTY_APPLE_AUDIENCES: AUD,
    NASTY_ACCOUNT_RATE_LIMIT: "4000",
    NASTY_NAME_COOLDOWN_MS: "2500",   // stands in for 30 days
  };
  const env = K.serverEnv(KIND, scratch, port, ADMIN_TOKEN, envExtra);
  let srv = K.startServer(KIND, env, "ACCOUNTS_VERBOSE");
  await K.waitHealthy(base);
  const c = K.makeClient(base);

  async function adminAccounts() {
    const r = await fetch(`${base}/admin/accounts`, { headers: { "x-admin-token": ADMIN_TOKEN } });
    return await r.json();
  }
  async function accountRow(uid) {
    const list = await adminAccounts();
    const a = list.find((x) => x.uid === uid);
    return a ? a.row : null;
  }
  async function board() {
    const r = await fetch(base + "/leaderboard");
    return await r.json();
  }
  let gid = 0;
  async function seed(entries) {
    const r = await fetch(base + "/solo-result", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: `names-${KIND}-${Date.now()}-${gid++}`, entries }),
    });
    return r.status;
  }
  async function signInAs(sub) {
    const r = await c.signIn(key, { sub });
    if (r.status !== 200) throw new Error("sign-in failed for " + sub + ": " + JSON.stringify(r.body));
    return r.body;
  }

  /* ============ a realistic pre-existing board, exactly the shape production has ============ */
  // Deliberately posted under three different capitalizations of one name, so the case-folding
  // work that landed earlier today is what puts them on one row - the claim then has to match
  // that same fold.
  await seed([
    { name: "Blake", delta: { hg4s: 1, hw4s: 1, hptsS: 3, hkoDealt: 2, hkoTaken: 1 } },
    { name: "Ginny", delta: { hg4s: 1, hptsS: 0, hkoTaken: 2 } },
    { name: "Jim", delta: { hg6t: 1, hw6t: 1, hptsT: 5 } },
  ]);
  await seed([
    { name: "blake", delta: { hg4s: 1, hkoDealt: 3 } },
    { name: "BLAKE", delta: { hg6t: 1, hw6t: 1, hptsT: 5, hkoTaken: 2 } },
  ]);
  const boardBefore = await board();
  const blakeKey = Object.keys(boardBefore).find((k) => k.toLowerCase() === "blake");
  check(!!blakeKey && Object.keys(boardBefore).filter((k) => k.toLowerCase() === "blake").length === 1,
    "seed: the three capitalizations of Blake are one row on the board (case folding, landed earlier today)");
  const blakeRowBefore = Object.assign({}, boardBefore[blakeKey]);
  check(blakeRowBefore.hg4s === 2 && blakeRowBefore.hw4s === 1 && blakeRowBefore.hkoDealt === 5 && blakeRowBefore.hptsT === 5,
    "seed: that row holds the summed totals (" + JSON.stringify(blakeRowBefore) + ")");

  /* ==================================== Part D: names ==================================== */
  const acctBlake = await signInAs("001111.blake.0001");
  {
    const r = await c.post("/account/name", { auth: acctBlake.sessionToken, name: "Blake" });
    check(r.status === 200 && r.body.gameName === "Blake", "D1 an account can claim a free game name");
    check(r.body.pendingClaim && r.body.pendingClaim.games === 3 && r.body.pendingClaim.wins === 2 &&
      r.body.pendingClaim.points === 8 && r.body.pendingClaim.koDealt === 5 && r.body.pendingClaim.koTaken === 3,
      "D1b and is told exactly what history is already sitting on the board under that name: " + JSON.stringify(r.body.pendingClaim));
    const bd = await board();
    check(sameNumbers(bd[blakeKey], blakeRowBefore), "D1c picking the name moves NOTHING on its own - the confirm is a separate step");
  }
  const acctSecond = await signInAs("001111.second.0002");
  {
    const r = await c.post("/account/name", { auth: acctSecond.sessionToken, name: "BLAKE" });
    check(r.status === 409 && r.body.error === "taken", "D2 first claim wins: a different capitalization of a taken name is refused");
    check(typeof r.body.message === "string" && /pick another/i.test(r.body.message), "D2b in plain language");
  }
  {
    const r = await c.post("/account/name", { auth: acctSecond.sessionToken, name: "bitch" });
    check(r.status === 400 && r.body.error === "blocked", "D3 a blocklisted name is refused");
    const r2 = await c.post("/account/name", { auth: acctSecond.sessionToken, name: "   " });
    check(r2.status === 400 && r2.body.error === "empty", "D3b an empty name is refused");
  }
  {
    const r = await c.post("/account/name", { auth: acctSecond.sessionToken, name: "AbcdefghijKLM" });
    check(r.status === 200 && r.body.gameName === "Abcdefghij" && r.body.gameName.length === 10,
      "D4 an over-long name is capped at the same 10 characters the setup screen uses");
  }
  {
    const a1 = await c.post("/account/name-available", { name: "Blake" });
    check(a1.status === 200 && a1.body.available === false && a1.body.reason === "taken", "D5 the live availability check reports a taken name");
    const a2 = await c.post("/account/name-available", { name: "Bandit" });
    check(a2.body.available === true, "D5b and a free one");
    const a3 = await c.post("/account/name-available", { auth: acctBlake.sessionToken, name: "blake" });
    check(a3.body.available === true, "D5c your OWN name always reads as available to you");
    const a4 = await c.post("/account/name-available", { name: "cunt" });
    check(a4.body.available === false && a4.body.reason === "blocked", "D5d and a blocked one");
  }
  {
    // The first rename is free (a day-one typo must not be a 30-day sentence); the one after it
    // is what starts the cooldown.
    const r1 = await c.post("/account/name", { auth: acctSecond.sessionToken, name: "Ginny" });
    check(r1.status === 200 && r1.body.gameName === "Ginny", "D6 the first rename is free");
    const r2 = await c.post("/account/name", { auth: acctSecond.sessionToken, name: "Ginnie" });
    check(r2.status === 429 && r2.body.error === "cooldown" && r2.body.daysLeft >= 1,
      "D6b a second rename inside the cooldown is refused");
    check(typeof r2.body.message === "string" && /change your name again in/i.test(r2.body.message) && !/cooldown|429/i.test(r2.body.message),
      "D6c with a plain-language wait message: " + JSON.stringify(r2.body.message));
    const r3 = await c.post("/account/name", { auth: acctSecond.sessionToken, name: "GINNY" });
    check(r3.status === 200 && r3.body.gameName === "GINNY",
      "D6d but changing only the CAPITALIZATION of your own name is always free (same folded name)");
  }
  {
    const r = await c.post("/account/name", { auth: acctSecond.sessionToken, name: "Blake" });
    check(r.status === 409 && r.body.error === "taken", "D7 renaming onto somebody else's name is refused before the cooldown is even considered");
  }

  /* ================================= Part E: the claim ================================= */
  {
    const r = await c.post("/account/claim", { auth: acctBlake.sessionToken });
    check(r.status === 200 && r.body.ok === true && r.body.alreadyDone === false, "E1 the claim runs");
    const row = await accountRow(acctBlake.uid);
    check(sameNumbers(row, blakeRowBefore),
      "E1b the account row equals the source row EXACTLY, key by key: " + JSON.stringify(row));
    const bd = await board();
    check(!Object.keys(bd).some((k) => k.toLowerCase() === "blake"), "E1c and the source name row is gone from the board");
    check(bd.Ginny && bd.Jim, "E1d while every OTHER name row is untouched");
  }
  {
    const r = await c.post("/account/claim", { auth: acctBlake.sessionToken });
    check(r.status === 200 && r.body.alreadyDone === true, "E2 claiming a second time is a no-op (the journal is the idempotency key)");
    const row = await accountRow(acctBlake.uid);
    check(sameNumbers(row, blakeRowBefore), "E2b and the counters did not move");
  }
  {
    // Renaming after the claim must not touch the counters at all - the account row is keyed on
    // the account id, so a rename rewrites one string and nothing else.
    await K.sleep(2600);   // wait out the short stand-in cooldown
    const before = await accountRow(acctBlake.uid);
    const r = await c.post("/account/name", { auth: acctBlake.sessionToken, name: "BlakeP" });
    check(r.status === 200 && r.body.gameName === "BlakeP", "E3 renaming after the cooldown is allowed");
    const after = await accountRow(acctBlake.uid);
    check(sameNumbers(before, after), "E3b and the account's lifetime counters are byte-identical before and after the rename");
    const me = await c.post("/account/me", { auth: acctBlake.sessionToken });
    check(Array.isArray(me.body.nameHistory) && me.body.nameHistory.some((h) => h.name === "Blake"),
      "E3c the old name is kept in the account's name history");
    const free = await c.post("/account/name-available", { name: "Blake" });
    check(free.body.available === true, "E3d and the released old name goes back in the pool");
    const third = await signInAs("001111.third.0003");
    const t = await c.post("/account/name", { auth: third.sessionToken, name: "Blake" });
    check(t.status === 200 && t.body.gameName === "Blake", "E3e a third person can now take it");
    check(!t.body.pendingClaim, "E3f and inherits NOTHING - only a never-claimed name row is ever offered");
  }
  {
    const r = await fetch(`${base}/admin/claim/undo`, {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
      body: JSON.stringify({ uid: acctBlake.uid }),
    });
    const body = await r.json();
    check(r.status === 200 && body.ok === true, "E4 admin can undo an individual claim");
    const bd = await board();
    const restored = Object.keys(bd).find((k) => k.toLowerCase() === "blake");
    check(!!restored && sameNumbers(bd[restored], blakeRowBefore),
      "E4b the source row is restored byte-identically: " + JSON.stringify(bd[restored]));
    const row = await accountRow(acctBlake.uid);
    check(!row || Object.keys(row).length === 0, "E4c and the account row is back to its pre-claim state (empty)");
    const missing = await fetch(`${base}/admin/claim/undo`, {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
      body: JSON.stringify({ uid: "no-such-account" }),
    });
    check(missing.status === 404, "E4d undoing a claim that never happened is a clean 404");
    const noauth = await fetch(`${base}/admin/claim/undo`, { method: "POST", body: "{}" });
    check(noauth.status === 401, "E4e and the undo route needs the admin token");
  }
  {
    // "No, start fresh." Nothing moves, the row stays on the board, and the account is never
    // offered it again.
    const decliner = await signInAs("001111.decline.0004");
    const n = await c.post("/account/name", { auth: decliner.sessionToken, name: "Jim" });
    check(n.status === 200 && n.body.pendingClaim && n.body.pendingClaim.games === 1, "E5 a second unclaimed name is offered to its claimer");
    const d = await c.post("/account/claim", { auth: decliner.sessionToken, decline: true });
    check(d.status === 200 && d.body.declined === true, "E5b declining is accepted");
    const bd = await board();
    check(bd.Jim && bd.Jim.hg6t === 1 && bd.Jim.hptsT === 5, "E5c the name row stays exactly where it was");
    const again = await c.post("/account/name", { auth: decliner.sessionToken, name: "Jim" });
    check(!again.body.pendingClaim, "E5d and the account is not asked again");
  }

  await K.stopServer(srv);

  /* =============== Part E6/E7: crash recovery, via the journal fault points =============== */
  // Both halves use the same recipe: boot with a fault point set, run the claim (it 500s
  // part-way through), kill the server, boot clean, run the claim again, and assert the numbers
  // are correct and counted EXACTLY ONCE.
  async function crashRecovery(faultPoint, label) {
    const s = K.makeScratch(`acct-crash-${faultPoint}-${KIND}`);
    const p = randPort() + 17;
    const b = `http://localhost:${p}`;
    const extra = Object.assign({}, envExtra);
    const cli = K.makeClient(b);
    let child = K.startServer(KIND, K.serverEnv(KIND, s, p, ADMIN_TOKEN, extra), "ACCOUNTS_VERBOSE");
    await K.waitHealthy(b);
    let g = 0;
    await fetch(b + "/solo-result", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: `crash-${faultPoint}-${KIND}-${g++}`, entries: [{ name: "Dad", delta: { hg4s: 3, hw4s: 2, hptsS: 7, hkoDealt: 4 } }] }),
    });
    const expected = await (await fetch(b + "/leaderboard")).json();
    const dadRow = Object.assign({}, expected.Dad);
    const acct = (await cli.signIn(key, { sub: "001111.crash." + faultPoint })).body;
    await cli.post("/account/name", { auth: acct.sessionToken, name: "Dad" });
    await K.stopServer(child);

    // Boot with the fault armed and let the claim die part-way.
    child = K.startServer(KIND, K.serverEnv(KIND, s, p, ADMIN_TOKEN, Object.assign({}, extra, { NASTY_CLAIM_FAULT: faultPoint })), "ACCOUNTS_VERBOSE");
    await K.waitHealthy(b);
    const boom = await cli.post("/account/claim", { auth: acct.sessionToken });
    check(boom.status === 500, `${label} the simulated crash really did abort the claim part-way`);
    await K.stopServer(child);

    // Boot clean and let it resume.
    child = K.startServer(KIND, K.serverEnv(KIND, s, p, ADMIN_TOKEN, extra), "ACCOUNTS_VERBOSE");
    await K.waitHealthy(b);
    const fixed = await cli.post("/account/claim", { auth: acct.sessionToken });
    check(fixed.status === 200, `${label}b the claim completes after a restart`);
    const list = await (await fetch(`${b}/admin/accounts`, { headers: { "x-admin-token": ADMIN_TOKEN } })).json();
    const row = (list.find((x) => x.uid === acct.uid) || {}).row;
    check(sameNumbers(row, dadRow), `${label}c and lands on EXACTLY the right numbers, counted once: ${JSON.stringify(row)}`);
    const bd = await (await fetch(b + "/leaderboard")).json();
    check(!Object.keys(bd).some((k) => k.toLowerCase() === "dad"), `${label}d with the source row cleaned up`);
    // A third attempt must still be a no-op.
    const third = await cli.post("/account/claim", { auth: acct.sessionToken });
    const row2 = ((await (await fetch(`${b}/admin/accounts`, { headers: { "x-admin-token": ADMIN_TOKEN } })).json()).find((x) => x.uid === acct.uid) || {}).row;
    check(third.status === 200 && sameNumbers(row2, dadRow), `${label}e and re-running it yet again changes nothing`);
    await K.stopServer(child);
  }
  await crashRecovery("after-journal", "E6");
  await crashRecovery("after-merge", "E7");

  /* ================================== Part F: deletion ================================== */
  {
    const s = K.makeScratch(`acct-del-${KIND}`);
    const p = randPort() + 31;
    const b = `http://localhost:${p}`;
    const cli = K.makeClient(b);
    const child = K.startServer(KIND, K.serverEnv(KIND, s, p, ADMIN_TOKEN, envExtra), "ACCOUNTS_VERBOSE");
    await K.waitHealthy(b);
    await fetch(b + "/solo-result", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: `del-${KIND}-1`, entries: [{ name: "Nana", delta: { hg4s: 5, hw4s: 3, hptsS: 9 } }] }),
    });
    const nanaRow = Object.assign({}, (await (await fetch(b + "/leaderboard")).json()).Nana);
    const acct = (await cli.signIn(key, { sub: "001111.nana.0500" })).body;
    await cli.post("/account/name", { auth: acct.sessionToken, name: "Nana" });
    await cli.post("/account/claim", { auth: acct.sessionToken });
    // A second, live session, to prove deletion kills every one of them and not just the caller's.
    const other = (await cli.signIn(key, { sub: "001111.nana.0500" })).body;

    const boardMid = await (await fetch(b + "/leaderboard")).json();
    check(!boardMid.Nana, "F1 (setup) after the claim the name row is off the served board");

    const d = await cli.post("/account/delete", { auth: acct.sessionToken });
    check(d.status === 200 && d.body.ok === true && d.body.keptOnBoard === true, "F1b deleting the account succeeds");
    check(/Settings/.test(d.body.message) && /Sign in with Apple/.test(d.body.message),
      "F1c and tells the player, in plain language, how to also remove NASTY from their Apple ID");
    const bd = await (await fetch(b + "/leaderboard")).json();
    check(sameNumbers(bd.Nana, nanaRow), "F2 the games survive: the row converts back to an ordinary unclaimed name row " + JSON.stringify(bd.Nana));
    const me = await cli.post("/account/me", { auth: acct.sessionToken });
    const me2 = await cli.post("/account/me", { auth: other.sessionToken });
    check(me.status === 401 && me2.status === 401, "F3 EVERY session for that account is dead, not just the one that asked");
    const list = await (await fetch(`${b}/admin/accounts`, { headers: { "x-admin-token": ADMIN_TOKEN } })).json();
    check(!list.some((x) => x.uid === acct.uid), "F3b the account record itself is gone");
    const avail = await cli.post("/account/name-available", { name: "Nana" });
    check(avail.body.available === true, "F4 the game name is released, so anyone can claim it again");
    const again = await cli.post("/account/delete", { auth: acct.sessionToken });
    check(again.status === 401, "F5 deleting twice with the same token is a clean 401 (there is nothing left to delete)");

    // The second, smaller option: "also erase my games from the board".
    await fetch(b + "/solo-result", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: `del-${KIND}-2`, entries: [{ name: "Papa", delta: { hg4s: 2, hw4s: 1, hptsS: 3 } }] }),
    });
    const papa = (await cli.signIn(key, { sub: "001111.papa.0501" })).body;
    await cli.post("/account/name", { auth: papa.sessionToken, name: "Papa" });
    await cli.post("/account/claim", { auth: papa.sessionToken });
    const d2 = await cli.post("/account/delete", { auth: papa.sessionToken, eraseBoard: true });
    check(d2.status === 200 && d2.body.keptOnBoard === false, "F6 the 'also erase my games' option is accepted");
    const bd2 = await (await fetch(b + "/leaderboard")).json();
    check(!bd2.Papa, "F6b and really does leave nothing behind on the board");
    await K.stopServer(child);
  }

  jwks.close();
  console.log(`\n[acct-names/${KIND}] ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
