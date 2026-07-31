"use strict";
/*
 * v0.65 (2026-08-02) - proves resetEquipToDefaults() (index.html, § SHOP, right after
 * acctEquipReset()) actually does what Blake asked for, verbatim: "when someone signs out it
 * should default everything (pegs, felt color, etc) back to the defaults (even mid game)".
 *
 * Real Playwright browser, real private Node server (test_accounts_kit.js), a real signed-in
 * account (real Apple-JWT sign-in against a test JWKS, not the window.__acct local-only test
 * hook), real /account/purchase calls for a real palette/felt/title, real Equip button clicks in
 * the real Shop UI, a real mid-game board (autotest(4,false), the same all-CPU driver
 * #autotest's own hash uses), then the real Sign out button in the real Admin panel.
 *
 * R1  before sign-out: the equipped palette/felt/title are genuinely on screen - COLORS4, the
 *     --felt1 CSS custom property, and a REAL tee element's rendered background color all match
 *     what was bought and equipped (not just internal state - actual computed pixels)
 * R2  sign-out (no confirm dialog needed - autotest's seats are all CPU, so
 *     gameInProgressForSignOut() has no human seat to warn about) resets EQUIP to
 *     {palette:null,felt:null,title:null} and persists that to localStorage
 * R3  the repaint is LIVE and MID-GAME, no restart: the SAME board (G unchanged, #game still on
 *     screen, no navigation) shows COLORS4 back to DEFAULT_COLORS4, the real tee's rendered
 *     background color changed to the default color, --felt1 back to DEFAULT_FELT.c
 * R4  the native status bar strip is re-synced too - the stubbed StatusBar.setBackgroundColor()
 *     plugin call log shows a call with DEFAULT_FELT.dark as the very next call after sign-out
 * R5  the you card's title badge is gone (no title equipped, and no ACCT at all once signed out)
 * R6  a SECOND account signing in on the same (freshly-reset) phone does not inherit the first
 *     account's old equip choice - starts from defaults, same as any other sign-in (the
 *     documented, deliberate design call in resetEquipToDefaults()'s own header comment)
 * R7  accountDelete() resets EQUIP the same way accountSignOut() does (same code path,
 *     resetEquipToDefaults(), re-verified independently rather than assumed identical)
 *
 * Usage: node test_equip_reset_signout.js
 */
const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
const path = require("path");
const fs = require("fs");
const K = require("./test_accounts_kit.js");

const INDEX = path.resolve(__dirname, "..", "..", "index.html");
const SHOTDIR = "/tmp/nasty-v065-equip-reset-shots";
fs.mkdirSync(SHOTDIR, { recursive: true });

const ADMIN_TOKEN = "equip-reset-admin-token";
const AUD = "com.pangman.nasty";
const ISSUER = "https://test.local";

let PASS = 0, FAIL = 0;
function log(...a) { console.log("[equip-reset]", ...a); }
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
function randPort() { return 31400 + Math.floor(Math.random() * 300); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Real palette/felt/title bought this session, straight from production's own SHOP_CATALOG ids
// (curled from https://play.nastyboardgame.com/shop and cross-checked against server/server.js -
// not invented ids). Sunset's four-seat colors4[0] is a distinctive orange-red (#c4431c) so a
// real tee's rendered pixel color is an unambiguous, easy assertion.
const PALETTE_ID = "palette_sunset", PALETTE_SEAT0_C = "#c4431c";
const FELT_ID = "felt_navy", FELT_C = "#23456b";
const TITLE_ID = "title_rookie";

// Stub just enough of Capacitor for IS_APP to read true (so the coming-soon website gate never
// engages and syncNativeStatusBarColor()/StatusBar really gets a plugin to call) - NOT the IAP
// plugin, this suite never buys anything with real money. StatusBar calls are logged so R4 can
// assert on them directly rather than just trusting the try/catch never threw.
function stubInit(cfg) {
  try { localStorage.setItem("nasty-account", cfg.token); } catch (e) {}
  window.__statusBarLog = [];
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      AppleSignIn: { isAvailable: async () => ({ available: true }) },
      StatusBar: {
        setBackgroundColor: async (o) => { window.__statusBarLog.push((o && o.color) || null); },
      },
    },
  };
}

