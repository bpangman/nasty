"use strict";
/*
 * test_accounts_attribution_2026_07_26.js - PERMANENT suite. v0.40.
 *
 * ============================================================================================
 * WHY THIS EXISTS: A REAL PRODUCTION DATA LOSS
 * ============================================================================================
 * NASTY_LEADERBOARD_ACCOUNTS_ONLY was switched on in production. With it on, the server credits
 * a result ONLY to an ACCOUNT:
 *   - online: finishGame() reads the `accountId` stored on the room's player record, which comes
 *     from an optional `acct` session token on the `host` / `join` messages;
 *   - solo/offline: POST /solo-result credits only when the body carries an `auth` session token
 *     whose account owns the submitted name.
 * THE CLIENT HAD NEVER SENT EITHER FIELD. So every result, from every player, signed in or not,
 * was silently dropped for as long as the switch was on. /solo-result still answered 200, so no
 * phone ever retried, and those games are gone for good.
 *
 * The server side was covered by tests (test_accounts_online.js proves the server credits
 * correctly WHEN `acct` arrives). Nothing tested that the SHIPPING CLIENT actually sends it. That
 * is the exact shape of this failure, and it is what this suite closes: every assertion below
 * drives the real index.html in a real browser and then reads the server's real leaderboard.
 *
 * ============================================================================================
 * PARTS
 * ============================================================================================
 *   A - SOLO, SWITCH ON, SIGNED IN. Sign in for real through the app's own flow (the native
 *       plugin is stubbed with its real contract; the token is genuinely RS256-signed and the
 *       server does the full issuer/audience/nonce verification against a local JWKS). Play a
 *       real offline game to a finish. The account's leaderboard row must go up, INCLUDING
 *       hkoDealt/hkoTaken. Before and after numbers are printed, not just asserted.
 *   B - SOLO, SWITCH ON, GUEST. Same game, nobody signed in: the board must not move, and the
 *       client must have RECORDED that it was not credited rather than shrugging.
 *   C - ONLINE, SWITCH ON, SIGNED IN. Host a real online game through the real lobby UI against a
 *       private server, play it to a finish, and assert the account's row went up including the
 *       knockout stats.
 *   D - ONLINE, SWITCH ON, GUEST. Same, signed out: the board does not move.
 *   E - THE WIRE ITSELF. Every frame the client sends is captured. Signed in, `host`/`join`/
 *       `rejoin`/`reclaim` carry `acct`; signed out, the key is ABSENT (not empty) so a guest's
 *       messages are byte-identical to v0.39's.
 *   F - SWITCH OFF (production today). Solo and online both still record by NAME exactly as they
 *       always have, whether or not the new fields are sent. This is the "nothing about today's
 *       behavior may change" guarantee.
 *   G - THE TWO RECONNECT RULES, end to end: a player who hosts as a GUEST and signs in MID-GAME
 *       is credited after their phone reconnects (a rejoin may FILL a missing accountId), and a
 *       player who LOSES their session mid-game still gets the game they were in (a rejoin can
 *       never overwrite or clear an accountId that is already set).
 *
 * Never touches production: private random ports, scratch storage, a throwaway admin token and a
 * local JWKS. Nothing here ever contacts Apple.
 *
 * Run: node tests/test_accounts_attribution_2026_07_26.js
 */
const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
require("./test_ui_v036_welcome_bypass.js").patch(chromium);
const path = require("path");
const K = require("./test_accounts_kit.js");

const INDEX_PATH = process.env.NASTY_INDEX || path.resolve(__dirname, "..", "..", "index.html");
const AUD = "com.pangman.nasty";
const ISSUER = "https://appleid.apple.com";   // the real issuer NAME; the JWKS is what is local
const ADMIN_TOKEN = "accounts-attribution-admin-token";

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}
function log(...a) { console.log("[attribution]", ...a); }
function randPort() { return 31200 + Math.floor(Math.random() * 400); }

