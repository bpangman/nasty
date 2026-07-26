"use strict";
/*
 * 2026-07-25 permanent regression suite - ACCOUNTS STAGE 2: Sign in with Apple, client side.
 *
 * Stage 1 (commit 3fb8f18) and the four-provider rebuild (a412437) built the whole server side
 * and left it dormant. This suite covers the half that shipped in v0.35: the three account rows
 * in the game's account panel actually doing something on a phone, and deliberately doing
 * nothing on the website.
 *
 * Parts:
 *   A - THE WEBSITE. In a plain browser there is no native Sign in with Apple, so all three rows
 *       stay exactly where they are and stay disabled behind an honest sentence. No dead Apple
 *       button. And a guest's experience is byte-for-byte what it was: they can start a game,
 *       open the panel, read the rules, toggle sound and rename themselves with no account.
 *   B - THE PHONE. With the native plugin present the whole flow runs for real against a private
 *       server: nonce, Apple identity token, session, first-sign-in name binding, who is signed
 *       in, sign out, sign in again onto the SAME account, and account deletion including its
 *       "are you sure" step. The Apple token is minted locally by test_accounts_kit.js and
 *       verified against a local JWKS - NOTHING here ever contacts Apple.
 *   C - THE LEADERBOARD IS UNTOUCHED. Two private servers, one with accounts off and one
 *       configured exactly like production, given the identical guest traffic: /leaderboard must
 *       come back byte for byte identical, and a guest's result must still post.
 *   D - THE PARKED SWITCHES ARE STILL PARKED. On a server configured exactly like production:
 *       the one-time name-claim window is closed and never offered, and Google, Facebook and the
 *       email code all answer "not set up".
 *
 * Never touches production: private random ports, scratch storage, a throwaway admin token, and
 * a local JWKS server. Never writes to the real global leaderboard.
 *
 * Run: node test_accounts_stage2_signin_2026_07_25.js
 */
const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
// v0.36 (2026-07-26): seed the first-run sign-in screen's answer before the page boots, so
// this suite runs as the returning player it was always written about. Real key, real code
// path, no stub - see test_ui_v036_welcome_bypass.js.
require("./test_ui_v036_welcome_bypass.js").patch(chromium);

const path = require("path");
const fs = require("fs");
const K = require("./test_accounts_kit.js");

const INDEX = "file://" + path.resolve(__dirname, "..", "..", "index.html");
const SHOTDIR = "/private/tmp/claude-501/-Users-jarvis/0bc923da-f111-499a-9b51-18988e4aba3d/scratchpad/shots-sso";
try { fs.mkdirSync(SHOTDIR, { recursive: true }); } catch (e) {}

const AUD = "com.pangman.nasty";
const ISSUER = "https://appleid.apple.com";   // the real one - the JWKS is what is local, not the name
const ADMIN_TOKEN = "accounts-stage2-admin-token";

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}
function randPort() { return 28100 + Math.floor(Math.random() * 700); }

/* A real game started from the menu, so seat 0 is a HUMAN - which is whose account this is.
   `ws` points the client at a private server; without it the client would try to look one up. */
async function humanBoard(page, ws) {
  const q = ws ? "?ws=" + encodeURIComponent(ws) : "";
  await page.goto(INDEX + q);
  await page.waitForSelector("#btnStart");
  await page.click("#btnStart");
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
  const picker = await page.evaluate(() => {
    const sp = document.getElementById("speedPickerOverlay");
    return sp && !sp.classList.contains("hidden");
  });
  if (picker) await page.click("#btnSpeedPick0");
  await page.waitForTimeout(250);
}
async function openPanel(page) {
  await page.click("#btnAccount");
  await page.waitForTimeout(150);
}
const readRows = (page) => page.evaluate(() => window.__acct.rows());

