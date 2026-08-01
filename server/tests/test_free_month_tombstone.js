"use strict";
/*
 * 2026-07-31 v0.68 § FREE MONTH TOMBSTONE - proves, against BOTH servers, that the
 * delete-and-recreate free-month loophole is genuinely closed, and that closing it never
 * punishes an honest reinstall.
 *
 * THE LOOPHOLE (confirmed real before the fix): onlineFreeMonths() derives the free window
 * from acct.created, so deleting an account and re-signing-in with the same Apple sub minted a
 * fresh `created` and a fresh free month, forever. The fix stores a permanent one-way-hashed
 * record per sign-in identity ("this identity's free month ran through YYYY-MM"), consulted at
 * account creation.
 *
 * SIMULATING "signed up months ago": `created` is stamped by newAccountRecord() from the real
 * clock, so these tests boot the server with NASTY_ACCOUNT_CREATED_MS (the v0.68 test-only
 * override, same convention as NASTY_MONTHLY_NOW_MS) pinned to May 2026, create + delete the
 * account, then RESTART the same server (same scratch state) without the override - the exact
 * restart technique test_online_access.js/test_monthly_ranking.js already use.
 *
 * Same hygiene as every suite here: private port, scratch storage, throwaway admin token,
 * local JWKS - Apple and Google are never contacted.
 *
 * Usage:
 *   node test_free_month_tombstone.js node
 *   node test_free_month_tombstone.js deno
 */
const fs = require("fs");
const path = require("path");
const K = require("./test_accounts_kit.js");

const KIND = process.argv[2] || "node";
const ADMIN_TOKEN = "freemonth-admin-token";
const AUD = "com.pangman.nasty";
const ISSUER = "https://freemonth.test.local";
const GOOGLE_ISS = "https://accounts.google.test.local";
const GOOGLE_AUD = "google-ios-client";

let PASS = 0, FAIL = 0;
function log(...a) { console.log("[free-month]", ...a); }
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
function randPort() { return 32700 + Math.floor(Math.random() * 300); }

// The 15th at noon UTC - never near a month boundary in any timezone (same helper as
// test_online_access.js).
function midMonthMs(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return Date.UTC(y, m - 1, 15, 18, 0, 0);
}