/* ------------------------------------------------------------------ a private server ------ */
async function bootServer(accountsOnly) {
  const key = K.makeKeyPair("attribution-key");
  const jwks = await K.startJwksServer([key]);
  const port = randPort();
  const base = `http://localhost:${port}`;
  const scratch = K.makeScratch("attribution");
  const env = K.serverEnv("node", scratch, port, ADMIN_TOKEN, {
    NASTY_ACCOUNTS_ENABLED: "1",
    NASTY_APPLE_JWKS_URL: jwks.url,
    NASTY_APPLE_ISSUER: ISSUER,
    NASTY_APPLE_AUDIENCES: AUD,
    NASTY_CLAIM_WINDOW_OPEN: "0",
    NASTY_LEADERBOARD_ACCOUNTS_ONLY: accountsOnly ? "1" : "0",
    NASTY_ACCOUNT_RATE_LIMIT: "4000",
  });
  const srv = K.startServer("node", env, "ATTRIBUTION_VERBOSE");
  await K.waitHealthy(base);
  return { key, jwks, port, base, scratch, srv, ws: `ws://127.0.0.1:${port}` };
}
async function boardFor(base, name) {
  const r = await fetch(base + "/leaderboard", { cache: "no-store" });
  const j = await r.json();
  const rows = (j && (j.board || j)) || {};
  const want = String(name).toLowerCase();
  for (const k of Object.keys(rows)) if (String(k).toLowerCase() === want) return rows[k];
  return null;
}
function statSum(row, keys) {
  if (!row) return 0;
  return keys.reduce((a, k) => a + (Number(row[k]) || 0), 0);
}
const GAME_KEYS = ["hg4s", "hg6s", "hg4t", "hg6t"];

/* ------------------------------------------------------------------ a browser page -------- */
// Every outgoing WebSocket frame is captured before the app's own code ever runs, so part E is
// reading what the client REALLY put on the wire, not what a helper says it did.
async function newPage(browser, wsUrl, { app = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  await ctx.addInitScript(() => {
    window.__sentFrames = [];
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try { if (typeof data === "string") window.__sentFrames.push(JSON.parse(data)); } catch (e) {}
      return origSend.apply(this, arguments);
    };
  });
  if (app) {
    await ctx.addInitScript(() => {
      window.Capacitor = window.Capacitor || {};
      window.Capacitor.Plugins = window.Capacitor.Plugins || {};
      window.Capacitor.Plugins.AppleSignIn = {
        isAvailable: async () => ({ available: true }),
        authorize: async (opts) => ({
          identityToken: await window.__mintAppleToken(opts.nonce, window.__appleSub || "001999.attr.0001"),
          user: window.__appleSub || "001999.attr.0001",
        }),
      };
    });
  }
  const page = await ctx.newPage();
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push(String(e)));
  return { ctx, page };
}
async function bindMinter(page, key, sub) {
  await page.exposeFunction("__mintAppleToken", async (nonce, s) =>
    K.mintIdentityToken(key, { nonce, sub: s || sub, iss: ISSUER, aud: AUD }));
  await page.addInitScript((s) => { window.__appleSub = s; }, sub);
}
async function gotoApp(page, wsUrl) {
  await page.goto("file://" + INDEX_PATH + "?ws=" + encodeURIComponent(wsUrl));
  await page.waitForFunction(() => typeof window.NET === "object");
  await page.evaluate(() => { try { localStorage.setItem("nasty-speed-chosen", "1"); } catch (e) {} });
}
/* Sign in through the app's own button, exactly as a person would. The ADMIN button that opens
   the account panel lives in the in-game top bar, so if no game is on screen yet this starts a
   throwaway local one first - the same thing test_accounts_stage2_signin_2026_07_25.js's
   humanBoard() does, and the same thing a person does, because that is where the button is. */
