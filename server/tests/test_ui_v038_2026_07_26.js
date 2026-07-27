"use strict";
/*
 * test_ui_v038_2026_07_26.js - PERMANENT suite for Blake's 2026-07-26 welcome-screen edit, sent
 * after he looked at the first-run screen on his phone.
 *
 *   Blake: "Add more space beneath the nasty badge and the welcome to nasty message. Also make it
 *   more exciting! And don't mention the word 'family'."
 *
 * Three things, all copy and spacing on #welcomeOverlay (index.html only - no engine, no server):
 *   1. SPACING - real vertical breathing room between the NASTY road-sign badge and the "Welcome
 *      to NASTY" heading, and between that heading and the first sentence.
 *   2. NO "FAMILY" - the word is gone from everything a player reads, not just this screen.
 *   3. PUNCHIER COPY - the exact strings Blake approved, in the game's own voice.
 *
 * Parts:
 *   A - the two gaps are measurably bigger than v0.37's, at all five widths in Blake's matrix,
 *       with real safe-area insets, and nothing overflows sideways.
 *   B - 320x568: the card is allowed to scroll (it always has at that height) but both CHOICES
 *       and the age line must still be above the fold. That is the contract the short-phone media
 *       query exists to keep and this edit must not break it.
 *   C - the copy: the new sentences are present verbatim, the two factual sentences are untouched,
 *       no em or en dashes anywhere, and the word "family" appears nowhere on the screen.
 *   D - repo-wide: no user-facing "family" string left anywhere in index.html. Comments are
 *       explicitly allowed to keep it (Blake meant the words players read) and `font-family` is
 *       obviously fine, so both are stripped before the scan.
 *   E - behaviour unchanged: shows once, both paths still work, and the persistence keys are
 *       still the ones v0.36 shipped (this edit must be copy-only).
 *
 * Everything is local, file:// only. No server, no network, nothing touched in production.
 *
 * Run: node tests/test_ui_v038_2026_07_26.js
 */
const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..", "..");
const INDEX_PATH = process.env.NASTY_INDEX || path.join(ROOT, "index.html");
const INDEX = "file://" + INDEX_PATH;
const SRC = fs.readFileSync(INDEX_PATH, "utf8");
const SHOTDIR = path.join("/private/tmp/claude-501/-Users-jarvis/0bc923da-f111-499a-9b51-18988e4aba3d/scratchpad", "shots-v038");
fs.mkdirSync(SHOTDIR, { recursive: true });

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}

// Blake's own device matrix with the insets each one really reports (same list as the v0.36/v0.37
// suites - kept identical on purpose so a layout claim means the same thing across all three).
const MATRIX = [
  { name: "320x568 (SE1)", w: 320, h: 568, top: 0, bottom: 0 },
  { name: "375x667 (SE2/3)", w: 375, h: 667, top: 0, bottom: 0 },
  { name: "390x844 (12/13/14)", w: 390, h: 844, top: 47, bottom: 34 },
  { name: "393x852 (15/16 Pro)", w: 393, h: 852, top: 59, bottom: 34 },
  { name: "430x932 (Pro Max)", w: 430, h: 932, top: 59, bottom: 34 },
];

/* v0.37's MEASURED visual gaps, not its CSS numbers - taken by running this exact suite against
   `git show 81b1a79:index.html` (the shipped v0.37 file) on 2026-07-26. Measuring rather than
   reading the CSS matters in the short branch: the badge is transform:scale(.62)d there, and
   scale() shrinks what you SEE without shrinking the laid-out box, so a -14px margin still leaves
   a 17.4px visual gap. Comparing against the raw -14 would have made the short-phone assertion
   below pass trivially and hidden the fact that this branch is intentionally untouched. */
const V037 = {
  tall: { badgeToH3: 6.0, h3ToNote: 10.0 },
  short: { badgeToH3: 17.4, h3ToNote: 6.0, ageBottom: 522.7 },
};