/* ===================== Part A - the website: honest, disabled, and guests untouched ===== */
async function partA(browser) {
  console.log("\n=== Part A: the website - sign-in unavailable, said plainly, guests unchanged ===");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await humanBoard(page, null);
  await openPanel(page);
  const rows = await readRows(page);

  ok(rows.available === false, "A1 a plain browser has no native Sign in with Apple");
  ok(rows.signIn && !rows.signIn.hidden && !rows.signOut.hidden && !rows.del.hidden,
    "A2 all three account rows are still VISIBLE, in the same place they were in v0.34");
  ok(rows.signIn.disabled && rows.signOut.disabled && rows.del.disabled,
    "A3 all three are disabled - nobody can tap a sign-in that is not there");
  ok(rows.signIn.text === "Sign in" && !/apple/i.test(rows.signIn.text),
    `A4 no dead Apple button on the web - the row just reads "${rows.signIn.text}"`);
  ok(/coming soon/i.test(rows.note) && /website/i.test(rows.note) && /app/i.test(rows.note),
    `A5 the note says so in plain language ("${rows.note}")`);
  ok(rows.confirmOpen === false, "A6 the delete confirmation is not showing");
  ok((await page.evaluate(() => window.__acct.state())) === null, "A7 nobody is signed in");

  // Clicking the disabled rows must do nothing at all - no navigation, no request, no error.
  await page.evaluate(() => { ["btnAcctSignIn", "btnAcctSignOut", "btnAcctDelete"].forEach((id) => document.getElementById(id).click()); });
  await page.waitForTimeout(200);
  const after = await readRows(page);
  ok(after.confirmOpen === false && (await page.evaluate(() => window.__acct.state())) === null,
    "A8 tapping the disabled rows changes nothing");

  // A guest's panel is exactly what it was: rules, sound, rename.
  const guest = await page.evaluate(async () => {
    const out = {};
    const sndBefore = document.getElementById("btnAcctSound").textContent;
    document.getElementById("btnAcctSound").click();
    await new Promise((r) => setTimeout(r, 80));
    out.soundToggles = document.getElementById("btnAcctSound").textContent !== sndBefore;
    document.getElementById("btnAcctSound").click();
    await new Promise((r) => setTimeout(r, 80));
    document.getElementById("btnAcctName").click();
    await new Promise((r) => setTimeout(r, 80));
    out.editorOpens = !document.getElementById("acctNameEdit").classList.contains("hidden");
    out.prefilled = document.getElementById("acctNameInput").value;
    document.getElementById("acctNameInput").value = "Guesty";
    document.getElementById("btnAcctNameSave").click();
    await new Promise((r) => setTimeout(r, 200));
    out.renamed = window.G.seats[0].name;
    out.rulesRow = !!document.getElementById("btnAcctRules");
    out.stillGuest = window.__acct.state() === null;
    return out;
  });
  ok(guest.soundToggles, "A9 guest: the sound row still toggles");
  ok(guest.editorOpens && guest.prefilled.length > 0, `A10 guest: renaming still opens pre-filled ("${guest.prefilled}")`);
  ok(guest.renamed === "Guesty", `A11 guest: renaming still renames the live game (${guest.renamed})`);
  ok(guest.rulesRow, "A12 guest: the rules row is still there");
  ok(guest.stillGuest, "A13 guest: none of that signed anybody in");
  await page.screenshot({ path: path.join(SHOTDIR, "web_signed_out.png") });
  ok(errors.length === 0, `A14 zero page errors on the website (${errors.join(" | ")})`);
  await ctx.close();
}

