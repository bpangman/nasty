/*
 * test_ui_topbar_v034_2026_07_25.js - PERMANENT suite for Blake's 2026-07-25 feedback after
 * playing v0.33 on his phone. Four items, all client-side (index.html only - no server file was
 * touched by that batch and none is touched here).
 *
 *   1. THE TOP ROW. "Please move the nasty logo up to the very top (centered) and then
 *      consolidate the 'quit' 'pause' and 'save' buttons into just a pause button in the top left
 *      and the account icon in the top right but make it equal spacing on the right/top (as far as
 *      distance from the top and side of the screen) as the pause button is (account circle looks
 *      closer and I don't like that."
 *   2. THE SAVED-GAME TILES. "on the saves please have the icon give details on the game - meaning
 *      if it was teams or FFA (free for all) (change the everyone for themselves phrasing) and
 *      also say how many pegs you had home. Still don't make this longer than 2 rows."
 *   3. THE SETUP OPTION ROWS. "Can you make the buttons have a little space away from 'game type'
 *      but still have them start even with the ones above them? (Might need to move the player
 *      buttons a tiny bit further away to match)"
 *   4. THE WORD FOR A COMPUTER PLAYER. "Change it back to CPU instead of Computer."
 *
 * Everything here is REAL RENDERED GEOMETRY in headless Chromium at Blake's five phone widths
 * with real iOS safe-area insets applied through CDP, 4P and 6P, in-game and in post-game review
 * mode. Nothing talks to a server or to production; the online-only rules are exercised by
 * setting NET.online/NET.isHost directly, the same technique test_topbar_buttons.js already uses,
 * because what is being tested is the CLIENT'S rule, not the server's.
 *
 * Run: node tests/test_ui_topbar_v034_2026_07_25.js
 */

const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
// v0.36 (2026-07-26): seed the first-run sign-in screen's answer before the page boots, so
// this suite runs as the returning player it was always written about. Real key, real code
// path, no stub - see test_ui_v036_welcome_bypass.js.
require("./test_ui_v036_welcome_bypass.js").patch(chromium);

const path = require("path");
const fs = require("fs");

const URL = "file://" + path.resolve(__dirname, "..", "..", "index.html");
const SHOTDIR = path.resolve(
  "/private/tmp/claude-501/-Users-jarvis/0bc923da-f111-499a-9b51-18988e4aba3d/scratchpad/shots-topbar-v034",
);
fs.mkdirSync(SHOTDIR, { recursive: true });

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  OK  ", label); }
  else { fail++; console.log("  FAIL ", label); }
}

// The five widths Blake's family actually uses, with the real safe-area insets each device
// reports. 320/375 have no notch; the other three do.
const MATRIX = [
  { name: "320x568 (SE1)", w: 320, h: 568, top: 0, bottom: 0 },
  { name: "375x667 (SE2/3)", w: 375, h: 667, top: 0, bottom: 0 },
  { name: "390x844 (12/13/14)", w: 390, h: 844, top: 47, bottom: 34 },
  { name: "393x852 (15/16 Pro)", w: 393, h: 852, top: 59, bottom: 34 },
  { name: "430x932 (Pro Max)", w: 430, h: 932, top: 59, bottom: 34 },
];