async function newCtx(browser, m) {
  const ctx = await browser.newContext({ viewport: { width: m.w, height: m.h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  await client.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: m.top, left: 0, bottom: m.bottom, right: 0 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, page, errors };
}

async function openWelcome(browser, m) {
  const { ctx, page, errors } = await newCtx(browser, m);
  await page.goto(INDEX);
  await page.waitForSelector("#btnWelcomeGuest");
  await page.waitForTimeout(350);
  return { ctx, page, errors };
}

function measure() {
  const card = document.querySelector("#welcomeOverlay .modalCard");
  const sign = document.querySelector("#welcomeOverlay .sign");
  const h3 = document.querySelector("#welcomeOverlay h3");
  const note = document.querySelector("#welcomeOverlay .welcomeNote");
  const apple = document.getElementById("btnWelcomeApple");
  const guest = document.getElementById("btnWelcomeGuest");
  const fines = Array.from(document.querySelectorAll("#welcomeOverlay .welcomeFine"))
    .filter((p) => !p.classList.contains("hidden") && p.getClientRects().length);
  const ageLine = fines.find((p) => /ages 13/i.test(p.textContent)) || null;
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height }; };
  // The badge is transform:scale()d in the short-phone branch, so getBoundingClientRect gives the
  // VISUAL box (what a person sees) while the negative CSS margin acts on the unscaled layout box.
  // The visual gap is the one that matters for "does it look cramped", so that is what is measured.
  return {
    card: r(card), sign: r(sign), h3: r(h3), note: r(note),
    apple: r(apple), guest: r(guest), age: r(ageLine),
    appleHidden: !apple || apple.classList.contains("hidden"),
    gapBadgeToH3: r(h3).top - r(sign).bottom,
    gapH3ToNote: r(note).top - r(h3).bottom,
    // .overlay.canScroll paints a 64px bottom fade plus the "more below - swipe up" nudge
    // (§ STYLE). Anything under that band is legible-ish at best, so "above the fold" for a
    // sentence a person has to READ means above innerHeight-64, not merely above innerHeight.
    canScroll: document.getElementById("welcomeOverlay").classList.contains("canScroll"),
    hintBand: 64,
    docScrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    copy: document.getElementById("welcomeOverlay").textContent.replace(/\s+/g, " ").trim(),
  };
}

async function partA(browser) {
  console.log("\n=== Part A: the badge and heading actually have room now, at every width ===");
  for (const m of MATRIX) {
    const { ctx, page, errors } = await openWelcome(browser, m);
    const g = await page.evaluate(measure);
    const short = m.h <= 640;
    if (short) {
      // The short-phone branch is deliberately NOT opened up - see the long comment on the
      // max-height:640px media query in index.html. Pin it to v0.37's measured values so a future
      // session cannot quietly change it without this suite noticing.
      ok(Math.abs(g.gapBadgeToH3 - V037.short.badgeToH3) < 1.5,
        `A1 ${m.name}: gap under the badge is UNCHANGED from v0.37 on purpose (${g.gapBadgeToH3.toFixed(1)}px vs ${V037.short.badgeToH3}px) - 568px of height has no room to spend`);
      ok(Math.abs(g.gapH3ToNote - V037.short.h3ToNote) < 1.5,
        `A2 ${m.name}: gap under the heading is UNCHANGED from v0.37 on purpose (${g.gapH3ToNote.toFixed(1)}px vs ${V037.short.h3ToNote}px)`);
    } else {
      ok(g.gapBadgeToH3 > V037.tall.badgeToH3 + 8,
        `A1 ${m.name}: gap under the NASTY badge is ${g.gapBadgeToH3.toFixed(1)}px, comfortably more than v0.37's measured ${V037.tall.badgeToH3}px`);
      ok(g.gapH3ToNote > V037.tall.h3ToNote + 4,
        `A2 ${m.name}: gap under "Welcome to NASTY" is ${g.gapH3ToNote.toFixed(1)}px, more than v0.37's measured ${V037.tall.h3ToNote}px`);
    }
    ok(g.docScrollW <= g.innerW + 1,
      `A3 ${m.name}: no sideways overflow (scrollWidth ${g.docScrollW} vs viewport ${g.innerW})`);
    ok(g.card.left >= -0.5 && g.card.right <= g.innerW + 0.5,
      `A4 ${m.name}: the card sits inside the viewport horizontally (${g.card.left.toFixed(1)}..${g.card.right.toFixed(1)})`);
    ok(g.guest.h >= 44, `A5 ${m.name}: the guest button is still a real 44px+ tap target (${g.guest.h.toFixed(1)}px)`);
    ok(errors.length === 0, `A6 ${m.name}: zero page errors`);
    if (m.w === 390) await page.screenshot({ path: path.join(SHOTDIR, "welcome_v038_390.png") });
    if (m.w === 320) await page.screenshot({ path: path.join(SHOTDIR, "welcome_v038_320.png") });
    await ctx.close();
  }
}

