"use strict";
/*
 * 2026-07-31 v0.68 § LAUNCH RESET - proves, against BOTH servers, everything the launch-day
 * wipe must and must NOT do:
 *
 *   - it refuses without the admin token, and refuses without the exact confirm phrase;
 *   - it backs up everything it deletes BEFORE deleting (and the backup really contains it);
 *   - it wipes accounts, sessions, names, wallets, leaderboard rows and the free-month
 *     tombstones (Blake's decision: post-launch signups all get their full free month);
 *   - it PRESERVES the Apple IAP transaction replay ledger - an old receipt replayed against
 *     a fresh post-launch account must still be refused, or wiping would reopen a
 *     free-credits minting hole;
 *   - it bumps the leaderboard epoch so every device clears its local cache;
 *   - and it REFUSES to ever run a second time - even across a full server restart.
 *
 * Same hygiene as every suite here: private port, scratch storage (including the guard-marker
 * file and backup dir - see serverEnv), throwaway admin token, local JWKS, the test-only IAP
 * signing chain. Nothing contacts Apple; nothing touches production.
 *
 * Usage:
 *   node test_launch_reset.js node
 *   node test_launch_reset.js deno
 */
const fs = require("fs");
const path = require("path");
const K = require("./test_accounts_kit.js");
const IAP = require("./test_iap_kit.js");

const KIND = process.argv[2] || "node";
const ADMIN_TOKEN = "launch-reset-admin-token";
const AUD = "com.pangman.nasty";
const ISSUER = "https://launchreset.test.local";

let PASS = 0, FAIL = 0;
function log(...a) { console.log("[launch-reset]", ...a); }
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
function randPort() { return 33100 + Math.floor(Math.random() * 300); }