/* ===================== Part B - the phone: the whole real flow ========================== */
async function partB(browser, key, jwks) {
  console.log("\n=== Part B: the iPhone app - sign in, sign out, sign in again, delete ===");
  const scratch = K.makeScratch("acct-stage2-app");
  const port = randPort();
  const base = `http://localhost:${port}`;
  // EXACTLY the production configuration: accounts on, Apple only, claim window closed,
  // account-only leaderboard off.
  const env = K.serverEnv("node", scratch, port, ADMIN_TOKEN, {
    NASTY_ACCOUNTS_ENABLED: "1",
    NASTY_APPLE_JWKS_URL: jwks.url,
    NASTY_APPLE_ISSUER: ISSUER,
    NASTY_APPLE_AUDIENCES: AUD,
    NASTY_CLAIM_WINDOW_OPEN: "0",
    NASTY_LEADERBOARD_ACCOUNTS_ONLY: "0",
    NASTY_ACCOUNT_RATE_LIMIT: "4000",
  });
  const srv = K.startServer("node", env, "ACCOUNTS_VERBOSE");
  await K.waitHealthy(base);
  const api = K.makeClient(base);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  /* The native plugin, stubbed with the REAL contract: it is handed the server's nonce and hands
     back an identity token carrying that same nonce, minted here with the test key and served
     from the local JWKS. Nothing about the server's verification is faked - it does the full
     RS256 + issuer + audience + nonce check on a genuinely signed token. */
  const seen = { nonces: [], tokens: [] };
  await page.exposeFunction("__mintAppleToken", async (nonce, sub) => {
    seen.nonces.push(nonce);
    const t = K.mintIdentityToken(key, { nonce, sub, iss: ISSUER, aud: AUD });
    seen.tokens.push(t);
    return t;
  });
  // isNativePlatform is deliberately NOT provided: that keeps IS_APP false so none of the app's
  // native boot (status bar, push, splash) runs, while appleSignInPlugin() still finds a plugin -
  // which is the only thing the account rows actually depend on.
  await page.addInitScript(() => {
    window.Capacitor = window.Capacitor || {};
    window.Capacitor.Plugins = window.Capacitor.Plugins || {};
    window.Capacitor.Plugins.AppleSignIn = {
      isAvailable: async () => ({ available: true }),
      authorize: async (opts) => ({ identityToken: await window.__mintAppleToken(opts.nonce, "001999.stage2.0001"), user: "001999.stage2.0001" }),
    };
  });

  await humanBoard(page, base);
  // Give this phone a name BEFORE signing in - the whole point of the first-sign-in binding is
  // that the player does not have to type it again.
  await page.evaluate(() => { setChosenName("Grandad"); });
  await openPanel(page);

  let rows = await readRows(page);
  ok(rows.available === true, "B1 the app finds the native Sign in with Apple plugin");
  ok(rows.signIn.text === "Sign in with Apple" && rows.signIn.disabled === false,
    `B2 signed out: the Sign in row is live and says which sign-in it is ("${rows.signIn.text}")`);
  ok(rows.signOut.disabled && rows.del.disabled, "B3 signed out: Sign out and Delete account are disabled");
  ok(/optional/i.test(rows.note), `B4 signed out: the note says signing in is optional ("${rows.note}")`);

  await page.click("#btnAcctSignIn");
  await page.waitForFunction(() => window.__acct.state() !== null, { timeout: 15000 });
  await page.waitForTimeout(400);

  const state = await page.evaluate(() => window.__acct.state());
  const stored = await page.evaluate(() => localStorage.getItem("nasty-account"));
  ok(state && typeof state.uid === "string" && state.uid.length === 32,
    `B5 signing in produced the server's own account id (${state && state.uid})`);
  ok(state.gameName === "Grandad", `B6 the first sign-in bound the name this phone was ALREADY using, with no retyping (${state.gameName})`);
  ok(typeof stored === "string" && stored.length === 64, "B7 the session is remembered on this phone");
  ok(seen.nonces.length === 1 && typeof seen.nonces[0] === "string" && seen.nonces[0].length >= 16,
    "B8 a server-issued nonce really was handed to Apple");

  rows = await readRows(page);
  ok(rows.signIn.disabled === true, "B9 signed in: the Sign in row goes quiet");
  ok(rows.signOut.disabled === false && rows.del.disabled === false, "B10 signed in: Sign out and Delete account come alive");
  ok(/signed in with apple/i.test(rows.note) && rows.note.includes("Grandad"),
    `B11 signed in: the panel says who you are ("${rows.note}")`);
  const who = await page.evaluate(() => document.getElementById("acctWhoSub").textContent);
  ok(/signed in with apple/i.test(who), `B12 the panel header says it too ("${who}")`);
  await page.screenshot({ path: path.join(SHOTDIR, "app_signed_in.png") });

  // The server agrees, and the nonce was genuinely single use.
  const me = await api.post("/account/me", { auth: stored });
  ok(me.status === 200 && me.body.uid === state.uid && me.body.gameName === "Grandad",
    "B13 the server holds the same account, under the same name");
  const replay = await api.post("/account/apple", { identityToken: seen.tokens[0], nonce: seen.nonces[0], platform: "ios" });
  ok(replay.status === 401 && replay.body && replay.body.error === "badnonce",
    `B14 replaying that exact sign-in is refused - the nonce was single use (${replay.status} ${replay.body && replay.body.error})`);
  ok(me.body.claimWindow && me.body.claimWindow.open === false,
    "B15 the one-time name claim window is CLOSED, so the client is never offered one");
  ok(Array.isArray(me.body.providers) && me.body.providers.length === 1 && me.body.providers[0] === "apple",
    `B16 Apple is the only sign-in method configured (${JSON.stringify(me.body.providers)})`);

  // ---- sign out
  await page.click("#btnAcctSignOut");
  await page.waitForFunction(() => window.__acct.state() === null, { timeout: 10000 });
  await page.waitForTimeout(300);
  rows = await readRows(page);
  const storedAfter = await page.evaluate(() => localStorage.getItem("nasty-account"));
  ok(storedAfter === null, "B17 signing out forgets the session on this phone");
  ok(rows.signIn.disabled === false && rows.signOut.disabled && rows.del.disabled,
    "B18 signing out puts the rows straight back to their signed-out state");
  const dead = await api.post("/account/me", { auth: stored });
  ok(dead.status === 401, `B19 the server killed that session too (${dead.status})`);
  const stillPlaying = await page.evaluate(() => !!(window.G && window.G.n));
  ok(stillPlaying, "B20 signing out did not disturb the game in progress");

  // ---- sign in again: SAME account, not a second one
  await page.click("#btnAcctSignIn");
  await page.waitForFunction(() => window.__acct.state() !== null, { timeout: 15000 });
  await page.waitForTimeout(400);
  const again = await page.evaluate(() => window.__acct.state());
  ok(again.uid === state.uid, `B21 signing in again lands on the SAME account (${again.uid})`);
  ok(again.gameName === "Grandad", "B22 and the same name on the family board - nothing to re-enter");

  // ---- delete: the confirm step, then cancel, then for real
  await page.click("#btnAcctDelete");
  await page.waitForTimeout(200);
  rows = await readRows(page);
  ok(rows.confirmOpen === true, "B23 Delete account asks first, inside this panel");
  const onlyOnePage = await page.evaluate(() => [...document.querySelectorAll(".overlay:not(.hidden)")].length);
  ok(onlyOnePage === 1, `B24 asking does NOT open a second full-screen page (${onlyOnePage} visible)`);
  await page.screenshot({ path: path.join(SHOTDIR, "app_delete_confirm.png") });
  await page.click("#btnAcctDelNo");
  await page.waitForTimeout(150);
  ok((await readRows(page)).confirmOpen === false, "B25 Keep my account closes it again");
  ok((await page.evaluate(() => window.__acct.state())) !== null, "B26 and the account is still there");

  const token2 = await page.evaluate(() => localStorage.getItem("nasty-account"));
  await page.click("#btnAcctDelete");
  await page.waitForTimeout(150);
  await page.click("#btnAcctDelYes");
  await page.waitForFunction(() => window.__acct.state() === null, { timeout: 10000 });
  await page.waitForTimeout(300);
  rows = await readRows(page);
  ok((await page.evaluate(() => localStorage.getItem("nasty-account"))) === null,
    "B27 deleting forgets the session on this phone");
  ok(rows.signIn.disabled === false && rows.signOut.disabled && rows.del.disabled,
    "B28 and the rows go back to their signed-out state");
  ok(/settings/i.test(rows.note) && /sign in with apple/i.test(rows.note),
    `B29 the panel explains the Apple Settings step, which no app can do for you ("${rows.note}")`);
  const gone = await api.post("/account/me", { auth: token2 });
  ok(gone.status === 401, `B30 the server really deleted it (${gone.status})`);
  ok((await page.evaluate(() => !!(window.G && window.G.n))), "B31 the game in progress survived all of that");
  ok(errors.length === 0, `B32 zero page errors across the whole flow (${errors.join(" | ")})`);

  await ctx.close();
  await K.stopServer(srv);
  return { scratch };
}

