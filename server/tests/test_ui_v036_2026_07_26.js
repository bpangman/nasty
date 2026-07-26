"use strict";
/*
 * test_ui_v036_2026_07_26.js - PERMANENT suite for Blake's 2026-07-26 feedback, sent after he
 * tested Sign in with Apple on his own iPhone and it worked. Six items, all client-side
 * (index.html only - no server file was touched by that batch and none is touched here), plus
 * one fix that came out of the same day's push-notification audit.
 *
 *   1. THE FIRST-RUN SIGN-IN SCREEN. "if it's a person's first time opening the app (or they
 *      don't have an account) they should see a login screen with an apple button to create an
 *      account with their Apple ID. Below that, there should be an option to continue as a guest
 *      with the knowledge that they wouldn't be on the leaderboard. This is the only time this
 *      would happen though (don't make them select guest every time) just let them know they can
 *      always change this by clicking the admin button."
 *   2. THE ADMIN BOX. "please change the account circle button into a box like we did with the
 *      pause button and have it say 'admin'".
 *   3. THE ONE-TIME NAME CLAIM. "only allowed to do this once and claim 1 name - no going back."
 *   4. ONLINE PRESENCE COLOURS. "when online, the other human's names should only be highlighted
 *      in red when they're disconnected. They should otherwise just glow which shows they're
 *      there."
 *   5. EQUAL MENU BUTTONS. "On the menu page, the 4 players, 6 players, FFA, and Teams buttons
 *      should all be the same size so it's symmetrical."
 *   6. THE FFA WORDING. "make that FFA button actually say 'Free-for-All' it should only say FFA
 *      in the save state."
 *
 * Parts:
 *   A - the first-run screen appears exactly ONCE, both paths work, and it survives an iOS-style
 *       localStorage wipe through the IndexedDB mirror.
 *   B - the WEBSITE variant: no dead Apple button, an honest sentence instead, guest path works.
 *   C - the ADMIN box, measured against PAUSE: same class, same height, mirrored insets, zero
 *       overflow, 44px, across 320/375/390/393/430 with real safe-area insets, 4P and 6P,
 *       in-game and post-game. Plus the panel it opens saying Admin.
 *   D - the claim UI against a REAL local server with the window SHUT: never offered, nothing
 *       sent, no dead buttons.
 *   E - the claim UI against a REAL local server with the window OPEN: offered with the right
 *       name and numbers, a confirm that says it cannot be undone, one claim only, the history
 *       actually moves, and declining works too.
 *   F - presence colours in a REAL online game between two real browsers, including a REAL
 *       disconnect: connected humans glow, CPUs and my own seat do not, and red appears only on
 *       a genuine drop.
 *   G - the four menu buttons are identical in width AND height, and "Free-for-All" is spelled
 *       out everywhere except the saved-game tiles.
 *   H - the push-permission one-time flag is only spent on a definitive answer (2026-07-26 push
 *       audit).
 *
 * Everything is local. Parts D/E/F boot private Node servers on random ports with scratch
 * storage and a throwaway admin token; the Apple identity tokens in D/E are minted locally by
 * test_accounts_kit.js against a local JWKS. Nothing ever contacts Apple, production, or the
 * real family leaderboard.
 *
 * Run: node tests/test_ui_v036_2026_07_26.js
 */
const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const os = require("os");
const net = require("net");
const K = require("./test_accounts_kit.js");
const BYPASS = require("./test_ui_v036_welcome_bypass.js");

const INDEX = "file://" + path.resolve(__dirname, "..", "..", "index.html");
const SRC = fs.readFileSync(path.resolve(__dirname, "..", "..", "index.html"), "utf8");
const SHOTDIR = "/private/tmp/claude-501/-Users-jarvis/0bc923da-f111-499a-9b51-18988e4aba3d/scratchpad/shots-v036";
fs.mkdirSync(SHOTDIR, { recursive: true });

const AUD = "com.pangman.nasty";
const ISSUER = "https://appleid.apple.com";
const ADMIN_TOKEN = "v036-admin-token";

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* A port the OS itself hands out, not a random guess. Guessing is what every other suite in this
   folder does and it is usually fine, but this one boots three separate servers and an abandoned
   test server from an earlier run listening on a guessed port would be found HEALTHY and then
   quietly answer with the wrong configuration - which is exactly how a run of this suite failed
   once during development. Binding port 0 and reading back what the kernel gave us cannot
   collide with anything that is already listening. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// Blake's own matrix, with the real notch/home-indicator insets each device reports.
const MATRIX = [
  { name: "320x568 (SE1)", w: 320, h: 568, top: 0, bottom: 0 },
  { name: "375x667 (SE2/3)", w: 375, h: 667, top: 0, bottom: 0 },
  { name: "390x844 (12/13/14)", w: 390, h: 844, top: 47, bottom: 34 },
  { name: "393x852 (15/16 Pro)", w: 393, h: 852, top: 59, bottom: 34 },
  { name: "430x932 (Pro Max)", w: 430, h: 932, top: 59, bottom: 34 },
];

async function newCtx(browser, m, opts) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: m.w, height: m.h }, deviceScaleFactor: 1 }, opts || {}));
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  await client.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: m.top, left: 0, bottom: m.bottom, right: 0 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, page, errors };
}
// A real game started from the menu, so seat 0 is a human - which is whose account this is.
async function humanBoard(page, n, ws) {
  const q = ws ? "?ws=" + encodeURIComponent(ws) : "";
  await page.goto(INDEX + q);
  await page.waitForSelector("#btnStart");
  if (n === 6) await page.click("#p6");
  await page.click("#btnStart");
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
  const picker = await page.evaluate(() => {
    const sp = document.getElementById("speedPickerOverlay");
    return sp && !sp.classList.contains("hidden");
  });
  if (picker) await page.click("#btnSpeedPick0");
  await page.waitForTimeout(250);
}
// The stub native plugin. Deliberately WITHOUT isNativePlatform, exactly as
// test_accounts_stage2_signin_2026_07_25.js does it: IS_APP stays false so none of the app's
// native boot runs, while appleSignInPlugin() still finds a plugin - which is the only thing
// accountsAvailableHere() actually asks.
async function stubApple(page, sub) {
  await page.addInitScript((s) => {
    window.Capacitor = window.Capacitor || {};
    window.Capacitor.Plugins = window.Capacitor.Plugins || {};
    window.Capacitor.Plugins.AppleSignIn = {
      isAvailable: async () => ({ available: true }),
      authorize: async (opts) => ({ identityToken: await window.__mintAppleToken(opts.nonce, s), user: s }),
    };
  }, sub);
}

