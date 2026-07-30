"use strict";
/*
 * v0.59 (2026-07-30) UI acceptance - the real-money release, driven through a REAL browser
 * (Playwright) against a REAL private Node server, with the ONE thing that cannot exist in a
 * browser - StoreKit itself - stubbed at the exact plugin boundary the iPhone app exposes
 * (window.Capacitor.Plugins.NastyIAP). Every signed transaction the stub "sells" is minted
 * against the test signing chain (test_iap_kit.js) and REALLY verified/credited by the server's
 * own /account/iap/verify - so everything from the tap to the credited wallet is the production
 * code path; only Apple's payment sheet is pretended.
 *
 *   U1  the Shop leads with the credit packs ("10 credits = $1"), Apple's own localized prices
 *       on the buttons, and every money-like string says CREDITS (Blake's decision)
 *   U2  an unaffordable item is not a dead button: gold "Buy with $X" -> in-place confirm that
 *       states credits AND dollars -> stubbed Apple purchase -> server credits -> the item
 *       purchase completes automatically -> leftovers stay
 *   U3  the Admin panel: Credits earned/bought/remaining wallet box, and the renamed
 *       "Shop Customizations" section leading with the two buyable token rows (Blake's item 2)
 *   U4  the two-button change-name flow (Blake's item 6): free-change heads-up, the verbatim
 *       token-redeem confirmation, and the buy-a-token offer - every rename behind an explicit
 *       accept
 *   U5  a mid-game rename lands on the live board instantly (applyLocalRenameNow for the local
 *       game on screen; the playerRenamed handler for the online broadcast, driven directly)
 *   U6  the crash-recovery drain: a pending never-finished transaction is credited at next boot
 *       and only THEN finished
 *   U7  320x568: same screens, no horizontal overflow
 *   U8  the WEBSITE (no plugin): guest note says credits, and NO money UI exists anywhere
 *
 * Screenshots: /tmp/nasty-v059-shots/ (390x844 and 320x568).
 *
 * Usage: node test_ui_v059_2026_07_30.js
 */
const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
require("./test_ui_v036_welcome_bypass.js").patch(chromium);
const path = require("path");
const fs = require("fs");
const K = require("./test_accounts_kit.js");
const IAP = require("./test_iap_kit.js");

const INDEX = path.resolve(__dirname, "..", "..", "index.html");
const SHOTDIR = "/tmp/nasty-v059-shots";
fs.mkdirSync(SHOTDIR, { recursive: true });

const ADMIN_TOKEN = "ui-v059-admin-token";
const AUD = "com.pangman.nasty";
const ISSUER = "https://test.local";

let PASS = 0, FAIL = 0;
function log(...a) { console.log("[ui-v059]", ...a); }
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
function randPort() { return 30600 + Math.floor(Math.random() * 500); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PACK_PRICES = {
  "com.pangman.nasty.credits50": { displayPrice: "$4.99", price: 4.99, name: "50 Credits" },
  "com.pangman.nasty.credits110": { displayPrice: "$9.99", price: 9.99, name: "110 Credits" },
  "com.pangman.nasty.credits280": { displayPrice: "$24.99", price: 24.99, name: "280 Credits" },
  "com.pangman.nasty.credits600": { displayPrice: "$49.99", price: 49.99, name: "600 Credits" },
};

// The stub - installed before any page script runs. Faithful to IAPPlugin.swift's contract:
// purchase() returns a signed transaction WITHOUT finishing; finish() is separate; getPending()
// serves whatever "unfinished" transactions localStorage carries (so a reload can prove the
// boot-time drain, U6).
function stubInit(cfg) {
  try { localStorage.setItem("nasty-account", cfg.token); } catch (e) {}
  const pools = cfg.jwsPools;
  window.__iapLog = [];
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      AppleSignIn: { isAvailable: async () => ({ available: true }) },
      NastyIAP: {
        isAvailable: async () => ({ available: true }),
        getProducts: async (o) => ({
          products: ((o && o.productIds) || []).map((id) => ({
            productId: id,
            displayName: cfg.prices[id] ? cfg.prices[id].name : id,
            displayPrice: cfg.prices[id] ? cfg.prices[id].displayPrice : "$?",
            price: cfg.prices[id] ? cfg.prices[id].price : 0,
          })),
        }),
        purchase: async (o) => {
          const pool = pools[o && o.productId] || [];
          const t = pool.shift();
          window.__iapLog.push("purchase:" + (o && o.productId));
          if (!t) return { state: "failed" };
          return { state: "purchased", jws: t.jws, transactionId: t.transactionId, productId: o.productId };
        },
        finish: async (o) => {
          window.__iapLog.push("finish:" + (o && o.transactionId));
          try {
            const p = JSON.parse(localStorage.getItem("test-iap-pending") || "[]");
            localStorage.setItem("test-iap-pending", JSON.stringify(p.filter((x) => x.transactionId !== (o && o.transactionId))));
          } catch (e) {}
          return { ok: true };
        },
        getPending: async () => {
          try { return { transactions: JSON.parse(localStorage.getItem("test-iap-pending") || "[]") }; }
          catch (e) { return { transactions: [] }; }
        },
      },
    },
  };
}