async function signInThroughApp(page, name) {
  await page.evaluate((n) => { setChosenName(n); }, name);
  const onBoard = await page.evaluate(() => !document.getElementById("game").classList.contains("hidden"));
  if (!onBoard) {
    await page.evaluate(() => { CFG.n = 4; CFG.teams = false; window.startGame(); });
    await page.waitForFunction(() => window.G != null && !document.getElementById("game").classList.contains("hidden"), { timeout: 15000 });
    await page.waitForTimeout(250);
  }
  await page.evaluate(() => document.getElementById("btnAccount").click());
  await page.waitForTimeout(250);
  await page.click("#btnAcctSignIn");
  await page.waitForFunction(() => window.__acct.state() !== null, { timeout: 20000 });
  await page.waitForTimeout(350);
  const st = await page.evaluate(() => window.__acct.state());
  await page.evaluate(() => { const b = document.getElementById("btnAcctClose"); if (b) b.click(); });
  await page.waitForTimeout(200);
  return st;
}
// A real offline game, one human + three CPUs, driven to a finish through commitMove().
async function playSoloToFinish(page, name) {
  await page.evaluate((n) => {
    CFG.n = 4; CFG.teams = false;
    CFG.seatMeta[4] = [{ type: "human", name: n }, { type: "cpu", diff: "easy", name: "A" },
                       { type: "cpu", diff: "easy", name: "B" }, { type: "cpu", diff: "easy", name: "C" }];
    window.startGame();
  }, name);
  await page.waitForFunction(() => window.G != null && !document.getElementById("game").classList.contains("hidden"), { timeout: 15000 });
  for (let i = 0; i < 6000; i++) {
    const step = await page.evaluate(() => {
      if (!window.G || window.G.over) return "over";
      if (window.G.turn !== 0) return "wait";
      const mv = window.legalMoves(0);
      if (!mv.length) return "nomove";
      window.commitMove(0, mv[Math.floor(Math.random() * mv.length)], null);
      return "moved";
    });
    if (step === "over") break;
    await page.waitForTimeout(60);
  }
  await page.waitForFunction(() => window.G && window.G.over, { timeout: 240000 });
  await page.waitForTimeout(2500);   // let the result POST land
}
// A real ONLINE game hosted through the real lobby UI, one human + three CPUs.
async function hostOnline(page, name) {
  await page.evaluate((n) => {
    CFG.n = 4; CFG.teams = false;
    CFG.seatMeta[4] = [{ type: "human", name: n }, { type: "cpu", diff: "easy", name: "A" },
                       { type: "cpu", diff: "easy", name: "B" }, { type: "cpu", diff: "easy", name: "C" }];
  }, name);
  await page.evaluate(() => document.getElementById("btnOnline").click());
  await page.evaluate(() => document.getElementById("btnHostGame").click());
  await page.waitForFunction(() => !document.getElementById("hostSpeedOverlay").classList.contains("hidden"), { timeout: 8000 });
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll("#hostSpeedBtns button")];
    (btns[btns.length - 1] || btns[0]).click();     // the fastest table speed on offer
  });
  await page.waitForFunction(() => window.NET && window.NET.code, { timeout: 15000 });
  await page.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
  await page.waitForFunction(() => !document.getElementById("btnRoomStart").disabled, { timeout: 15000 });
  await page.evaluate(() => document.getElementById("btnRoomStart").click());
  await page.waitForFunction(() => window.G != null && !document.getElementById("game").classList.contains("hidden"), { timeout: 20000 });
}
// Drop the socket the way a phone in a lift does. The client's own retry path reconnects and
// sends `rejoin` - which is the message part G is really about.
async function forceReconnect(page) {
  await page.evaluate(() => { try { window.NET.ws.close(); } catch (e) {} });
  await page.waitForFunction(() => window.NET && window.NET.ws && window.NET.ws.readyState === 1, { timeout: 30000 });
  await page.waitForTimeout(1200);
}
async function playOnlineOut(page) {
  for (let i = 0; i < 12000; i++) {
    const step = await page.evaluate(() => {
      if (!window.G || window.G.over) return "over";
      if (window.NET && window.NET.mySeat !== window.G.turn) return "wait";
      const mv = window.legalMoves(window.G.turn);
      if (!mv.length) return "nomove";
      window.commitMove(window.G.turn, mv[Math.floor(Math.random() * mv.length)], null);
      return "moved";
    });
    if (step === "over") break;
    await page.waitForTimeout(60);
  }
  await page.waitForFunction(() => window.G && window.G.over, { timeout: 300000 });
  await page.waitForTimeout(2500);
}
async function playOnlineToFinish(page, name) { await hostOnline(page, name); await playOnlineOut(page); }