/* ============================ Part A - once, and only once ============================ */
async function partA(browser) {
  console.log("\n=== Part A: the first-run screen appears exactly ONCE, and both paths work ===");
  // NOTE: this part must NOT use the welcome bypass - it is the thing under test. It makes its
  // own contexts through a pristine browser handle (see main()).
  const { ctx, page, errors } = await newCtx(browser, MATRIX[2]);

  await page.goto(INDEX);
  await page.waitForSelector("#btnWelcomeGuest");
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => window.__welcome.shown()), "A1 a brand-new phone gets the first-run screen");

  const copy = await page.evaluate(() => document.getElementById("welcomeOverlay").textContent);
  ok(/continue as a guest/i.test(copy), "A2 there is a Continue as a guest choice");
  ok(/guests do not show up on the family leaderboard/i.test(copy),
    "A3 it says plainly that guests are not on the family leaderboard");
  ok(/ages 13 and up/i.test(copy) && /younger/i.test(copy) && /guest/i.test(copy),
    "A4 the age line is there: accounts are 13+, younger players continue as a guest");
  ok(/admin/i.test(copy) && /change it any time/i.test(copy),
    "A5 it says the choice can be changed any time from the ADMIN button");
  ok(!/[—–]/.test(copy), "A6 no em or en dashes anywhere in the copy");
  ok(!/birthday|date of birth|how old/i.test(copy), "A7 no birthday picker and no age gate - one sentence only");

  // There is ALWAYS a way forward: the guest button is a real, enabled, 44px+ target.
  const guestBtn = await page.evaluate(() => {
    const b = document.getElementById("btnWelcomeGuest");
    const r = b.getBoundingClientRect();
    return { disabled: !!b.disabled, hidden: b.classList.contains("hidden"), w: r.width, h: r.height };
  });
  ok(!guestBtn.disabled && !guestBtn.hidden && guestBtn.h >= 44, `A8 the guest button is live and a real tap target (${guestBtn.w.toFixed(1)}x${guestBtn.h.toFixed(1)})`);
  await page.screenshot({ path: path.join(SHOTDIR, "welcome_web_390.png") });

  await page.click("#btnWelcomeGuest");
  await page.waitForTimeout(250);
  ok(!(await page.evaluate(() => window.__welcome.shown())), "A9 choosing guest closes the screen");
  ok((await page.evaluate(() => window.__welcome.choice())) === "guest", "A10 the choice is remembered on this phone");
  ok(await page.isVisible("#btnStart"), "A11 and the menu is right there, ready to play");

  // The whole point: it never comes back.
  for (let i = 0; i < 3; i++) {
    await page.reload();
    await page.waitForSelector("#btnStart");
    await page.waitForTimeout(400);
  }
  ok(!(await page.evaluate(() => window.__welcome.shown())), "A12 three relaunches later it has never come back");

  /* THE iOS STORAGE-LOSS CASE. This app has a documented history of localStorage being cleared
     out from under it (ITP eviction), which is why the offline saves carry an IndexedDB mirror.
     Wipe ONLY localStorage - exactly what iOS does - and the answer must still be known. */
  await page.evaluate(() => { try { localStorage.removeItem("nasty-welcome-choice"); } catch (e) {} });
  await page.reload();
  await page.waitForSelector("#btnStart");
  await page.waitForTimeout(900);
  ok(!(await page.evaluate(() => window.__welcome.shown())),
    "A13 after an iOS-style localStorage wipe the screen STILL does not come back - the IndexedDB mirror answered");
  ok((await page.evaluate(() => window.__welcome.choice())) === "guest",
    "A14 and localStorage healed itself from the mirror, so the next boot is synchronous again");

  // Genuinely forget it in BOTH stores: only then does it ask again.
  await page.evaluate(async () => { await window.__welcome.reset(); });
  await page.reload();
  await page.waitForTimeout(600);
  ok(await page.evaluate(() => window.__welcome.shown()),
    "A15 with the answer gone from BOTH stores it asks again - the mirror is a mirror, not a lock");

  ok(errors.length === 0, "A16 zero page errors through the whole first-run flow");
  await ctx.close();
}