/* ===================== Part C - the leaderboard is byte-for-byte untouched ============== */
async function partC(browser, jwks) {
  console.log("\n=== Part C: the leaderboard is exactly what it was, with accounts switched on ===");
  const scriptEntries = [
    { gameId: "stage2-a", entries: [{ name: "Blake", delta: { hg4s: 1, hw4s: 1, hpts: 12, hkoDealt: 2, hkoTaken: 1 } }] },
    { gameId: "stage2-b", entries: [{ name: "Ellen", delta: { hg4s: 1, hpts: 4 } }, { name: "Blake", delta: { hg4s: 1, hpts: 7 } }] },
    { gameId: "stage2-c", entries: [{ name: "Kid", delta: { hg6s: 1, hw6s: 1, hptsT: 9 } }] },
  ];

  async function runOne(tag, extraEnv) {
    const scratch = K.makeScratch("acct-stage2-" + tag);
    const port = randPort();
    const base = `http://localhost:${port}`;
    const env = K.serverEnv("node", scratch, port, ADMIN_TOKEN, extraEnv);
    const srv = K.startServer("node", env, "ACCOUNTS_VERBOSE");
    await K.waitHealthy(base);
    const results = [];
    for (const s of scriptEntries) {
      const r = await fetch(base + "/solo-result", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(s),
      });
      results.push({ status: r.status, body: await r.text() });
    }
    const lb = await fetch(base + "/leaderboard");
    const body = await lb.text();
    const epoch = lb.headers.get("x-leaderboard-epoch");
    await K.stopServer(srv);
    return { results, body, epoch };
  }

  const off = await runOne("off", { NASTY_ACCOUNTS_ENABLED: "0" });
  const on = await runOne("on", {
    NASTY_ACCOUNTS_ENABLED: "1",
    NASTY_APPLE_JWKS_URL: jwks.url,
    NASTY_APPLE_ISSUER: ISSUER,
    NASTY_APPLE_AUDIENCES: AUD,
    NASTY_CLAIM_WINDOW_OPEN: "0",
    NASTY_LEADERBOARD_ACCOUNTS_ONLY: "0",
  });

  ok(off.body === on.body, "C1 /leaderboard is byte-for-byte identical with accounts on and with accounts off");
  ok(off.epoch === on.epoch, `C2 the epoch header is identical (${off.epoch} / ${on.epoch})`);
  ok(JSON.stringify(off.results) === JSON.stringify(on.results),
    "C3 every guest /solo-result answer is identical too");
  const parsed = JSON.parse(on.body);
  ok(parsed.Blake && parsed.Blake.hg4s === 2 && parsed.Blake.hw4s === 1,
    `C4 a GUEST's games still land on the shared board with accounts on (${JSON.stringify(parsed.Blake)})`);
  ok(parsed.Kid && parsed.Ellen, "C5 every guest name is on it - the account-only switch is OFF");
  ok(Object.values(parsed).every((v) => v && typeof v === "object" && !("account" in v) && !("frozen" in v)),
    "C6 the body is still the flat {name:{stats}} shape every shipped build renders");
}

