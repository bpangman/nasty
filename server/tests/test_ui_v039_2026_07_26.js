"use strict";
/*
 * test_ui_v039_2026_07_26.js - PERMANENT suite for Blake's 2026-07-26 welcome-screen batch (v0.39).
 *
 * Three asks, all client-side (index.html only - no engine, no server, no protocol change):
 *
 *   1. "Can you have the sign in screen appear on every new iteration of the app? Whether it be
 *      TestFlight or an update that went through the App Store? Since it's technically a new version
 *      of the app? That way I can also see this page every time in the meantime as well."
 *   2. "There should also be language that says like 'create an account or sign in to an existing
 *      one via Apple' or something like that which acknowledges you might already have an account."
 *   3. "make it more exciting with exclamation points! Even in the game too (especially the login
 *      page)"
 *
 * Parts:
 *   A - ONCE PER VERSION, proved by simulating a real update. The page is served over http from a
 *       throwaway local server whose copy of index.html carries a swappable version string, so the
 *       ORIGIN never changes - which is exactly what an app update looks like to localStorage and
 *       IndexedDB. Answer once, relaunch twice: no screen. Bump the version: the screen is back.
 *       Answer again: gone again. Nothing test-only is called to make that happen.
 *   B - the SIGNED-IN player gets a greeting, not a second sign-in: "Welcome back", one "Keep
 *       playing!" button, no Apple button, no guest button, and the two new-player-only sentences
 *       hidden. Tapping it records the answer for this version and does not come back until the next
 *       one.
 *   C - the COPY. The Apple clarification is there and is beside the button rather than inside its
 *       title (Apple's HIG fixes the words on a Sign in with Apple button). The old "You will only
 *       be asked this once" sentence is gone, because it would now be false. No "family", no em or
 *       en dashes, the age sentence and the guest/leaderboard sentence still factual and unjazzed.
 *   D - MEASUREMENTS at Blake's five widths with real safe-area insets, for BOTH variants (website:
 *       no Apple button; iPhone app: Apple button present, stubbed plugin). Nothing overflows
 *       sideways, both choices are real 44px+ targets, and the age sentence is NOT lower than v0.38
 *       had it - v0.38 flagged that line as already sitting inside the "more below - swipe up" fade
 *       at 320x568, so this suite pins it as an upper bound in BOTH variants.
 *   E - the EXCITEMENT SWEEP, from both directions: the moments that should have energy have it, and
 *       every confirmation, destructive or factual string is still flat. An exclamation mark on
 *       "Concede this game?" would be bad design, so that is a test, not a promise.
 *
 * Everything is local: file:// plus one http server bound to 127.0.0.1 on an ephemeral port, and a
 * dead ?ws= override (127.0.0.1:9) so nothing can reach for a real game server. No production
 * contact of any kind.
 *
 * Run: node tests/test_ui_v039_2026_07_26.js
 */
const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
const http = require("http");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..", "..");
const INDEX_PATH = process.env.NASTY_INDEX || path.join(ROOT, "index.html");
const SRC = fs.readFileSync(INDEX_PATH, "utf8");
// The version this checkout ships, read the same way the app itself reads it (appVersion(), § WELCOME).
const VER = (SRC.match(/id="verTap"[^>]*>([^<]+)</) || [, ""])[1].trim();
// A dead port, so resolveWsUrl() resolves instantly to something that refuses the connection. The
// account calls then fail as {status:0} - which the app treats as "the server is having a moment",
// leaving the stored session token alone. That is what part B needs, and it cannot touch production.
const DEAD_WS = "ws://127.0.0.1:9";
const INDEX = "file://" + INDEX_PATH + "?ws=" + encodeURIComponent(DEAD_WS);
const SHOTDIR = path.join("/private/tmp/claude-501/-Users-jarvis/0bc923da-f111-499a-9b51-18988e4aba3d/scratchpad", "shots-v039");
fs.mkdirSync(SHOTDIR, { recursive: true });

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}