async function newCtx(browser, m) {
  const ctx = await browser.newContext({ viewport: { width: m.w, height: m.h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  await client.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { top: m.top, left: 0, bottom: m.bottom, right: 0 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, page, errors };
}

// Start a real offline game of n seats and get past the one-time speed picker.
async function board(page, n) {
  await page.goto(URL);
  await page.waitForSelector("#btnStart");
  if (n === 6) { await page.click("#p6"); await page.waitForTimeout(120); }
  await page.click("#btnStart");
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
  const picker = await page.evaluate(() => {
    const sp = document.getElementById("speedPickerOverlay");
    return sp && !sp.classList.contains("hidden");
  });
  if (picker) await page.click("#btnSpeedPick0");
  await page.waitForTimeout(250);
}

async function makePostGame(page) {
  // G.over must genuinely be set - syncAll() drives the post-game row off it after every move,
  // so faking only showWin() would be undone by the next CPU turn.
  await page.evaluate(() => { window.G.over = true; window.G.winners = [0]; window.showWin(); window.closeWinOverlay(); });
  await page.waitForTimeout(250);
}

/* ==================== Part A - the three-slot row, at every width ==================== */
async function partA(browser) {
  console.log("\n=== Part A: exactly PAUSE (or RESULTS) + the centred logo + the circle, equal insets, zero overflow ===");
  for (const m of MATRIX) {
    for (const n of [4, 6]) {
      for (const postGame of [false, true]) {
        const { ctx, page, errors } = await newCtx(browser, m);
        await board(page, n);
        if (postGame) await makePostGame(page);
        const r = await page.evaluate(() => {
          const tb = document.getElementById("topbar");
          const box = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom }; };
          const visible = [...tb.querySelectorAll("button")].filter((b) => !b.classList.contains("hidden"));
          const logo = document.getElementById("gameLogo");
          const sign = document.querySelector("#gameLogo .sign");
          const circle = document.getElementById("btnAccount");
          const left = visible.filter((b) => b !== circle);
          return {
            vw: window.innerWidth,
            visibleIds: visible.map((b) => b.id),
            leftIds: left.map((b) => b.id),
            leftText: left.map((b) => b.textContent.trim()),
            left: left.length === 1 ? box(left[0]) : null,
            circle: box(circle),
            logo: box(logo),
            sign: box(sign),
            overflowRow: tb.scrollWidth - tb.clientWidth,
            overflowDoc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            logoInTopbar: !!logo.closest("#topbar"),
            // Nothing else may be in this row - a stray third control is exactly the regression
            // Blake asked to be rid of.
            rowChildren: [...tb.children].map((c) => c.id || c.className),
          };
        });
        const label = `${m.name} ${n}P ${postGame ? "post-game" : "in-game"}`;

        // 1. THREE THINGS, never more.
        ok(r.visibleIds.length === 2, `${label}: exactly two buttons in the row (${JSON.stringify(r.visibleIds)}) - plus the logo makes three things`);
        ok(r.leftIds.length === 1 && r.leftIds[0] === (postGame ? "btnResults" : "btnPause"),
          `${label}: the left slot holds ${postGame ? "RESULTS" : "PAUSE"} and nothing else (${JSON.stringify(r.leftIds)})`);
        ok(r.visibleIds[r.visibleIds.length - 1] === "btnAccount", `${label}: the account circle is the last control in the row`);
        ok(r.logoInTopbar, `${label}: the NASTY logo lives in the top row itself (Blake: "move the nasty logo up to the very top")`);
        ok(r.rowChildren.length === 3, `${label}: the row has exactly three slots (${JSON.stringify(r.rowChildren)})`);

        // 2. EQUAL INSETS - Blake's actual complaint.
        const leftInsetX = r.left.x, leftInsetY = r.left.y;
        const circleInsetX = r.vw - r.circle.right, circleInsetY = r.circle.y;
        ok(Math.abs(leftInsetY - circleInsetY) <= 1,
          `${label}: the button and the circle are the SAME distance from the top edge (${leftInsetY.toFixed(2)} vs ${circleInsetY.toFixed(2)}px)`);
        ok(Math.abs(leftInsetX - circleInsetX) <= 1,
          `${label}: the button's left inset equals the circle's right inset (${leftInsetX.toFixed(2)} vs ${circleInsetX.toFixed(2)}px)`);
        ok(Math.abs(r.left.bottom - r.circle.bottom) <= 1,
          `${label}: they line up along their bottom edges too (${r.left.bottom.toFixed(2)} vs ${r.circle.bottom.toFixed(2)}px)`);

        // 3. The logo is centred on the SCREEN, not on the leftover space.
        const signCentre = (r.sign.x + r.sign.right) / 2;
        ok(Math.abs(signCentre - r.vw / 2) <= 1,
          `${label}: the NASTY sign is optically centred on the viewport (centre ${signCentre.toFixed(2)} vs ${(r.vw / 2).toFixed(2)})`);
        ok(r.left.right < r.sign.x - 2 && r.circle.x > r.sign.right + 2,
          `${label}: neither control touches the logo (left ends ${r.left.right.toFixed(1)}, sign ${r.sign.x.toFixed(1)}..${r.sign.right.toFixed(1)}, circle starts ${r.circle.x.toFixed(1)})`);

        // 4. Overflow and tap targets.
        ok(r.overflowRow === 0, `${label}: ZERO horizontal overflow on the row (scrollWidth - clientWidth = ${r.overflowRow})`);
        ok(r.overflowDoc <= 0, `${label}: ZERO horizontal overflow on the page itself (${r.overflowDoc})`);
        ok(r.left.h >= 44 && r.circle.h >= 44 && r.circle.w >= 44,
          `${label}: both controls clear the 44px tap floor (button ${r.left.h.toFixed(1)}px, circle ${r.circle.w.toFixed(1)}x${r.circle.h.toFixed(1)})`);
        ok(r.left.x >= -0.5 && r.circle.right <= r.vw + 0.5, `${label}: both controls are fully on screen`);
        ok(errors.length === 0, `${label}: zero page errors`);

        if (!postGame && n === 4 && (m.w === 320 || m.w === 390)) {
          await page.screenshot({ path: path.join(SHOTDIR, `toprow_${m.w}.png`), clip: { x: 0, y: 0, width: m.w, height: 160 } });
        }
        await ctx.close();
      }
    }
  }
}

/* ==================== Part A2 - the one pathological aspect ratio ====================
   A phone turned sideways (the web version has no orientation lock) hits the app's own
   max-height:480px landscape block, which shrinks the top row's chrome to 36px. Blake's equal-
   inset promise has to survive that too - and it is exactly the place where an override that
   changes one control's height and not the other's would quietly break it. */
async function partA2(browser) {
  console.log("\n=== Part A2: the equal insets hold in landscape, where the row deliberately shrinks ===");
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  await client.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, left: 0, bottom: 34, right: 0 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await board(page, 4);
  const r = await page.evaluate(() => {
    const p = document.getElementById("btnPause").getBoundingClientRect();
    const c = document.getElementById("btnAccount").getBoundingClientRect();
    const sign = document.querySelector("#gameLogo .sign").getBoundingClientRect();
    const tb = document.getElementById("topbar");
    return { pTop: p.y, pLeft: p.x, pH: p.height, pBottom: p.bottom,
      cTop: c.y, cRight: window.innerWidth - c.right, cH: c.height, cBottom: c.bottom,
      centre: (sign.x + sign.right) / 2, vw: window.innerWidth, over: tb.scrollWidth - tb.clientWidth };
  });
  ok(Math.abs(r.pTop - r.cTop) <= 1, `landscape: same distance from the top edge (${r.pTop.toFixed(2)} vs ${r.cTop.toFixed(2)})`);
  ok(Math.abs(r.pLeft - r.cRight) <= 1, `landscape: the left inset equals the right inset (${r.pLeft.toFixed(2)} vs ${r.cRight.toFixed(2)})`);
  ok(Math.abs(r.pH - r.cH) <= 1, `landscape: both controls shrink together, same height (${r.pH.toFixed(1)} vs ${r.cH.toFixed(1)}) - the 36px landscape tradeoff applies to BOTH or neither`);
  ok(Math.abs(r.pBottom - r.cBottom) <= 1, `landscape: their bottom edges still line up (${r.pBottom.toFixed(2)} vs ${r.cBottom.toFixed(2)})`);
  ok(Math.abs(r.centre - r.vw / 2) <= 1, `landscape: the logo is still centred on the screen (${r.centre.toFixed(2)} vs ${(r.vw / 2).toFixed(2)})`);
  ok(r.over === 0, `landscape: zero horizontal overflow (${r.over})`);
  ok(errors.length === 0, "Part A2: zero page errors");
  await ctx.close();
}

/* ==================== Part B - the board still sits in the middle ====================
   The logo moved, so fitBoard()'s top reference moved with it. Blake's rule from v0.33 is
   unchanged and must still hold: the gap between the bottom of the logo block and the top of the
   drawn board equals the gap between the bottom of the board and the top of the message band. */
async function partB(browser) {
  console.log("\n=== Part B: the gap above the board still equals the gap below it, measured from the logo's NEW position ===");
  for (const m of MATRIX) {
    for (const n of [4, 6]) {
      const { ctx, page, errors } = await newCtx(browser, m);
      await board(page, n);
      const g = await page.evaluate(() => {
        const bs = document.getElementById("boardScale").getBoundingClientRect();
        const art = document.getElementById("boardSvg").getBBox();
        const sc = bs.width / 1000;
        const artTop = bs.top + art.y * sc, artBottom = artTop + art.height * sc;
        const logoBottom = document.getElementById("gameLogo").getBoundingClientRect().bottom;
        const bandTop = document.getElementById("toasts").getBoundingClientRect().top;
        const wrapTop = document.getElementById("boardWrap").getBoundingClientRect().top;
        return { above: +(artTop - logoBottom).toFixed(2), below: +(bandTop - artBottom).toFixed(2), artTop: +artTop.toFixed(2), wrapTop: +wrapTop.toFixed(2), scale: +sc.toFixed(4) };
      });
      const label = `${m.name} ${n}P`;
      ok(Math.abs(g.above - g.below) <= 1, `${label}: the gap above the board equals the gap below (${g.above}px vs ${g.below}px)`);
      ok(g.above >= 9.5 && g.below >= 9.5, `${label}: both gaps are real breathing room, not zero (${g.above}/${g.below})`);
      // #boardWrap is overflow:hidden, so the board's top must never be asked to sit above it -
      // that is the coupling between the top row's bottom padding and BOARD_GAP_MIN.
      ok(g.artTop >= g.wrapTop - 0.5, `${label}: the board's top edge stays inside #boardWrap, never clipped (${g.artTop} vs wrap top ${g.wrapTop})`);
      ok(errors.length === 0, `${label}: zero page errors`);
      await ctx.close();
    }
  }
}

/* ==================== Part C - QUIT and SAVE still work, from the PAUSED screen ====================
   The two buttons left the top row; their actions did not. This part drives every option on the
   PAUSED screen through its real handler and checks the real consequence. */
async function partC(browser) {
  console.log("\n=== Part C: every QUIT/SAVE action is still reachable, and still means what it meant, from the PAUSED screen ===");
  const m = MATRIX[2];

  // C1 - the sheet's shape: safe options first, loss-bearing ones after and styled danger.
  {
    const { ctx, page, errors } = await newCtx(browser, m);
    await board(page, 4);
    const sheet = await page.evaluate(() => {
      document.getElementById("btnPause").click();
      const btns = [...document.querySelectorAll("#leaveConfirmOverlay .bigBtns .btn")];
      return {
        open: !document.getElementById("leaveConfirmOverlay").classList.contains("hidden"),
        paused: window.G.paused,
        ids: btns.map((b) => b.id),
        texts: btns.map((b) => b.textContent.trim()),
        classes: btns.map((b) => b.className),
        hidden: btns.map((b) => b.classList.contains("hidden")),
        onlyPage: [...document.querySelectorAll(".overlay:not(.hidden)")].map((o) => o.id),
      };
    });
    ok(sheet.open && sheet.paused === true, "PAUSE opens the PAUSED screen and really pauses the table");
    ok(sheet.onlyPage.length === 1 && sheet.onlyPage[0] === "leaveConfirmOverlay", `exactly one full-screen page is up (${JSON.stringify(sheet.onlyPage)}) - the v0.33 never-two-overlays rule still holds`);
    ok(sheet.ids[0] === "btnLeaveCancel", `the SAFE option is still first (${JSON.stringify(sheet.ids)}) - v0.31 exit-safety ordering`);
    ok(sheet.ids.includes("btnLeaveSave"), "SAVE's action is here: Save & leave");
    ok(sheet.ids.includes("btnLeaveDiscard"), "QUIT's action is here: Leave without saving");
    ok(sheet.ids.includes("btnLeaveForGood"), "and Hand my seat to a CPU is here too");
    const discardIdx = sheet.ids.indexOf("btnLeaveDiscard"), forGoodIdx = sheet.ids.indexOf("btnLeaveForGood");
    ok(/danger/.test(sheet.classes[discardIdx]) && /danger/.test(sheet.classes[forGoodIdx]),
      "both loss-bearing options are still styled danger");
    ok(/cpu/i.test(sheet.texts[forGoodIdx]) && !/computer/i.test(sheet.texts[forGoodIdx]),
      `the seat-handover option says CPU, not computer (got "${sheet.texts[forGoodIdx]}")`);
    ok(sheet.hidden[forGoodIdx] === true, "offline, the seat-handover option is correctly hidden (online-only, unchanged gating)");
    ok(errors.length === 0, "C1: zero page errors");
    await ctx.close();
  }

  // C2 - Return to game: resumes, no consequence.
  {
    const { ctx, page, errors } = await newCtx(browser, m);
    await board(page, 4);
    const r = await page.evaluate(() => {
      document.getElementById("btnPause").click();
      document.getElementById("btnLeaveCancel").click();
      return { paused: window.G.paused, inGame: !document.getElementById("game").classList.contains("hidden"),
        pages: [...document.querySelectorAll(".overlay:not(.hidden)")].map((o) => o.id) };
    });
    ok(r.paused === false && r.inGame && r.pages.length === 0, `"Return to game" resumes the table and leaves nothing on screen (paused=${r.paused}, pages=${JSON.stringify(r.pages)})`);
    ok(errors.length === 0, "C2: zero page errors");
    await ctx.close();
  }

  // C3 - Save & leave: on the menu, the save is on disk, NO loss recorded, resume tile offered.
  {
    const { ctx, page, errors } = await newCtx(browser, m);
    await board(page, 4);
    await page.waitForTimeout(400);
    const before = await page.evaluate(() => localStorage.getItem("nasty-stats"));
    await page.evaluate(() => { document.getElementById("btnPause").click(); document.getElementById("btnLeaveSave").click(); });
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => ({
      onMenu: !document.getElementById("menu").classList.contains("hidden"),
      saved: !!(localStorage.getItem("nasty-save-offline-1") || localStorage.getItem("nasty-save-offline-2")),
      stats: localStorage.getItem("nasty-stats"),
      tileShown: !document.getElementById("btnSavedGame").classList.contains("hidden"),
    }));
    ok(r.onMenu, '"Save & leave" lands on the menu');
    ok(r.saved, '"Save & leave" leaves a real save on disk');
    ok(r.stats === before, '"Save & leave" records no loss - it is not a concede path');
    ok(r.tileShown, "the menu offers a resume tile afterwards");
    ok(errors.length === 0, "C3: zero page errors");
    await ctx.close();
  }

  // C4 - Leave without saving: goes through the concede confirm; cancelling is completely free.
  {
    const { ctx, page, errors } = await newCtx(browser, m);
    await board(page, 4);
    const r = await page.evaluate(() => {
      document.getElementById("btnPause").click();
      document.getElementById("btnLeaveDiscard").click();
      const heading = document.getElementById("surrenderConfirmHeading").textContent;
      const pages = [...document.querySelectorAll(".overlay:not(.hidden)")].map((o) => o.id);
      document.getElementById("btnSurrenderCancel").click();
      return { heading, pages, pausedAfter: window.G.paused, inGame: !document.getElementById("game").classList.contains("hidden"),
        pagesAfter: [...document.querySelectorAll(".overlay:not(.hidden)")].map((o) => o.id) };
    });
    ok(r.heading === "CONCEDE?", `"Leave without saving" still warns first (heading "${r.heading}")`);
    ok(r.pages.length === 1 && r.pages[0] === "surrenderConfirmOverlay", `the warning replaces the sheet rather than stacking on it (${JSON.stringify(r.pages)})`);
    ok(r.pagesAfter.length === 0 && r.pausedAfter === false && r.inGame,
      "cancelling the warning puts the player straight back in the running game, nothing left over");
    ok(errors.length === 0, "C4: zero page errors");
    await ctx.close();
  }

  // C5 - Leave without saving, confirmed: the game is really gone and a loss really is recorded.
  {
    const { ctx, page, errors } = await newCtx(browser, m);
    await board(page, 4);
    await page.waitForTimeout(400);
    const before = await page.evaluate(() => localStorage.getItem("nasty-stats"));
    await page.evaluate(() => {
      document.getElementById("btnPause").click();
      document.getElementById("btnLeaveDiscard").click();
      document.getElementById("btnSurrenderConfirm").click();
    });
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => ({
      onMenu: !document.getElementById("menu").classList.contains("hidden"),
      saved: !!(localStorage.getItem("nasty-save-offline-1") || localStorage.getItem("nasty-save-offline-2")),
      stats: localStorage.getItem("nasty-stats"),
    }));
    ok(r.onMenu, "confirming the concede lands on the menu");
    ok(!r.saved, "confirming the concede really does discard the save (it is not a quiet keep)");
    ok(r.stats !== before, "confirming the concede records the loss it warned about");
    ok(errors.length === 0, "C5: zero page errors");
    await ctx.close();
  }

  // C6 - the whole path is unreachable once the game is over (nothing left to concede), and the
  // post-game exits are the ones the row/panel offer instead.
  {
    const { ctx, page, errors } = await newCtx(browser, m);
    await board(page, 4);
    await makePostGame(page);
    const r = await page.evaluate(() => {
      document.getElementById("btnPause").click();
      return {
        sheetHidden: document.getElementById("leaveConfirmOverlay").classList.contains("hidden"),
        surrHidden: document.getElementById("surrenderConfirmOverlay").classList.contains("hidden"),
        resultsShown: !document.getElementById("btnResults").classList.contains("hidden"),
        menuRowShown: !document.getElementById("btnAcctMenu").classList.contains("hidden"),
      };
    });
    ok(r.sheetHidden && r.surrHidden, "a finished game cannot be conceded - the PAUSED screen refuses to open at all");
    ok(r.resultsShown, "post-game, the left slot offers RESULTS");
    ok(r.menuRowShown, 'post-game, the account panel offers "Back to the menu"');
    // Both post-game actions really work.
    await page.evaluate(() => document.getElementById("btnResults").click());
    await page.waitForTimeout(200);
    const reopened = await page.evaluate(() => !document.getElementById("winOverlay").classList.contains("hidden"));
    ok(reopened, "RESULTS reopens the win popup");
    await page.evaluate(() => { document.getElementById("btnWinClose").click(); document.getElementById("btnAccount").click(); document.getElementById("btnAcctMenu").click(); });
    await page.waitForTimeout(300);
    const left = await page.evaluate(() => ({
      onMenu: !document.getElementById("menu").classList.contains("hidden"),
      surrShown: !document.getElementById("surrenderConfirmOverlay").classList.contains("hidden"),
    }));
    ok(left.onMenu && !left.surrShown, '"Back to the menu" is a free exit from a finished game - no warning, no loss');
    ok(errors.length === 0, "C6: zero page errors");
    await ctx.close();
  }
}

