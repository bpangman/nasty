"use strict";
/*
 * 2026-07-25 § ACCOUNTS Stage 1, suite 3 of 3: THE DORMANCY PROOF.
 *
 * This is the regression net for the whole stage, and the one that matters most: NOTHING BLAKE
 * OR THE FAMILY CAN SEE HAS CHANGED. It proves that in three separate ways.
 *
 *   Part G - the kill switch. With NASTY_ACCOUNTS_ENABLED=0 the account layer does not exist at
 *     all: /account/* falls through to the same plain 404 it hits today, the two new admin
 *     routes are gone, and not one storage file is created.
 *   Part H - byte-identical HTTP. Two servers are booted side by side from the same scratch
 *     recipe - one with accounts OFF, one with accounts fully ON AND CONFIGURED - and the same
 *     deterministic script of requests is run against both. Every response body and every header
 *     that matters is compared BYTE FOR BYTE: /health, /leaderboard (after an identical sequence
 *     of solo results), the epoch header, the CORS preflight, the Apple app-site-association
 *     file, the /join redirect page, the 404 page, every /solo-result answer including its error
 *     cases, and every /admin/leaderboard route. A `/solo-result` carrying the new `auth` field
 *     is compared against the same submission without it, proving the field really is accepted
 *     and ignored.
 *   Part I - the whole protocol surface. `protocol_checklist.js` (the 54-check full wire
 *     protocol suite) is run against a server with accounts fully enabled and again with them
 *     disabled, and both runs must report the identical pass/fail numbers.
 *   Part J - and with an account signed in and a name claimed, an ordinary guest posting under
 *     that same name still lands on the board exactly as it does today. Anti-squatting is
 *     Stage 5, deliberately not this stage.
 *
 * Usage:
 *   node test_accounts_dormant.js node
 *   node test_accounts_dormant.js deno
 */
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const K = require("./test_accounts_kit.js");

const KIND = process.argv[2] || "node";
const ADMIN_TOKEN = "accounts-dormant-admin-token";
const AUD = "com.pangman.nasty";
const ISSUER = "https://test.local";

let PASS = 0, FAIL = 0;
function log(...a) { console.log("[acct-dormant]", ...a); }
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
function randPort() { return 28400 + Math.floor(Math.random() * 600); }

// A full, comparable capture of one HTTP response: status, body text, and the headers this app
// actually promises anything about.
const HEADERS_THAT_MATTER = [
  "content-type", "x-leaderboard-epoch",
  "access-control-allow-origin", "access-control-allow-methods",
  "access-control-allow-headers", "access-control-expose-headers",
];
async function capture(base, pathname, init) {
  const r = await fetch(base + pathname, init);
  const headers = {};
  for (const h of HEADERS_THAT_MATTER) { const v = r.headers.get(h); if (v !== null) headers[h] = v; }
  return { status: r.status, headers, body: await r.text() };
}