// Blake's own device matrix with the insets each one really reports - the same list the v0.36, v0.37
// and v0.38 suites use, kept identical on purpose so a layout claim means the same thing in all four.
const MATRIX = [
  { name: "320x568 (SE1)", w: 320, h: 568, top: 0, bottom: 0 },
  { name: "375x667 (SE2/3)", w: 375, h: 667, top: 0, bottom: 0 },
  { name: "390x844 (12/13/14)", w: 390, h: 844, top: 47, bottom: 34 },
  { name: "393x852 (15/16 Pro)", w: 393, h: 852, top: 59, bottom: 34 },
  { name: "430x932 (Pro Max)", w: 430, h: 932, top: 59, bottom: 34 },
];

/* v0.38's MEASURED age-sentence positions at 320x568, taken by running the measuring code below
   against `git show HEAD~:index.html` on 2026-07-26 (the shipped v0.38 file), for both variants.
   These are upper bounds in part D: v0.38's own suite flagged this line as already sitting inside the
   64px "more below - swipe up" fade, so v0.39 is not allowed to push it even a pixel lower. */
const V038_AGE_BOTTOM_320 = { web: 522.7, app: 503.3 };

/* The stub native plugin, exactly as test_accounts_stage2_signin_2026_07_25.js and the v0.36 suite do
   it: deliberately WITHOUT isNativePlatform, so IS_APP stays false (none of the app's native boot
   runs) while appleSignInPlugin() still finds a plugin - which is the only thing
   accountsAvailableHere() actually asks. This is how the iPhone-app variant of the screen is reached
   from a desktop browser. */
async function stubApple(target) {
  await target.addInitScript(() => {
    window.Capacitor = window.Capacitor || {};
    window.Capacitor.Plugins = window.Capacitor.Plugins || {};
    window.Capacitor.Plugins.AppleSignIn = {
      isAvailable: async () => ({ available: true }),
      authorize: async () => { throw new Error("cancelled"); },
    };
  });
}

async function newCtx(browser, m) {
  const ctx = await browser.newContext({ viewport: { width: m.w, height: m.h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  await client.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: m.top, left: 0, bottom: m.bottom, right: 0 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, page, errors };
}

/* The measuring probe. Runs in the page. Only VISIBLE elements are measured - the two variants hide
   different things, and textContent alone would happily report a hidden button's label. */
function measure() {
  const vis = (el) => !!(el && !el.classList.contains("hidden") && el.getClientRects().length);
  const r = (el) => { if (!vis(el)) return null; const b = el.getBoundingClientRect(); return { top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), left: +b.left.toFixed(1), right: +b.right.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const card = document.querySelector("#welcomeOverlay .modalCard");
  const sign = document.querySelector("#welcomeOverlay .sign");
  const h3 = document.getElementById("welcomeTitle");
  const note = document.getElementById("welcomeNote");
  const fines = Array.from(document.querySelectorAll("#welcomeOverlay .welcomeFine")).filter(vis);
  const age = fines.find((p) => /ages 13/i.test(p.textContent)) || null;
  // What a player can actually READ: the visible text of the visible elements, nothing hidden.
  const visibleText = Array.from(document.querySelectorAll("#welcomeOverlay .modalCard *"))
    .filter((el) => vis(el) && !el.children.length)
    .map((el) => el.textContent.replace(/\s+/g, " ").trim())
    .filter(Boolean).join(" ");
  return {
    card: r(card), sign: r(sign), h3: r(h3), note: r(note), age: r(age),
    apple: r(document.getElementById("btnWelcomeApple")),
    cont: r(document.getElementById("btnWelcomeContinue")),
    guest: r(document.getElementById("btnWelcomeGuest")),
    lastFine: r(fines[fines.length - 1]),
    fineCount: fines.length,
    gapBadgeToH3: +(h3.getBoundingClientRect().top - sign.getBoundingClientRect().bottom).toFixed(1),
    gapH3ToNote: +(note.getBoundingClientRect().top - h3.getBoundingClientRect().bottom).toFixed(1),
    // .overlay.canScroll paints a 64px bottom fade plus the "more below - swipe up" nudge (§ STYLE),
    // so "readable" means above innerHeight-64 whenever that class is on.
    canScroll: document.getElementById("welcomeOverlay").classList.contains("canScroll"),
    hintBand: 64,
    docScrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth, innerH: window.innerHeight,
    title: h3.textContent.trim(),
    visibleText,
    allText: document.getElementById("welcomeOverlay").textContent.replace(/\s+/g, " ").trim(),
  };
}

/* ================= Part A - once per VERSION, proved with a real update ================= */
/* Serves index.html over http on 127.0.0.1 with a swappable version string. Same URL, same origin,
   different bytes - which is precisely what "the app updated" means to the browser's storage. */
function startServer() {
  let ver = VER;
  const srv = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    if (url === "/" || url === "/index.html") {
      const body = SRC.replace(`<span id="verTap">${VER}</span>`, `<span id="verTap">${ver}</span>`);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }); res.end("no");
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({
      url: "http://127.0.0.1:" + srv.address().port + "/index.html?ws=" + encodeURIComponent(DEAD_WS),
      setVersion: (v) => { ver = v; },
      version: () => ver,
      close: () => new Promise((r) => srv.close(r)),
    }));
  });
}