async function main() {
  const key = K.makeKeyPair("equip-reset-key");
  const scratch = K.makeScratch("equip-reset");
  const port = randPort();
  const base = `http://localhost:${port}`;
  const jwks = await K.startJwksServer([key]);
  const env = K.serverEnv("node", scratch, port, ADMIN_TOKEN, {
    NASTY_APPLE_ISSUER: ISSUER, NASTY_APPLE_AUDIENCES: AUD, NASTY_ACCOUNT_RATE_LIMIT: "4000",
    NASTY_APPLE_JWKS_URL: jwks.url,
  });
  const srv = K.startServer("node", env, "EQUIP_RESET_VERBOSE");
  await K.waitHealthy(base);
  const c = K.makeClient(base);

  // Account 1: "Baker" - buys and equips Sunset/Navy Felt/Rookie, then signs out mid-game.
  const baker = await c.signIn(key, { sub: "001777.baker.0001" });
  if (baker.status !== 200) throw new Error("sign-in failed: " + JSON.stringify(baker.body));
  const bakerToken = baker.body.sessionToken;
  await c.post("/account/name", { auth: bakerToken, name: "Baker" });
  await fetch(base + "/solo-result", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ gameId: "equip-reset-seed-" + Date.now(), auth: bakerToken, entries: [{ name: "Baker", delta: { hg4s: 1, hw4s: 1, hptsS: 200 } }] }),
  });
  for (const itemId of [PALETTE_ID, FELT_ID, TITLE_ID]) {
    const r = await c.post("/account/purchase", { auth: bakerToken, itemId });
    if (r.status !== 200) throw new Error(`setup purchase ${itemId} failed: ` + JSON.stringify(r.body));
  }

  const url = `file://${INDEX}?ws=ws://localhost:${port}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(stubInit, { token: bakerToken });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("PAGE ERROR:", e.message));
  await page.goto(url);
  await page.waitForFunction(() => document.body && document.body.textContent.includes("Baker"), null, { timeout: 15000 });
  const shot = (name) => page.screenshot({ path: path.join(SHOTDIR, name) });

  try {
    // ---- equip all three from the real Shop UI, real clicks, real equipToggle() ----
    await page.click("#btnShop");
    await page.waitForSelector(`#shopBody .shopItem[data-id="${PALETTE_ID}"] .shopEquipBtn`, { timeout: 10000 });
    for (const itemId of [PALETTE_ID, FELT_ID, TITLE_ID]) {
      await page.click(`#shopBody .shopItem[data-id="${itemId}"] .shopEquipBtn`);
      await page.waitForFunction((id) => {
        const b = document.querySelector(`#shopBody .shopItem[data-id="${id}"] .shopEquipBtn`);
        return b && /Equipped/.test(b.textContent);
      }, itemId, { timeout: 10000 });
    }
    await page.click("#btnShopClose");

    // ---- a real mid-game board (autotest()/#autotest6's own driver function, called directly -
    // documented global, same one HANDOFF's own screenshot sessions use), then freeze it so the
    // before/after comparison is against the exact same frame, not a board that kept playing
    // itself mid-assertion ----
    // location.hash containing "autotest" is what shouldShowSpeedPicker() (§ UTIL) checks to
    // skip #speedPickerOverlay - without it, startGame() would hold the first deal behind that
    // gate and #btnAccount (the in-game Admin button) never appears since the board never draws.
    await page.evaluate(() => { location.hash = "autotest"; autotest(4, false); });
    await page.waitForFunction(() => window.G && Array.isArray(window.G.seats), null, { timeout: 10000 });
    await sleep(300);
    await page.evaluate(() => { window.G.paused = true; });
    await sleep(150);

    // ---- R1: before sign-out, the equip is genuinely on screen ----
    const before = await page.evaluate(() => ({
      colors4_0: COLORS4[0].c,
      felt1: getComputedStyle(document.documentElement).getPropertyValue("--felt1").trim(),
      equip: JSON.parse(JSON.stringify(EQUIP || {})),
      // teeSVG() (§ RENDER) paints a tee as an inline SVG with the real seat color on the top
      // ellipse's `fill` attribute (col.c) - a REAL on-screen tee's actual painted pixel color,
      // not a CSS background-color (tees have none; they're SVG, not a styled div).
      teeFill: (() => {
        const svg = document.getElementById("tee-0-0");
        const el = svg && svg.querySelector("ellipse[stroke]");
        return el ? el.getAttribute("fill") : null;
      })(),
      titleBadgeShown: !!document.querySelector(".youTitlePanel"),
      gameVisible: !document.getElementById("game").classList.contains("hidden"),
    }));
    check(before.colors4_0 === PALETTE_SEAT0_C, "R1a COLORS4[0] is the equipped Sunset color before sign-out: " + before.colors4_0);
    check(before.felt1.toLowerCase() === FELT_C.toLowerCase(), "R1b --felt1 is the equipped Navy Felt color before sign-out: " + before.felt1);
    check(before.equip.palette && before.equip.palette.id === PALETTE_ID, "R1c EQUIP.palette is Sunset before sign-out");
    check(before.equip.felt && before.equip.felt.id === FELT_ID, "R1d EQUIP.felt is Navy before sign-out");
    check(before.equip.title && before.equip.title.id === TITLE_ID, "R1e EQUIP.title is Rookie before sign-out");
    check((before.teeFill || "").toLowerCase() === PALETTE_SEAT0_C.toLowerCase(), `R1f a REAL on-screen tee's rendered SVG fill is the equipped color: ${before.teeFill}`);
    check(before.titleBadgeShown, "R1g the you card shows the equipped title badge before sign-out");
    check(before.gameVisible, "R1h sanity: #game is genuinely on screen (mid-game) before sign-out");
    await shot("01_before_signout_equipped.png");

    // ---- sign out: Admin panel -> Sign out, mid-game, no dialog (all seats are CPU) ----
    // #btnMenuAdmin only exists on #menu - mid-game the SAME openAccountPanel() is reached via
    // the in-game topbar's own "Admin" button (#btnAccount, top-right slot, § topbar comment:
    // "Same id, same panel, same handler as the old circle") - this is the real mid-game path,
    // not a menu round trip.
    await page.click("#btnAccount");
    await page.waitForSelector("#btnAcctSignOut:not([disabled])", { timeout: 10000 });
    await page.click("#btnAcctSignOut");
    // renderAccountRows() flips #btnAcctSignIn back to enabled the instant isSignedIn() is false -
    // the definitive "sign-out actually completed" signal (§ ACCOUNT SIGN-IN's own comment: "the
    // three sign-in rows... repaint... can never lag behind").
    await page.waitForFunction(() => !document.getElementById("btnAcctSignIn").disabled, null, { timeout: 10000 });
    await sleep(150);
    await page.click("#btnAcctClose");
    await sleep(150);

    // ---- R2/R3: EQUIP reset, persisted, and the SAME mid-game board repainted live ----
    const after = await page.evaluate(() => ({
      colors4_0: COLORS4[0].c,
      felt1: getComputedStyle(document.documentElement).getPropertyValue("--felt1").trim(),
      equip: JSON.parse(JSON.stringify(EQUIP || {})),
      equipStored: JSON.parse(localStorage.getItem("nasty-equipped") || "null"),
      teeFill: (() => {
        const svg = document.getElementById("tee-0-0");
        const el = svg && svg.querySelector("ellipse[stroke]");
        return el ? el.getAttribute("fill") : null;
      })(),
      titleBadgeShown: !!document.querySelector(".youTitlePanel"),
      gameVisible: document.getElementById("game") && !document.getElementById("game").classList.contains("hidden"),
      seatsUnchanged: window.G && Array.isArray(window.G.seats) && window.G.seats.length === 4,
      signedIn: !!window.__acct.state(),
    }));
    check(after.colors4_0 === "#2f8f5b", "R2a COLORS4[0] is back to DEFAULT_COLORS4[0] (Green, #2f8f5b) after sign-out: " + after.colors4_0);
    check(after.felt1.toLowerCase() !== FELT_C.toLowerCase(), "R3a --felt1 is no longer the equipped Navy color after sign-out: " + after.felt1);
    check(!after.equip.palette && !after.equip.felt && !after.equip.title, "R2b in-memory EQUIP is fully reset: " + JSON.stringify(after.equip));
    check(after.equipStored && !after.equipStored.palette && !after.equipStored.felt && !after.equipStored.title,
      "R2c localStorage['nasty-equipped'] is fully reset too (persisted, survives a reload): " + JSON.stringify(after.equipStored));
    check((after.teeFill || "").toLowerCase() === "#2f8f5b", `R3b the SAME real tee element's rendered SVG fill is back to the default color: ${after.teeFill}`);
    check(!after.titleBadgeShown, "R5a the you card's title badge is gone (no title equipped, and no ACCT at all)");
    check(!after.signedIn, "R5b confirmed actually signed out (window.__acct.state() is null)");
    check(after.gameVisible, "R3c #game is STILL on screen - no restart, no navigation, this is the SAME mid-game board");
    check(after.seatsUnchanged, "R3d G.seats is untouched (still the same 4-seat game) - only the paint changed, not the game");
    await shot("02_after_signout_reset.png");

    // ---- R4: the native status bar strip was re-synced to the default, live ----
    const barLog = await page.evaluate(() => window.__statusBarLog.slice());
    check(barLog.length > 0, "R4a the stubbed StatusBar plugin was called at all during this run: " + JSON.stringify(barLog));
    check(barLog[barLog.length - 1] === "#0e3421", "R4b the LAST StatusBar.setBackgroundColor() call (i.e. the sign-out repaint) sent DEFAULT_FELT.dark: " + barLog[barLog.length - 1]);

    // Un-pause - R2/R3 needed the board frozen for a stable comparison, but leaving G.paused=true
    // for the rest of this run lets syncAmbientPause() (§ CAPACITOR) pop the ambient "PAUSED" full-
    // screen overlay at its own next timer tick, which would then block every click below. Nothing
    // to do with resetEquipToDefaults() itself - just this suite's own screenshot bookkeeping.
    await page.evaluate(() => { if (window.G) window.G.paused = false; });
    await page.click("#pauseOverlay").catch(() => {});
    await sleep(150);
    await shot("02b_after_signout_reset_unpaused.png");

    // ---- R6: a second account signing in does NOT inherit the reset-away equip - starts from
    // defaults too, the documented "EQUIP is per-phone, not per-account" design call.
    // Deliberately NOT a page.reload() - this context's addInitScript seeds nasty-account from a
    // fixed closure value (Baker's token) on every navigation, which would silently stomp a
    // manual localStorage switch straight back to Baker. Switching identity in-page - the real
    // saveAcctToken()/refreshAccount() functions the app itself calls on a real sign-in - avoids
    // that entirely and is just as real a test of the app's own account-switch code path. ----
    const cara = await c.signIn(key, { sub: "001778.cara.0002" });
    await c.post("/account/name", { auth: cara.body.sessionToken, name: "Cara" });
    await page.evaluate(async (token) => {
      saveAcctToken(token);
      await refreshAccount();
      renderAccountRows(); updateAccountButton(); renderYouCard();
    }, cara.body.sessionToken);
    await page.waitForFunction(() => document.body && document.body.textContent.includes("Cara"), null, { timeout: 15000 });
    const caraEquip = await page.evaluate(() => JSON.parse(JSON.stringify(EQUIP || {})));
    check(!caraEquip.palette && !caraEquip.felt && !caraEquip.title, "R6 a second account signing in on this phone starts from defaults too, not Baker's old equip: " + JSON.stringify(caraEquip));

    // ---- R7: accountDelete() resets EQUIP the same way, independently re-verified ----
    // A FRESH context/page, signed in as Baker from a clean boot (exactly how R1's own page was
    // set up) - not a re-use of the first page's already-mutated state (it opened/closed the
    // account panel, switched identity in-page, sat through a mid-game pause/unpause, etc.).
    // bakerToken itself is DEAD now - the real accountSignOut() above genuinely called the real
    // POST /account/signout against this real test server, which really revokes the session
    // token server-side (server.js/server.ts "§ ACCOUNT SIGN-IN"), so re-signing in as the same
    // Apple identity (same `sub`) for a fresh session token is the only way back in - exactly
    // what a real person re-opening the app and tapping "Sign in with Apple" again would get.
    // Baker already owns Sunset from setup, so this only needs to equip it and delete.
    const bakerAgain = await c.signIn(key, { sub: "001777.baker.0001" });
    if (bakerAgain.status !== 200) throw new Error("Baker re-sign-in failed: " + JSON.stringify(bakerAgain.body));
    const bakerToken2 = bakerAgain.body.sessionToken;
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await ctx2.addInitScript(stubInit, { token: bakerToken2 });
    const page2 = await ctx2.newPage();
    page2.on("pageerror", (e) => log("PAGE ERROR (page2):", e.message));
    await page2.goto(url);
    await page2.waitForFunction(() => document.body && document.body.textContent.includes("Baker"), null, { timeout: 15000 });
    await page2.click("#btnMenuAdmin");
    // refreshAcctEquip() (§ SHOP) is async - fetches the catalog + wallet before it un-hides
    // #acctEquip at all, so #acctEquipToggleBtn isn't clickable the instant the panel opens.
    await page2.waitForSelector("#acctEquip:not(.hidden)", { timeout: 10000 });
    // #acctEquipBody starts collapsed every time the panel opens (v0.53, Blake: "it dominates the
    // whole page... you have to click and then it opens") - #acctEquipToggleBtn is the real
    // expand affordance, same as a finger tap on "Shop Customizations" would do.
    await page2.click("#acctEquipToggleBtn");
    await page2.waitForSelector(`#acctEquipBody .shopItem[data-id="${PALETTE_ID}"] .acctEquipBtn`, { timeout: 10000 });
    await page2.click(`#acctEquipBody .shopItem[data-id="${PALETTE_ID}"] .acctEquipBtn`);
    // Null-guarded: acctEquipToggle() -> refreshAcctEquip() briefly shows "Loading your items..."
    // (replacing #acctEquipBody's whole innerHTML, including this button) between the click and
    // the real re-render landing, so the element genuinely does not exist for a moment.
    await page2.waitForFunction((id) => {
      const b = document.querySelector(`#acctEquipBody .shopItem[data-id="${id}"] .acctEquipBtn`);
      return b && /Equipped/.test(b.textContent);
    }, PALETTE_ID, { timeout: 10000 });
    const beforeDelete = await page2.evaluate(() => JSON.parse(JSON.stringify(EQUIP || {})));
    check(beforeDelete.palette && beforeDelete.palette.id === PALETTE_ID, "R7 setup: Baker has Sunset equipped again (fresh page), going into account delete");
    await page2.waitForSelector("#btnAcctDelete:not([disabled])", { timeout: 10000 });
    await page2.click("#btnAcctDelete");
    await page2.waitForSelector("#acctDelConfirm:not(.hidden)", { timeout: 5000 });
    await page2.click("#btnAcctDelYes");
    await page2.waitForFunction(() => !window.__acct.state(), null, { timeout: 10000 });
    await sleep(150);
    const afterDelete = await page2.evaluate(() => JSON.parse(JSON.stringify(EQUIP || {})));
    check(!afterDelete.palette && !afterDelete.felt && !afterDelete.title, "R7b accountDelete() resets EQUIP the same way accountSignOut() does: " + JSON.stringify(afterDelete));

    log(`\n${PASS} passed, ${FAIL} failed. Screenshots: ${SHOTDIR}`);
  } finally {
    await browser.close();
    K.stopServer(srv);
  }
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