async function main() {
  const key = K.makeKeyPair("dormant-key");
  const jwks = await K.startJwksServer([key]);

  /* ================== Part G: the kill switch is a true revert ================== */
  {
    const s = K.makeScratch(`acct-off-${KIND}`);
    const p = randPort();
    const b = `http://localhost:${p}`;
    const child = K.startServer(KIND, K.serverEnv(KIND, s, p, ADMIN_TOKEN, {
      NASTY_ACCOUNTS_ENABLED: "0",
      // Deliberately configured for Apple as well, to prove the kill switch beats the Apple gate.
      NASTY_APPLE_JWKS_URL: jwks.url, NASTY_APPLE_ISSUER: ISSUER, NASTY_APPLE_AUDIENCES: AUD,
    }), "ACCOUNTS_VERBOSE");
    await K.waitHealthy(b);
    const g1 = await capture(b, "/account/nonce");
    check(g1.status === 404 && g1.body === "nasty relay - see /health" && /text\/plain/.test(g1.headers["content-type"] || ""),
      "G1 with the kill switch off, /account/nonce is the same plain 404 every unknown path has always been");
    const g2 = await capture(b, "/account/apple", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    check(g2.status === 404 && g2.body === "nasty relay - see /health", "G2 and so is POST /account/apple");
    const g3 = await capture(b, "/admin/accounts", { headers: { "x-admin-token": ADMIN_TOKEN } });
    check(g3.status === 404 && JSON.parse(g3.body).error === "no such admin route", "G3 the new admin listing route is gone");
    const g4 = await capture(b, "/admin/claim/undo", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN }, body: "{}",
    });
    check(g4.status === 404 && JSON.parse(g4.body).error === "no such admin route", "G4 and so is the claim-undo route");
    if (KIND === "node") {
      const made = ["accounts.json", "account-index.json", "sessions.json", "auth-nonces.json", "accounts-leaderboard.json", "claims.json"]
        .filter((f) => fs.existsSync(path.join(s, f)));
      check(made.length === 0, "G5 and not one account storage file was created (" + (made.join(",") || "none") + ")");
    } else {
      check(true, "G5 (node-only file check, skipped on deno)");
    }
    await K.stopServer(child);
  }

  /* ============ Part H: byte-identical HTTP, accounts OFF vs accounts fully ON ============ */
  {
    const sOff = K.makeScratch(`acct-cmpoff-${KIND}`);
    const sOn = K.makeScratch(`acct-cmpon-${KIND}`);
    const pOff = randPort() + 11, pOn = randPort() + 12;
    const bOff = `http://localhost:${pOff}`, bOn = `http://localhost:${pOn}`;
    const childOff = K.startServer(KIND, K.serverEnv(KIND, sOff, pOff, ADMIN_TOKEN, { NASTY_ACCOUNTS_ENABLED: "0" }), "ACCOUNTS_VERBOSE");
    const childOn = K.startServer(KIND, K.serverEnv(KIND, sOn, pOn, ADMIN_TOKEN, {
      NASTY_ACCOUNTS_ENABLED: "1", NASTY_APPLE_JWKS_URL: jwks.url,
      NASTY_APPLE_ISSUER: ISSUER, NASTY_APPLE_AUDIENCES: AUD, NASTY_ACCOUNT_RATE_LIMIT: "4000",
    }), "ACCOUNTS_VERBOSE");
    await K.waitHealthy(bOff);
    await K.waitHealthy(bOn);

    // The identical script, run against both, in the same order.
    const script = [
      ["health shape", async (b) => {
        const r = await capture(b, "/health");
        const j = JSON.parse(r.body);
        // uptime and room count genuinely differ between two processes; everything else must not.
        return JSON.stringify({ status: r.status, keys: Object.keys(j).sort(), ok: j.ok, epoch: j.epoch, protocolVersion: j.protocolVersion, headers: r.headers });
      }],
      ["apple-app-site-association", (b) => capture(b, "/.well-known/apple-app-site-association")],
      ["join redirect page", (b) => capture(b, "/join/ABCD")],
      ["unknown path 404", (b) => capture(b, "/definitely-not-a-route")],
      ["CORS preflight", (b) => capture(b, "/leaderboard", { method: "OPTIONS" })],
      ["empty leaderboard", (b) => capture(b, "/leaderboard")],
      ["solo-result: a normal game", (b) => capture(b, "/solo-result", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameId: "cmp-1", entries: [{ name: "Blake", delta: { hg4s: 1, hw4s: 1, hptsS: 3, hkoDealt: 2 } }, { name: "Ginny", delta: { hg4s: 1, hkoTaken: 2 } }] }),
      })],
      ["solo-result: the same game again (dedupe)", (b) => capture(b, "/solo-result", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameId: "cmp-1", entries: [{ name: "Blake", delta: { hg4s: 1 } }] }),
      })],
      ["solo-result: missing gameId", (b) => capture(b, "/solo-result", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entries: [] }),
      })],
      ["solo-result: a stale epoch", (b) => capture(b, "/solo-result", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameId: "cmp-stale", epoch: 0, entries: [{ name: "Blake", delta: { hg4s: 1 } }] }),
      })],
      ["solo-result: a negative delta", (b) => capture(b, "/solo-result", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameId: "cmp-neg", entries: [{ name: "Blake", delta: { hg4s: -5, hw4s: 1 } }] }),
      })],
      ["solo-result: a blocked name", (b) => capture(b, "/solo-result", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameId: "cmp-bad", entries: [{ name: "bitch", delta: { hg4s: 1 } }] }),
      })],
      ["solo-result: mixed capitalization folds onto one row", (b) => capture(b, "/solo-result", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameId: "cmp-case", entries: [{ name: "BLAKE", delta: { hg6t: 1, hw6t: 1, hptsT: 5 } }] }),
      })],
      // THE ONE NEW THING a future client sends. It must change nothing at all.
      ["solo-result: carrying the new auth field", (b) => capture(b, "/solo-result", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameId: "cmp-auth", auth: "a-session-token-a-future-client-would-send", entries: [{ name: "Jim", delta: { hg4s: 1, hw4s: 1, hptsS: 3 } }] }),
      })],
      ["leaderboard after all of that", (b) => capture(b, "/leaderboard")],
      ["admin leaderboard read", (b) => capture(b, "/admin/leaderboard", { headers: { "x-admin-token": ADMIN_TOKEN } })],
      ["admin leaderboard PATCH", (b) => capture(b, "/admin/leaderboard/Ginny", {
        method: "PATCH", headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
        body: JSON.stringify({ hw4s: 9 }),
      })],
      ["admin leaderboard DELETE", (b) => capture(b, "/admin/leaderboard/Jim", {
        method: "DELETE", headers: { "x-admin-token": ADMIN_TOKEN },
      })],
      ["leaderboard after the admin edits", (b) => capture(b, "/leaderboard")],
      ["admin unauthorized", (b) => capture(b, "/admin/leaderboard")],
      ["admin unknown route", (b) => capture(b, "/admin/nope", { headers: { "x-admin-token": ADMIN_TOKEN } })],
      ["admin leaderboard reset (new season)", (b) => capture(b, "/admin/leaderboard/reset", {
        method: "POST", headers: { "x-admin-token": ADMIN_TOKEN },
      })],
      ["leaderboard after the reset", (b) => capture(b, "/leaderboard")],
    ];
    let diffs = 0;
    for (const [label, fn] of script) {
      const a = await fn(bOff);
      const bb = await fn(bOn);
      const sa = typeof a === "string" ? a : JSON.stringify(a);
      const sb = typeof bb === "string" ? bb : JSON.stringify(bb);
      if (sa !== sb) { diffs++; log("FAIL", `H diff on "${label}"\n  accounts OFF: ${sa}\n  accounts ON : ${sb}`); }
    }
    if (diffs === 0) { PASS++; log("OK  ", `H1 all ${script.length} HTTP responses are byte-identical with accounts off and accounts fully on`); }
    else { FAIL++; }

    // And the served board is still the flat {name:{stat:number}} map every shipped build renders.
    const lb = JSON.parse((await capture(bOn, "/leaderboard")).body);
    const shapeOk = Object.keys(lb).every((n) => lb[n] && typeof lb[n] === "object" && !Array.isArray(lb[n]) &&
      Object.keys(lb[n]).every((k) => typeof lb[n][k] === "number"));
    check(shapeOk, "H2 /leaderboard's body is still the flat {name:{stat:number}} shape an already-shipped build renders");

    await K.stopServer(childOff);
    await K.stopServer(childOn);
  }

  /* ============ Part I: the whole wire protocol, with accounts on and with them off ============ */
  {
    function runChecklist(extraEnv) {
      const res = spawnSync(process.execPath, ["protocol_checklist.js", KIND], {
        cwd: "/Users/jarvis/nasty-game/server/tests",
        env: Object.assign({}, process.env, extraEnv),
        encoding: "utf8",
      });
      const m = String(res.stdout || "").match(/(\d+) passed, (\d+) failed/);
      return { code: res.status, passed: m ? Number(m[1]) : -1, failed: m ? Number(m[2]) : -1, out: res.stdout };
    }
    const off = runChecklist({ NASTY_ACCOUNTS_ENABLED: "0" });
    const on = runChecklist({
      NASTY_ACCOUNTS_ENABLED: "1", NASTY_APPLE_JWKS_URL: jwks.url,
      NASTY_APPLE_ISSUER: ISSUER, NASTY_APPLE_AUDIENCES: AUD,
    });
    check(off.failed === 0 && off.passed > 40, `I1 protocol_checklist with accounts OFF: ${off.passed} passed, ${off.failed} failed`);
    check(on.failed === 0 && on.passed === off.passed,
      `I2 protocol_checklist with accounts fully ON: ${on.passed} passed, ${on.failed} failed - identical to the accounts-off run`);
  }

  /* ============ Part J: a claimed name does NOT change anything for a guest yet ============ */
  {
    const s = K.makeScratch(`acct-guest-${KIND}`);
    const p = randPort() + 29;
    const b = `http://localhost:${p}`;
    const cli = K.makeClient(b);
    const child = K.startServer(KIND, K.serverEnv(KIND, s, p, ADMIN_TOKEN, {
      NASTY_ACCOUNTS_ENABLED: "1", NASTY_APPLE_JWKS_URL: jwks.url,
      NASTY_APPLE_ISSUER: ISSUER, NASTY_APPLE_AUDIENCES: AUD, NASTY_ACCOUNT_RATE_LIMIT: "4000",
    }), "ACCOUNTS_VERBOSE");
    await K.waitHealthy(b);
    const acct = (await cli.signIn(key, { sub: "001111.guestcheck.0001" })).body;
    await cli.post("/account/name", { auth: acct.sessionToken, name: "Blake" });
    await cli.post("/account/claim", { auth: acct.sessionToken });
    const r = await fetch(b + "/solo-result", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: "guest-1", entries: [{ name: "Blake", delta: { hg4s: 1, hw4s: 1, hptsS: 3 } }] }),
    });
    const body = await r.json();
    check(r.status === 200 && body.ok === true, "J1 a guest posting a game under a CLAIMED name is still accepted, exactly as today");
    const lb = await (await fetch(b + "/leaderboard")).json();
    const row = lb[Object.keys(lb).find((k) => k.toLowerCase() === "blake") || ""];
    check(row && row.hg4s === 1 && row.hw4s === 1 && row.hptsS === 3,
      "J1b and it lands on the board under that name - anti-squatting is Stage 5, deliberately not this stage");
    const health = await (await fetch(b + "/health")).json();
    check(health.protocolVersion === 5, "J2 PROTOCOL_VERSION is still 5 - nothing in this stage needed a bump");
    await K.stopServer(child);
  }

  jwks.close();
  console.log(`\n[acct-dormant/${KIND}] ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