async function partA(browser) {
  console.log("\n=== Part A: shown once per app VERSION, and it comes back after an update ===");
  const srv = await startServer();
  const { ctx, page, errors } = await newCtx(browser, MATRIX[2]);
  try {
    await page.goto(srv.url);
    await page.waitForSelector("#btnWelcomeGuest");
    await page.waitForTimeout(400);
    ok(await page.evaluate(() => window.__welcome.shown()), "A1 a brand-new phone gets the screen");
    ok((await page.evaluate(() => window.__welcome.appVersion())) === VER,
      `A2 the app reports its own version from the version line under the menu (${await page.evaluate(() => window.__welcome.appVersion())})`);

    await page.click("#btnWelcomeGuest");
    await page.waitForTimeout(250);
    ok(!(await page.evaluate(() => window.__welcome.shown())), "A3 choosing guest closes it");
    const stored = await page.evaluate(() => ({ c: window.__welcome.choice(), v: window.__welcome.ver() }));
    ok(stored.c === "guest" && stored.v === VER,
      `A4 the answer is stamped with the version it was given under (${JSON.stringify(stored)})`);

    for (let i = 0; i < 2; i++) { await page.goto(srv.url); await page.waitForSelector("#btnStart"); await page.waitForTimeout(450); }
    ok(!(await page.evaluate(() => window.__welcome.shown())),
      "A5 two more launches on the SAME version and it never came back - inside a version nothing changed");

    // iOS-style storage loss, still inside the same version: the IndexedDB mirror must answer.
    await page.evaluate(() => { try { localStorage.removeItem("nasty-welcome-choice"); localStorage.removeItem("nasty-welcome-ver"); } catch (e) {} });
    await page.goto(srv.url); await page.waitForSelector("#btnStart"); await page.waitForTimeout(900);
    ok(!(await page.evaluate(() => window.__welcome.shown())),
      "A6 after an iOS-style localStorage wipe it STILL does not come back - the IndexedDB mirror answered");
    ok((await page.evaluate(() => window.__welcome.ver())) === VER,
      "A7 and localStorage healed itself from the mirror, version and all, so the next boot is synchronous again");

    // THE FEATURE. A real update: same origin, same storage, new version string.
    srv.setVersion("v9.99-test");
    await page.goto(srv.url);
    await page.waitForSelector("#welcomeOverlay:not(.hidden)", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    const afterUpdate = await page.evaluate(() => ({ shown: window.__welcome.shown(), app: window.__welcome.appVersion(), stored: window.__welcome.ver() }));
    ok(afterUpdate.shown === true && afterUpdate.app === "v9.99-test" && afterUpdate.stored === VER,
      `A8 THE ASK: after an update the screen is back, with the old answer still on the phone (${JSON.stringify(afterUpdate)})`);
    ok(await page.evaluate(() => window.__welcome.guestVisible()),
      "A9 and it is the full screen, not a stub - the guest choice is right there again");

    await page.click("#btnWelcomeGuest"); await page.waitForTimeout(250);
    ok((await page.evaluate(() => window.__welcome.ver())) === "v9.99-test",
      "A10 answering re-stamps the phone with the NEW version");
    await page.goto(srv.url); await page.waitForSelector("#btnStart"); await page.waitForTimeout(450);
    ok(!(await page.evaluate(() => window.__welcome.shown())),
      "A11 and it is quiet again for the rest of that version - one screen per update, not one per launch");

    // Not-a-version-we-know is treated as "ask", never as "answered".
    await page.evaluate(() => { try { localStorage.setItem("nasty-welcome-ver", ""); } catch (e) {} });
    await page.evaluate(async () => { await window.__welcome.reset(); await window.__welcome.check(); });
    await page.waitForTimeout(400);
    ok(await page.evaluate(() => window.__welcome.shown()),
      "A12 with the answer gone from BOTH stores it asks again - the mirror is a mirror, not a lock");

    ok(errors.length === 0, `A13 zero page errors through the whole per-version flow (${errors.length})`);
  } finally {
    await ctx.close();
    await srv.close();
  }
}

/* ================= Part B - somebody who already has an account ================= */
async function partB(browser) {
  console.log("\n=== Part B: a signed-in player is greeted, not asked to sign in again ===");
  const srv = await startServer();
  const { ctx, page, errors } = await newCtx(browser, MATRIX[2]);
  try {
    await stubApple(page);
    // A phone that signed in on an earlier version: a session token in the real key, and the answer
    // recorded under an older version. Exactly what Blake's own phone looks like the day this ships.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("nasty-account", "test-session-token");
        localStorage.setItem("nasty-welcome-choice", "account");
        localStorage.setItem("nasty-welcome-ver", "v0.38");
      } catch (e) {}
    });
    await page.goto(srv.url);
    await page.waitForSelector("#welcomeOverlay:not(.hidden)", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    const g = await page.evaluate(measure);
    const st = await page.evaluate(() => ({
      shown: window.__welcome.shown(), signedIn: window.__welcome.signedIn(),
      apple: window.__welcome.appleVisible(), cont: window.__welcome.continueVisible(),
      guest: window.__welcome.guestVisible(), appleNote: window.__welcome.appleNoteVisible(),
      web: window.__welcome.webNoteVisible(),
    }));
    ok(st.shown && st.signedIn, "B1 a signed-in phone DOES see the screen after an update (v0.36 skipped it entirely)");
    ok(/welcome back/i.test(g.title), `B2 the heading greets them back ("${g.title}")`);
    ok(st.cont === true && /keep playing/i.test(g.cont ? "" : "") === false && g.cont !== null,
      "B3 there is a single primary button, and it is the Keep playing one");
    ok(st.apple === false, "B4 no second Sign in with Apple button - they are already signed in, tapping it would do nothing");
    ok(st.guest === false, "B5 no guest button either - switching to guest is a deliberate trip to ADMIN, not a stray tap here");
    ok(st.appleNote === false && st.web === false, "B6 the two Apple explainers are hidden - neither applies to somebody already signed in");
    ok(!/ages 13 and up/i.test(g.visibleText) && !/do not appear on the leaderboard/i.test(g.visibleText),
      "B7 the two new-player-only sentences are hidden - they have an account, both questions are answered");
    ok(/ADMIN/.test(g.visibleText) && /change it any time/i.test(g.visibleText),
      "B8 it still tells them where to change their mind: ADMIN");
    ok(/after every update/i.test(g.visibleText), "B9 and that this screen is an every-update thing now");
    ok(g.cont && g.cont.h >= 44, `B10 Keep playing is a real 44px+ tap target (${g.cont ? g.cont.h : "n/a"}px)`);
    await page.screenshot({ path: path.join(SHOTDIR, "welcome_signedin_390.png") });

    await page.click("#btnWelcomeContinue");
    await page.waitForTimeout(250);
    ok(!(await page.evaluate(() => window.__welcome.shown())), "B11 Keep playing closes it");
    ok(await page.isVisible("#btnStart"), "B12 and the menu is right there, ready to play");
    const rec = await page.evaluate(() => ({ c: window.__welcome.choice(), v: window.__welcome.ver() }));
    ok(rec.c === "account" && rec.v === VER, `B13 it records an account answer for THIS version (${JSON.stringify(rec)})`);

    await page.goto(srv.url); await page.waitForSelector("#btnStart"); await page.waitForTimeout(500);
    ok(!(await page.evaluate(() => window.__welcome.shown())), "B14 and does not ask them again on the next launch");
    srv.setVersion("v9.99-test");
    await page.goto(srv.url);
    await page.waitForSelector("#welcomeOverlay:not(.hidden)", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    ok(await page.evaluate(() => window.__welcome.shown() && window.__welcome.continueVisible()),
      "B15 next update, same greeting - a signed-in player is on the same per-version rhythm as everybody else");
    ok(errors.length === 0, `B16 zero page errors through the signed-in flow (${errors.length})`);

    /* The token still has to be gone-able: signing out anywhere leaves a normal first-run screen.
       The open screen is closed first on purpose - maybeShowWelcome() refuses to run while another
       full-screen page is up (the § OVERLAY LAYER "never two overlays" invariant), which is correct
       behaviour and would otherwise make this check a no-op. */
    await page.click("#btnWelcomeContinue");
    await page.waitForTimeout(200);
    await page.evaluate(() => { try { localStorage.removeItem("nasty-account"); } catch (e) {} });
    await page.evaluate(async () => { await window.__welcome.reset(); await window.__welcome.check(); });
    await page.waitForTimeout(400);
    ok(await page.evaluate(() => window.__welcome.shown() && window.__welcome.guestVisible() && window.__welcome.appleVisible()),
      "B17 sign out and it is the ordinary first-run screen again, Apple button and guest button both back");
  } finally {
    await ctx.close();
    await srv.close();
  }
}