async function main() {
  const appleKey = K.makeKeyPair("freemonth-apple-key");
  const googleKey = K.makeKeyPair("freemonth-google-key");
  const appleJwks = await K.startJwksServer([appleKey]);
  const googleJwks = await K.startJwksServer([googleKey]);
  const providerEnv = {
    NASTY_ACCOUNTS_ENABLED: "1",
    NASTY_APPLE_JWKS_URL: appleJwks.url, NASTY_APPLE_ISSUER: ISSUER, NASTY_APPLE_AUDIENCES: AUD,
    NASTY_GOOGLE_JWKS_URL: googleJwks.url, NASTY_GOOGLE_ISSUER: GOOGLE_ISS, NASTY_GOOGLE_AUDIENCES: GOOGLE_AUD,
    NASTY_ACCOUNT_RATE_LIMIT: "8000",
  };
  let seq = 0;
  async function boot(extra, tag) {
    const scratch = K.makeScratch(`freemonth-${tag}-${KIND}`);
    const port = randPort() + (seq++);
    const base = `http://localhost:${port}`;
    const env = K.serverEnv(KIND, scratch, port, ADMIN_TOKEN, Object.assign({}, providerEnv, extra));
    const child = K.startServer(KIND, env, "FREEMONTH_VERBOSE");
    await K.waitHealthy(base);
    const s = {
      port, base, scratch, env, c: K.makeClient(base),
      stop() { return K.stopServer(child); },
    };
    return s;
  }
  // Restart the SAME server (same scratch/port/state) with changed env. Setting a var to ""
  // REMOVES an override: both servers parse Number("") as NaN and fall back to the real clock.
  async function restart(s, extraEnv) {
    await s.stop();
    const env = Object.assign({}, s.env, extraEnv || {});
    const child = K.startServer(KIND, env, "FREEMONTH_VERBOSE");
    await K.waitHealthy(s.base);
    s.env = env;
    s.stop = () => K.stopServer(child);
  }
  async function signInApple(c, sub, name) {
    const r = await c.signIn(appleKey, { sub, iss: ISSUER, aud: AUD });
    if (r.status !== 200) throw new Error("apple sign-in failed for " + sub + ": " + JSON.stringify(r.body));
    if (name) await c.post("/account/name", { auth: r.body.sessionToken, name });
    return r.body;
  }
  async function status(c, auth) { return await c.post("/account/online-status", { auth }); }

  /* =============================================================================================
   * GROUP 1 - THE LOOPHOLE, closed. An account whose free window (May+June 2026) is long over
   * deletes itself; re-signing-in with the same Apple sub gets a NEW account that inherits the
   * ALREADY-USED state - no fresh free month, and the sign-in response says so plainly.
   * ========================================================================================== */
  {
    const s = await boot({ NASTY_ACCOUNT_CREATED_MS: String(midMonthMs("2026-05")) }, "group1-loophole");
    try {
      const first = await signInApple(s.c, "001999.loop1", "Loop1");
      check(first.freeMonthUsed === undefined, "1.0 the FIRST account for a fresh identity carries no freeMonthUsed flag");
      const st0 = await status(s.c, first.sessionToken);
      check(st0.body.freeThroughMonth === "2026-06", "1.1 back-dated (May 2026) signup's free window runs through 2026-06: " + st0.body.freeThroughMonth);
      check(st0.body.entitled === false, "1.2 and that window is already over on the real clock (sanity)");

      const del = await s.c.post("/account/delete", { auth: first.sessionToken });
      check(del.status === 200, "1.3 the account deletes cleanly");

      // Back to the REAL clock: without the fix, the recreated account's `created` would be
      // "now" and mint a brand-new free month - the exact abuse Blake described.
      await restart(s, { NASTY_ACCOUNT_CREATED_MS: "" });
      const again = await s.c.signIn(appleKey, { sub: "001999.loop1", iss: ISSUER, aud: AUD });
      check(again.status === 200, "1.4 re-signing-in with the same Apple sub still works (a new account is created)");
      check(again.body.freeMonthUsed === true, "1.5 THE LOOPHOLE IS CLOSED: the new account is flagged freeMonthUsed");
      check(typeof again.body.freeMonthNotice === "string" && /free month/i.test(again.body.freeMonthNotice) && /token/i.test(again.body.freeMonthNotice),
        "1.6 and the sign-in response carries the plain-language notice: " + JSON.stringify(again.body.freeMonthNotice));
      check(!/[–—]/.test(again.body.freeMonthNotice || ""), "1.7 the notice has no em/en dashes (house rule)");
      const st1 = await status(s.c, again.body.sessionToken);
      check(st1.body.entitled === false && st1.body.reason === "none", "1.8 the recreated account is NOT entitled: " + JSON.stringify({ entitled: st1.body.entitled, reason: st1.body.reason }));
      check(st1.body.freeThroughMonth === "2026-06", "1.9 status still truthfully reports the ORIGINAL window's end (2026-06): " + st1.body.freeThroughMonth);

      // CONTROL: a genuinely new identity on the SAME server, same moment, gets its free month.
      const fresh = await signInApple(s.c, "001999.fresh1", "Fresh1");
      check(fresh.freeMonthUsed === undefined, "1.10 control: a genuinely new identity gets no freeMonthUsed flag");
      const stf = await status(s.c, fresh.sessionToken);
      check(stf.body.entitled === true && stf.body.reason === "free", "1.11 control: and a real free month: " + JSON.stringify({ entitled: stf.body.entitled, reason: stf.body.reason }));

      // Round 3: delete the recreated account and come back AGAIN - the ORIGINAL record wins
      // forever (a recreate-then-delete cycle must never push freeThroughMonth forward).
      await s.c.post("/account/delete", { auth: again.body.sessionToken });
      const third = await s.c.signIn(appleKey, { sub: "001999.loop1", iss: ISSUER, aud: AUD });
      check(third.body.freeMonthUsed === true, "1.12 a third account for the same sub is still flagged");
      const st3 = await status(s.c, third.body.sessionToken);
      check(st3.body.freeThroughMonth === "2026-06", "1.13 and still capped at the ORIGINAL 2026-06 - repeat cycles never move it: " + st3.body.freeThroughMonth);

      // The tombstone survives a full server restart (it is persisted state, not memory).
      await restart(s, {});
      const st4 = await status(s.c, third.body.sessionToken);
      check(st4.status === 200 && st4.body.entitled === false && st4.body.freeThroughMonth === "2026-06",
        "1.14 the inherited cap survives a server restart: " + JSON.stringify({ entitled: st4.body.entitled, freeThroughMonth: st4.body.freeThroughMonth }));
    } finally { await s.stop(); }
  }

  /* =============================================================================================
   * GROUP 2 - THE HONEST REINSTALL. Delete and re-sign-in INSIDE the original free window:
   * the new account keeps the remainder of that window, no flag, no notice, no punishment.
   * Real clock throughout - signup month is the real current month.
   * ========================================================================================== */
  {
    const s = await boot({}, "group2-reinstall");
    try {
      const a = await signInApple(s.c, "001999.reinstall", "Reins");
      const before = await status(s.c, a.sessionToken);
      check(before.body.entitled === true && before.body.reason === "free", "2.0 setup: fresh account is free-entitled");
      const origThrough = before.body.freeThroughMonth;
      await s.c.post("/account/delete", { auth: a.sessionToken });
      const back = await s.c.signIn(appleKey, { sub: "001999.reinstall", iss: ISSUER, aud: AUD });
      check(back.status === 200 && back.body.freeMonthUsed === undefined,
        "2.1 reinstalling INSIDE the free window raises no flag and no notice (not punitive)");
      const after = await status(s.c, back.body.sessionToken);
      check(after.body.entitled === true && after.body.reason === "free",
        "2.2 the reinstalled account keeps the remainder of its original free window");
      check(after.body.freeThroughMonth === origThrough,
        "2.3 and the window END never moves (" + origThrough + " before, " + after.body.freeThroughMonth + " after) - deleting bought nothing");
    } finally { await s.stop(); }
  }

  /* =============================================================================================
   * GROUP 3 - NO SIDE DOOR VIA A LINKED PROVIDER. Link Google onto an Apple account, delete
   * the account, come back through GOOGLE alone: the Google identity carries the same record.
   * ========================================================================================== */
  {
    const s = await boot({ NASTY_ACCOUNT_CREATED_MS: String(midMonthMs("2026-05")) }, "group3-linked");
    try {
      const a = await signInApple(s.c, "001999.linked", "Linked");
      const linked = await s.c.link(a.sessionToken, "google", googleKey, { iss: GOOGLE_ISS, aud: GOOGLE_AUD, sub: "google-linked-1" });
      check(linked.status === 200, "3.0 setup: a Google sign-in is linked onto the Apple account");
      await s.c.post("/account/delete", { auth: a.sessionToken });
      await restart(s, { NASTY_ACCOUNT_CREATED_MS: "" });
      const viaGoogle = await s.c.signInWith("google", googleKey, { iss: GOOGLE_ISS, aud: GOOGLE_AUD, sub: "google-linked-1" });
      check(viaGoogle.status === 200, "3.1 returning through Google alone creates a new account");
      check(viaGoogle.body.freeMonthUsed === true, "3.2 NO SIDE DOOR: the linked Google identity inherited the used-free-month record");
      const st = await status(s.c, viaGoogle.body.sessionToken);
      check(st.body.entitled === false && st.body.freeThroughMonth === "2026-06",
        "3.3 capped at the original account's window: " + JSON.stringify({ entitled: st.body.entitled, freeThroughMonth: st.body.freeThroughMonth }));
    } finally { await s.stop(); }
  }

  /* =============================================================================================
   * GROUP 4 - WHAT IS ACTUALLY STORED (node only - the deno twin runs the byte-identical logic
   * against KV, which this suite cannot open directly). The persisted file must contain ONLY
   * 64-hex-char one-way hashes mapping to {freeThroughMonth, ts} - never a raw sub, uid, name
   * or email. This is the "cannot be turned back into who they are" promise, checked on disk.
   * ========================================================================================== */
  if (KIND === "node") {
    const s = await boot({}, "group4-storage");
    try {
      const sub = "001999.storagecheck.veryrecognizable";
      const a = await signInApple(s.c, sub, "StoreChk");
      await s.c.post("/account/delete", { auth: a.sessionToken });
      const file = path.join(s.scratch, "free-months.json");
      check(fs.existsSync(file), "4.0 the tombstone store exists on disk after create+delete");
      const raw = fs.readFileSync(file, "utf8");
      const obj = JSON.parse(raw);
      const keys = Object.keys(obj);
      check(keys.length === 1, "4.1 exactly one record for one identity: " + keys.length);
      check(keys.every((k) => /^[0-9a-f]{64}$/.test(k)), "4.2 the key is a 64-hex SHA-256, not an identifier");
      check(!raw.includes(sub) && !raw.includes("StoreChk") && !raw.includes(a.uid),
        "4.3 the raw sub, the game name and the uid appear NOWHERE in the stored file");
      const rec = obj[keys[0]];
      check(JSON.stringify(Object.keys(rec).sort()) === JSON.stringify(["freeThroughMonth", "ts"]),
        "4.4 the record holds ONLY freeThroughMonth + ts (the minimum): " + JSON.stringify(rec));
      // And the salt that makes the hash unlinkable exists (the kit points it into scratch,
      // exactly like every other storage file) and is a real generated value, not the sub.
      const saltFile = path.join(s.scratch, "free-month-salt.txt");
      check(fs.existsSync(saltFile), "4.5 a persistent salt was generated on first use");
      const salt = fs.readFileSync(saltFile, "utf8").trim();
      check(/^[0-9a-f]{64}$/.test(salt), "4.6 the salt is 32 random bytes hex, generated server-side");
    } finally { await s.stop(); }
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
