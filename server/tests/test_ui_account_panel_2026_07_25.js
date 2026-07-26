"use strict";
/*
 * 2026-07-25 permanent regression suite - Blake's feedback after playing v0.32 on his phone.
 * Three asks, all client-side (index.html only; no server file was touched by this batch):
 *
 *   1. "Replace the 'rules' and 'mute' buttons with an account (circle icon) that is the first
 *      letter of their chosen name. When clicked, this opens a mini window that offers the rules
 *      and mute buttons as well as other settings and things that belong on this kind of panel
 *      (including option to delete their account or change their name, stuff like that, but it
 *      makes the row of buttons spacier up top especially on smaller phones)."
 *      Follow-up: "Should also have a sign out button option there."
 *
 *   2. "When the paused button is pressed you can see the 'leave game' badge is over the top of
 *      the old 'paused' badge. Please replace the leave game badge with a pause message instead
 *      and definitely don't stack those badges like that."
 *      Follow-up: "It's actually the whole old page behind it (I can see the buttons too)."
 *
 *   3. "I don't like how you moved the game board up so that it rest right below the nasty sign
 *      when you're playing the game because now there is way too much space down low. There
 *      should always be an equal amount of space between the nasty plaque at the top and the
 *      board as there is between the board at the bottom and the word bubbles that pop up.
 *      Regardless of screen size."
 *
 * Parts:
 *   A - the top bar's new shape: four equal text buttons plus one circle, zero horizontal
 *       overflow, 44px tap targets, at 320/375/390/393/430 with real iOS safe-area insets, in
 *       4P and 6P, in-game AND in post-game review mode.
 *   B - the circle itself: the right letter, the right seat colour, readable ink, every awkward
 *       name shape handled (punctuation-first like "J.B.", no letters at all, empty, lowercase,
 *       astral characters), and the letter updating the instant the name changes.
 *   C - the panel: opens, fits every width with nothing clipped, every row present and doing
 *       what it says (rules, sound, change name, fix my connection), and - IN A BROWSER - the
 *       three account rows visible but disabled behind a plain-language note. Sign in with Apple
 *       shipped in v0.35 and is native only; its live behaviour has its own permanent suite,
 *       test_accounts_stage2_signin_2026_07_25.js.
 *   D - PAUSE shows exactly ONE full-screen page, headed PAUSED, with the options on it; the
 *       plain "someone else paused" page still appears for everyone else, and comes back by
 *       itself when a page that was covering it closes.
 *   E - the invariant: never two full-screen .overlay layers visible at once, checked by opening
 *       every overlay in the app one at a time, plus the legitimate hand-off flows (pause sheet
 *       to concede confirm, overwrite warning, slot replace, reunion lobby, post-game).
 *   F - the board is vertically CENTRED between the in-game logo and the message band: the gap
 *       above equals the gap below within 2px, across the whole matrix, 4P and 6P, including
 *       with a long two-line message and in post-game review mode.
 *
 * Fully offline (file://). Nothing here contacts a server: in a plain browser there is no native
 * Sign in with Apple, so no /account/* call is ever made from these pages.
 *
 * Run: node test_ui_account_panel_2026_07_25.js
 */
const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
const path = require("path");
const fs = require("fs");

const INDEX = "file://" + path.resolve(__dirname, "..", "..", "index.html");
const SHOTDIR = "/private/tmp/claude-501/-Users-jarvis/0bc923da-f111-499a-9b51-18988e4aba3d/scratchpad/shots-acct";
try { fs.mkdirSync(SHOTDIR, { recursive: true }); } catch (e) {}

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}

// Blake's own matrix, with the real notch/home-indicator insets the last few releases have used.
const MATRIX = [
  { w: 320, h: 568, top: 0, bottom: 0, name: "320x568 (SE)" },
  { w: 375, h: 667, top: 0, bottom: 0, name: "375x667 (8)" },
  { w: 390, h: 844, top: 47, bottom: 34, name: "390x844 (13/14)" },
  { w: 393, h: 852, top: 59, bottom: 34, name: "393x852 (15/16 Pro)" },
  { w: 430, h: 932, top: 59, bottom: 34, name: "430x932 (Pro Max)" },
];