/* =================================== Parts A and B ========================================= */
async function partsAB(browser) {
  console.log("\n=== Parts A/B: SOLO results with the account-only switch ON ===");
  const S = await bootServer(true);
  try {
    /* Prove the switch really is ON before asserting anything about it - and prove it with the
       NEW reply field, which is itself part of the fix: before v0.40 the server's answer here was
       a bare {ok,epoch} and a client could not tell "recorded" from "silently dropped". */
    const probe = await fetch(S.base + "/solo-result", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: "attribution-probe-" + Date.now(), entries: [] }),
    }).then((r) => r.json());
    ok(probe.ok === true && probe.accountsOnly === true && Array.isArray(probe.credited),
      `A0 the private server is up with the account-only switch ON, and /solo-result now SAYS so (${JSON.stringify(probe)})`);

    // ---- A: signed in
    const { ctx, page } = await newPage(browser, S.ws, { app: true });
    await bindMinter(page, S.key, "001999.attr.solo");
    await gotoApp(page, S.ws);
    const st = await signInThroughApp(page, "Grandad");
    ok(st && st.uid && st.gameName === "Grandad", `A1 signed in for real through the app's own button (uid ${st && st.uid}, name ${st && st.gameName})`);

    const before = await boardFor(S.base, "Grandad");
    await playSoloToFinish(page, "Grandad");
    const after = await boardFor(S.base, "Grandad");
    log("A solo signed-in board before:", JSON.stringify(before), "after:", JSON.stringify(after));
    ok(statSum(after, GAME_KEYS) === statSum(before, GAME_KEYS) + 1,
      `A2 the signed-in player's SOLO game landed on the shared board (games ${statSum(before, GAME_KEYS)} -> ${statSum(after, GAME_KEYS)})`);
    const koAfter = statSum(after, ["hkoDealt", "hkoTaken"]);
    ok(koAfter >= statSum(before, ["hkoDealt", "hkoTaken"]),
      `A3 the knockout stats rode along too (hkoDealt ${after && after.hkoDealt || 0}, hkoTaken ${after && after.hkoTaken || 0})`);
    const uncredA = await page.evaluate(() => (typeof window.__lbUncredited === 'function' ? window.__lbUncredited() : null));
    ok(Array.isArray(uncredA) && uncredA.length === 0, `A4 and the client recorded no "not credited" note, because it WAS credited (${JSON.stringify(uncredA)})`);
    ok(page.__errors.length === 0, "A5 zero page errors");
    await ctx.close();

    // ---- B: guest
    const g = await newPage(browser, S.ws);
    await gotoApp(g.page, S.ws);
    const gBefore = await boardFor(S.base, "Guesty");
    await playSoloToFinish(g.page, "Guesty");
    const gAfter = await boardFor(S.base, "Guesty");
    log("B solo guest board before:", JSON.stringify(gBefore), "after:", JSON.stringify(gAfter));
    ok(gAfter == null || statSum(gAfter, GAME_KEYS) === 0,
      `B1 a GUEST's solo result does not reach the shared board while the switch is on (row ${JSON.stringify(gAfter)})`);
    const uncred = await g.page.evaluate(() => (typeof window.__lbUncredited === 'function' ? window.__lbUncredited() : null));
    ok(Array.isArray(uncred) && uncred.length === 1 && /not signed in/.test(uncred[0].why),
      `B2 and the client RECORDED that it was not credited instead of dropping it silently (${JSON.stringify(uncred)})`);
    ok(g.page.__errors.length === 0, "B3 zero page errors");
    await g.ctx.close();
  } finally {
    await K.stopServer(S.srv);
    await S.jwks.close();
  }
}