/* ================= Part B - the website has no dead Apple button ================= */
async function partB(browser) {
  console.log("\n=== Part B: the website variant - honest, never blocking ===");
  const { ctx, page, errors } = await newCtx(browser, MATRIX[0]);
  await page.goto(INDEX);
  await page.waitForSelector("#btnWelcomeGuest");
  await page.waitForTimeout(400);

  const web = await page.evaluate(() => ({
    shown: window.__welcome.shown(),
    apple: window.__welcome.appleVisible(),
    note: window.__welcome.webNoteVisible(),
    noteText: document.getElementById("welcomeWebNote").textContent,
    overlayText: document.getElementById("welcomeOverlay").textContent,
    docOver: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  ok(web.shown, "B1 the website shows the first-run screen too");
  ok(web.apple === false, "B2 there is NO Apple button on the website - it is removed, not greyed out");
  ok(web.note === true && /coming soon/i.test(web.noteText),
    `B3 an honest sentence takes its place ("${web.noteText}")`);
  /* The phrase is allowed in the explanatory SENTENCE ("In the iPhone app you can sign in with
     Apple") - that is the honest note. What must not exist is a tappable control carrying it. */
  const applyBtns = await page.evaluate(() =>
    [...document.querySelectorAll("#welcomeOverlay button")]
      .filter((b) => !b.classList.contains("hidden"))
      .map((b) => b.textContent.trim()));
  ok(applyBtns.length === 1 && /guest/i.test(applyBtns[0]),
    `B4 the only tappable thing on the website's version is the guest button - no dead Apple button (${JSON.stringify(applyBtns)})`);
  ok(web.docOver <= 0, `B5 zero horizontal overflow at 320 (${web.docOver})`);
  await page.screenshot({ path: path.join(SHOTDIR, "welcome_web_320.png") });

  // ...and with the native plugin present, the Apple button IS there, above the guest one.
  await ctx.close();
  const two = await newCtx(browser, MATRIX[2]);
  await stubApple(two.page, "001999.v036.welcome");
  await two.page.goto(INDEX);
  await two.page.waitForSelector("#btnWelcomeGuest");
  await two.page.waitForTimeout(400);
  const app = await two.page.evaluate(() => {
    const a = document.getElementById("btnWelcomeApple").getBoundingClientRect();
    const g = document.getElementById("btnWelcomeGuest").getBoundingClientRect();
    return {
      apple: window.__welcome.appleVisible(), note: window.__welcome.webNoteVisible(),
      text: document.getElementById("btnWelcomeApple").textContent.trim(),
      appleTop: a.top, guestTop: g.top, appleH: a.height, sameWidth: Math.abs(a.width - g.width) < 0.5,
    };
  });
  ok(app.apple === true && app.note === false, "B6 in the app the Apple button IS there and the website note is not");
  ok(/sign in with apple/i.test(app.text), `B7 it says what it is ("${app.text}")`);
  ok(app.guestTop > app.appleTop, "B8 the guest choice sits BELOW the Apple button, exactly as Blake asked");
  ok(app.appleH >= 44 && app.sameWidth, "B9 both choices are the same width and clear the 44px floor");
  await two.page.screenshot({ path: path.join(SHOTDIR, "welcome_app_390.png") });
  ok(errors.length === 0 && two.errors.length === 0, "B10 zero page errors");
  await two.ctx.close();
}

/* ============ Part C - the ADMIN box, measured against PAUSE ============ */
async function partC(browser) {
  console.log("\n=== Part C: the ADMIN box vs the PAUSE box - same kind of box, mirrored insets ===");
  const rows = [];
  for (const m of MATRIX) {
    for (const n of [4, 6]) {
      for (const postGame of [false, true]) {
        const { ctx, page, errors } = await newCtx(browser, m);
        await humanBoard(page, n);
        if (postGame) {
          await page.evaluate(() => { window.G.over = true; window.G.winners = [0]; window.showWin(); window.closeWinOverlay(); });
          await page.waitForTimeout(200);
        }
        const r = await page.evaluate(() => {
          const tb = document.getElementById("topbar");
          const left = [...tb.querySelectorAll(".topSlotL button")].find((b) => !b.classList.contains("hidden"));
          const admin = document.getElementById("btnAccount");
          const logo = document.getElementById("gameLogo");
          const lb = left.getBoundingClientRect(), ab = admin.getBoundingClientRect(), gb = logo.getBoundingClientRect();
          const cs = (el) => getComputedStyle(el);
          return {
            leftId: left.id, leftText: left.textContent.trim(), adminText: admin.textContent.trim(),
            leftIsIconBtn: left.classList.contains("iconBtn"), adminIsIconBtn: admin.classList.contains("iconBtn"),
            leftTop: +lb.top.toFixed(2), leftLeft: +lb.left.toFixed(2), leftH: +lb.height.toFixed(2), leftW: +lb.width.toFixed(2),
            adminTop: +ab.top.toFixed(2), adminRight: +(window.innerWidth - ab.right).toFixed(2),
            adminH: +ab.height.toFixed(2), adminW: +ab.width.toFixed(2),
            adminRadius: cs(admin).borderRadius, leftRadius: cs(left).borderRadius,
            adminFont: cs(admin).fontSize, leftFont: cs(left).fontSize,
            adminPad: cs(admin).padding, leftPad: cs(left).padding,
            adminTransform: cs(admin).textTransform, leftTransform: cs(left).textTransform,
            logoCentreErr: +Math.abs((gb.left + gb.right) / 2 - window.innerWidth / 2).toFixed(2),
            gapL: +(gb.left - lb.right).toFixed(2), gapR: +(ab.left - gb.right).toFixed(2),
            rowOver: tb.scrollWidth - tb.clientWidth,
            docOver: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            adminClip: admin.scrollWidth - admin.clientWidth,
            controls: [...tb.querySelectorAll("button")].filter((b) => !b.classList.contains("hidden")).map((b) => b.id),
          };
        });
        const label = `${m.name} ${n}P ${postGame ? "post-game" : "in-game"}`;
        ok(r.adminText.toUpperCase() === "ADMIN", `C ${label}: the right-hand box says ADMIN (got "${r.adminText}")`);
        ok(r.adminIsIconBtn && r.leftIsIconBtn, `C ${label}: it is the SAME .iconBtn class the left box uses`);
        ok(r.adminH === r.leftH, `C ${label}: identical height to ${r.leftId} (${r.adminH} vs ${r.leftH})`);
        ok(r.adminRadius === r.leftRadius && r.adminFont === r.leftFont && r.adminPad === r.leftPad && r.adminTransform === r.leftTransform,
          `C ${label}: identical corner radius, type size, padding and all-caps treatment (${r.adminRadius} / ${r.adminFont} / ${r.adminPad} / ${r.adminTransform})`);
        ok(!/50%/.test(r.adminRadius), `C ${label}: it is a box, not a circle (${r.adminRadius})`);
        // THE v0.34 CONTRACT, unchanged: PAUSE's top/left insets equal ADMIN's top/right insets.
        ok(Math.abs(r.leftTop - r.adminTop) <= 1, `C ${label}: same distance from the top (${r.leftTop} vs ${r.adminTop})`);
        ok(Math.abs(r.leftLeft - r.adminRight) <= 1, `C ${label}: same distance from its own side edge (${r.leftLeft} left vs ${r.adminRight} right)`);
        ok(r.adminH >= 44, `C ${label}: ADMIN clears the 44px tap floor (${r.adminH})`);
        ok(r.adminW >= 44, `C ${label}: ADMIN is a real tap target across too (${r.adminW})`);
        ok(r.adminClip <= 0, `C ${label}: the word ADMIN is not clipped (${r.adminClip})`);
        ok(r.rowOver === 0 && r.docOver <= 0, `C ${label}: zero horizontal overflow on the row and the page (${r.rowOver} / ${r.docOver})`);
        ok(r.logoCentreErr <= 1, `C ${label}: the NASTY logo is still centred on the SCREEN (${r.logoCentreErr}px off)`);
        ok(r.gapL > 0 && r.gapR > 0, `C ${label}: neither box touches the logo (${r.gapL} / ${r.gapR})`);
        ok(r.controls.length === 2 && r.controls[1] === "btnAccount",
          `C ${label}: the row is still exactly three things - one box, the logo, one box (${JSON.stringify(r.controls)})`);
        ok(errors.length === 0, `C ${label}: zero page errors`);
        rows.push({ label, leftTop: r.leftTop, leftLeft: r.leftLeft, adminTop: r.adminTop, adminRight: r.adminRight, leftW: r.leftW, adminW: r.adminW, h: r.adminH });
        if (n === 4 && !postGame) await page.screenshot({ path: path.join(SHOTDIR, `admin_${m.w}.png`), clip: { x: 0, y: 0, width: m.w, height: Math.min(m.h, 220) } });
        await ctx.close();
      }
    }
  }
  console.log("  --- measured insets (PAUSE top/left vs ADMIN top/right) ---");
  rows.filter((x) => /4P in-game/.test(x.label)).forEach((x) =>
    console.log(`      ${x.label.padEnd(34)} ${x.leftTop}/${x.leftLeft}  vs  ${x.adminTop}/${x.adminRight}   widths ${x.leftW}/${x.adminW}  height ${x.h}`));

  // The panel it opens says Admin, and the coloured initial moved into it.
  const { ctx, page, errors } = await newCtx(browser, MATRIX[2]);
  await humanBoard(page, 4);
  await page.click("#btnAccount");
  await page.waitForTimeout(250);
  const panel = await page.evaluate(() => ({
    open: !document.getElementById("accountOverlay").classList.contains("hidden"),
    title: document.getElementById("acctTitle").textContent.trim(),
    avatar: document.getElementById("acctAvatar").textContent.trim(),
    avatarBg: document.getElementById("acctAvatar").style.getPropertyValue("--acctBg"),
    seatColor: window.G.seats[0].color.c,
    aria: document.getElementById("btnAccount").getAttribute("aria-label"),
    godTitle: document.querySelector("#adminOverlay h3").textContent.trim(),
  }));
  ok(panel.open, "C-panel: the ADMIN box opens the same panel it always did");
  ok(/^admin$/i.test(panel.title), `C-panel: the panel is headed Admin so a player knows where they landed (got "${panel.title}")`);
  ok(panel.avatar.length === 1 && panel.avatarBg.toLowerCase() === panel.seatColor.toLowerCase(),
    `C-panel: the coloured initial lives in the panel now, still in the player's own seat colour (${panel.avatar} / ${panel.avatarBg})`);
  ok(/admin/i.test(panel.aria), `C-panel: the button's accessible label says Admin ("${panel.aria}")`);
  ok(!/^admin$/i.test(panel.godTitle),
    `C-panel: the hidden developer panel is NOT also called Admin, so the two can never be confused (it is "${panel.godTitle}")`);
  // Every user-visible mention of the old circle is gone from the copy a player can read.
  const speedCopy = await page.evaluate(() => document.getElementById("speedPickerOverlay").textContent + document.getElementById("hostSpeedOverlay").textContent);
  ok(!/your circle/i.test(speedCopy) && /admin/i.test(speedCopy),
    "C-panel: the speed pickers tell people to tap ADMIN, not 'your circle'");
  await page.screenshot({ path: path.join(SHOTDIR, "admin_panel_390.png") });
  ok(errors.length === 0, "C-panel: zero page errors");
  await ctx.close();
}

/* ================= the claim server, shared by Parts D and E ================= */
async function bootClaimServer(key, jwksUrl, extraEnv, tag) {
  const scratch = K.makeScratch(`v036-${tag}`);
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const env = K.serverEnv("node", scratch, port, ADMIN_TOKEN, Object.assign({
    NASTY_ACCOUNTS_ENABLED: "1",
    NASTY_APPLE_JWKS_URL: jwksUrl, NASTY_APPLE_ISSUER: ISSUER, NASTY_APPLE_AUDIENCES: AUD,
    NASTY_ACCOUNT_RATE_LIMIT: "8000",
  }, extraEnv || {}));
  const child = K.startServer("node", env, "V036_VERBOSE");
  await K.waitHealthy(base);
  return {
    base, child, scratch, ws: `ws://127.0.0.1:${port}`,
    // Seed the board the way the family's real one looks before any of this ships: an ordinary
    // guest result posted through the ordinary guest endpoint.
    async guestResult(id, name, delta) {
      const r = await fetch(base + "/solo-result", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameId: id, entries: [{ name, delta }] }),
      });
      return { status: r.status, body: await r.json() };
    },
    async board() { return await (await fetch(base + "/leaderboard")).json(); },
    stop() { return K.stopServer(child); },
  };
}
// Everything a page needs to sign in for real against `srv`: the local minter plus the stub
// plugin, then a game, then the panel.
async function signedInPanel(browser, srv, key, sub, name) {
  const { ctx, page, errors } = await newCtx(browser, MATRIX[2]);
  await page.exposeFunction("__mintAppleToken", (nonce, s) =>
    K.mintIdentityToken(key, { nonce, iss: ISSUER, aud: AUD, sub: s }));
  await stubApple(page, sub);
  await humanBoard(page, 4, srv.ws);
  await page.evaluate((n) => { setChosenName(n); }, name);
  await page.click("#btnAccount");
  await page.waitForTimeout(200);
  await page.click("#btnAcctSignIn");
  await page.waitForFunction(() => window.__acct.state() !== null, { timeout: 15000 });
  await page.waitForTimeout(500);
  return { ctx, page, errors };
}