async function newCtx(browser, m) {
  const ctx = await browser.newContext({ viewport: { width: m.w, height: m.h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  await client.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: m.top, left: 0, bottom: m.bottom, right: 0 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, page, errors };
}

// An all-CPU game (no human seat) - fastest way onto a real board when the test is about layout.
async function autoBoard(page, n) {
  await page.goto(INDEX + (n === 6 ? "#autotest6" : "#autotest"));
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
  await page.waitForTimeout(400);
}

// A real game started from the menu, so seat 0 is a HUMAN - which is what the account circle is
// about. n=6 flips the players toggle first.
async function humanBoard(page, n) {
  await page.goto(INDEX);
  await page.waitForSelector("#btnStart");
  if (n === 6) { await page.click("#p6"); await page.waitForTimeout(80); }
  await page.click("#btnStart");
  await page.waitForFunction(() => window.G && window.G.n, { timeout: 20000 });
  const picker = await page.evaluate(() => {
    const sp = document.getElementById("speedPickerOverlay");
    return sp && !sp.classList.contains("hidden");
  });
  if (picker) await page.click("#btnSpeedPick0");
  await page.waitForTimeout(250);
}

const visibleOverlays = () => [...document.querySelectorAll(".overlay:not(.hidden)")].map((o) => o.id);

/* ============================= Part A - the top bar shape =============================
   2026-07-25 (v0.34): UPDATED, deliberately, for the top-row rebuild Blake asked for after
   playing v0.33 - "consolidate the 'quit' 'pause' and 'save' buttons into just a pause button in
   the top left and the account icon in the top right". The row is no longer FOUR equal text
   buttons plus a circle; it is ONE text button (PAUSE, or RESULTS once the game is over), the
   NASTY logo centred, and the circle. So the "all text buttons share one width" assertion has
   nothing left to compare and is replaced by "exactly one text button is visible at a time",
   which is the real contract now. Nothing else in this part was weakened: zero overflow, the
   44px floor on both controls, the circle being on screen and never blank, and the old RULES /
   MUTE buttons staying gone are all unchanged. The full new geometry contract (equal insets,
   optical centring of the logo) has its own permanent suite,
   test_ui_topbar_v034_2026_07_25.js. */
async function partA(browser) {
  console.log("\n=== Part A: one text button + centred logo + one circle, zero overflow, every width, 4P/6P, in-game and post-game ===");
  for (const m of MATRIX) {
    for (const n of [4, 6]) {
      for (const postGame of [false, true]) {
        const { ctx, page, errors } = await newCtx(browser, m);
        await autoBoard(page, n);
        if (postGame) {
          // G.over must really be set: syncAll() drives the post-game top bar off it after every
          // move, so faking only showWin() would be undone by the next CPU turn.
          await page.evaluate(() => { window.G.over = true; window.G.winners = [0]; window.showWin(); window.closeWinOverlay(); });
          await page.waitForTimeout(200);
        }
        // Worst case speed label: Turbo is the longest speed word. It lives in the account panel
        // now (v0.34), so it no longer sizes anything in this row - set anyway, so this part still
        // proves the row is unaffected by it.
        await page.evaluate(() => { USER_SPEED = 2.6; updateSpeedButtonLabel(); });
        await page.waitForTimeout(120);
        const r = await page.evaluate(() => {
          const tb = document.getElementById("topbar");
          // v0.34: the buttons sit inside their own left/right slot wrappers, so this walks the
          // whole row rather than only its direct children.
          const shown = [...tb.querySelectorAll("button")].filter((el) => !el.classList.contains("hidden"));
          const text = shown.filter((b) => b.classList.contains("iconBtn"));
          const circle = document.getElementById("btnAccount");
          const cr = circle.getBoundingClientRect();
          return {
            overflow: tb.scrollWidth - tb.clientWidth,
            textIds: text.map((b) => b.id),
            textW: text.map((b) => +b.getBoundingClientRect().width.toFixed(2)),
            textH: text.map((b) => +b.getBoundingClientRect().height.toFixed(2)),
            clipped: text.map((b) => b.scrollWidth - b.clientWidth),
            rules2: !!document.getElementById("btnRules2"),
            oldMute: !!document.getElementById("btnMute"),
            circle: { w: +cr.width.toFixed(2), h: +cr.height.toFixed(2), left: cr.left, right: cr.right, hidden: circle.classList.contains("hidden"), letter: (circle.textContent || "").trim() },
            vw: window.innerWidth,
          };
        });
        const label = `${m.name} ${n}P ${postGame ? "post-game" : "in-game"}`;
        ok(r.overflow === 0, `${label}: ZERO horizontal overflow on the whole row (scrollWidth - clientWidth = ${r.overflow})`);
        ok(r.textW.length === 1,
          `${label}: exactly ONE text button is visible in the row - ${JSON.stringify(r.textIds)} (v0.34 consolidation)`);
        ok(r.clipped.every((c) => c <= 0), `${label}: no text button clips its own label`);
        ok(r.textH.every((h) => h >= 44), `${label}: text buttons clear the 44px tap floor - ${JSON.stringify(r.textH)}`);
        ok(!r.hidden && r.circle.h >= 44 && r.circle.w >= 44, `${label}: the account circle is a real 44px+ tap target (${r.circle.w}x${r.circle.h})`);
        ok(r.circle.left >= -0.5 && r.circle.right <= r.vw + 0.5, `${label}: the circle is fully on screen`);
        ok(r.circle.letter.length >= 1, `${label}: the circle is never blank (shows "${r.circle.letter}")`);
        ok(!r.rules2 && !r.oldMute, `${label}: the old RULES and MUTE top-bar buttons are gone from the app entirely`);
        if (postGame) {
          // v0.34: review mode is RESULTS / logo / circle. The way back to the menu moved into the
          // account panel ("Back to the menu"), and the win popup keeps its own Back to menu too.
          const pg = await page.evaluate(() => ({
            results: document.getElementById("btnResults").textContent,
            resultsHidden: document.getElementById("btnResults").classList.contains("hidden"),
            pauseHidden: document.getElementById("btnPause").classList.contains("hidden"),
            circleHidden: document.getElementById("btnAccount").classList.contains("hidden"),
            menuRowHidden: document.getElementById("btnAcctMenu").classList.contains("hidden"),
            oldMenuBtn: !!document.getElementById("btnMenu"),
            oldSaveBtn: !!document.getElementById("btnSave"),
          }));
          ok(/results/i.test(pg.results) && !pg.resultsHidden && pg.pauseHidden && !pg.circleHidden,
            `${label}: review mode is RESULTS / logo / circle (${pg.results}, circle still there)`);
          ok(!pg.menuRowHidden, `${label}: "Back to the menu" is offered in the account panel once the game is over`);
          ok(!pg.oldMenuBtn && !pg.oldSaveBtn, `${label}: the old QUIT and SAVE top-bar buttons are gone from the app entirely`);
        }
        ok(errors.length === 0, `${label}: zero page errors`);
        if (m.w === 320 && n === 4 && !postGame) await page.screenshot({ path: path.join(SHOTDIR, "topbar_320.png") });
        if (m.w === 390 && n === 4 && !postGame) await page.screenshot({ path: path.join(SHOTDIR, "topbar_390.png") });
        await ctx.close();
      }
    }
  }
}

/* ============================= Part B - the circle's letter and colour ============================= */
async function partB(browser) {
  console.log("\n=== Part B: the circle shows the right letter in the right colour, and updates the moment the name changes ===");
  const { ctx, page, errors } = await newCtx(browser, MATRIX[2]);
  await humanBoard(page, 4);

  const first = await page.evaluate(() => ({
    letter: document.getElementById("acctInitial").textContent,
    name: window.chosenName(),
    seat: window.accountSeatIndex(),
    bg: document.getElementById("btnAccount").style.getPropertyValue("--acctBg"),
    seatColor: window.G.seats[0].color.c,
    aria: document.getElementById("btnAccount").getAttribute("aria-label"),
  }));
  ok(first.seat === 0, "offline, the circle belongs to the first human seat (seat 0)");
  ok(first.letter === first.name.slice(0, 1).toUpperCase(), `the letter is the first letter of the chosen name ("${first.name}" -> "${first.letter}")`);
  ok(first.bg.toLowerCase() === first.seatColor.toLowerCase(), `the circle is painted in that seat's own board colour (${first.bg} === ${first.seatColor})`);
  ok(/./.test(first.aria) && first.aria.indexOf(first.name) >= 0, `the circle has a real accessible label ("${first.aria}")`);

  // Pure-function edge cases - the ones a family will actually produce.
  const cases = await page.evaluate(() => {
    const f = window.accountInitial;
    return {
      jb: f("J.B."), dot: f(".Jim"), lower: f("ginny"), digit: f("7up"), none: f("..."),
      empty: f(""), nul: f(null), spaces: f("   "), emoji: f("\u{1F600}Jim"), accent: f("elsa"),
      accented: f("élodie"),
    };
  });
  ok(cases.jb === "J", 'a name that starts with punctuation-in-the-middle style ("J.B.") shows J');
  ok(cases.dot === "J", 'a name that STARTS with punctuation (".Jim") shows J, not the dot');
  ok(cases.lower === "G", 'a lowercase name ("ginny") shows an uppercase G');
  ok(cases.digit === "7", 'a name that starts with a digit ("7up") shows 7');
  ok(cases.none === "?" && cases.empty === "?" && cases.nul === "?" && cases.spaces === "?",
    'a name with no letters or digits at all, an empty name, and a null name all show "?" - never blank');
  ok(cases.emoji.length >= 1, "an emoji-first name never renders as half a surrogate pair (got a real character)");
  ok(cases.accent === "E" && cases.accented === "É", "accented and non-ASCII first letters are handled");

  // Ink: a light seat colour must get dark ink, a dark one cream.
  const ink = await page.evaluate(() => ({
    yellow: window.inkFor("#f0c419"), white: window.inkFor("#efe6d2"),
    green: window.inkFor("#2f8f5b"), navy: window.inkFor("#41598f"), junk: window.inkFor("nope"),
  }));
  ok(ink.yellow !== ink.green && ink.white !== ink.navy, "light seat colours (Yellow/White) get different ink from dark ones (Green/Navy)");
  ok(!!ink.junk, "an unparseable colour still returns a real ink value (never blank)");

  // A yellow seat really does paint a yellow circle with dark ink.
  const yellow = await page.evaluate(() => {
    window.G.seats[0].type = "cpu";
    window.G.seats[3].type = "human";
    window.updateAccountButton();
    const b = document.getElementById("btnAccount");
    return { seat: window.accountSeatIndex(), bg: b.style.getPropertyValue("--acctBg"), ink: b.style.getPropertyValue("--acctInk"), c: window.G.seats[3].color.c };
  });
  ok(yellow.seat === 3 && yellow.bg.toLowerCase() === yellow.c.toLowerCase(), `a Yellow seat paints a Yellow circle (${yellow.bg})`);
  ok(yellow.ink === "#14210f", `a Yellow circle uses dark ink so the letter is readable (${yellow.ink})`);
  await page.evaluate(() => { window.G.seats[3].type = "cpu"; window.G.seats[0].type = "human"; window.updateAccountButton(); });

  // Change the name: circle, plaque, setup screen and stored config all move together.
  const renamed = await page.evaluate(async () => {
    document.getElementById("btnAccount").click();
    document.getElementById("btnAcctName").click();
    document.getElementById("acctNameInput").value = "Zelda";
    document.getElementById("btnAcctNameSave").click();
    await new Promise((r) => setTimeout(r, 120));
    const cfg = JSON.parse(localStorage.getItem("nasty-setup") || "{}");
    return {
      letter: document.getElementById("acctInitial").textContent,
      avatar: document.getElementById("acctAvatar").textContent,
      who: document.getElementById("acctWhoName").textContent,
      seatName: window.G.seats[0].name,
      plaque: document.querySelector("#plaque-0 .nm").textContent,
      cfg4: cfg.seatMeta["4"][0].name, cfg6: cfg.seatMeta["6"][0].name,
      editorHidden: document.getElementById("acctNameEdit").classList.contains("hidden"),
      chosen: window.chosenName(),
    };
  });
  ok(renamed.letter === "Z", `the circle's letter updates IMMEDIATELY after a name change (now "${renamed.letter}")`);
  ok(renamed.avatar === "Z" && renamed.who === "Zelda", "the panel's own avatar and name update too");
  ok(renamed.seatName === "Zelda" && renamed.plaque === "Zelda", "the live game's seat and its board name plate are renamed as well (offline)");
  ok(renamed.cfg4 === "Zelda" && renamed.cfg6 === "Zelda", "the stored setup name is updated for BOTH table sizes, so it is the same name next game");
  ok(renamed.editorHidden, "the inline name editor closes itself after saving");
  ok(renamed.chosen === "Zelda", "chosenName() - the one value the setup screen and the online join screen read - is the new name");

  // Rejected names never get through, and never blank the circle.
  const rejected = await page.evaluate(async () => {
    document.getElementById("btnAcctName").click();
    document.getElementById("acctNameInput").value = "shit";
    document.getElementById("btnAcctNameSave").click();
    await new Promise((r) => setTimeout(r, 80));
    const warn1 = document.getElementById("acctNameWarn").textContent;
    document.getElementById("acctNameInput").value = "   ";
    document.getElementById("btnAcctNameSave").click();
    await new Promise((r) => setTimeout(r, 80));
    const warn2 = document.getElementById("acctNameWarn").textContent;
    document.getElementById("btnAcctNameCancel").click();
    return { warn1, warn2, still: window.chosenName(), letter: document.getElementById("acctInitial").textContent };
  });
  ok(/nicer/i.test(rejected.warn1), `a blocked name is refused with a friendly message ("${rejected.warn1}")`);
  ok(/name/i.test(rejected.warn2), `an empty name is refused with a friendly message ("${rejected.warn2}")`);
  ok(rejected.still === "Zelda" && rejected.letter === "Z", "a refused name never changes the stored name or the circle");

  // The join screen pre-fills with the same one name.
  const prefilled = await page.evaluate(async () => {
    document.getElementById("btnAcctClose").click();
    window.doLeaveGame(true);
    await new Promise((r) => setTimeout(r, 200));
    window.openJoinOverlay("", true);
    await new Promise((r) => setTimeout(r, 150));
    return document.getElementById("joinNameInput").value;
  });
  ok(prefilled === "Zelda", `the online join screen pre-fills the same chosen name (got "${prefilled}")`);

  ok(errors.length === 0, "Part B: zero page errors");
  await ctx.close();
}

/* ============================= Part C - the panel ============================= */
async function partC(browser) {
  console.log("\n=== Part C: the account panel - opens, fits, every row works or is clearly disabled ===");
  for (const m of MATRIX) {
    const { ctx, page, errors } = await newCtx(browser, m);
    await humanBoard(page, 4);
    await page.click("#btnAccount");
    await page.waitForTimeout(200);

    const geo = await page.evaluate(() => {
      const ov = document.getElementById("accountOverlay");
      const card = ov.querySelector(".modalCard");
      const cr = card.getBoundingClientRect();
      const rows = [...ov.querySelectorAll(".acctRow")].filter((b) => !b.classList.contains("hidden"));
      return {
        open: !ov.classList.contains("hidden"),
        onlyOne: [...document.querySelectorAll(".overlay:not(.hidden)")].length,
        cardLeft: cr.left, cardRight: cr.right, cardTop: cr.top, cardBottom: cr.bottom,
        vw: window.innerWidth, vh: window.innerHeight,
        overflowX: card.scrollWidth - card.clientWidth,
        rows: rows.map((b) => ({ id: b.id, h: +b.getBoundingClientRect().height.toFixed(1), w: +b.getBoundingClientRect().width.toFixed(1), text: b.textContent.trim(), disabled: b.disabled })),
        // The card is the scroller here (.modalCard is max-height:82vh + overflow-y:auto), with
        // the overlay itself as the outer fallback - scroll both, then check the last control is
        // genuinely reachable, the same "nothing is silently unreachable" check
        // test_overlay_sizing.js Part C makes for the confirm dialogs.
        reachable: (() => { card.scrollTop = card.scrollHeight; ov.scrollTop = ov.scrollHeight; const b = document.getElementById("btnAcctClose").getBoundingClientRect(); return b.top >= -0.5 && b.bottom <= window.innerHeight + 0.5; })(),
      };
    });
    ok(geo.open, `${m.name}: the panel opens`);
    ok(geo.onlyOne === 1, `${m.name}: exactly one full-screen page is visible with the panel open (${geo.onlyOne})`);
    ok(geo.cardLeft >= -0.5 && geo.cardRight <= geo.vw + 0.5, `${m.name}: the panel is fully within the screen width (${geo.cardLeft.toFixed(1)} - ${geo.cardRight.toFixed(1)} of ${geo.vw})`);
    ok(geo.overflowX <= 0, `${m.name}: nothing inside the panel overflows sideways`);
    ok(geo.rows.every((r) => r.h >= 44), `${m.name}: every row clears the 44px tap floor - ${JSON.stringify(geo.rows.map((r) => r.h))}`);
    ok(geo.reachable, `${m.name}: the Close button is reachable (scrolling if the panel is taller than the screen)`);
    ok(errors.length === 0, `${m.name}: zero page errors with the panel open`);
    if (m.w === 320 || m.w === 390) await page.screenshot({ path: path.join(SHOTDIR, `panel_${m.w}.png`) });
    await ctx.close();
  }

  // Behaviour, once, at a normal width.
  const { ctx, page, errors } = await newCtx(browser, MATRIX[2]);
  await humanBoard(page, 4);
  await page.click("#btnAccount");
  await page.waitForTimeout(180);

  const rows = await page.evaluate(() => {
    const ids = ["btnAcctRules", "btnAcctSound", "btnAcctName", "btnAcctReset", "btnAcctSignIn", "btnAcctSignOut", "btnAcctDelete"];
    const out = {};
    ids.forEach((id) => {
      const b = document.getElementById(id);
      out[id] = b ? { text: b.textContent.trim(), hidden: b.classList.contains("hidden"), disabled: !!b.disabled, danger: /danger/.test(b.className) } : null;
    });
    out.note = document.getElementById("acctSoonNote").textContent;
    return out;
  });
  ok(rows.btnAcctRules && !rows.btnAcctRules.hidden, "the panel offers the rules");
  ok(rows.btnAcctSound && /sound/i.test(rows.btnAcctSound.text) && /on|off/i.test(rows.btnAcctSound.text), `the panel offers the sound toggle, showing its current state ("${rows.btnAcctSound.text}")`);
  ok(rows.btnAcctName && /name/i.test(rows.btnAcctName.text), "the panel offers Change your name");
  ok(rows.btnAcctReset && rows.btnAcctReset.hidden, "offline, Fix my connection is hidden (there is no server to re-reach) - same gating it had in the pause sheet");
  ok(rows.btnAcctReset && !rows.btnAcctReset.danger && !/reset connection/i.test(rows.btnAcctReset.text), `Fix my connection is plain language and not styled as costly (got "${rows.btnAcctReset.text}") - the two assertions that used to live in test_ui_polish Part F`);
  /* 2026-07-25 (v0.35) - UPDATED, not weakened. These three assertions used to mean "accounts do
     not exist yet". Sign in with Apple shipped in v0.35, so what they mean NOW is the thing that
     has to stay true forever: this is a plain browser, there is no native Sign in with Apple to
     call, so the rows stay exactly where they are and stay disabled behind an honest sentence
     rather than showing a dead Apple button. The live side of it has its own permanent suite,
     test_accounts_stage2_signin_2026_07_25.js, which drives the real flow end to end. */
  ok(rows.btnAcctSignIn && !rows.btnAcctSignIn.hidden && rows.btnAcctSignIn.disabled, "on the WEBSITE, Sign in is VISIBLE but disabled (no native Sign in with Apple here)");
  ok(rows.btnAcctSignOut && !rows.btnAcctSignOut.hidden && rows.btnAcctSignOut.disabled, "on the WEBSITE, Sign out is VISIBLE but disabled");
  ok(rows.btnAcctDelete && !rows.btnAcctDelete.hidden && rows.btnAcctDelete.disabled, "on the WEBSITE, Delete account is VISIBLE but disabled");
  ok(/coming soon/i.test(rows.note), `the panel says so in plain language ("${rows.note}")`);
  ok(!/apple/i.test(rows.btnAcctSignIn.text), `no dead Apple button in a browser - the row just reads "${rows.btnAcctSignIn.text}"`);

  /* This used to be "no /account/* call may exist anywhere in the app". As of v0.35 exactly one
     provider is wired up, so the assertion becomes the narrower thing that must hold: Apple is
     live, and Google, Facebook, the email code, the one-time claim and the account-aware
     /leaderboard/v2 are all still parked. */
  const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "index.html"), "utf8");
  ok(/\/account\/apple/.test(src) && /\/account\/nonce/.test(src), "the client calls Apple's account endpoints (live since v0.35)");
  ok(!/\/account\/(google|facebook|email)/.test(src) && !/\/account\/claim/.test(src) && !/\/leaderboard\/v2/.test(src),
    "Google, Facebook, the email code, the name-claim window and /leaderboard/v2 are all still parked");

  // Sound really toggles, and persists.
  const sound = await page.evaluate(async () => {
    const before = document.getElementById("btnAcctSound").textContent;
    document.getElementById("btnAcctSound").click();
    await new Promise((r) => setTimeout(r, 80));
    const after = document.getElementById("btnAcctSound").textContent;
    const stored = localStorage.getItem("nasty-muted");
    document.getElementById("btnAcctSound").click();
    await new Promise((r) => setTimeout(r, 80));
    return { before, after, stored, back: document.getElementById("btnAcctSound").textContent, storedBack: localStorage.getItem("nasty-muted") };
  });
  ok(sound.before !== sound.after, `the sound row toggles ("${sound.before}" -> "${sound.after}")`);
  ok(sound.stored === "1" && sound.storedBack === "0", "muting is remembered on the phone, exactly as the old MUTE button did");
  ok(sound.back === sound.before, "toggling twice comes back to where it started");

  // Rules opens the SAME rules panel, one page at a time, and hands the account panel back.
  const rulesFlow = await page.evaluate(async () => {
    document.getElementById("btnAcctRules").click();
    await new Promise((r) => setTimeout(r, 150));
    const during = [...document.querySelectorAll(".overlay:not(.hidden)")].map((o) => o.id);
    document.getElementById("btnRulesClose").click();
    await new Promise((r) => setTimeout(r, 150));
    const after = [...document.querySelectorAll(".overlay:not(.hidden)")].map((o) => o.id);
    return { during, after };
  });
  ok(rulesFlow.during.length === 1 && rulesFlow.during[0] === "rulesOverlay", `the rules panel replaces the account panel rather than stacking on it (${JSON.stringify(rulesFlow.during)})`);
  ok(rulesFlow.after.length === 1 && rulesFlow.after[0] === "accountOverlay", `closing the rules hands the account panel back (${JSON.stringify(rulesFlow.after)})`);

  // Fix my connection appears online only, and does not open a second page.
  const online = await page.evaluate(async () => {
    window.NET.online = true;
    window.renderAccountPanel();
    await new Promise((r) => setTimeout(r, 80));
    const shown = !document.getElementById("btnAcctReset").classList.contains("hidden");
    window.NET.online = false;
    window.renderAccountPanel();
    return shown;
  });
  ok(online, "online, Fix my connection appears in the panel (it moved here out of the pause sheet)");

  // The inline name editor is INSIDE this panel - it must never be a second full-screen page.
  const editor = await page.evaluate(async () => {
    document.getElementById("btnAcctName").click();
    await new Promise((r) => setTimeout(r, 100));
    return {
      open: !document.getElementById("acctNameEdit").classList.contains("hidden"),
      overlays: [...document.querySelectorAll(".overlay:not(.hidden)")].map((o) => o.id),
      inputH: document.getElementById("acctNameInput").getBoundingClientRect().height,
    };
  });
  ok(editor.open && editor.overlays.length === 1 && editor.overlays[0] === "accountOverlay",
    "the name editor opens inside the panel - still exactly one full-screen page");
  ok(editor.inputH >= 44, `the name box is a real tap target (${editor.inputH.toFixed(1)}px)`);

  ok(errors.length === 0, "Part C: zero page errors");
  await ctx.close();
}