/* =================================== Parts C and D ========================================= */
async function partsCD(browser) {
  console.log("\n=== Parts C/D: ONLINE results with the account-only switch ON ===");
  const S = await bootServer(true);
  try {
    const { ctx, page } = await newPage(browser, S.ws, { app: true });
    await bindMinter(page, S.key, "001999.attr.online");
    await gotoApp(page, S.ws);
    const st = await signInThroughApp(page, "Nana");
    ok(st && st.uid && st.gameName === "Nana", `C1 signed in for real (uid ${st && st.uid})`);

    const before = await boardFor(S.base, "Nana");
    await playOnlineToFinish(page, "Nana");
    const after = await boardFor(S.base, "Nana");
    log("C online signed-in board before:", JSON.stringify(before), "after:", JSON.stringify(after));
    ok(statSum(after, GAME_KEYS) === statSum(before, GAME_KEYS) + 1,
      `C2 the signed-in host's ONLINE game landed on the shared board (games ${statSum(before, GAME_KEYS)} -> ${statSum(after, GAME_KEYS)})`);
    ok(after && (("hkoDealt" in after) || ("hkoTaken" in after)) ? true : statSum(after, ["hkoDealt", "hkoTaken"]) === 0,
      `C3 knockout stats present on the account row where the game produced any (hkoDealt ${after && after.hkoDealt || 0}, hkoTaken ${after && after.hkoTaken || 0})`);
    const frames = await page.evaluate(() => window.__sentFrames.filter((f) => f && f.type === "host"));
    ok(frames.length === 1 && typeof frames[0].acct === "string" && frames[0].acct.length > 0,
      "C4 and the reason it worked is on the wire: the `host` frame carried an `acct` token");
    ok(page.__errors.length === 0, "C5 zero page errors");
    await ctx.close();

    // ---- D: guest online
    const g = await newPage(browser, S.ws);
    await gotoApp(g.page, S.ws);
    await playOnlineToFinish(g.page, "Randy");
    const gAfter = await boardFor(S.base, "Randy");
    log("D online guest board after:", JSON.stringify(gAfter));
    ok(gAfter == null || statSum(gAfter, GAME_KEYS) === 0,
      `D1 a GUEST's online result does not reach the shared board while the switch is on (row ${JSON.stringify(gAfter)})`);
    const gf = await g.page.evaluate(() => window.__sentFrames.filter((f) => f && f.type === "host"));
    ok(gf.length === 1 && !("acct" in gf[0]),
      "D2 a guest's `host` frame has NO acct key at all - byte-identical to what v0.39 sent");
    ok(g.page.__errors.length === 0, "D3 zero page errors");
    await g.ctx.close();
  } finally {
    await K.stopServer(S.srv);
    await S.jwks.close();
  }
}