/* ==================== Part D - SPEED, in its new home ==================== */
async function partD(browser) {
  console.log("\n=== Part D: the table speed moved into the account panel and behaves exactly as it did ===");
  const m = MATRIX[2];
  const { ctx, page, errors } = await newCtx(browser, m);
  await board(page, 4);

  const gone = await page.evaluate(() => !!document.getElementById("btnSpeed"));
  ok(!gone, "there is no SPEED button in the top row any more");

  // Where it lives: right next to Sound, in the panel the circle opens.
  const placed = await page.evaluate(() => {
    document.getElementById("btnAccount").click();
    const rows = [...document.querySelectorAll("#accountOverlay .acctRows .acctRow")].map((b) => b.id);
    const speed = document.getElementById("btnAcctSpeed");
    const r = speed.getBoundingClientRect();
    return { rows, text: speed.textContent, h: r.height, nextToSound: rows.indexOf("btnAcctSpeed") === rows.indexOf("btnAcctSound") + 1 };
  });
  ok(placed.rows.includes("btnAcctSpeed"), `the Table speed row is in the account panel (${JSON.stringify(placed.rows)})`);
  ok(placed.nextToSound, "it sits directly next to Sound, as asked");
  ok(/table speed/i.test(placed.text), `the row says what it is (got "${placed.text.trim()}")`);
  ok(placed.h >= 44, `the row clears the 44px tap floor (${placed.h.toFixed(1)}px)`);

  // Offline: tapping cycles the speed, applies it for real, and remembers it.
  const cycled = await page.evaluate(() => {
    const before = { label: document.getElementById("btnAcctSpeed").textContent, speed: SPEED };
    document.getElementById("btnAcctSpeed").click();
    return { before, after: { label: document.getElementById("btnAcctSpeed").textContent, speed: SPEED }, stored: localStorage.getItem("nasty-speed") };
  });
  ok(cycled.before.label !== cycled.after.label, `tapping the row steps to the next speed ("${cycled.before.label.trim()}" -> "${cycled.after.label.trim()}")`);
  ok(cycled.before.speed !== cycled.after.speed, `the real animation-pacing SPEED variable actually changed (${cycled.before.speed} -> ${cycled.after.speed})`);
  ok(cycled.stored !== null, "the choice is remembered on this phone");

  // Online, host: the change goes to the server (one shared pace for the table), same wire
  // message the top-bar button always sent.
  const asHost = await page.evaluate(() => {
    const sent = [];
    const realSend = window.netSend;
    window.netSend = (msg) => sent.push(msg);
    window.NET.online = true; window.NET.isHost = true; window.NET.tableSpeed = 1;
    window.renderAccountPanel();
    const disabled = document.getElementById("btnAcctSpeed").disabled;
    document.getElementById("btnAcctSpeed").click();
    window.netSend = realSend;
    return { sent, disabled, label: document.getElementById("btnAcctSpeed").textContent };
  });
  ok(asHost.disabled === false, "online, the HOST can use the row");
  ok(asHost.sent.length === 1 && asHost.sent[0].type === "setTableSpeed", `the host's tap sends the table-speed change to the server (${JSON.stringify(asHost.sent)})`);

  // Online, everyone else: the rule is explained in plain words ON the row, and the row is
  // disabled. A toast would have been painted underneath this full-screen panel.
  const asGuest = await page.evaluate(() => {
    window.NET.online = true; window.NET.isHost = false; window.NET.tableSpeed = 1.7;
    window.renderAccountPanel();
    const b = document.getElementById("btnAcctSpeed");
    const small = b.querySelector("small");
    return { disabled: b.disabled, text: b.textContent, small: small ? small.textContent : null };
  });
  ok(asGuest.disabled === true, "online, a guest cannot change the table speed");
  ok(asGuest.small && /only the host/i.test(asGuest.small), `and is told why, in plain words, right on the row (got "${asGuest.small}")`);
  ok(/fast/i.test(asGuest.text), `the row still shows the table's CURRENT shared speed to everyone (got "${asGuest.text.trim()}")`);
  ok(errors.length === 0, "Part D: zero page errors");
  await ctx.close();
}