/* ============================= Part D - the PAUSED page ============================= */
async function partD(browser) {
  console.log("\n=== Part D: PAUSE shows exactly ONE page, headed PAUSED, and the plain paused page still works for everyone else ===");
  for (const m of MATRIX) {
    const { ctx, page, errors } = await newCtx(browser, m);
    await humanBoard(page, 4);
    await page.click("#btnPause");
    await page.waitForTimeout(250);
    const r = await page.evaluate(() => {
      const vis = [...document.querySelectorAll(".overlay:not(.hidden)")];
      const sheet = document.getElementById("leaveConfirmOverlay");
      const cc = sheet.querySelector(".confirmCard").getBoundingClientRect();
      return {
        visible: vis.map((o) => o.id),
        badge: sheet.querySelector(".sign b").textContent.trim(),
        body: sheet.querySelector("p").textContent.trim(),
        buttons: [...sheet.querySelectorAll(".bigBtns .btn")].filter((b) => !b.classList.contains("hidden")).map((b) => ({ id: b.id, text: b.textContent.trim(), danger: /danger/.test(b.className), primary: /primary/.test(b.className) })),
        paused: window.G.paused,
        cardTop: cc.top, cardBottom: cc.bottom, vh: window.innerHeight,
        pauseOverlayHidden: document.getElementById("pauseOverlay").classList.contains("hidden"),
      };
    });
    ok(r.visible.length === 1, `${m.name}: EXACTLY ONE full-screen page after tapping PAUSE (${JSON.stringify(r.visible)})`);
    ok(r.visible[0] === "leaveConfirmOverlay" && r.pauseOverlayHidden, `${m.name}: it is the pause sheet, and the old plain paused page is NOT underneath it`);
    ok(r.badge === "PAUSED", `${m.name}: the badge reads PAUSED (was "LEAVE GAME?")`);
    ok(!/leave game\?/i.test(r.body) && r.body.length > 10, `${m.name}: the wording is about pausing ("${r.body}")`);
    ok(r.paused === true, `${m.name}: the table really is paused`);
    ok(r.buttons[0] && r.buttons[0].id === "btnLeaveCancel" && r.buttons[0].primary, `${m.name}: the safe option is still first and primary (v0.31 ordering)`);
    ok(r.buttons.some((b) => b.id === "btnLeaveSave") && r.buttons.some((b) => b.id === "btnLeaveDiscard" && b.danger),
      `${m.name}: save-and-leave and the danger-styled leave-without-saving are both still there`);
    ok(!r.buttons.some((b) => b.id === "btnResetConnection"), `${m.name}: Fix my connection is NOT in this sheet any more (it moved to the account panel)`);
    ok(r.cardTop >= -0.5 && r.cardBottom <= r.vh + 0.5, `${m.name}: the page fits the screen (top ${r.cardTop.toFixed(1)}, bottom ${r.cardBottom.toFixed(1)}, viewport ${r.vh})`);
    ok(errors.length === 0, `${m.name}: zero page errors`);
    if (m.w === 320 || m.w === 390) await page.screenshot({ path: path.join(SHOTDIR, `paused_${m.w}.png`) });
    await ctx.close();
  }

  // Everyone ELSE at the table still sees the plain "PAUSED / tap to resume" page.
  const { ctx, page, errors } = await newCtx(browser, MATRIX[2]);
  await humanBoard(page, 4);
  const other = await page.evaluate(async () => {
    window.setPaused(true);   // a pause that did NOT come from this phone's own sheet
    await new Promise((r) => setTimeout(r, 200));
    const vis = [...document.querySelectorAll(".overlay:not(.hidden)")].map((o) => o.id);
    return { vis, badge: document.querySelector("#pauseOverlay .sign b").textContent.trim(), sub: document.getElementById("pauseSub").textContent };
  });
  ok(other.vis.length === 1 && other.vis[0] === "pauseOverlay", `a pause someone else started still shows the plain paused page, on its own (${JSON.stringify(other.vis)})`);
  ok(other.badge === "PAUSED" && /resume/i.test(other.sub), `it still reads PAUSED / tap to resume ("${other.sub}")`);

  // ...and it gets out of the way for a real page, then comes back by itself.
  const shuffle = await page.evaluate(async () => {
    window.openOverlay("rulesOverlay");
    await new Promise((r) => setTimeout(r, 120));
    const during = [...document.querySelectorAll(".overlay:not(.hidden)")].map((o) => o.id);
    document.getElementById("btnRulesClose").click();
    await new Promise((r) => setTimeout(r, 200));
    const after = [...document.querySelectorAll(".overlay:not(.hidden)")].map((o) => o.id);
    return { during, after, paused: window.G.paused };
  });
  ok(shuffle.during.length === 1 && shuffle.during[0] === "rulesOverlay", "opening the rules while the table is paused hides the paused page rather than stacking (1 page)");
  ok(shuffle.after.length === 1 && shuffle.after[0] === "pauseOverlay" && shuffle.paused, "closing it brings the paused page back by itself, because the table is still paused");

  // Tapping the plain page's own Leave game button hands over to the sheet - still one page.
  const handoff = await page.evaluate(async () => {
    document.getElementById("btnSaveQuit").click();
    await new Promise((r) => setTimeout(r, 200));
    return [...document.querySelectorAll(".overlay:not(.hidden)")].map((o) => o.id);
  });
  ok(handoff.length === 1 && handoff[0] === "leaveConfirmOverlay", `the plain page's own Leave game button hands over to the sheet without stacking (${JSON.stringify(handoff)})`);
  ok(errors.length === 0, "Part D: zero page errors");
  await ctx.close();
}