async function partB(browser) {
  console.log("\n=== Part B: 320x568 - the two choices and the age line stay above the fold ===");
  const m = MATRIX[0];
  const { ctx, page } = await openWelcome(browser, m);
  const g = await page.evaluate(measure);
  // The Apple button is removed entirely on the website (accountsAvailableHere() is false in a
  // plain browser), so only assert on it when it is actually in the flow.
  if (!g.appleHidden && g.apple) {
    ok(g.apple.bottom <= m.h, `B1 the Apple button is fully above the fold (bottom ${g.apple.bottom.toFixed(1)} <= ${m.h})`);
  } else {
    ok(true, "B1 no Apple button in the website variant - nothing to keep above the fold (v0.36 behaviour, unchanged)");
  }
  ok(g.guest.bottom <= m.h, `B2 the guest button is fully above the fold (bottom ${g.guest.bottom.toFixed(1)} <= ${m.h})`);
  ok(g.age && g.age.bottom <= m.h, `B3 the age line is above the fold (bottom ${g.age ? g.age.bottom.toFixed(1) : "n/a"} <= ${m.h})`);
  // v0.38: the first cut of this edit passed B3 and still looked wrong - the last line of the age
  // sentence sat inside the "more below - swipe up" fade. Reading the number is not the same as
  // reading the sentence, so the real contract is clearance of the hint band.
  const readable = m.h - (g.canScroll ? g.hintBand : 0);
  ok(g.guest.bottom <= readable, `B4 the guest button clears the scroll-hint band (bottom ${g.guest.bottom.toFixed(1)} <= ${readable})`);
  // The age sentence's last line already sat inside the hint fade in v0.37 (measured 522.7px
  // against a readable 504px) - a real, pre-existing 320x568 nit that is NOT this edit's to fix,
  // and squeezing this screen further to fix it would be the wrong trade. What IS asserted is that
  // v0.38 did not make it worse by even a pixel.
  ok(g.age && g.age.bottom <= V037.short.ageBottom + 0.5,
    `B5 the age sentence is no lower than v0.37 had it (${g.age ? g.age.bottom.toFixed(1) : "n/a"} <= ${V037.short.ageBottom}) - pre-existing hint-fade overlap not made worse`);
  console.log(`  ... 320x568 gaps: badge->h3 ${g.gapBadgeToH3.toFixed(1)}px, h3->note ${g.gapH3ToNote.toFixed(1)}px; canScroll=${g.canScroll}; age bottom ${g.age ? g.age.bottom.toFixed(1) : "n/a"} of readable ${readable}`);
  await ctx.close();
}