/* ==================== Part E - the saved-game tiles ==================== */
function mkSave(n, teams, names, homeCount, ts) {
  const seats = [];
  for (let i = 0; i < n; i++) seats.push({ name: names[i] || "Bot" + i, type: names[i] ? "human" : "cpu", diff: "easy" });
  const pieces = seats.map((_, si) => Array.from({ length: 5 }, (_, k) => (
    si === 0 && k < homeCount ? { state: "home", steps: 48 + k + 1 } : { state: "base", steps: -1 })));
  return { G: { n, teams, seats, pieces, over: false }, ts };
}

async function partE(browser) {
  console.log("\n=== Part E: a saved-game tile says Teams or FFA and how many tees were home, in never more than 2 rows ===");
  // Worst realistic content AND the pathological maximum: three 10-character names (NAME_MAX).
  const CASES = [
    { key: "6P teams, 3 humans, all 5 home", save: () => mkSave(6, true, ["Wilhelmina", "Bartholome", "Christophe"], 5, Date.now() - 12 * 60000) },
    { key: "4P FFA, 1 human, 3 home", save: () => mkSave(4, false, ["Blake"], 3, Date.now() - 90 * 60000) },
  ];
  for (const m of MATRIX) {
    const { ctx, page, errors } = await newCtx(browser, m);
    await page.goto(URL);
    await page.waitForSelector("#btnStart");
    await page.evaluate((saves) => {
      localStorage.setItem("nasty-save-offline-1", JSON.stringify(saves[0]));
      localStorage.setItem("nasty-save-offline-2", JSON.stringify(saves[1]));
    }, CASES.map((c) => c.save()));
    await page.reload();
    await page.waitForTimeout(400);
    const tiles = await page.evaluate(() => ["btnSavedGame", "btnSavedGame2"].map((id) => {
      const row = document.getElementById(id);
      const t1 = row.querySelector(".t1"), t2 = row.querySelector(".t2");
      const line = (el) => parseFloat(getComputedStyle(el).lineHeight) || 16;
      return {
        hidden: row.classList.contains("hidden"),
        t1: t1.textContent.trim(), t2: t2.textContent.trim(),
        t1rows: Math.round(t1.getBoundingClientRect().height / line(t1)),
        t2rows: Math.round(t2.getBoundingClientRect().height / line(t2)),
        t1nowrap: getComputedStyle(t1).whiteSpace === "nowrap",
        t2nowrap: getComputedStyle(t2).whiteSpace === "nowrap",
        tapH: row.querySelector(".savedTileMain").getBoundingClientRect().height,
        over: Math.max(0, row.getBoundingClientRect().right - document.querySelector("#menu .panel").getBoundingClientRect().right),
      };
    }));
    tiles.forEach((t, i) => {
      const label = `${m.name} tile ${i + 1} (${CASES[i].key})`;
      ok(!t.hidden, `${label}: the tile is shown`);
      ok(t.t1rows + t.t2rows === 2, `${label}: EXACTLY 2 rows of text, never more (${t.t1rows} + ${t.t2rows})`);
      ok(t.t1nowrap && t.t2nowrap, `${label}: both rows are single-line by construction, so no name can ever push it to 3 rows`);
      ok(/\b(Teams|FFA)\b/.test(t.t1), `${label}: the tile says whether it was Teams or FFA (got "${t.t1}")`);
      ok(/\b[46]P\b/.test(t.t1), `${label}: the tile says the table size (got "${t.t1}")`);
      ok(/\d\/5 home/.test(t.t2), `${label}: the tile says how many of your own tees were home (got "${t.t2}")`);
      ok(!/everyone for themselves/i.test(t.t1 + t.t2), `${label}: the old "Everyone for themselves" phrasing is gone`);
      ok(t.tapH >= 44, `${label}: the tile is still a 44px+ tap target (${t.tapH.toFixed(1)}px)`);
      ok(t.over <= 0.5, `${label}: the tile does not poke out of the panel (${t.over.toFixed(2)}px)`);
    });
    // The exact counts must be right, not just present.
    ok(/5\/5 home/.test(tiles[0].t2), `${m.name}: the 5-home save says 5/5 (got "${tiles[0].t2}")`);
    ok(/3\/5 home/.test(tiles[1].t2), `${m.name}: the 3-home save says 3/5 (got "${tiles[1].t2}")`);
    ok(/Teams/.test(tiles[0].t1) && /FFA/.test(tiles[1].t1), `${m.name}: Teams and FFA are told apart correctly`);
    ok(errors.length === 0, `${m.name}: zero page errors on the menu`);
    if (m.w === 320 || m.w === 390) {
      const box = await page.evaluate(() => { const b = document.getElementById("btnSavedGame").getBoundingClientRect(); return { x: Math.max(0, b.x - 6), y: Math.max(0, b.y - 6), width: b.width + 12, height: b.height + 12 }; });
      await page.screenshot({ path: path.join(SHOTDIR, `savedtile_${m.w}.png`), clip: box });
    }
    await ctx.close();
  }
}