/* ============================= Part E - never two full-screen pages ============================= */
async function partE(browser) {
  console.log("\n=== Part E: the invariant - one full-screen page at a time, everywhere in the app ===");
  const { ctx, page, errors } = await newCtx(browser, MATRIX[2]);
  await humanBoard(page, 4);

  // Every overlay in the app, opened one after another from whatever is already up.
  const ids = await page.evaluate(async () => {
    const seq = [
      ["accountOverlay", () => document.getElementById("btnAccount").click()],
      ["rulesOverlay", () => window.openOverlay("rulesOverlay")],
      ["leaveConfirmOverlay", () => window.openLeaveConfirm()],
      ["surrenderConfirmOverlay", () => window.openSurrenderConfirm()],
      ["overwriteWarnOverlay", () => window.openOverlay("overwriteWarnOverlay")],
      ["slotReplaceOverlay", () => window.openOverlay("slotReplaceOverlay")],
      ["speedPickerOverlay", () => window.openOverlay("speedPickerOverlay")],
      ["hostSpeedOverlay", () => window.openOverlay("hostSpeedOverlay")],
      ["onlineOverlay", () => window.openOverlay("onlineOverlay")],
      ["joinOverlay", () => window.openOverlay("joinOverlay")],
      ["roomOverlay", () => window.openOverlay("roomOverlay")],
      ["onlineRulesOverlay", () => window.openOverlay("onlineRulesOverlay")],
      ["reunionOverlay", () => window.openOverlay("reunionOverlay")],
      ["lbOverlay", () => window.openOverlay("lbOverlay")],
      ["adminOverlay", () => window.openOverlay("adminOverlay")],
      ["passOverlay", () => window.openOverlay("passOverlay")],
      ["winOverlay", () => window.openOverlay("winOverlay")],
      ["accountOverlay", () => window.openOverlay("accountOverlay")],
    ];
    const out = [];
    for (const [id, fn] of seq) {
      fn();
      await new Promise((r) => setTimeout(r, 60));
      out.push({ want: id, vis: [...document.querySelectorAll(".overlay:not(.hidden)")].map((o) => o.id) });
    }
    return out;
  });
  for (const step of ids) {
    ok(step.vis.length === 1 && step.vis[0] === step.want, `opening ${step.want} leaves EXACTLY it visible (${JSON.stringify(step.vis)})`);
  }

  // The backstop: even a raw classList.remove('hidden') - the way every one of these used to be
  // opened - is corrected within a frame.
  const raw = await page.evaluate(async () => {
    window.openOverlay("accountOverlay");
    document.getElementById("rulesOverlay").classList.remove("hidden");   // deliberately NOT through openOverlay
    const immediate = [...document.querySelectorAll(".overlay:not(.hidden)")].map((o) => o.id);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))));
    const settled = [...document.querySelectorAll(".overlay:not(.hidden)")].map((o) => o.id);
    return { immediate, settled };
  });
  ok(raw.immediate.length === 2, `sanity: a raw classList.remove really did put two pages up for a moment (${JSON.stringify(raw.immediate)})`);
  ok(raw.settled.length === 1 && raw.settled[0] === "rulesOverlay", `the backstop settles it to the newest one within a frame (${JSON.stringify(raw.settled)})`);

  // The one documented exemption, and only that one.
  // STACKABLE_OVERLAYS is a top-level `const`, which in a classic script is a lexical binding and
  // NOT a window property - a bare identifier inside evaluate() reaches the real one (same trick
  // this repo's other suites use for USER_SPEED, see HANDOFF.md's window.SPEED note).
  const exempt = await page.evaluate(() => STACKABLE_OVERLAYS);
  ok(Array.isArray(exempt) && exempt.length === 1 && exempt[0] === "reclaimReqOverlay",
    `exactly one deliberate exemption, the host's "someone wants back in" prompt (${JSON.stringify(exempt)})`);

  // The real hand-off flows a family will actually walk through.
  const flows = await page.evaluate(async () => {
    const snap = () => [...document.querySelectorAll(".overlay:not(.hidden)")].map((o) => o.id);
    const out = {};
    // pause sheet -> concede confirm -> back to the game
    document.getElementById("btnAccount").click();
    document.getElementById("btnAcctClose").click();
    document.getElementById("btnPause").click();
    await new Promise((r) => setTimeout(r, 120));
    out.sheet = snap();
    document.getElementById("btnLeaveDiscard").click();
    await new Promise((r) => setTimeout(r, 120));
    out.concede = snap();
    document.getElementById("btnSurrenderCancel").click();
    await new Promise((r) => setTimeout(r, 200));
    out.afterCancel = snap();
    out.pausedAfterCancel = window.G.paused;
    // 2026-07-25 (v0.34 top-row rebuild): the SAVE button and its own SAVE & LEAVE? confirm are
    // gone - Blake asked for the top row to consolidate down to one PAUSE button, and the safe
    // "Save & leave" exit has always lived on this same PAUSED sheet, calling the identical
    // doLeaveGame(true). Coverage did not move: the sheet's own Save & leave button is exercised
    // right here, and it must still be exactly one page with nothing stacked under it.
    document.getElementById("btnPause").click();
    await new Promise((r) => setTimeout(r, 120));
    out.save = snap();
    document.getElementById("btnLeaveCancel").click();
    await new Promise((r) => setTimeout(r, 120));
    out.afterSave = snap();
    // post-game (G.over for real - see Part A's note)
    window.G.over = true;
    window.G.winners = [0];
    window.showWin();
    await new Promise((r) => setTimeout(r, 150));
    out.win = snap();
    window.closeWinOverlay();
    await new Promise((r) => setTimeout(r, 120));
    out.review = snap();
    document.getElementById("btnResults").click();   // the post-game RESULTS button (v0.34)
    await new Promise((r) => setTimeout(r, 150));
    out.results = snap();
    return out;
  });
  ok(flows.sheet.length === 1 && flows.sheet[0] === "leaveConfirmOverlay", "pause sheet: one page");
  ok(flows.concede.length === 1 && flows.concede[0] === "surrenderConfirmOverlay", `the concede confirm reached FROM the pause sheet replaces it (${JSON.stringify(flows.concede)})`);
  ok(flows.afterCancel.length === 0, `cancelling the concede confirm leaves NO page up and resumes the table (paused=${flows.pausedAfterCancel})`);
  ok(flows.save.length === 1 && flows.save[0] === "leaveConfirmOverlay", "the PAUSED sheet (which carries Save & leave) is one page");
  ok(flows.afterSave.length === 0, "closing it leaves the board clear");
  ok(flows.win.length === 1 && flows.win[0] === "winOverlay", "the win popup is one page");
  ok(flows.review.length === 0, "post-game review mode shows the finished board with no page over it");
  ok(flows.results.length === 1 && flows.results[0] === "winOverlay", "Results reopens exactly one page");
  ok(errors.length === 0, "Part E: zero page errors");
  await ctx.close();
}