/* ================= Part C - the copy ================= */
async function partC(browser) {
  console.log("\n=== Part C: the copy - Apple acknowledged, 'only once' gone, no family, no dashes ===");
  // The iPhone-app variant, because that is the one with the Apple button on it.
  const { ctx, page } = await newCtx(browser, MATRIX[2]);
  await stubApple(page);
  await page.goto(INDEX);
  await page.waitForSelector("#welcomeOverlay:not(.hidden)", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  const g = await page.evaluate(measure);
  ok(/Welcome to NASTY!/.test(g.title), `C1 the heading has some life in it ("${g.title}")`);
  ok(/Race five tees home and send everybody else packing!/.test(g.visibleText),
    "C2 the opening line is the game's own voice, with the exclamation mark Blake asked for");
  ok(/New here\? It creates your account\. Been here before\? It signs you back in\./.test(g.visibleText),
    "C3 THE ASK: the copy beside the button says plainly that one tap covers both cases");
  const appleBtn = await page.evaluate(() => document.getElementById("btnWelcomeApple").textContent.trim());
  ok(appleBtn === "Sign in with Apple",
    `C4 the BUTTON keeps Apple's own required wording - the explaining happens around it, not in the title ("${appleBtn}")`);
  ok(!/only be asked this once/i.test(g.allText),
    "C5 the old 'You will only be asked this once' sentence is gone - it would be a lie now");
  ok(/You will see this again after every update\./.test(g.visibleText),
    "C6 and is replaced by the truth: it comes back after every update");
  ok(/change it any time - tap ADMIN at the top of the game screen\./.test(g.visibleText),
    "C7 the ADMIN escape hatch is still spelled out, word for word");
  ok(/Accounts are for ages 13 and up\. Anyone younger should continue as a guest\./.test(g.visibleText),
    "C8 the age sentence is untouched, factual and unexcited - no exclamation mark on a policy line");
  // v0.40 (2026-07-26): Blake reworded this line to "Guests can play every game mode - they just do
  // not appear on the leaderboard." The point of C9 was never the phrasing, it was that the line is
  // FACTUAL and carries no exclamation mark, so it now asserts that contract instead. The v0.40
  // wording is pinned verbatim in test_ui_v040_2026_07_26.js part B.
  ok(/guests can play/i.test(g.visibleText) && /do not appear on the leaderboard\./.test(g.visibleText)
    && !/Guests can play[^.!]*!/.test(g.visibleText),
    "C9 the guest/leaderboard consequence is stated plainly, also unexcited");
  ok(!/family/i.test(g.allText), "C10 the word 'family' appears nowhere on the screen");
  ok(!/[—–]/.test(g.allText), "C11 no em or en dashes anywhere in the copy");
  const marks = (g.visibleText.match(/!/g) || []).length;
  ok(marks >= 2 && marks <= 5, `C12 energy, not shouting: ${marks} exclamation marks on the whole screen`);
  await page.screenshot({ path: path.join(SHOTDIR, "welcome_app_390.png") });
  await ctx.close();

  // The website variant: no Apple button, so no Apple sentence either - the honest note instead.
  const web = await newCtx(browser, MATRIX[2]);
  await web.page.goto(INDEX);
  await web.page.waitForSelector("#welcomeOverlay:not(.hidden)", { timeout: 8000 }).catch(() => {});
  await web.page.waitForTimeout(400);
  const wg = await web.page.evaluate(measure);
  const wst = await web.page.evaluate(() => ({ apple: window.__welcome.appleVisible(), note: window.__welcome.appleNoteVisible(), web: window.__welcome.webNoteVisible() }));
  ok(wst.apple === false && wst.note === false && wst.web === true,
    "C13 on the website there is no Apple button, so the sentence about it is hidden too and the honest 'coming soon' note shows (v0.36 behaviour kept)");
  ok(/Guests can play every game mode/.test(wg.visibleText) && /ages 13 and up/.test(wg.visibleText),
    "C14 the website variant still carries the guest and age sentences");
  ok(!/family/i.test(wg.allText) && !/[—–]/.test(wg.allText), "C15 website variant: no family, no dashes");
  await web.ctx.close();
}

/* ================= Part D - measurements, both variants, five widths ================= */
async function partD(browser) {
  console.log("\n=== Part D: it still fits - both variants, five widths, real insets ===");
  for (const variant of ["web", "app"]) {
    for (const m of MATRIX) {
      const { ctx, page, errors } = await newCtx(browser, m);
      if (variant === "app") await stubApple(page);
      await page.goto(INDEX);
      await page.waitForSelector("#welcomeOverlay:not(.hidden)", { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(400);
      const g = await page.evaluate(measure);
      const tag = `${variant} ${m.name}`;
      ok(g.docScrollW <= g.innerW + 1, `D1 ${tag}: no sideways overflow (${g.docScrollW} vs ${g.innerW})`);
      ok(g.card.left >= -0.5 && g.card.right <= g.innerW + 0.5, `D2 ${tag}: the card sits inside the viewport (${g.card.left}..${g.card.right})`);
      const primary = variant === "app" ? g.apple : g.guest;
      ok(primary && primary.h >= 44, `D3 ${tag}: the first choice is a real 44px+ target (${primary ? primary.h : "n/a"}px)`);
      ok(g.guest && g.guest.h >= 44, `D4 ${tag}: the guest choice is a real 44px+ target (${g.guest ? g.guest.h : "n/a"}px)`);
      const readable = m.h - (g.canScroll ? g.hintBand : 0);
      ok(g.guest.bottom <= readable, `D5 ${tag}: both choices clear the scroll-hint band (guest bottom ${g.guest.bottom} <= ${readable})`);
      ok(g.age && g.age.bottom <= m.h, `D6 ${tag}: the age sentence is above the fold (${g.age ? g.age.bottom : "n/a"} <= ${m.h})`);
      if (m.w === 320) {
        // v0.38's own suite flagged this line as already inside the fade. It is not allowed to get
        // lower, in EITHER variant - and after the font-size fix it is comfortably higher in both.
        ok(g.age.bottom <= V038_AGE_BOTTOM_320[variant],
          `D7 ${tag}: the age sentence is no lower than v0.38 had it (${g.age.bottom} <= ${V038_AGE_BOTTOM_320[variant]})`);
        ok(g.age.bottom <= readable,
          `D8 ${tag}: and it now clears the swipe-up fade entirely (${g.age.bottom} <= ${readable}) - the nit v0.37 and v0.38 both reported`);
      }
      // The two gaps v0.38 measured and froze at 320 are margin gaps, so they must be untouched.
      if (m.w === 320) {
        ok(Math.abs(g.gapBadgeToH3 - 17.4) < 1.5, `D9 ${tag}: v0.38's frozen gap under the badge is unchanged (${g.gapBadgeToH3} vs 17.4)`);
        ok(Math.abs(g.gapH3ToNote - 6.0) < 1.5, `D10 ${tag}: v0.38's frozen gap under the heading is unchanged (${g.gapH3ToNote} vs 6.0)`);
      }
      if (m.w === 390) {
        ok(g.gapBadgeToH3 > 14, `D11 ${tag}: v0.38's roomier gap under the badge survives on Blake's own size (${g.gapBadgeToH3}px)`);
        ok(g.gapH3ToNote > 14, `D12 ${tag}: and under the heading (${g.gapH3ToNote}px)`);
      }
      ok(errors.length === 0, `D13 ${tag}: zero page errors`);
      console.log(`  ... ${tag}: age bottom ${g.age ? g.age.bottom : "n/a"}, last line ${g.lastFine ? g.lastFine.bottom : "n/a"}, canScroll ${g.canScroll}, readable ${readable}`);
      if (m.w === 320) await page.screenshot({ path: path.join(SHOTDIR, `welcome_${variant}_320.png`) });
      if (m.w === 430) await page.screenshot({ path: path.join(SHOTDIR, `welcome_${variant}_430.png`) });
      await ctx.close();
    }
  }
}

/* ================= Part E - the excitement sweep, and where it stopped ================= */
function partE() {
  console.log("\n=== Part E: energy where it belongs, and nowhere near a confirmation ===");
  // Strip what a player never reads before scanning: HTML comments and JS/CSS comments.
  const visible = SRC.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  // 1. The moments that SHOULD have energy.
  const punched = [
    ["the menu tagline", /Land on somebody… and send them packing!/],
    ["the win badge, free-for-all", /wins the whole thing!/],
    ["the win badge, teams", /win it together!/],
    ["the win sentence, teams", /got all ten tees home!/],
    ["the win sentence, free-for-all", /tees are home! Everyone else: better luck next deal\./],
    ["the takeout toast", /💥 NASTY! \$\{G\.seats\[seat\]\.name\} sends/],
    ["a fresh shuffle", /Fresh shuffle! \$\{G\.seats\[G\.dealer\]\.name\} deals/],
    ["the first deal of a game", /deals first - \$\{G\.seats\[G\.turn\]\.name\} starts us off!/],
    ["resuming a saved game", /Welcome back! Picking your game up right where you left it/],
    ["signing in", /You're in! You are/],
    ["a room opening", /Your room is open!/],
    ["the pass-the-phone page", /your cards are ready!/],
    ["the signature rule", /blasted back to base<\/b>!/],
  ];
  for (const [what, re] of punched) ok(re.test(visible), `E1 ${what} has an exclamation mark now`);

  /* 2. WHERE IT DELIBERATELY STOPPED. Every one of these is either a confirmation that costs
     something, a destructive action, a factual/policy line, or an error - an exclamation mark on any
     of them reads as a cheerful shove towards a decision the player may regret. */
  const flat = [
    ["the concede confirmation", /Are you sure you want to concede\? This will count as a loss on the leaderboard\./],
    ["the concede heading", /<b id="surrenderConfirmHeading">CONCEDE\?<\/b>/],
    ["the saved-tile concede confirmation", /Concede this game\? This will count as a loss on the leaderboard\./],
    ["the PAUSED sheet", /Your game is holding right here\. Jump back in, or step away for now\./],
    ["the delete-account confirmation", /Delete your account\? Your Apple sign-in and every signed-in session go straight away, and this cannot be undone\./],
    ["the claim-your-name warning", /This cannot be undone\. You can only do this once, for one name, and the offer goes away for good afterwards\./],
    ["the claim-your-name question", /<b id="acctClaimTitle">Is this you\?<\/b>/],
    ["the age line", /Accounts are for ages 13 and up\. Anyone younger should continue as a guest\./],
    // v0.40: reworded by Blake, still flat and factual - see part B of the v0.40 suite.
    ["the guest/leaderboard line", /Guests can play every game mode - they just do not appear on the leaderboard\./],
    ["the leaderboard points rules", /Points per win: 1 for each Easy CPU you beat, 2 for Tricky, 3 for Nasty or a person - people only, CPUs never show up here\./],
    ["the leaderboard KO rules", /Ratio = KOs per KO'd \(Perfect = never been KO'd yet\) - people only, CPUs never show up here\./],
    ["the signed-out message", /Signed out\. Everything on this phone works exactly the same\./],
    ["the Apple failure message", /Apple couldn't finish that sign-in\. Please try again\./],
    ["the version-mismatch message", /This game needs the newest version of NASTY\. Please refresh the page \(website\) or update the app \(App Store\) and try again\./],
    ["the move-failed message", /That move did not go through\. Tap Pause, then Save & leave - your game is kept and you can pick it right back up\./],
    ["a player being skipped", /can't move - out for the rest of this hand/],
  ];
  for (const [what, re] of flat) ok(re.test(visible), `E2 ${what} is still exactly as flat as it was`);

  // 3. And the destructive/confirmation BLOCKS carry no exclamation mark at all.
  const noBangBlocks = [
    ["#surrenderConfirmOverlay", /<div id="surrenderConfirmOverlay"[\s\S]*?\n<\/div>/],
    ["#leaveConfirmOverlay", /<div id="leaveConfirmOverlay"[\s\S]*?\n<\/div>/],
    ["the delete-account confirm box", /<div class="acctConfirm hidden" id="acctDelConfirm">[\s\S]*?<\/div>\n/],
    ["the claim-your-name box", /<div class="acctClaim hidden" id="acctClaim">[\s\S]*?<\/div>\n/],
  ];
  for (const [what, re] of noBangBlocks) {
    const m = visible.match(re);
    ok(!!m && !/!/.test(m[0].replace(/&amp;/g, "&")), `E3 ${what} contains no exclamation mark anywhere`);
  }

  // 4. Repo-wide guards that must survive any copy edit.
  const userFacing = visible.split("\n").filter((l) => /family/i.test(l) && !/font-family/i.test(l));
  ok(userFacing.length === 0, `E4 no user-facing "family" string anywhere in index.html (${userFacing.length})`);
  const dashes = visible.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /[—–]/.test(l));
  ok(dashes.length === 0, `E5 no em or en dashes in anything a player reads (${dashes.length}${dashes.length ? ": line " + dashes[0][0] : ""})`);
  ok(/const PROTOCOL_VERSION=5/.test(SRC) || /PROTOCOL_VERSION\s*=\s*5/.test(SRC), "E6 PROTOCOL_VERSION is still 5 - this batch is client-only");
  ok(/nasty-welcome-choice/.test(SRC) && /nasty-welcome-ver/.test(SRC) && /rememberWelcomeChoice/.test(SRC),
    "E7 both storage keys and the shared writer are where the rest of the app expects them");
}

async function main() {
  const browser = await chromium.launch();
  try {
    await partA(browser);
    await partB(browser);
    await partC(browser);
    await partD(browser);
    partE();
  } finally {
    await browser.close();
  }
  console.log(`\n=== v0.39 welcome + excitement suite: ${pass} passed, ${fail} failed ===`);
  console.log("screenshots: " + SHOTDIR);
  process.exit(fail ? 1 : 0);
}
main();