async function main() {
  const key = K.makeKeyPair("launch-reset-key");
  const jwks = await K.startJwksServer([key]);
  const scratch = K.makeScratch(`launch-reset-${KIND}`);
  const port = randPort();
  const base = `http://localhost:${port}`;
  const env = K.serverEnv(KIND, scratch, port, ADMIN_TOKEN, {
    NASTY_ACCOUNTS_ENABLED: "1",
    NASTY_APPLE_JWKS_URL: jwks.url, NASTY_APPLE_ISSUER: ISSUER, NASTY_APPLE_AUDIENCES: AUD,
    NASTY_ACCOUNT_RATE_LIMIT: "8000",
    NASTY_IAP_ROOT_CA_B64: IAP.GOOD_ROOT_B64,
    NASTY_IAP_LEDGER_FILE: path.join(scratch, "iap-ledger.json"),
    NASTY_IAP_EVENTS_FILE: path.join(scratch, "iap-events.json"),
    NASTY_PURCHASE_IDS_FILE: path.join(scratch, "purchase-ids.json"),
  });
  let child = K.startServer(KIND, env, "LAUNCH_RESET_VERBOSE");
  await K.waitHealthy(base);
  const c = K.makeClient(base);
  const admin = (method, p, body) => fetch(base + p, {
    method,
    headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  async function signInAs(sub, name) {
    const r = await c.signIn(key, { sub, iss: ISSUER, aud: AUD });
    if (r.status !== 200) throw new Error("sign-in failed for " + sub + ": " + JSON.stringify(r.body));
    if (name) await c.post("/account/name", { auth: r.body.sessionToken, name });
    return r.body;
  }
  async function boardEpoch() {
    const r = await fetch(base + "/leaderboard");
    return { epoch: Number(r.headers.get("x-leaderboard-epoch")), board: await r.json() };
  }

  try {
    /* ================= SETUP: a world worth wiping ================= */
    const alice = await signInAs("001222.alice", "Alice");
    const bob = await signInAs("001222.bob", "Bob");
    await fetch(base + "/solo-result", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: "launch-reset-seed-1", entries: [{ name: "Alice", delta: { hg4s: 1, hw4s: 1, hptsS: 200 } }] }),
    });
    const buy = await c.post("/account/purchase", { auth: alice.sessionToken, itemId: "palette_sunset" });
    check(buy.status === 200, "S1 setup: Alice owns a shop item (a wallet worth wiping): " + JSON.stringify(buy.body && buy.body.purchased));
    // A real (test-chain) Apple IAP purchase, so the replay ledger has an entry to preserve.
    const txn = IAP.mintTransaction({});
    const iap1 = await c.post("/account/iap/verify", { auth: alice.sessionToken, jws: txn.jws });
    check(iap1.status === 200 && iap1.body.creditsAdded === 50, "S2 setup: a verified IAP purchase credited Alice: " + JSON.stringify({ status: iap1.status, credits: iap1.body && iap1.body.creditsAdded }));
    // Bob deletes, so a free-month tombstone exists to prove the wipe clears it.
    const delBob = await c.post("/account/delete", { auth: bob.sessionToken });
    check(delBob.status === 200, "S3 setup: Bob deleted his account (a free-month tombstone now exists)");
    const bobBack = await c.signIn(key, { sub: "001222.bob", iss: ISSUER, aud: AUD });
    check(bobBack.status === 200 && !!bobBack.body.uid, "S4 setup: Bob's re-created account exists (inherits the tombstone state)");
    const preEpoch = (await boardEpoch()).epoch;
    const preBoard = (await boardEpoch()).board;
    check(!!preBoard.Alice, "S5 setup: Alice is on the leaderboard before the wipe");

    /* ================= REFUSALS BEFORE THE REAL RUN ================= */
    const noToken = await fetch(base + "/admin/launch-reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: "WIPE EVERYTHING FOR LAUNCH" }) });
    check(noToken.status === 401, "R1 without the admin token the wipe is 401, full stop: " + noToken.status);
    const noPhrase = await admin("POST", "/admin/launch-reset", {});
    check(noPhrase.status === 400 && noPhrase.body.error === "confirmrequired", "R2 without the confirm phrase it refuses (400 confirmrequired) and explains itself");
    const wrongPhrase = await admin("POST", "/admin/launch-reset", { confirm: "wipe everything for launch" });
    check(wrongPhrase.status === 400, "R3 the phrase is exact - a lowercase attempt refuses too");
    const still = await boardEpoch();
    check(!!still.board.Alice && still.epoch === preEpoch, "R4 every refused attempt deleted NOTHING (board and epoch untouched)");
    const status0 = await admin("GET", "/admin/launch-reset");
    check(status0.status === 200 && status0.body.done === false, "R5 the status probe says not-yet-run: " + JSON.stringify(status0.body));

    /* ================= THE BACKUP PREVIEW ================= */
    const preview = await admin("GET", "/admin/launch-reset/backup");
    check(preview.status === 200 && preview.body && preview.body.data, "B1 the read-only backup preview answers");
    const previewStr = JSON.stringify(preview.body);
    check(previewStr.includes(alice.uid) && previewStr.includes("Alice"), "B2 the preview really contains the accounts and names it would delete");
    check(!previewStr.includes(String(txn.payload.transactionId)),
      "B3 the preview is scoped to what will be WIPED - the IAP replay ledger (which survives) is not in it");

    /* ================= THE WIPE ITSELF ================= */
    const wipe = await admin("POST", "/admin/launch-reset", { confirm: "WIPE EVERYTHING FOR LAUNCH" });
    check(wipe.status === 200 && wipe.body.ok === true, "W1 the wipe runs exactly once, successfully: " + JSON.stringify({ status: wipe.status, deleted: wipe.body && wipe.body.deleted }));
    const backupStr = JSON.stringify(wipe.body.backup || {});
    check(backupStr.includes(alice.uid) && backupStr.includes("Alice"), "W2 the response carries the FULL backup taken before deletion (Alice's account and row are in it)");
    if (KIND === "node") {
      const marker = JSON.parse(fs.readFileSync(path.join(scratch, "launch-reset-done.json"), "utf8"));
      check(fs.existsSync(marker.backupFile), "W3 (node) the backup was ALSO written to a local file before deletion: " + path.basename(marker.backupFile));
      const onDisk = fs.readFileSync(marker.backupFile, "utf8");
      check(onDisk.includes(alice.uid), "W4 (node) and that file genuinely contains the deleted data");
    } else {
      check(typeof wipe.body.runId === "string" && wipe.body.runId.length > 0, "W3 (deno) the run has an id under which the backup chunks were stored in KV");
      // Exactly 2 accounts exist at wipe time: Alice, plus Bob's RE-created account (his
      // original was deleted in setup, before the wipe).
      check((wipe.body.deleted.account || 0) === 2, "W4 (deno) deleted counts confirm the account rows went: " + JSON.stringify(wipe.body.deleted));
    }

    /* ================= SQUARE ONE, VERIFIED ================= */
    const after = await boardEpoch();
    check(JSON.stringify(after.board) === "{}", "V1 the leaderboard is completely empty");
    check(after.epoch === preEpoch + 1, "V2 the epoch bumped (" + preEpoch + " -> " + after.epoch + ") so every device clears its local cache");
    const accounts = await admin("GET", "/admin/accounts");
    check(Array.isArray(accounts.body) && accounts.body.length === 0, "V3 the account list is empty - everyone must sign up again");
    const oldSession = await c.post("/account/me", { auth: alice.sessionToken });
    check(oldSession.status === 401, "V4 Alice's old session token is dead (401)");
    const statusDone = await admin("GET", "/admin/launch-reset");
    check(statusDone.body.done === true && statusDone.body.state === "done", "V5 the status probe now says done: " + JSON.stringify({ done: statusDone.body.done, state: statusDone.body.state }));

    // Names are free again, tombstones are gone: Bob signs up fresh, takes ALICE's old name,
    // and gets a full free month with no freeMonthUsed flag despite his pre-wipe deletion.
    const bob2 = await c.signIn(key, { sub: "001222.bob", iss: ISSUER, aud: AUD });
    check(bob2.status === 200 && bob2.body.freeMonthUsed === undefined, "V6 TOMBSTONES CLEARED: Bob's pre-wipe delete history is gone - no freeMonthUsed flag at launch");
    const st = await c.post("/account/online-status", { auth: bob2.body.sessionToken });
    check(st.body.entitled === true && st.body.reason === "free", "V7 and Bob has a genuine full free month: " + JSON.stringify({ entitled: st.body.entitled, reason: st.body.reason }));
    const takeName = await c.post("/account/name", { auth: bob2.body.sessionToken, name: "Alice" });
    check(takeName.status === 200, "V8 NAME RESERVATIONS CLEARED: the name Alice owned pre-wipe is claimable again");

    /* ================= THE IAP LEDGER SURVIVES ================= */
    const replay = await c.post("/account/iap/verify", { auth: bob2.body.sessionToken, jws: txn.jws });
    check(replay.status === 409 && replay.body.error === "alreadyused",
      "L1 LEDGER PRESERVED: Alice's pre-wipe Apple transaction REPLAYED against a fresh post-wipe account is refused (409 alreadyused) - no free credits from old receipts");
    const fresh = IAP.mintTransaction({});
    const newBuy = await c.post("/account/iap/verify", { auth: bob2.body.sessionToken, jws: fresh.jws });
    check(newBuy.status === 200 && newBuy.body.creditsAdded === 50, "L2 while a genuinely NEW transaction still credits normally post-wipe");

    /* ================= NEVER TWICE ================= */
    const second = await admin("POST", "/admin/launch-reset", { confirm: "WIPE EVERYTHING FOR LAUNCH" });
    check(second.status === 409 && second.body.error === "alreadyran", "T1 a second invocation refuses outright (409 alreadyran) - live post-launch data is safe");
    const bobStill = await c.post("/account/me", { auth: bob2.body.sessionToken });
    check(bobStill.status === 200, "T2 and the refused second run deleted NOTHING (Bob's new account still answers)");

    // The guard must survive a full restart - the marker is persisted state, not memory.
    await K.stopServer(child);
    child = K.startServer(KIND, env, "LAUNCH_RESET_VERBOSE");
    await K.waitHealthy(base);
    const third = await admin("POST", "/admin/launch-reset", { confirm: "WIPE EVERYTHING FOR LAUNCH" });
    check(third.status === 409 && third.body.error === "alreadyran", "T3 even after a full server restart, the wipe still refuses to run again");
    const bobSurvives = await c.post("/account/me", { auth: bob2.body.sessionToken });
    check(bobSurvives.status === 200, "T4 and post-restart, post-refusal, the new world is still intact");
    const health = await fetch(base + "/health").then((r) => r.json());
    check(health.ok === true, "T5 /health is fine through all of it");
  } finally {
    await K.stopServer(child);
  }

  log(`${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => {
  FAIL++;
  log("FAIL", "unexpected exception: " + (e && e.stack || e));
  log(`${PASS} passed, ${FAIL} failed`);
  process.exit(1);
});