/* ============================= Part F - the board sits in the middle ============================= */
// The two gaps Blake is describing, measured against what he can actually SEE:
//   top    - the bottom of the visible in-game logo (the "EST. 1993" line when it is showing, the
//            NASTY sign itself when item C has hidden that line on a short screen);
//   bottom - the top of the message band (#toasts), the fixed row the bubble and Skip share;
//   board  - the SVG's own drawn artwork (getBBox), not the 1000x1000 canvas box, which carries
//            deliberate slack around the drawing for plaques and tee overhang.
const GAP_PROBE = () => {
  const svg = document.getElementById("boardSvg");
  const bb = svg.getBBox();
  const bs = document.getElementById("boardScale");
  const s = new DOMMatrix(getComputedStyle(bs).transform).a;
  const bsr = bs.getBoundingClientRect();
  const artTop = bsr.top + bb.y * s, artBottom = bsr.top + (bb.y + bb.height) * s;
  const sub = document.querySelector("#gameLogo .sub2");
  const subShown = getComputedStyle(sub).visibility !== "hidden";
  const logoBottom = subShown ? sub.getBoundingClientRect().bottom : document.querySelector("#gameLogo .sign").getBoundingClientRect().bottom;
  const band = document.getElementById("toasts").getBoundingClientRect();
  return {
    above: +(artTop - logoBottom).toFixed(2), below: +(band.top - artBottom).toFixed(2),
    scale: +s.toFixed(4), subShown,
    boxBottom: bsr.bottom, bandTop: band.top,
  };
};