/* ===================== Part D - the parked switches are still parked =================== */
async function partD(key, jwks) {
  console.log("\n=== Part D: the switches Blake asked to leave alone are still off ===");
  const scratch = K.makeScratch("acct-stage2-parked");
  const port = randPort();
  const base = `http://localhost:${port}`;
  const env = K.serverEnv("node", scratch, port, ADMIN_TOKEN, {
    NASTY_ACCOUNTS_ENABLED: "1",
    NASTY_APPLE_JWKS_URL: jwks.url,
    NASTY_APPLE_ISSUER: ISSUER,
    NASTY_APPLE_AUDIENCES: AUD,
    NASTY_CLAIM_WINDOW_OPEN: "0",
    NASTY_LEADERBOARD_ACCOUNTS_ONLY: "0",
    NASTY_ACCOUNT_RATE_LIMIT: "4000",
  });
  const srv = K.startServer("node", env, "ACCOUNTS_VERBOSE");
  await K.waitHealthy(base);
  const api = K.makeClient(base);

  // Put some history on the board under a name, then sign in and take that name. With the window
  // closed the server must NOT offer to move it, and must not move it.
  await fetch(base + "/solo-result", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ gameId: "parked-1", entries: [{ name: "Grandad", delta: { hg4s: 47, hw4s: 19, hpts: 210 } }] }),
  });
  const s = await api.signIn(key, { sub: "001999.parked.0001", iss: ISSUER, aud: AUD });
  ok(s.status === 200, "D1 a sign-in works on a production-shaped server");
  ok(s.body.claimWindow && s.body.claimWindow.open === false, "D2 the one-time name claim window is CLOSED");
  const named = await api.post("/account/name", { auth: s.body.sessionToken, name: "Grandad" });
  ok(named.status === 200 && named.body.pendingClaim === null,
    `D3 taking a name with 47 games of history on it offers NO claim - the window is shut (${JSON.stringify(named.body.pendingClaim)})`);
  const claim = await api.post("/account/claim", { auth: s.body.sessionToken });
  ok(claim.status === 410 && claim.body.error === "claimclosed", `D4 and asking for one anyway is refused (${claim.status})`);
  const lb = (await api.get("/leaderboard")).body || {};
  ok(lb.Grandad && lb.Grandad.hg4s === 47 && lb.Grandad.hw4s === 19,
    `D5 the old history is exactly where it was, untouched (${JSON.stringify(lb.Grandad)})`);

  const g = await api.post("/account/google", { identityToken: "x", nonce: "y" });
  const f = await api.post("/account/facebook", { accessToken: "x", nonce: "y" });
  const e = await api.post("/account/email/start", { email: "someone@example.com" });
  ok(g.status === 503, `D6 Google sign-in is not set up (${g.status})`);
  ok(f.status === 503, `D7 Facebook sign-in is not set up (${f.status})`);
  ok(e.status === 503, `D8 the email code method is not set up (${e.status})`);

  await K.stopServer(srv);
}