/* ==================== Part F - the setup screen's two option rows ==================== */
async function partF(browser) {
  console.log("\n=== Part F: the option buttons stand clear of their labels and start at the same left edge ===");
  for (const m of MATRIX) {
    const { ctx, page, errors } = await newCtx(browser, m);
    await page.goto(URL);
    await page.waitForSelector("#btnStart");
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#menu .optRow")].map((row) => {
        const lab = row.querySelector("label").getBoundingClientRect();
        const segs = row.querySelector(".segs").getBoundingClientRect();
        const first = row.querySelector(".seg").getBoundingClientRect();
        return { label: row.querySelector("label").textContent.trim(), labelRight: +lab.right.toFixed(2),
          segsLeft: +segs.left.toFixed(2), segsW: +segs.width.toFixed(2), firstLeft: +first.left.toFixed(2), h: +row.getBoundingClientRect().height.toFixed(2) };
      });
      const panel = document.querySelector("#menu .panel").getBoundingClientRect();
      const btns = ["p4", "p6", "mFFA", "mTeams"].map((id) => {
        const el = document.getElementById(id); const b = el.getBoundingClientRect();
        return { id, text: el.textContent.trim(), h: +b.height.toFixed(2), clipped: el.scrollWidth > el.clientWidth + 0.5, over: +Math.max(0, b.right - panel.right, panel.left - b.left).toFixed(2) };
      });
      return { rows, btns, docOver: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    const players = r.rows.find((x) => /players/i.test(x.label));
    const gameType = r.rows.find((x) => /game type/i.test(x.label));
    ok(Math.abs(players.firstLeft - gameType.firstLeft) <= 0.5,
      `${m.name}: both rows' FIRST buttons share an identical left edge (${players.firstLeft} vs ${gameType.firstLeft}px)`);
    ok(Math.abs(players.segsW - gameType.segsW) <= 0.5,
      `${m.name}: the two option blocks are still the same width (${players.segsW} vs ${gameType.segsW}px) - v0.32 symmetry kept`);
    const gapP = +(players.segsLeft - players.labelRight).toFixed(2);
    const gapG = +(gameType.segsLeft - gameType.labelRight).toFixed(2);
    ok(gapP >= 10 && gapG >= 10, `${m.name}: there is real space between each label and its buttons (${gapP}px / ${gapG}px)`);
    ok(Math.abs(gapP - gapG) <= 0.5, `${m.name}: it is the SAME gap on both rows (${gapP} vs ${gapG})`);
    ok(r.btns.every((b) => b.h >= 44), `${m.name}: every option button clears the 44px tap floor (${JSON.stringify(r.btns.map((b) => b.h))})`);
    ok(r.btns.every((b) => !b.clipped), `${m.name}: no option button clips its own label`);
    ok(r.btns.every((b) => b.over <= 0.5), `${m.name}: no option button pokes out of the panel`);
    ok(r.docOver <= 0, `${m.name}: the menu page has zero horizontal overflow (${r.docOver})`);
    const ffa = r.btns.find((b) => b.id === "mFFA");
    // ASSERTION UPDATED 2026-07-26 (v0.36 item 6), deliberately, not weakened. v0.34 renamed this
    // button from "Everyone for themselves" to "FFA"; v0.36 is Blake changing his mind about the
    // abbreviation: "make that FFA button actually say 'Free-for-All' it should only say FFA in
    // the save state." The thing that must stay true forever is what the ORIGINAL assertion was
    // really about - the old "Everyone for themselves" phrasing is gone - so that is what is
    // checked, plus the new required wording. The saved tiles' short "FFA" has its own assertion
    // in Part E above and in test_ui_v036_2026_07_26.js.
    ok(ffa.text === "Free-for-All", `${m.name}: the game-type button spells out Free-for-All (got "${ffa.text}")`);
    ok(!/everyone for themselves/i.test(ffa.text), `${m.name}: the old "Everyone for themselves" phrasing is still gone`);
    ok(errors.length === 0, `${m.name}: zero page errors`);
    if (m.w === 320 || m.w === 390) await page.screenshot({ path: path.join(SHOTDIR, `setup_${m.w}.png`), clip: { x: 0, y: 0, width: m.w, height: Math.min(m.h, 620) } });
    await ctx.close();
  }
}