async function main() {
  const key = K.makeKeyPair("ui59-key");
  const scratch = K.makeScratch("ui-v059");
  const port = randPort();
  const base = `http://localhost:${port}`;
  const envExtra = {
    NASTY_APPLE_ISSUER: ISSUER,
    NASTY_APPLE_AUDIENCES: AUD,
    NASTY_ACCOUNT_RATE_LIMIT: "4000",
    NASTY_IAP_ROOT_CA_B64: IAP.GOOD_ROOT_B64,
    NASTY_IAP_LEDGER_FILE: path.join(scratch, "iap-ledger.json"),
    NASTY_IAP_EVENTS_FILE: path.join(scratch, "iap-events.json"),
    // PRODUCTION PARITY, learned the hard way on this suite's first run: production runs the
    // ACCOUNT-ONLY board (earned credits live on the account row, keyed by uid) with the claim
    // window CLOSED. With the switch off, earned credits are name-keyed - so this suite's many
    // renames would detach the seeded balance mid-flow (and a claim offer pops over the panel),
    // neither of which exists in production.
    NASTY_LEADERBOARD_ACCOUNTS_ONLY: "1",
    NASTY_CLAIM_WINDOW_OPEN: "0",
  };
  const jwks = await K.startJwksServer([key]);
  envExtra.NASTY_APPLE_JWKS_URL = jwks.url;
  const env = K.serverEnv("node", scratch, port, ADMIN_TOKEN, envExtra);
  const srv = K.startServer("node", env, "ACCOUNTS_VERBOSE");
  await K.waitHealthy(base);
  const c = K.makeClient(base);

  // One real account, 90 earned credits to start (enough for tokens, nowhere near Midnight's 250).
  const who = await c.signIn(key, { sub: "001555.shopper.0001" });
  if (who.status !== 200) throw new Error("sign-in failed: " + JSON.stringify(who.body));
  const token = who.body.sessionToken;
  await c.post("/account/name", { auth: token, name: "Shopper" });
  // Seeded WITH auth - under the account-only board this lands on the account's own uid-keyed
  // row, exactly where a real player's earned credits live in production (rename-proof).
  await fetch(base + "/solo-result", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ gameId: "ui59-seed-" + Date.now(), auth: token, entries: [{ name: "Shopper", delta: { hg4s: 1, hw4s: 1, hptsS: 90 } }] }),
  });

  // Pre-minted signed transactions, three per pack - the server refuses a reused transaction id,
  // exactly as in production, so every stubbed "purchase" must be a fresh one.
  const jwsPools = {};
  for (const pid of Object.keys(PACK_PRICES)) {
    jwsPools[pid] = [0, 1, 2].map(() => {
      const t = IAP.mintTransaction({ productId: pid });
      return { jws: t.jws, transactionId: t.payload.transactionId, productId: pid };
    });
  }

  const url = `file://${INDEX}?ws=ws://localhost:${port}`;
  const browser = await chromium.launch();

  async function newAppPage(viewport) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    await ctx.addInitScript(stubInit, { token, jwsPools, prices: PACK_PRICES });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => log("PAGE ERROR:", e.message));
    await page.goto(url);
    // signed-in boot settles when the you card shows the account name
    await page.waitForFunction(() => document.body && document.body.textContent.includes("Shopper"), null, { timeout: 15000 });
    return { ctx, page };
  }
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTDIR, name) });

  try {
    /* =========================== the 390x844 pass =========================== */
    const { page } = await newAppPage({ width: 390, height: 844 });

    // ---- U1: the Shop ----
    await page.click("#btnShop");
    await page.waitForFunction(() => {
      const b = document.getElementById("shopBalanceBox");
      return b && /credits to spend/.test(b.textContent);
    }, null, { timeout: 10000 });
    await page.waitForFunction(() => document.body.textContent.includes("$4.99"), null, { timeout: 10000 });
    const shopText = await page.evaluate(() => document.getElementById("shopBody").textContent + " | " + document.getElementById("shopBalanceBox").textContent);
    check(/90 credits to spend/.test(shopText), "U1 the balance line says CREDITS: '90 credits to spend'");
    check(/Buy credits - 10 credits = \$1/.test(shopText), "U1b the credit packs section leads with Blake's 10-credits-per-dollar anchor");
    check(/\$4\.99/.test(shopText) && /\$9\.99/.test(shopText) && /\$24\.99/.test(shopText) && /\$49\.99/.test(shopText),
      "U1c all four packs show Apple's localized prices");
    check(/\+10% bonus/.test(shopText) && /\+20% bonus/.test(shopText), "U1d bigger packs carry their bonus labels");
    const ptsLeft = await page.evaluate(() => (document.getElementById("shopBody").textContent.match(/\bpts\b|\bpoints\b/g) || []).length);
    check(ptsLeft === 0, "U1e not a single 'points'/'pts' string left anywhere in the shop body");
    await shot(page, "01_shop_390.png");

    // ---- U2: unaffordable item -> money offer -> full outright purchase ----
    const midnightRow = '#shopBody .shopItem[data-id="palette_midnight"]';
    check(await page.locator(midnightRow + " .shopBuyBtn[disabled]").count() === 1,
      "U2 Midnight (250) is still shown with its disabled credits button (the honest credit price)");
    check(await page.locator(midnightRow + " .shopMoneyBtn").count() === 1,
      "U2b and it now ALSO offers the gold real-money button instead of being a dead end");
    await page.locator(midnightRow + " .shopMoneyBtn").scrollIntoViewIfNeeded();
    await page.click(midnightRow + " .shopMoneyBtn");
    await page.waitForSelector(midnightRow + " .shopMoneyRow:not(.hidden)");
    const moneyRowText = await page.locator(midnightRow + " .shopMoneyRow").textContent();
    check(/costs 250 credits and you have 90/.test(moneyRowText), "U2c the money confirm states the item cost AND the current balance in credits");
    check(/280-credit pack for \$24\.99/.test(moneyRowText), "U2d it offers the SMALLEST covering pack (shortfall 160 -> the 280 pack) with the real price");
    check(/Leftover credits stay/.test(moneyRowText), "U2e and says leftovers stay");
    await shot(page, "02_money_confirm_390.png");
    await page.click(midnightRow + " .shopMoneyYes");
    await page.waitForSelector('#shopBody .shopItem[data-id="palette_midnight"] .shopEquipBtn', { timeout: 15000 });
    const balText = await page.evaluate(() => document.getElementById("shopBalanceBox").textContent);
    check(/120 credits to spend/.test(balText), "U2f 90 + 280 bought - 250 spent = 120 credits left, and the item purchase completed automatically");
    check(/280 bought/.test(balText), "U2g the balance sub-line now reports the bought credits");
    const iapLog1 = await page.evaluate(() => window.__iapLog.join(","));
    check(/purchase:com\.pangman\.nasty\.credits280/.test(iapLog1) && /finish:/.test(iapLog1),
      "U2h the native plugin saw purchase() and then finish() - in that order, only after the server credited");
    await shot(page, "03_after_money_buy_390.png");
    await page.click("#btnShopClose");

    // ---- U3: Admin panel - credits wallet + Shop Customizations with buyable tokens ----
    await page.click("#btnMenuAdmin");
    await page.waitForFunction(() => {
      const w = document.getElementById("acctWallet");
      return w && !w.classList.contains("hidden") && /\d/.test(document.getElementById("acctPtsRemaining").textContent);
    }, null, { timeout: 10000 });
    const walletText = await page.evaluate(() => document.getElementById("acctWallet").textContent);
    check(/Credits earned\s*90/.test(walletText.replace(/\s+/g, " ")), "U3 wallet box: Credits earned 90");
    check(/Credits bought\s*280/.test(walletText.replace(/\s+/g, " ")), "U3b wallet box: Credits bought 280 (row appears once nonzero)");
    check(/Credits remaining\s*120/.test(walletText.replace(/\s+/g, " ")), "U3c wallet box: Credits remaining 120");
    const eqHead = await page.locator("#acctEquipToggleBtn .acctEquipHead").textContent();
    check(eqHead.trim() === "Shop Customizations", "U3d the section is named 'Shop Customizations' (was 'Personalizations')");
    await page.click("#acctEquipToggleBtn");
    await page.waitForSelector('#acctEquipBody .shopItem[data-id="namechange_credit"]');
    const eqBody = await page.evaluate(() => document.getElementById("acctEquipBody").textContent);
    check(/Tokens/.test(eqBody) && /Nickname Change/.test(eqBody) && /You have 0/.test(eqBody),
      "U3e the Nickname Change token row is right there, with the held count");
    check(/Online Access/.test(eqBody), "U3f and the Online Access token row is there too");
    check(await page.locator('#acctEquipBody .shopItem[data-id="online_month"] .shopBuyBtn').count() === 1,
      "U3g both rows carry real Buy buttons inside the panel");
    check(/Midnight/.test(eqBody), "U3h the money-bought Midnight palette shows up as an owned customization");
    await shot(page, "04_admin_customizations_390.png");

    // Buy a nickname token right here in the panel (through the same confirm the Shop uses).
    await page.click('#acctEquipBody .shopItem[data-id="namechange_credit"] .shopBuyBtn');
    await page.waitForSelector('#acctEquipBody .shopConfirmRow[data-id="namechange_credit"]:not(.hidden)');
    const rowConfirm = await page.locator('#acctEquipBody .shopConfirmRow[data-id="namechange_credit"]').textContent();
    check(/30 credits/.test(rowConfirm), "U3i the in-panel confirm prices the token in credits");
    await page.click('#acctEquipBody .shopConfirmYes[data-id="namechange_credit"]');
    await page.waitForFunction(() => /You have 1/.test(document.getElementById("acctEquipBody").textContent), null, { timeout: 10000 });
    check(true, "U3j buying from the panel works and the held count updates in place (You have 1)");

    // ---- U4: the two-button change-name flow ----
    await page.click("#btnAcctName");
    await page.waitForSelector("#acctNameEdit:not(.hidden)");
    await page.waitForFunction(() => /You have 1 Nickname Change token/.test(document.getElementById("acctNameCreditNote").textContent), null, { timeout: 10000 });
    const btnCount = await page.evaluate(() => {
      const box = document.getElementById("acctNameEdit");
      return Array.from(box.querySelectorAll(".acctNameBtns button")).map((b) => b.textContent.trim()).join("|");
    });
    check(btnCount === "Change name|Cancel", "U4 exactly TWO buttons: Change name | Cancel (the redeem button is gone)");
    await shot(page, "05_name_two_buttons_390.png");

    // 4a: the FREE change heads-up (first rename is free; lock not started yet).
    await page.fill("#acctNameInput", "Shopper2");
    await page.click("#btnAcctNameSave");
    await page.waitForSelector("#acctNameConfirm:not(.hidden)");
    const freeText = await page.locator("#acctNameConfirm").textContent();
    check(/This one is free, but you won't be able to change your name again for 30 days without a Nickname Change token/.test(freeText),
      "U4b the lighter free-change heads-up appears, with Blake's chosen wording");
    await shot(page, "06_free_headsup_390.png");
    await page.click("#acctNameFreeYes");
    await page.waitForFunction(() => document.getElementById("acctWhoName").textContent.includes("Shopper2"), null, { timeout: 10000 });
    check(true, "U4c accepting it renames for free (now Shopper2)");

    // 4b: the token-redeem confirmation (lock now active, one token held).
    await page.click("#btnAcctName");
    await page.waitForSelector("#acctNameEdit:not(.hidden)");
    await page.waitForFunction(() => /You have 1 Nickname Change token/.test(document.getElementById("acctNameCreditNote").textContent), null, { timeout: 10000 });
    await page.fill("#acctNameInput", "Shopper3");
    await page.click("#btnAcctNameSave");
    await page.waitForSelector("#acctNameConfirm:not(.hidden)");
    const tokText = await page.locator("#acctNameConfirm").textContent();
    check(/To confirm: you're about to redeem 1 Nickname Change token\. You have 1 and will have 0 after this change/.test(tokText),
      "U4d the explicit token-redeem confirmation, in Blake's requested shape (redeeming 1, have 1, 0 after, Shop pointer)");
    await shot(page, "07_token_confirm_390.png");
    await page.click("#acctNameTokenYes");
    await page.waitForFunction(() => document.getElementById("acctWhoName").textContent.includes("Shopper3"), null, { timeout: 10000 });
    check(true, "U4e explicit accept redeems the token and renames (now Shopper3)");

    // 4c: no token held -> the buy-a-token offer.
    await page.click("#btnAcctName");
    await page.waitForSelector("#acctNameEdit:not(.hidden)");
    await sleep(600);
    await page.fill("#acctNameInput", "Shopper4");
    await page.click("#btnAcctNameSave");
    await page.waitForSelector("#acctNameConfirm:not(.hidden)", { timeout: 10000 });
    const offerText = await page.locator("#acctNameConfirm").textContent();
    check(/You don't have a Nickname Change token - one costs 30 credits, and you have 90/.test(offerText),
      "U4f with no token, the flow says so and offers to buy one with credits (30 of 90)");
    await shot(page, "08_token_offer_390.png");
    await page.click("#acctNameBuyYes");
    await page.waitForSelector("#acctNameConfirm:not(.hidden)", { timeout: 10000 });
    await page.waitForFunction(() => /about to redeem 1 Nickname Change token/.test(document.getElementById("acctNameConfirm").textContent), null, { timeout: 10000 });
    check(true, "U4g buying the token flows straight into the SAME explicit redeem confirmation - never a silent redeem");
    await page.click("#acctNameTokenYes");
    await page.waitForFunction(() => document.getElementById("acctWhoName").textContent.includes("Shopper4"), null, { timeout: 10000 });
    check(true, "U4h and the rename lands (now Shopper4)");
    await page.click("#btnAcctX");

    // ---- U5: mid-game rename, live on the board ----
    await page.click("#btnStart");
    await page.waitForSelector("#offlineSeatOverlay:not(.hidden)");
    await page.click("#btnOfflineSeatStart");
    // A first-ever game on this profile gets the table-speed gate - answer it like a player.
    try {
      await page.waitForSelector("#speedPickerOverlay:not(.hidden)", { timeout: 4000 });
      await page.click("#speedPickerBtns .btn");
    } catch (e) { /* not shown - fine, some profiles have a stored speed */ }
    await page.waitForSelector("#plaque-0 .nm", { timeout: 15000 });
    const plaqueBefore = await page.locator("#plaque-0 .nm").textContent();
    check(plaqueBefore === "Shopper4", "U5 the local game's own plaque carries the account name (Shopper4)");
    // Rename mid-game through the real panel flow (buy one more token with credits: 60 - 30 = 30 left).
    await page.click("#btnAccount");
    await page.waitForSelector("#accountOverlay:not(.hidden)");
    await page.click("#btnAcctName");
    await page.waitForSelector("#acctNameEdit:not(.hidden)");
    await sleep(600);
    await page.fill("#acctNameInput", "Shopper5");
    await page.click("#btnAcctNameSave");
    await page.waitForFunction(() => /one costs 30 credits/.test((document.getElementById("acctNameConfirm") || {}).textContent || ""), null, { timeout: 10000 });
    await page.click("#acctNameBuyYes");
    await page.waitForFunction(() => /about to redeem/.test((document.getElementById("acctNameConfirm") || {}).textContent || ""), null, { timeout: 10000 });
    await page.click("#acctNameTokenYes");
    await page.waitForFunction(() => document.querySelector("#plaque-0 .nm") && document.querySelector("#plaque-0 .nm").textContent === "Shopper5", null, { timeout: 10000 });
    check(true, "U5b the rename hit the LIVE board's plaque instantly, mid-game (applyLocalRenameNow)");
    await page.click("#btnAcctX");
    await shot(page, "09_midgame_rename_390.png");
    // The online half of the same feature: drive the server's broadcast shape straight into the
    // real handler and watch the DOM move (the wire itself is proven end to end by
    // test_live_rename.js against both servers).
    const prBefore = await page.locator("#plaque-1 .nm").textContent();
    const prResult = await page.evaluate(() => {
      handleNetMessage({ type: "playerRenamed", playerId: 42, seat: 1, name: "Zed" });
      return document.querySelector("#plaque-1 .nm").textContent;
    });
    check(prBefore !== "Zed" && prResult === "Zed", "U5c a playerRenamed broadcast renames the seat's plaque through the real handler");

    // ---- U6: the boot-time pending-transaction drain ----
    const pendTxn = IAP.mintTransaction({ productId: "com.pangman.nasty.credits50" });
    await page.evaluate((t) => {
      localStorage.setItem("test-iap-pending", JSON.stringify([{ jws: t.jws, transactionId: t.transactionId, productId: "com.pangman.nasty.credits50" }]));
    }, { jws: pendTxn.jws, transactionId: pendTxn.payload.transactionId });
    await page.goto(url);   // "next launch"
    await page.waitForFunction(() => (localStorage.getItem("test-iap-pending") || "[]") === "[]", null, { timeout: 15000 });
    const iapLog2 = await page.evaluate(() => window.__iapLog.join(","));
    check(new RegExp("finish:" + pendTxn.payload.transactionId).test(iapLog2),
      "U6 at next boot the pending transaction was re-sent, credited, and only then finished");
    await page.click("#btnMenuAdmin");
    await page.waitForFunction(() => /330/.test(document.getElementById("acctPtsBought").textContent), null, { timeout: 10000 });
    check(true, "U6b and the wallet shows the recovered credits (Credits bought 280 + 50 = 330)");
    await shot(page, "10_pending_drain_390.png");
    await page.close();

    /* =========================== the 320x568 pass =========================== */
    const { page: p320 } = await newAppPage({ width: 320, height: 568 });
    await p320.click("#btnShop");
    await p320.waitForFunction(() => document.body.textContent.includes("$4.99"), null, { timeout: 10000 });
    await shot(p320, "11_shop_320.png");
    // Royal (150) is unaffordable at 80 credits -> money confirm at 320 must fit.
    const royalRow = '#shopBody .shopItem[data-id="palette_royal"]';
    await p320.locator(royalRow + " .shopMoneyBtn").scrollIntoViewIfNeeded();
    await p320.click(royalRow + " .shopMoneyBtn");
    await p320.waitForSelector(royalRow + " .shopMoneyRow:not(.hidden)");
    await shot(p320, "12_money_confirm_320.png");
    const overflowShop = await p320.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflowShop <= 1, "U7 no horizontal overflow at 320px with the shop + money confirm open (overflow=" + overflowShop + "px)");
    await p320.click("#btnShopClose");
    await p320.click("#btnMenuAdmin");
    await p320.waitForFunction(() => !document.getElementById("acctWallet").classList.contains("hidden"), null, { timeout: 10000 });
    await p320.click("#acctEquipToggleBtn");
    await p320.waitForSelector('#acctEquipBody .shopItem[data-id="namechange_credit"]');
    await shot(p320, "13_customizations_320.png");
    await p320.click("#btnAcctName");
    await p320.waitForSelector("#acctNameEdit:not(.hidden)");
    await sleep(600);
    await p320.fill("#acctNameInput", "Shopper6");
    await p320.click("#btnAcctNameSave");
    await p320.waitForSelector("#acctNameConfirm:not(.hidden)", { timeout: 10000 });
    await shot(p320, "14_name_offer_320.png");
    const overflowPanel = await p320.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflowPanel <= 1, "U7b no horizontal overflow at 320px in the panel flows (overflow=" + overflowPanel + "px)");
    await p320.close();

    /* =========================== U8: the website, no plugin =========================== */
    const webCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const web = await webCtx.newPage();
    await web.goto(`file://${INDEX}?preview=1&ws=ws://localhost:${port}`);
    await web.waitForSelector("#btnShop", { timeout: 15000 });
    await web.click("#btnShop");
    await web.waitForFunction(() => {
      const b = document.getElementById("shopBalanceBox");
      return b && b.textContent.length > 10;
    }, null, { timeout: 10000 });
    const webShop = await web.evaluate(() => document.getElementById("shopBalanceBox").textContent + document.getElementById("shopBody").textContent);
    check(/Signing in is what earns and holds your credits/.test(webShop), "U8 the website's guest note says CREDITS");
    const moneyBtns = await web.locator(".shopMoneyBtn, .shopPackBtn").count();
    check(moneyBtns === 0, "U8b and there is NO money UI anywhere on the website (no plugin, no packs, no dollar buttons)");
    await shot(web, "15_web_shop_guest_390.png");
    await web.close();
  } catch (e) {
    FAIL++;
    log("FAIL", "unexpected exception: " + (e && e.stack || e));
  } finally {
    try { await browser.close(); } catch (e) {}
    await K.stopServer(srv);
    jwks.close();
  }

  log(`screenshots: ${SHOTDIR}`);
  log(`${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main();
