"use strict";
/*
 * 2026-07-31 v0.68 (task 5) - the blocked-invite deep link, proven END TO END in a real
 * browser. Blake: "what happens if somebody without an account or an expired online access
 * account (needs to purchase token) receives an online invite and clicks the link? Make sure
 * it doesn't let them and tells them why!"
 *
 * The SERVER half was already proven (test_online_access.js 3.12/3.14: guest join refused
 * signInRequired, unentitled join refused onlineAccessRequired). What was never proven is the
 * lived experience: arriving at the app via a shared ?join=CODE link and hitting those
 * refusals through the real client code. This suite drives exactly that, Playwright against
 * the real index.html and a real private Node server, and screenshots each blocked state.
 *
 * Scenarios (both in the iPhone-app context - the Capacitor stub - because online play IS
 * app-only today; the plain website shows the coming-soon gate, asserted here too):
 *   A. a signed-out GUEST opens ?join=CODE        -> the sign-in gate (#welcomeOverlay), menu
 *                                                    intact behind it, guest escape works
 *   B. a signed-in account whose free month LAPSED opens ?join=CODE
 *                                                 -> the server refusal, rendered by
 *                                                    handleOnlineAccessRejection(): clean
 *                                                    return to the menu + the blocked overlay
 *                                                    with the plain "credits" message and a
 *                                                    working "See Online Access" next step
 *   C. the plain WEBSITE (no app, no preview) with ?join=CODE -> the coming-soon gate, not a
 *                                                    broken half-booted game
 *
 * Screenshots land in the session scratchpad (SHOTDIR below).
 *
 * Usage: node test_join_link_blocked.js        (node server only - the entitlement logic is
 *                                               twin-tested in test_online_access.js /
 *                                               test_free_month_tombstone.js; this suite is
 *                                               about the CLIENT)
 */
const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
const path = require("path");
const fs = require("fs");
const K = require("./test_accounts_kit.js");
const WebSocket = require("/Users/jarvis/nasty-game/server/node_modules/ws");

const INDEX = path.resolve(__dirname, "..", "..", "index.html");
const SHOTDIR = process.env.NASTY_SHOTDIR ||
  "/private/tmp/claude-501/-Users-jarvis/11c53fac-7b65-4eaa-bc83-8b62a8b426e0/scratchpad/v068-shots";
fs.mkdirSync(SHOTDIR, { recursive: true });

const ADMIN_TOKEN = "join-link-admin-token";
const AUD = "com.pangman.nasty";
const ISSUER = "https://joinlink.test.local";

let PASS = 0, FAIL = 0;
function log(...a) { console.log("[join-link]", ...a); }
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
function randPort() { return 33500 + Math.floor(Math.random() * 300); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The iPhone-app boot shows #bootCover (the NASTY sign slam) over everything for up to ~4s -
// purely cosmetic, but a screenshot taken under it shows only felt. Wait it out first.
async function waitBootCoverGone(page) {
  await page.waitForFunction(() => {
    const b = document.getElementById("bootCover");
    return !b || b.classList.contains("hidden");
  }, null, { timeout: 10000 });
  await sleep(200);
}

function midMonthMs(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return Date.UTC(y, m - 1, 15, 18, 0, 0);
}

// The iPhone-app stand-in: enough Capacitor for IS_APP to read true and for the Apple sign-in
// plugin to look available - the same stub test_equip_reset_signout.js established. `token`
// (optional) pre-signs the device in, exactly like a returning player's phone.
function stubInit(cfg) {
  try {
    if (cfg.token) localStorage.setItem("nasty-account", cfg.token);
    localStorage.setItem("nasty-speed-chosen", "1");   // the one-time speed picker is not what this suite tests
  } catch (e) {}
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      AppleSignIn: { isAvailable: async () => ({ available: true }) },
      StatusBar: { setBackgroundColor: async () => {} },
    },
  };
}