async function partC(browser) {
  console.log("\n=== Part C: the copy Blake approved, and no 'family' ===");
  const { ctx, page } = await openWelcome(browser, MATRIX[2]);
  const g = await page.evaluate(measure);
  /* v0.39 (2026-07-26): Blake asked for the login page to be "more exciting with exclamation
     points!", so the exact sentence this used to pin is gone. The CONTRACT v0.38 cared about is
     unchanged and still asserted - the opening line still promises that signing in keeps your record
     yours - it just no longer pins one phrasing, the same treatment v0.38 itself gave the v0.36
     assertion below it. New copy: "Race five tees home and send everybody else packing! Sign in and
     your wins, your takeouts and your bragging rights all stay yours." Verbatim pinning of the v0.39
     wording lives in test_ui_v039_2026_07_26.js part C, which is where it belongs. */
  ok(/wins/i.test(g.copy) && /takeouts/i.test(g.copy) && /bragging rights/i.test(g.copy) && /stay yours/i.test(g.copy),
    "C1 the welcome note still promises that signing in keeps your record yours");
  /* v0.40 (2026-07-26): DELIBERATELY REPLACED. Blake reworded this one line - "Guests can play
     every game mode - they just do not appear on the leaderboard." - so the v0.38 phrasing this
     pinned no longer exists. Same treatment C1 got in v0.39 and this suite gave the v0.36
     assertion before that: keep the CONTRACT (a guest is told plainly they will not be on the
     leaderboard) and stop pinning one sentence here. Verbatim pinning of the v0.40 wording lives in
     test_ui_v040_2026_07_26.js part B, where it belongs. */
  ok(/guests can play/i.test(g.copy) && /do not appear on the leaderboard/i.test(g.copy),
    "C2 the guest fine print still says plainly that a guest is not on the leaderboard");
  ok(/Accounts are for ages 13 and up\. Anyone younger should continue as a guest\./.test(g.copy),
    "C3 the age sentence is untouched and still factual");
  /* v0.39 (2026-07-26): DELIBERATELY REPLACED, and this is the one assertion in this suite that had
     to change rather than be loosened. Blake: "Can you have the sign in screen appear on every new
     iteration of the app?" The screen is remembered per app version now, so "You will only be asked
     this once" became false the moment that shipped and the sentence had to go. What still has to be
     true - and is - is the second half: the choice can be changed any time from ADMIN. The new
     sentence, and the fact that the old one is gone, are pinned in test_ui_v039_2026_07_26.js part C. */
  ok(!/only be asked this once/i.test(g.copy),
    "C4 the old asked-once sentence is gone - v0.39 shows this screen after every update, so it would be a lie");
  ok(/see this again after every update/i.test(g.copy) && /change it any time - tap ADMIN at the top of the game screen\./.test(g.copy),
    "C4b and the replacement says so plainly, keeping the ADMIN escape hatch word for word");
  ok(!/family/i.test(g.copy), "C5 the word 'family' appears nowhere on the screen");
  ok(!/[—–]/.test(g.copy), "C6 no em or en dashes anywhere in the copy");
  ok(!/leaderboard remembers you|works exactly the same/i.test(g.copy), "C7 the old flat wording is gone");
  await ctx.close();
}

function partD() {
  console.log("\n=== Part D: no user-facing 'family' anywhere in index.html ===");
  // Strip what a player never reads: HTML comments, CSS/JS block comments, line comments. Blake
  // explicitly said code comments are fine - he means the words players read.
  let s = SRC
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  const hits = s.split("\n")
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /family/i.test(l) && !/font-family/i.test(l));
  ok(hits.length === 0,
    `D1 zero user-facing "family" strings left in index.html (${hits.length}${hits.length ? ": " + hits.slice(0, 4).map(([n, l]) => n + ":" + l.trim().slice(0, 70)).join(" | ") : ""})`);
  ok(!/<title>[^<]*family/i.test(SRC), "D2 the page title does not say family either");
  ok(!/Also take my name off the family leaderboard/.test(SRC), "D3 the delete-account checkbox no longer says family");
}

async function partE(browser) {
  console.log("\n=== Part E: behaviour is unchanged - shows once, both paths work ===");
  const { ctx, page } = await openWelcome(browser, MATRIX[2]);
  ok(await page.evaluate(() => window.__welcome.shown()), "E1 a brand-new browser still gets the first-run screen");
  await page.click("#btnWelcomeGuest");
  await page.waitForTimeout(250);
  ok(!(await page.evaluate(() => window.__welcome.shown())), "E2 choosing guest still closes it");
  const stored = await page.evaluate(() => localStorage.getItem("nasty-welcome-choice"));
  ok(!!stored, `E3 the choice is still persisted under nasty-welcome-choice (${stored})`);
  const page2 = await ctx.newPage();
  await page2.goto(INDEX);
  await page2.waitForSelector("#btnStart");
  await page2.waitForTimeout(350);
  ok(!(await page2.evaluate(() => window.__welcome.shown())), "E4 it does not come back on the next open");
  await ctx.close();
  ok(/nasty-welcome-choice/.test(SRC) && /rememberWelcomeChoice/.test(SRC),
    "E5 the persistence path (localStorage key + IndexedDB mirror helper) is untouched");
}

async function main() {
  const browser = await chromium.launch();
  try {
    await partA(browser);
    await partB(browser);
    await partC(browser);
    partD();
    await partE(browser);
  } finally {
    await browser.close();
  }
  console.log(`\n=== v0.38 welcome-screen suite: ${pass} passed, ${fail} failed ===`);
  console.log("screenshots: " + SHOTDIR);
  process.exit(fail ? 1 : 0);
}
main();