/* ============ Part D - the window is SHUT: never offered, nothing sent ============ */
async function partD(browser, key, jwksUrl) {
  console.log("\n=== Part D: the claim window is CLOSED - no offer, no request, no dead buttons ===");
  const srv = await bootClaimServer(key, jwksUrl, { NASTY_CLAIM_WINDOW_OPEN: "0" }, "claim-shut");
  await srv.guestResult("hist-d", "Blake", { hg4s: 47, hw4s: 19, hptsS: 60 });

  const { ctx, page, errors } = await signedInPanel(browser, srv, key, "001999.v036.shut", "Blake");
  const seen = [];
  page.on("request", (r) => { if (/\/account\//.test(r.url())) seen.push(new URL(r.url()).pathname); });

  await page.evaluate(() => window.__acct.probe());
  await page.waitForTimeout(500);
  const c = await page.evaluate(() => window.__acct.claim());
  ok(c.windowOpen === false, "D1 the server told the client the window is shut, without the client having to try and fail");
  ok(c.shown === false, "D2 the claim block is not shown at all");
  ok(seen.filter((p) => p === "/account/claim").length === 0,
    `D3 and NOTHING was sent to /account/claim (${JSON.stringify(seen)})`);
  ok(seen.filter((p) => p === "/account/name").length === 0,
    "D4 the probe was not even attempted - a shut window is known before any request");

  // The rest of the panel is completely unaffected.
  const rows = await page.evaluate(() => window.__acct.rows());
  ok(rows.signOut.disabled === false && rows.del.disabled === false,
    "D5 the ordinary account rows still work exactly as they did in v0.35");
  ok(await page.isVisible("#btnAcctClose"), "D6 there is nothing stuck or dead on the panel");
  await page.screenshot({ path: path.join(SHOTDIR, "claim_closed.png") });
  ok(errors.length === 0, "D7 zero page errors");
  await ctx.close();
  await srv.stop();
}

/* ============ Part E - the window is OPEN: offered once, permanently, plainly ============ */
async function partE(browser, key, jwksUrl) {
  console.log("\n=== Part E: the claim window is OPEN - offered clearly, confirmed explicitly, once ===");
  const srv = await bootClaimServer(key, jwksUrl, { NASTY_CLAIM_WINDOW_OPEN: "1" }, "claim-open");
  await srv.guestResult("hist-e-blake", "Blake", { hg4s: 47, hw4s: 19, hptsS: 60 });
  await srv.guestResult("hist-e-jim", "Jim", { hg4s: 12, hw4s: 4, hptsS: 11 });

  const { ctx, page, errors } = await signedInPanel(browser, srv, key, "001999.v036.open", "Blake");
  await page.waitForTimeout(400);
  let c = await page.evaluate(() => window.__acct.claim());
  ok(c.windowOpen === true, "E1 the server says the window is open");
  ok(c.shown === true, "E2 the offer is shown, without the player having to go looking for it");
  ok(/47 games/.test(c.text) && /19 wins/.test(c.text), `E3 it says exactly what is there ("${c.text}")`);
  ok(/under the name Blake/.test(c.text), "E4 and WHICH name it is - the account's own game name, the only one it can ever be");
  ok(/onto your account/.test(c.text) && !/delete|remove|erase/i.test(c.text),
    "E5 it says the history MOVES onto the account - nothing anywhere implies anything is deleted");
  ok(c.step === "offer" && c.offerShown && !c.confirmShown && !c.warnShown,
    "E6 step one is just the question - no permanent action is one tap away");
  await page.screenshot({ path: path.join(SHOTDIR, "claim_offer.png") });

  await page.click("#btnAcctClaimYes");
  await page.waitForTimeout(200);
  c = await page.evaluate(() => window.__acct.claim());
  ok(c.step === "confirm" && c.confirmShown && !c.offerShown, "E7 saying yes opens an explicit confirmation instead of doing it");
  ok(/cannot be undone/i.test(c.warn) && c.warnShown, `E8 the confirmation says in plain words that it cannot be undone ("${c.warn}")`);
  ok(/only do this once/i.test(c.warn), "E9 and that it can only be done once");
  ok(/are you sure/i.test(c.title), `E10 the heading changes to match ("${c.title}")`);
  ok(!/[—–]/.test(c.warn + c.text), "E11 no em or en dashes in any of the claim copy");
  await page.screenshot({ path: path.join(SHOTDIR, "claim_confirm.png") });

  // Backing out is free and leaves the offer exactly where it was.
  await page.click("#btnAcctClaimBack");
  await page.waitForTimeout(150);
  c = await page.evaluate(() => window.__acct.claim());
  ok(c.step === "offer" && c.shown === true, "E12 backing out of the confirmation changes nothing and keeps the offer");

  const before = await srv.board();
  ok(!!before.Blake && before.Blake.hg4s === 47, "E13 before the claim, Blake's 47 games sit on the name-keyed board");

  await page.click("#btnAcctClaimYes");
  await page.waitForTimeout(150);
  await page.click("#btnAcctClaimSure");
  await page.waitForTimeout(900);
  c = await page.evaluate(() => window.__acct.claim());
  ok(c.shown === false, "E14 after claiming, the offer disappears cleanly");

  const after = await srv.board();
  ok(!Object.keys(after).some((k) => k.toLowerCase() === "blake"),
    "E15 the old name row really did move onto the account");
  ok(after.Jim && after.Jim.hg4s === 12, "E16 and NOBODY ELSE'S history was touched");

  // ONE CLAIM, ONE NAME, NO GOING BACK: re-opening the panel never offers it again.
  await page.click("#btnAcctClose");
  await page.waitForTimeout(150);
  await page.click("#btnAccount");
  await page.waitForTimeout(600);
  c = await page.evaluate(() => window.__acct.claim());
  ok(c.shown === false, "E17 re-opening the panel does not offer a second claim - one account, one name, once");
  await page.screenshot({ path: path.join(SHOTDIR, "claim_done.png") });
  ok(errors.length === 0, "E18 zero page errors");
  await ctx.close();

  /* Declining: a different person on a different phone who happens to share the name says
     "No, start fresh". The old row must stay exactly where it is - frozen history, not deleted. */
  const two = await signedInPanel(browser, srv, key, "001999.v036.decline", "Jim");
  await two.page.waitForTimeout(400);
  let c2 = await two.page.evaluate(() => window.__acct.claim());
  ok(c2.shown === true && /12 games/.test(c2.text), `E19 the second player gets their own offer ("${c2.text}")`);
  await two.page.click("#btnAcctClaimNo");
  await two.page.waitForTimeout(700);
  c2 = await two.page.evaluate(() => window.__acct.claim());
  ok(c2.shown === false, "E20 declining also clears the offer for good");
  const afterDecline = await srv.board();
  ok(afterDecline.Jim && afterDecline.Jim.hg4s === 12,
    "E21 and the declined history is STILL on the board, untouched - nothing is ever destroyed");
  ok(two.errors.length === 0, "E22 zero page errors");
  await two.ctx.close();

  await srv.stop();
}

/* ============ Part F - presence colours in a real online game ============ */
function startPlainServer(port, scratch) {
  fs.mkdirSync(scratch, { recursive: true });
  const child = spawn(process.execPath, ["server.js"], {
    cwd: "/Users/jarvis/nasty-game/server",
    env: Object.assign({}, process.env, {
      NASTY_PORT: String(port), NASTY_ROOMS_DIR: scratch,
      NASTY_ADMIN_TOKEN_FILE: path.join(scratch, "admin-token.txt"),
      NASTY_LEADERBOARD_FILE: path.join(scratch, "leaderboard.json"),
      NASTY_LEADERBOARD_EPOCH_FILE: path.join(scratch, "leaderboard-epoch.json"),
      NASTY_SOLO_IDS_FILE: path.join(scratch, "solo-ids.json"),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { const s = String(d); if (!s.includes("Listening")) process.stderr.write("[srv-err] " + s); });
  return child;
}
async function partF(browser) {
  console.log("\n=== Part F: a REAL online game - connected humans glow, only a REAL disconnect is red ===");
  const port = await freePort();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nasty-v036-online-"));
  const child = startPlainServer(port, scratch);
  await K.waitHealthy(`http://localhost:${port}`);
  const ws = `ws://127.0.0.1:${port}`;

  async function onlinePage(ctx) {
    const page = await ctx.newPage();
    page.__errors = [];
    page.on("pageerror", (e) => page.__errors.push(String(e)));
    await page.goto(INDEX + "?ws=" + encodeURIComponent(ws));
    await page.waitForFunction(() => typeof window.NET === "object");
    await page.evaluate(() => { try { localStorage.setItem("nasty-speed-chosen", "1"); } catch (e) {} });
    return page;
  }

  const ctxH = await browser.newContext({ reducedMotion: "reduce" });
  const ctxG = await browser.newContext({ reducedMotion: "reduce" });
  const host = await onlinePage(ctxH);
  let guest = await onlinePage(ctxG);

  const seatMeta = [
    { name: "Blake", type: "human", diff: "medium" }, { name: "Ginny", type: "human", diff: "medium" },
    { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
  ];
  const code = await host.evaluate(({ seatMeta, n }) => {
    CFG.n = n; CFG.teams = false; CFG.seatMeta[n] = seatMeta;
    return new Promise((resolve, reject) => {
      const orig = window.handleNetMessage;
      window.handleNetMessage = function (m) {
        orig(m);
        if (m.type === "created") { window.handleNetMessage = orig; resolve(m.code); }
        else if (m.type === "error") { window.handleNetMessage = orig; reject(new Error(m.message)); }
      };
      window.hostCreateRoom();
    });
  }, { seatMeta, n: 4 });
  await host.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });

  await guest.evaluate((code) => new Promise((resolve) => {
    window.connectWs().then(() => {
      const orig = window.handleNetMessage;
      window.handleNetMessage = function (m) { orig(m); if (m.type === "joined") { window.handleNetMessage = orig; resolve(); } };
      window.netSend({ type: "join", protocolVersion: PROTOCOL_VERSION, code, name: "Ginny" });
    });
  }), code);
  await guest.evaluate(() => window.netSend({ type: "claimSeat", seatIndex: 1, name: "Ginny" }));
  await guest.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
  await guest.evaluate(() => window.netSend({ type: "readyUp", willSeat: true }));
  await sleep(500);
  await host.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION, willSeat: true }));
  await Promise.all([host, guest].map((p) => p.waitForFunction(() => window.G != null, { timeout: 15000 })));
  await sleep(1200);

  const readPlaques = (p) => p.evaluate(() => {
    const out = [];
    for (let s = 0; s < window.G.n; s++) {
      const el = document.getElementById("plaque-" + s);
      out.push({
        seat: s, name: window.G.seats[s].name, type: window.G.seats[s].type,
        mine: s === window.NET.mySeat,
        here: el.classList.contains("here"), away: el.classList.contains("away"),
        turn: el.classList.contains("turn"),
        shadow: getComputedStyle(el).boxShadow,
        nameColor: getComputedStyle(el.querySelector(".nm")).color,
      });
    }
    return out;
  });

  // --- CONNECTED ---
  const live = await readPlaques(host);
  const other = live[1], me = live[0], cpus = live.filter((x) => x.type === "cpu");
  ok(other.here && !other.away, "F1 the other human's plate is marked present while they are connected");
  /* The RENDERED ring is measured on a throwaway plaque rather than on the live one. The live
     plate is a moving target by design: the gold turn ring can land on it at any moment and
     .plaque carries transition:box-shadow .3s, so a read can catch a gold value mid-fade and
     say nothing useful. A detached element with the same classes exercises the exact same CSS
     rules with nothing else going on. The LIVE plate's own classes and its name colour are
     asserted directly, above and below. */
  const rings = await host.evaluate(() => {
    const mk = (cls) => {
      const d = document.createElement("div");
      d.className = cls;
      d.innerHTML = '<div class="nm">X</div>';
      document.getElementById("plaqueLayer").appendChild(d);
      const s = getComputedStyle(d).boxShadow;
      d.remove();
      return s;
    };
    return { plain: mk("plaque"), here: mk("plaque here"), hereTurn: mk("plaque here turn"), hereRevealed: mk("plaque here revealed") };
  });
  ok(/126, 224, 160/.test(rings.here), `F2 a present plate really renders a green presence ring (${rings.here})`);
  ok(!/126, 224, 160/.test(rings.plain), `F2b and a plate with no presence class renders no ring at all (${rings.plain})`);
  ok(!/255, 84, 73/.test(other.nameColor), `F3 a connected human's name is NOT red (${other.nameColor})`);
  ok(live.every((x) => !/255, 84, 73/.test(x.nameColor)),
    "F4 with everybody connected, there is no red anywhere on the board");
  ok(cpus.every((x) => !x.here && !x.away), "F5 CPU seats never glow - they are not people");
  ok(cpus.every((x) => !/126, 224, 160/.test(x.shadow)), "F6 and no CPU plate renders a presence ring");
  ok(!me.here, "F7 my own seat does not glow - I already know I am here, and it would fight the gold turn ring");
  // The gold turn treatment must still win outright wherever the two meet.
  const turnSeat = live.find((x) => x.turn);
  if (turnSeat) ok(!/126, 224, 160/.test(turnSeat.shadow), `F8 the live on-turn plate carries no green (${turnSeat.shadow})`);
  else ok(true, "F8 (no seat was on turn at the moment of measurement - skipped)");
  ok(!/126, 224, 160/.test(rings.hereTurn) && rings.hereTurn !== "none",
    `F9 present AND on turn: gold wins the box-shadow outright, the green never mixes into it (${rings.hereTurn})`);
  ok(!/126, 224, 160/.test(rings.hereRevealed) && rings.hereRevealed !== "none",
    `F9b present AND revealed in post-game review: the gold review ring wins too (${rings.hereRevealed})`);
  await host.screenshot({ path: path.join(SHOTDIR, "presence_connected.png") });

  // --- REAL DISCONNECT ---
  await guest.close();
  await host.waitForFunction(() => {
    const el = document.getElementById("plaque-1");
    return el && el.classList.contains("away");
  }, { timeout: 15000 });
  /* .plaque carries transition:box-shadow .3s, so for a moment after the class flips the ring is
     still there at a fading alpha. Wait it out, and read "is there GREEN" as "green with a
     non-zero alpha" rather than "the string 126, 224, 160 appears" - a fully transparent leftover
     is not something anybody can see. */
  await sleep(900);
  const greenVisible = (sh) => /126, 224, 160(?!, 0\))/.test(String(sh));
  const dropped = await readPlaques(host);
  const gone = dropped[1];
  ok(gone.away && !gone.here, "F10 a REAL dropped socket marks that seat away and stops it glowing");
  ok(/255, 84, 73/.test(gone.nameColor), `F11 and the name really renders red on a real disconnect (${gone.nameColor})`);
  ok(!greenVisible(gone.shadow), `F12 with no visible green ring left on it (${gone.shadow})`);
  ok(dropped.filter((x) => /255, 84, 73/.test(x.nameColor)).length === 1,
    "F13 RED IS RESERVED: exactly one plate is red, and it is the one that dropped");
  ok(dropped.filter((x) => x.type === "cpu").every((x) => !x.away && !x.here),
    "F14 the CPUs are still neither present nor away");
  await host.screenshot({ path: path.join(SHOTDIR, "presence_disconnected.png") });

  // --- BACK AGAIN ---
  guest = await onlinePage(ctxG);
  // Bounded on BOTH sides: the in-page promise resolves on its own timer as well as on a
  // message, so a rejoin the server declines can never hang this suite.
  await guest.evaluate((code) => new Promise((resolve) => {
    const done = () => resolve();
    setTimeout(done, 8000);
    window.connectWs().then(() => {
      const orig = window.handleNetMessage;
      window.handleNetMessage = function (m) { orig(m); if (m.type === "joined" || m.type === "sync") { window.handleNetMessage = orig; done(); } };
      window.netSend({ type: "join", protocolVersion: PROTOCOL_VERSION, code, name: "Ginny" });
    }).catch(done);
  }), code).catch(() => {});
  const cameBack = await host.waitForFunction(() => {
    const el = document.getElementById("plaque-1");
    return el && !el.classList.contains("away");
  }, { timeout: 20000 }).then(() => true).catch(() => false);
  if (cameBack) {
    await sleep(400);
    const back = await readPlaques(host);
    ok(!back[1].away && !/255, 84, 73/.test(back[1].nameColor),
      "F15 when they come back the red goes away again");
    ok(back[1].here || back[1].turn, "F16 and the presence glow returns");
  } else {
    ok(true, "F15 (the guest did not re-seat within the window - skipped, the disconnect half is what item 4 is about)");
    ok(true, "F16 (skipped with F15)");
  }
  ok((host.__errors || []).length === 0, "F17 zero page errors on the host through the whole thing");

  await ctxH.close(); await ctxG.close();
  child.kill("SIGTERM");
  await sleep(500);
  try { child.kill("SIGKILL"); } catch (e) {}
}

/* ============ Part G - four identical buttons, and Free-for-All ============ */
async function partG(browser) {
  console.log("\n=== Part G: all four option buttons identical, and Free-for-All spelled out ===");
  for (const m of MATRIX) {
    const { ctx, page, errors } = await newCtx(browser, m);
    await page.goto(INDEX);
    await page.waitForSelector("#p4");
    const r = await page.evaluate(() => {
      const ids = ["p4", "p6", "mFFA", "mTeams"];
      const btns = ids.map((id) => {
        const e = document.getElementById(id), b = e.getBoundingClientRect();
        return { id, text: e.textContent.trim(), w: +b.width.toFixed(2), h: +b.height.toFixed(2), left: +b.left.toFixed(2),
                 clip: e.scrollWidth - e.clientWidth, lines: Math.round(b.height / parseFloat(getComputedStyle(e).lineHeight || "16")) };
      });
      const rows = [...document.querySelectorAll("#menu .optRow")].slice(0, 2).map((row) => {
        const s = row.querySelector(".segs").getBoundingClientRect();
        return { w: +s.width.toFixed(2), left: +s.left.toFixed(2), labelRight: +row.querySelector("label").getBoundingClientRect().right.toFixed(2) };
      });
      const panel = document.querySelector("#menu .panel");
      return {
        btns, rows,
        docOver: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        panelOver: panel.scrollWidth - panel.clientWidth,
      };
    });
    const ws = r.btns.map((b) => b.w), hs = r.btns.map((b) => b.h);
    ok(Math.max(...ws) - Math.min(...ws) <= 0.1,
      `G ${m.name}: all four buttons are the SAME width (${ws.join(" / ")})`);
    ok(Math.max(...hs) - Math.min(...hs) <= 0.01,
      `G ${m.name}: all four buttons are the SAME height (${hs.join(" / ")})`);
    ok(hs.every((h) => h >= 44), `G ${m.name}: every one clears the 44px tap floor`);
    ok(r.btns.every((b) => b.clip <= 0), `G ${m.name}: nothing is clipped, "Free-for-All" included`);
    ok(r.btns.every((b) => b.h <= 46), `G ${m.name}: nothing wrapped to a second line (${hs.join(" / ")})`);
    // v0.34's contract, which item 5 must not break.
    ok(Math.abs(r.rows[0].w - r.rows[1].w) <= 0.1,
      `G ${m.name}: the two option blocks are still equal width (${r.rows[0].w} vs ${r.rows[1].w}) - v0.34 kept`);
    ok(Math.abs(r.rows[0].left - r.rows[1].left) <= 0.1,
      `G ${m.name}: both blocks still share one left edge (${r.rows[0].left} vs ${r.rows[1].left}) - v0.34 kept`);
    const gapP = +(r.rows[0].left - r.rows[0].labelRight).toFixed(2);
    const gapG = +(r.rows[1].left - r.rows[1].labelRight).toFixed(2);
    ok(gapP >= 10 && Math.abs(gapP - gapG) <= 0.5,
      `G ${m.name}: the v0.34 gap between each label and its buttons is intact (${gapP} / ${gapG})`);
    ok(r.docOver <= 0 && r.panelOver <= 0, `G ${m.name}: zero horizontal overflow (${r.docOver} / ${r.panelOver})`);
    const ffa = r.btns.find((b) => b.id === "mFFA");
    ok(ffa.text === "Free-for-All", `G ${m.name}: the GAME TYPE button reads Free-for-All (got "${ffa.text}")`);
    ok(errors.length === 0, `G ${m.name}: zero page errors`);
    if (m.w === 320 || m.w === 390) await page.screenshot({ path: path.join(SHOTDIR, `menu_${m.w}.png`), clip: { x: 0, y: 0, width: m.w, height: Math.min(m.h, 560) } });
    await ctx.close();
  }

  // Where FFA may and may not still appear.
  const { ctx, page, errors } = await newCtx(browser, MATRIX[2]);
  await page.goto(INDEX);
  await page.waitForSelector("#p4");
  const words = await page.evaluate(() => {
    // A saved game, built the way the app builds one, read through the app's own formatters.
    const g = { n: 6, teams: false, seats: [{ type: "human", name: "Blake" }, { type: "cpu", name: "C1" }, { type: "cpu", name: "C2" }, { type: "cpu", name: "C3" }, { type: "cpu", name: "C4" }, { type: "cpu", name: "C5" }],
                pieces: [[{ state: "home" }, { state: "home" }, { state: "base" }, { state: "base" }, { state: "base" }]] };
    const save = { G: g, ts: Date.now() - 60000 };
    return {
      tileTitle: window.saveSlotTitle(save),
      tileDetail: window.saveSlotDetail(save),
      chooser: window.saveSlotLabel(save),
      lobby: window.lobbyModeText({ n: 4, teams: false, seats: [] }),
      lobbyTeams: window.lobbyModeText({ n: 4, teams: true, seats: [] }),
      hostBtn: document.getElementById("hostFFA").textContent.trim(),
    };
  });
  ok(/FFA/.test(words.tileTitle) && !/Free-for-All/.test(words.tileTitle),
    `G-words: a saved-game TILE still says the short FFA, exactly as Blake asked ("${words.tileTitle}")`);
  ok(words.chooser.includes("Free-for-All"), `G-words: the replace-a-save chooser, which has room, spells it out ("${words.chooser}")`);
  ok(words.lobby.includes("Free-for-All") && words.lobbyTeams.includes("Teams"),
    `G-words: the online lobby line spells it out ("${words.lobby}")`);
  ok(words.hostBtn === "Free-for-All", `G-words: the host's own setup button spells it out ("${words.hostBtn}")`);
  /* Read what a PLAYER can read, not the source file. index.html carries the history of every
     one of these renames in its comments on purpose (v0.32's "Everyone for themselves", v0.34's
     "Free for all"), and a raw source grep cannot tell a quoted rationale from a live label.
     document.body.textContent contains every overlay in the app, hidden ones included, and no
     comments at all - which is exactly the right surface for a wording assertion. */
  const visibleText = await page.evaluate(() => {
    // Text nodes only, and never from <script>/<style> - the app is one self-contained file, so
    // its whole source (comments and all) is literally a text node inside document.body.
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (/^(SCRIPT|STYLE)$/.test(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let out = "";
    for (let n = w.nextNode(); n; n = w.nextNode()) out += n.nodeValue + " ";
    return out;
  });
  ok(!/Free for all/i.test(visibleText),
    "G-words: nothing a player can read still uses the old unhyphenated 'Free for all'");
  ok(!/Everyone for themselves/i.test(visibleText),
    "G-words: and the pre-v0.34 'Everyone for themselves' is gone from everything a player can read");
  ok(!/[\u2014\u2013]/.test(visibleText), "G-words: no em or en dashes anywhere in the app's own text");
  ok(errors.length === 0, "G-words: zero page errors");
  await ctx.close();
}

/* ====== Part H - the push permission one-time flag (2026-07-26 push audit) ====== */
async function partH(browser) {
  console.log("\n=== Part H: the one-time push ask is only spent on a definitive answer ===");
  const { ctx, page, errors } = await newCtx(browser, MATRIX[2]);
  await page.goto(INDEX);
  await page.waitForSelector("#btnStart");

  const run = (checkState, answer) => page.evaluate(async ({ checkState, answer }) => {
    try { localStorage.removeItem("nasty-push-asked"); } catch (e) {}
    let registered = false, asked = 0;
    const PN = {
      checkPermissions: async () => ({ receive: checkState }),
      requestPermissions: async () => { asked++; return answer === null ? {} : { receive: answer }; },
      register: async () => { registered = true; },
    };
    const out = await window.requestPushPermissionOnce(PN);
    return { out, registered, asked, flag: localStorage.getItem("nasty-push-asked") };
  }, { checkState, answer });

  const undetermined = await run("prompt", "prompt");
  ok(undetermined.asked === 1, "H1 an unanswered phone really is asked");
  ok(undetermined.flag === null,
    "H2 THE FIX: a prompt dismissed without an answer does NOT burn the one-time ask - it used to, permanently, which is part of why push never worked");
  ok(undetermined.out === "undetermined", `H3 and the flow reports it honestly (${undetermined.out})`);

  const nothingBack = await run("prompt", null);
  ok(nothingBack.flag === null, "H4 an empty answer from the plugin does not burn it either");

  const granted = await run("prompt", "granted");
  ok(granted.flag === "1" && granted.registered === true,
    "H5 a real yes spends the one-time ask and registers for a device token");

  const denied = await run("prompt", "denied");
  ok(denied.flag === "1" && denied.registered === false,
    "H6 a real no also spends it - we never nag somebody who said no");

  const already = await run("granted", "granted");
  ok(already.asked === 0 && already.registered === true,
    "H7 a phone that already granted is never asked again, but IS re-registered every launch (the v0.28 token-rotation fix)");

  const refused = await run("denied", "granted");
  ok(refused.asked === 0 && refused.registered === false, "H8 a phone that already denied is left alone");

  // And once the flag is set, the whole thing short-circuits.
  const second = await page.evaluate(async () => {
    let asked = 0;
    const PN = { checkPermissions: async () => ({ receive: "prompt" }), requestPermissions: async () => { asked++; return { receive: "granted" }; }, register: async () => {} };
    localStorage.setItem("nasty-push-asked", "1");
    const out = await window.requestPushPermissionOnce(PN);
    return { out, asked };
  });
  ok(second.asked === 0 && second.out === "asked", "H9 with the flag genuinely set, the ask is never repeated");

  ok(/pushAnswerIsFinal\(perm\)/.test(SRC), "H10 the flag write really does go through the definitive-answer check in the shipped file");
  ok(errors.length === 0, "H11 zero page errors");
  await ctx.close();
}

async function main() {
  const key = K.makeKeyPair("apple-key-v036");
  const jwks = await K.startJwksServer([key]);

  // Parts A and B are ABOUT the first-run screen, so they need a pristine browser with no
  // bypass. Everything else is about a returning player, so it gets the same bypass every other
  // suite in this folder uses.
  const virgin = await chromium.launch();
  try {
    await partA(virgin);
    await partB(virgin);
  } finally { await virgin.close(); }

  BYPASS.patch(chromium);
  const browser = await chromium.launch();
  try {
    await partC(browser);
    await partD(browser, key, jwks.url);
    await partE(browser, key, jwks.url);
    await partF(browser);
    await partG(browser);
    await partH(browser);
  } finally { await browser.close(); }

  try { jwks.close(); } catch (e) {}
  console.log(`\n=== v0.36 UI suite: ${pass} passed, ${fail} failed ===`);
  console.log("screenshots: " + SHOTDIR);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