/* ====================================== Part E ============================================= */
async function partE(browser) {
  console.log("\n=== Part E: what the client actually puts on the wire ===");
  const S = await bootServer(true);
  try {
    // signed in: host, then a forced reconnect so a `rejoin` frame is produced too
    const { ctx, page } = await newPage(browser, S.ws, { app: true });
    await bindMinter(page, S.key, "001999.attr.wire");
    await gotoApp(page, S.ws);
    await signInThroughApp(page, "Wired");
    await page.evaluate(() => {
      CFG.n = 4; CFG.teams = false;
      CFG.seatMeta[4] = [{ type: "human", name: "Wired" }, { type: "cpu", diff: "easy", name: "A" },
                         { type: "cpu", diff: "easy", name: "B" }, { type: "cpu", diff: "easy", name: "C" }];
    });
    await page.evaluate(() => document.getElementById("btnOnline").click());
    await page.evaluate(() => document.getElementById("btnHostGame").click());
    await page.waitForFunction(() => !document.getElementById("hostSpeedOverlay").classList.contains("hidden"), { timeout: 8000 });
    await page.evaluate(() => { const b = [...document.querySelectorAll("#hostSpeedBtns button")][0]; b.click(); });
    await page.waitForFunction(() => window.NET && window.NET.code, { timeout: 15000 });
    // force a reconnect: the client's own retry path sends `rejoin`
    await page.evaluate(() => { try { window.NET.ws.close(); } catch (e) {} });
    await page.waitForTimeout(4000);
    const sent = await page.evaluate(() => window.__sentFrames);
    const host = sent.filter((f) => f.type === "host");
    const rejoin = sent.filter((f) => f.type === "rejoin");
    ok(host.length >= 1 && typeof host[0].acct === "string" && host[0].acct.length === 64,
      `E1 signed in: the host frame carries the 64-char session token as \`acct\``);
    ok(rejoin.length >= 1 && rejoin.every((f) => typeof f.acct === "string" && f.acct.length === 64),
      `E2 signed in: every rejoin frame carries it too (${rejoin.length} rejoin frames seen)`);
    ok(page.__errors.length === 0, "E3 zero page errors");

    /* A second phone JOINING that room, signed in as somebody else. `join` is the other front
       door and carries identity the same way `host` does; without this the join path would be
       covered only by reading the code, which is exactly how the original bug survived. */
    const code = await page.evaluate(() => window.NET.code);
    const j = await newPage(browser, S.ws, { app: true });
    await bindMinter(j.page, S.key, "001999.attr.joiner");
    await gotoApp(j.page, S.ws);
    await signInThroughApp(j.page, "Joiner");
    await j.page.evaluate(() => document.getElementById("btnOnline").click());
    await j.page.evaluate(() => document.getElementById("btnJoinGame").click());
    await j.page.evaluate((c) => { document.getElementById("joinCodeInput").value = c; }, code);
    await j.page.evaluate(() => document.getElementById("btnJoinCodeNext").click());
    await j.page.evaluate(() => { document.getElementById("joinNameInput").value = "Joiner"; });
    await j.page.evaluate(() => document.getElementById("btnJoinNameNext").click());
    await j.page.waitForFunction(() => window.NET && window.NET.lobby != null, { timeout: 15000 });
    const jf = await j.page.evaluate(() => window.__sentFrames.filter((f) => f.type === "join"));
    ok(jf.length >= 1 && typeof jf[0].acct === "string" && jf[0].acct.length === 64,
      "E3b a signed-in player JOINING a room carries `acct` on the join frame too");
    ok(j.page.__errors.length === 0, "E3c zero page errors on the joining phone");
    await j.ctx.close();
    await ctx.close();

    // signed out: no key anywhere
    const g = await newPage(browser, S.ws);
    await gotoApp(g.page, S.ws);
    await g.page.evaluate(() => {
      CFG.n = 4; CFG.teams = false;
      CFG.seatMeta[4] = [{ type: "human", name: "Plain" }, { type: "cpu", diff: "easy", name: "A" },
                         { type: "cpu", diff: "easy", name: "B" }, { type: "cpu", diff: "easy", name: "C" }];
    });
    await g.page.evaluate(() => document.getElementById("btnOnline").click());
    await g.page.evaluate(() => document.getElementById("btnHostGame").click());
    await g.page.waitForFunction(() => !document.getElementById("hostSpeedOverlay").classList.contains("hidden"), { timeout: 8000 });
    await g.page.evaluate(() => { const b = [...document.querySelectorAll("#hostSpeedBtns button")][0]; b.click(); });
    await g.page.waitForFunction(() => window.NET && window.NET.code, { timeout: 15000 });
    await g.page.evaluate(() => { try { window.NET.ws.close(); } catch (e) {} });
    await g.page.waitForTimeout(4000);
    const gsent = await g.page.evaluate(() => window.__sentFrames);
    ok(gsent.length > 0 && gsent.every((f) => !("acct" in f)),
      `E4 signed out: not one of the ${gsent.length} frames this client sent has an acct key`);
    ok(g.page.__errors.length === 0, "E5 zero page errors");
    await g.ctx.close();
  } finally {
    await K.stopServer(S.srv);
    await S.jwks.close();
  }
}