/* ==================== Part G - one word for a computer player, and it is CPU ==================== */
async function partG(browser) {
  console.log("\n=== Part G: CPU everywhere, no stray \"computer\" left in anything a player can read ===");
  const { ctx, page, errors } = await newCtx(browser, MATRIX[2]);
  await page.goto(URL);
  await page.waitForSelector("#btnStart");

  // Every readable leaf of user-visible text on the menu/setup screen.
  const menuCopy = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("button,.btn,option,label,li,p,small,.t1,.t2,#lbCaption,h3").forEach((el) => {
      if (el.children.length === 0 || el.tagName === "OPTION") { const t = (el.textContent || "").trim(); if (t) out.push(t); }
    });
    document.querySelectorAll("[aria-label]").forEach((el) => out.push(el.getAttribute("aria-label")));
    return out;
  });
  const menuBad = menuCopy.filter((t) => /\bcomputers?\b/i.test(t));
  ok(menuBad.length === 0, `menu/setup: nothing readable says "computer" (${JSON.stringify(menuBad.slice(0, 4))})`);
  const typeSel = await page.evaluate(() => [...document.querySelectorAll(".typeSel option")].map((o) => o.textContent.trim()));
  ok(typeSel.includes("CPU") && !typeSel.includes("Computer"), `the seat dropdown offers Human / CPU (got ${JSON.stringify([...new Set(typeSel)])})`);

  // In-game copy: the leaderboard caption on both tabs, the PAUSED sheet, the account panel.
  await board(page, 4);
  const gameCopy = await page.evaluate(() => {
    const out = [];
    document.getElementById("btnPause").click();
    document.querySelectorAll("#leaveConfirmOverlay .btn").forEach((b) => out.push(b.textContent.trim()));
    document.getElementById("btnLeaveCancel").click();
    document.getElementById("btnAccount").click();
    document.querySelectorAll("#accountOverlay .acctRow").forEach((b) => out.push(b.textContent.trim()));
    document.getElementById("btnAcctClose").click();
    return out;
  });
  const gameBad = gameCopy.filter((t) => /\bcomputers?\b/i.test(t));
  ok(gameBad.length === 0, `in-game panels: nothing says "computer" (${JSON.stringify(gameBad.slice(0, 4))})`);

  const captions = await page.evaluate(() => {
    const out = {};
    window.lbTab = "solo"; window.updateLbCaption && window.updateLbCaption();
    out.solo = document.getElementById("lbCaption").textContent;
    return out;
  });
  ok(/\bCPUs?\b/.test(captions.solo) && !/\bcomputers?\b/i.test(captions.solo),
    `the leaderboard caption says CPU (got "${captions.solo.slice(0, 80)}...")`);

  // And the source itself carries no user-visible "computer" string. Comments are stripped first -
  // this file and index.html both quote the old wording on purpose to explain the change.
  const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "index.html"), "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const strayLines = src.split("\n").filter((l) => /['"`][^'"`]*\bcomputers?\b/i.test(l));
  ok(strayLines.length === 0, `no live string in index.html still says "computer" (${JSON.stringify(strayLines.slice(0, 3))})`);
  const ffaStray = src.split("\n").filter((l) => /Everyone for themselves/i.test(l));
  ok(ffaStray.length === 0, `no live string still says "Everyone for themselves" (${JSON.stringify(ffaStray.slice(0, 3))})`);
  ok(errors.length === 0, "Part G: zero page errors");
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    await partA(browser);
    await partA2(browser);
    await partB(browser);
    await partC(browser);
    await partD(browser);
    await partE(browser);
    await partF(browser);
    await partG(browser);
  } finally {
    await browser.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`screenshots in ${SHOTDIR}`);
  process.exit(fail ? 1 : 0);
})();