async function main() {
  const key = K.makeKeyPair("join-link-key");
  const jwks = await K.startJwksServer([key]);
  const scratch = K.makeScratch("join-link");
  const port = randPort();
  const base = `http://localhost:${port}`;
  // Clock pinned to September: a freshly created account (real created = July) is already past
  // its free window, so "signed in but lapsed" needs no waiting - test_online_access.js's own
  // Group 3 technique.
  const env = K.serverEnv("node", scratch, port, ADMIN_TOKEN, {
    NASTY_ACCOUNTS_ENABLED: "1",
    NASTY_APPLE_JWKS_URL: jwks.url, NASTY_APPLE_ISSUER: ISSUER, NASTY_APPLE_AUDIENCES: AUD,
    NASTY_ACCOUNT_RATE_LIMIT: "8000",
    NASTY_MONTHLY_NOW_MS: String(midMonthMs("2026-09")),
  });
  const srv = K.startServer("node", env, "JOIN_LINK_VERBOSE");
  await K.waitHealthy(base);
  const c = K.makeClient(base);

  // The lapsed guest-of-honor: signed in, named, NOT entitled under the pinned September clock.
  const lapsed = await c.signIn(key, { sub: "001333.lapsed", iss: ISSUER, aud: AUD });
  if (lapsed.status !== 200) throw new Error("lapsed sign-in failed: " + JSON.stringify(lapsed.body));
  await c.post("/account/name", { auth: lapsed.body.sessionToken, name: "Lapsed" });
  const lapsedStatus = await c.post("/account/online-status", { auth: lapsed.body.sessionToken });
  check(lapsedStatus.body.entitled === false, "0.1 setup: the invited player's free month has genuinely lapsed");

  // An ENTITLED host with a real open lobby, so the invite code is genuine.
  await fetch(base + "/solo-result", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ gameId: "join-link-seed", entries: [{ name: "Hosty", delta: { hg4s: 1, hw4s: 1, hptsS: 100 } }] }),
  });
  const host = await c.signIn(key, { sub: "001333.host", iss: ISSUER, aud: AUD });
  await c.post("/account/name", { auth: host.body.sessionToken, name: "Hosty" });
  const buy = await c.post("/account/purchase", { auth: host.body.sessionToken, itemId: "online_month" });
  check(buy.status === 200, "0.2 setup: the host bought this month's Online Access");
  const hostWs = new WebSocket(`ws://localhost:${port}`);
  const roomCode = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("host never created a room")), 10000);
    hostWs.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "ping") { hostWs.send(JSON.stringify({ type: "pong", t: msg.t })); return; }
      if (msg.type === "created") { clearTimeout(t); resolve(msg.code); }
    });
    hostWs.on("open", () => hostWs.send(JSON.stringify({
      type: "host", protocolVersion: 5, name: "Hosty", n: 4, teams: false,
      seats: [
        { name: "Hosty", type: "human", diff: "medium" },
        { name: "Open", type: "human", diff: "medium" },
        { name: "CPU2", type: "cpu", diff: "easy" },
        { name: "CPU3", type: "cpu", diff: "easy" },
      ],
      acct: host.body.sessionToken,
    })));
  });
  check(/^[A-Z]{4}$/.test(roomCode), "0.3 setup: a real open lobby exists, code " + roomCode);

  const browser = await chromium.launch();
  const joinUrl = `file://${INDEX}?ws=ws://localhost:${port}&join=${roomCode}`;

  try {
    /* ============ SCENARIO A: signed-out guest taps the invite (app context) ============ */
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
      await ctx.addInitScript(stubInit, {});
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(joinUrl);
      await page.waitForFunction(() => {
        const w = document.getElementById("welcomeOverlay");
        return w && !w.classList.contains("hidden");
      }, null, { timeout: 15000 });
      const a = await page.evaluate(() => ({
        menuVisible: !document.getElementById("menu").classList.contains("hidden"),
        title: document.getElementById("welcomeTitle").textContent,
        note: document.getElementById("welcomeNote").textContent,
        appleBtnShown: !document.getElementById("btnWelcomeApple").classList.contains("hidden"),
        guestBtnShown: !document.getElementById("btnWelcomeGuest").classList.contains("hidden"),
        blockedShown: !document.getElementById("onlineAccessBlockedOverlay").classList.contains("hidden"),
      }));
      await waitBootCoverGone(page);
      await page.screenshot({ path: path.join(SHOTDIR, "A_guest_invite_signin_gate.png") });
      check(a.menuVisible, "A1 the guest lands on the real menu (not a dead end) with the sign-in gate on top");
      check(/sign in/i.test(a.title), "A2 the gate says what is needed: " + JSON.stringify(a.title));
      check(/account/i.test(a.note), "A3 and why: " + JSON.stringify(a.note));
      check(a.appleBtnShown, "A4 the ONE real next step - Sign in with Apple - is right there");
      check(a.guestBtnShown, "A5 and so is the no-pressure way out (Continue as a guest)");
      check(!a.blockedShown, "A6 the paid-access overlay is NOT shown to a guest (sign-in comes first, not a paywall)");
      // The escape hatch really escapes: guest lands on a clean, working menu.
      await page.click("#btnWelcomeGuest");
      await sleep(400);
      const a2 = await page.evaluate(() => ({
        welcomeShown: !document.getElementById("welcomeOverlay").classList.contains("hidden"),
        menuVisible: !document.getElementById("menu").classList.contains("hidden"),
        anyOverlayOpen: Array.from(document.querySelectorAll(".overlay")).some((o) => !o.classList.contains("hidden")),
      }));
      check(!a2.welcomeShown && a2.menuVisible && !a2.anyOverlayOpen, "A7 'Continue as a guest' lands cleanly back on the menu, nothing stuck: " + JSON.stringify(a2));
      check(errors.length === 0, "A8 zero page errors through the whole guest flow: " + JSON.stringify(errors));
      await ctx.close();
    }

    /* ============ SCENARIO B: signed-in but LAPSED taps the invite (app context) ============ */
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
      await ctx.addInitScript(stubInit, { token: lapsed.body.sessionToken });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(joinUrl);
      // The server's refusal must surface as the blocked overlay - the deep-link edge case
      // handleOnlineAccessRejection() exists for.
      await page.waitForFunction(() => {
        const o = document.getElementById("onlineAccessBlockedOverlay");
        return o && !o.classList.contains("hidden");
      }, null, { timeout: 20000 });
      const b = await page.evaluate(() => ({
        menuVisible: !document.getElementById("menu").classList.contains("hidden"),
        gameHidden: document.getElementById("game").classList.contains("hidden"),
        joinOverlayShown: !document.getElementById("joinOverlay").classList.contains("hidden"),
        welcomeShown: !document.getElementById("welcomeOverlay").classList.contains("hidden"),
        text: document.getElementById("onlineBlockedText").textContent,
        goBtn: document.getElementById("btnOnlineBlockedGo").textContent,
      }));
      await waitBootCoverGone(page);
      await page.screenshot({ path: path.join(SHOTDIR, "B_lapsed_invite_blocked.png") });
      check(b.menuVisible && b.gameHidden, "B1 the lapsed player is back on the menu, no half-joined game: " + JSON.stringify({ menu: b.menuVisible, gameHidden: b.gameHidden }));
      check(!b.joinOverlayShown && !b.welcomeShown, "B2 no leftover join/sign-in overlays underneath");
      check(/free online period has ended/i.test(b.text), "B3 the explanation is the server's own plain sentence: " + JSON.stringify(b.text));
      check(/50 credits/.test(b.text), "B4 it says CREDITS (the v0.59 currency), not points - the task-3 fix, read through the real UI");
      check(/online access/i.test(b.goBtn), "B5 the next step is a real button: " + JSON.stringify(b.goBtn));
      // The next step genuinely works: See Online Access opens the Admin panel's own section.
      await page.click("#btnOnlineBlockedGo");
      await page.waitForFunction(() => {
        const o = document.getElementById("accountOverlay");
        return o && !o.classList.contains("hidden");
      }, null, { timeout: 10000 });
      await sleep(700);   // let refreshAcctOnline() paint the real server-driven state
      const b2 = await page.evaluate(() => ({
        onlineBody: document.getElementById("acctOnlineBody").textContent,
        blockedStillShown: !document.getElementById("onlineAccessBlockedOverlay").classList.contains("hidden"),
      }));
      await page.screenshot({ path: path.join(SHOTDIR, "B_lapsed_next_step_admin_panel.png") });
      check(!b2.blockedStillShown, "B6 the blocked overlay closed when the next step was taken");
      check(b2.onlineBody.length > 0, "B7 and the Online Access section is really there to act on: " + JSON.stringify(b2.onlineBody.slice(0, 120)));
      check(errors.length === 0, "B8 zero page errors through the whole lapsed flow: " + JSON.stringify(errors));
      await ctx.close();
    }

    /* ============ SCENARIO C: the plain website (no app) with the same link ============ */
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(joinUrl);
      await sleep(1200);
      const cState = await page.evaluate(() => ({
        comingSoon: (() => { const el = document.getElementById("comingSoon"); return !!el && !el.classList.contains("hidden"); })(),
        menuShown: (() => { const el = document.getElementById("menu"); return !!el && !el.classList.contains("hidden"); })(),
        bodyText: document.body.textContent.slice(0, 400),
      }));
      await page.screenshot({ path: path.join(SHOTDIR, "C_website_invite_coming_soon.png") });
      check(cState.comingSoon && !cState.menuShown,
        "C1 the pre-launch WEBSITE shows the coming-soon page for an invite link (online is app-only today), never a broken half-booted game: " + JSON.stringify({ comingSoon: cState.comingSoon, menuShown: cState.menuShown }));
      check(errors.length === 0, "C2 zero page errors on the website path: " + JSON.stringify(errors));
      await ctx.close();
    }
  } finally {
    try { hostWs.close(); } catch (e) {}
    await browser.close();
    await K.stopServer(srv);
  }

  log("screenshots: " + SHOTDIR);
  log(`${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => {
  FAIL++;
  log("FAIL", "unexpected exception: " + (e && e.stack || e));
  log(`${PASS} passed, ${FAIL} failed`);
  process.exit(1);
});