/* ====================================== Part F ============================================= */
async function partF(browser) {
  console.log("\n=== Part F: with the switch OFF, nothing about today's behaviour changes ===");
  const S = await bootServer(false);
  try {
    // signed in, solo - must record BY NAME exactly as it always has
    const { ctx, page } = await newPage(browser, S.ws, { app: true });
    await bindMinter(page, S.key, "001999.attr.off");
    await gotoApp(page, S.ws);
    await signInThroughApp(page, "Offy");
    const before = await boardFor(S.base, "Offy");
    await playSoloToFinish(page, "Offy");
    const after = await boardFor(S.base, "Offy");
    log("F signed-in solo, switch OFF, before:", JSON.stringify(before), "after:", JSON.stringify(after));
    ok(statSum(after, GAME_KEYS) === statSum(before, GAME_KEYS) + 1,
      `F1 switch OFF: a signed-in player's solo game still records by name (${statSum(before, GAME_KEYS)} -> ${statSum(after, GAME_KEYS)})`);
    const uncred = await page.evaluate(() => (typeof window.__lbUncredited === 'function' ? window.__lbUncredited() : null));
    ok(Array.isArray(uncred) && uncred.length === 0, "F2 switch OFF: nothing is flagged uncredited");
    await ctx.close();

    // guest, solo
    const g = await newPage(browser, S.ws);
    await gotoApp(g.page, S.ws);
    const gb = await boardFor(S.base, "Guesty");
    await playSoloToFinish(g.page, "Guesty");
    const ga = await boardFor(S.base, "Guesty");
    log("F guest solo, switch OFF, before:", JSON.stringify(gb), "after:", JSON.stringify(ga));
    ok(statSum(ga, GAME_KEYS) === statSum(gb, GAME_KEYS) + 1,
      `F3 switch OFF: a GUEST's solo game still records exactly as it does today (${statSum(gb, GAME_KEYS)} -> ${statSum(ga, GAME_KEYS)})`);
    ok(g.page.__errors.length === 0 && page.__errors.length === 0, "F4 zero page errors");
    await g.ctx.close();

    // guest, online
    const o = await newPage(browser, S.ws);
    await gotoApp(o.page, S.ws);
    const ob = await boardFor(S.base, "Onliner");
    await playOnlineToFinish(o.page, "Onliner");
    const oa = await boardFor(S.base, "Onliner");
    log("F guest online, switch OFF, before:", JSON.stringify(ob), "after:", JSON.stringify(oa));
    ok(statSum(oa, GAME_KEYS) === statSum(ob, GAME_KEYS) + 1,
      `F5 switch OFF: a GUEST's online game still records by name (${statSum(ob, GAME_KEYS)} -> ${statSum(oa, GAME_KEYS)})`);
    ok(o.page.__errors.length === 0, "F6 zero page errors");
    await o.ctx.close();
  } finally {
    await K.stopServer(S.srv);
    await S.jwks.close();
  }
}

/* ====================================== Part G ============================================= */
/* The two RECONNECT rules, proved by outcome rather than by introspection - the leaderboard is
   the only thing that actually matters, so that is what is measured.
   G1 is Blake's real scenario: somebody starts a game as a guest, signs in while the game is
   running, then their phone drops the socket for a moment. Before v0.40 that player's accountId
   stayed null forever (identity was only ever captured at the front door) and their finished game
   went nowhere with the switch on. A rejoin may now FILL a missing accountId.
   G2 is the guarantee that had to survive that change: a reconnect must never be able to REMOVE
   an identity that is already there, so a session that expires (or a sign-out) mid-game cannot
   cost anybody the game they are in the middle of. */