/* ===================== Part E - the client source itself ============================== */
function partE() {
  console.log("\n=== Part E: what the client file may and may not contain ===");
  const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "index.html"), "utf8");
  ok(/\/account\/apple/.test(src) && /\/account\/nonce/.test(src),
    "E1 the client really does call the account endpoints now (this replaces v0.33's 'it must not' assertion)");
  ok(!/\/account\/(google|facebook|email)/.test(src),
    "E2 Google, Facebook and the email code are NOT wired up - they stay parked");
  /* ASSERTION UPDATED 2026-07-26 (v0.36 item 3), deliberately. v0.35 left the one-time name claim
     unbuilt on the client, so "the call must not exist" was the right check. Blake is opening a
     72-hour claim window with v0.36, so the client now has it - and the check becomes the thing
     that has to stay true for the rest of this file's Part D, which boots a production-shaped
     server with the window SHUT: the claim is never offered and never sent unless the SERVER's
     own claimWindow.open says so. Part D below proves that live; this proves it structurally. */
  ok(/\/account\/claim/.test(src), "E3 the one-time claim flow IS wired up now (v0.36 item 3)");
  ok(/if\(!claimWindowOpen\(\)\|\|ACCT\.claimDeclined\)return;/.test(src),
    "E3b and it is gated on the server's own claimWindow before a single request is sent");
  ok(!/\/leaderboard\/v2/.test(src), "E4 the client still reads the plain /leaderboard, not the account-aware v2");
  ok(!/acct\s*:/.test(src.replace(/[a-zA-Z]acct\s*:/g, "")) || !/'acct'|"acct"/.test(src),
    "E5 no acct field is sent on host/join - the websocket wire is unchanged from v0.34");
  // Blake's standing rule. Scoped to the section this batch added, so it fails on OUR work
  // rather than on somebody else's older comment elsewhere in the file.
  const secStart = src.indexOf("§ ACCOUNT SIGN-IN (v0.35");
  const secEnd = src.indexOf("renderAccountRows();\nupdateAccountButton();", secStart);
  ok(secStart > 0 && secEnd > secStart, "E6a the new section is where it says it is");
  ok(!/[–—]/.test(src.slice(secStart, secEnd)), "E6 no em or en dashes anywhere in the new section");
}

(async () => {
  const key = K.makeKeyPair("stage2-key");
  const jwks = await K.startJwksServer([key]);
  const browser = await chromium.launch();
  try {
    await partA(browser);
    await partB(browser, key, jwks);
    await partC(browser, jwks);
    await partD(key, jwks);
    partE();
  } finally {
    await browser.close();
    jwks.close();
  }
  console.log(`\n=== accounts stage 2: ${pass} passed, ${fail} failed ===`);
  console.log("screenshots: " + SHOTDIR);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