async function partF(browser) {
  console.log("\n=== Part F: the board is centred between the logo and the message band - equal gaps, every width, 4P and 6P ===");
  for (const m of MATRIX) {
    for (const n of [4, 6]) {
      const { ctx, page, errors } = await newCtx(browser, m);
      await autoBoard(page, n);
      const g = await page.evaluate(GAP_PROBE);
      const label = `${m.name} ${n}P`;
      ok(Math.abs(g.above - g.below) <= 2,
        `${label}: the gap above the board equals the gap below (${g.above}px vs ${g.below}px)`);
      ok(g.above > 0 && g.below > 0, `${label}: both gaps are real, not zero or negative`);
      ok(g.boxBottom <= g.bandTop + 0.5, `${label}: the board still never reaches the message band (v0.31 item B holds)`);

      // A long two-line message must not move the board.
      const after = await page.evaluate(async () => {
        window.toast("\u{1F4A5} NASTY! Wilhelmina sends Wilhelmina back to base!", 4000, true);
        await new Promise((r) => setTimeout(r, 400));
        return null;
      }).then(() => page.evaluate(GAP_PROBE));
      ok(Math.abs(after.above - g.above) <= 0.5 && Math.abs(after.below - g.below) <= 0.5,
        `${label}: a long two-line message does not move the board (${after.above}/${after.below})`);

      // Post-game review mode keeps the same layout.
      const pg = await page.evaluate(async () => {
        window.G.over = true; window.G.winners = [0]; window.showWin(); window.closeWinOverlay();
        await new Promise((r) => setTimeout(r, 200));
        window.fitBoard();
        await new Promise((r) => setTimeout(r, 100));
        return null;
      }).then(() => page.evaluate(GAP_PROBE));
      ok(Math.abs(pg.above - pg.below) <= 2, `${label}: still centred in post-game review mode (${pg.above}px vs ${pg.below}px)`);
      ok(errors.length === 0, `${label}: zero page errors`);
      if (n === 4 && (m.w === 320 || m.w === 390)) await page.screenshot({ path: path.join(SHOTDIR, `board_centred_${m.w}.png`) });
      await ctx.close();
    }
  }

  // A resize mid-game re-centres rather than drifting.
  const { ctx, page, errors } = await newCtx(browser, MATRIX[4]);
  await autoBoard(page, 4);
  await page.setViewportSize({ width: 375, height: 667 });
  await page.waitForTimeout(400);
  const resized = await page.evaluate(GAP_PROBE);
  ok(Math.abs(resized.above - resized.below) <= 2, `after a mid-game resize the board re-centres itself (${resized.above}px vs ${resized.below}px)`);
  ok(errors.length === 0, "Part F: zero page errors across a resize");
  await ctx.close();
}

async function main() {
  const browser = await chromium.launch();
  await partA(browser);
  await partB(browser);
  await partC(browser);
  await partD(browser);
  await partE(browser);
  await partF(browser);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log("screenshots in " + SHOTDIR);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