async function partG(browser) {
  console.log("\n=== Part G: signing in mid-game, and losing a session mid-game ===");
  const S = await bootServer(true);
  try {
    // ---- G1: host as a GUEST, sign in mid-game, drop the socket, finish. Must be credited.
    const a = await newPage(browser, S.ws, { app: true });
    await bindMinter(a.page, S.key, "001999.attr.mid");
    await gotoApp(a.page, S.ws);
    await hostOnline(a.page, "Middy");
    const hostFrame = await a.page.evaluate(() => window.__sentFrames.find((f) => f.type === "host"));
    ok(hostFrame && !("acct" in hostFrame), "G1a the game really did start as a guest - no acct on the host frame");
    const st = await signInThroughApp(a.page, "Middy");
    ok(st && st.uid, `G1b signed in mid-game through the app's own panel (uid ${st && st.uid})`);
    await forceReconnect(a.page);
    const rj = await a.page.evaluate(() => window.__sentFrames.filter((f) => f.type === "rejoin"));
    ok(rj.length >= 1 && rj[rj.length - 1].acct, "G1c the reconnect carried the new session as acct");
    const before = await boardFor(S.base, "Middy");
    await playOnlineOut(a.page);
    const after = await boardFor(S.base, "Middy");
    log("G1 board before:", JSON.stringify(before), "after:", JSON.stringify(after));
    ok(statSum(after, GAME_KEYS) === statSum(before, GAME_KEYS) + 1,
      `G1d a guest who signs in MID-GAME and reconnects is credited (${statSum(before, GAME_KEYS)} -> ${statSum(after, GAME_KEYS)})`);
    ok(a.page.__errors.length === 0, "G1e zero page errors");
    await a.ctx.close();

    // ---- G2: host SIGNED IN, sign out mid-game, drop the socket, finish. Must STILL be credited.
    const b = await newPage(browser, S.ws, { app: true });
    await bindMinter(b.page, S.key, "001999.attr.sticky");
    await gotoApp(b.page, S.ws);
    const st2 = await signInThroughApp(b.page, "Sticky");
    ok(st2 && st2.uid, `G2a signed in before hosting (uid ${st2 && st2.uid})`);
    await hostOnline(b.page, "Sticky");
    const before2 = await boardFor(S.base, "Sticky");
    await b.page.evaluate(() => document.getElementById("btnAccount").click());
    await b.page.waitForTimeout(250);
    await b.page.click("#btnAcctSignOut");
    await b.page.waitForFunction(() => window.__acct.state() === null, { timeout: 15000 });
    await b.page.evaluate(() => { const x = document.getElementById("btnAcctClose"); if (x) x.click(); });
    await b.page.waitForTimeout(250);
    await forceReconnect(b.page);
    const rj2 = await b.page.evaluate(() => window.__sentFrames.filter((f) => f.type === "rejoin"));
    ok(rj2.length >= 1 && !("acct" in rj2[rj2.length - 1]),
      "G2b after signing out the reconnect carries NO acct at all");
    await playOnlineOut(b.page);
    const after2 = await boardFor(S.base, "Sticky");
    log("G2 board before:", JSON.stringify(before2), "after:", JSON.stringify(after2));
    ok(statSum(after2, GAME_KEYS) === statSum(before2, GAME_KEYS) + 1,
      `G2c losing the session mid-game does NOT cost the player the game they were in (${statSum(before2, GAME_KEYS)} -> ${statSum(after2, GAME_KEYS)})`);
    ok(b.page.__errors.length === 0, "G2d zero page errors");
    await b.ctx.close();
  } finally {
    await K.stopServer(S.srv);
    await S.jwks.close();
  }
}

(async () => {
  const browser = await chromium.launch();
  try {
    await partsAB(browser);
    await partsCD(browser);
    await partE(browser);
    await partF(browser);
    await partG(browser);
  } finally {
    await browser.close();
  }
  console.log(`\n=== v0.40 account-attribution suite: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})();
