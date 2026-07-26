"use strict";
/*
 * HELPER, NOT A SUITE. Do not run this directly - it exports one function.
 *
 * v0.36 (2026-07-26) added a FIRST-RUN SIGN-IN SCREEN (index.html, § WELCOME). Blake's ask:
 * "if it's a person's first time opening the app (or they don't have an account) they should see
 * a login screen with an apple button... Below that, there should be an option to continue as a
 * guest... This is the only time this would happen though."
 *
 * Every Playwright context is a brand-new browser profile, so before this helper existed EVERY
 * suite in this folder became a first-time player overnight and sat behind that screen. That is
 * the app behaving correctly, not a bug - but it is not what those suites are about. Each of them
 * is written from the point of view of somebody who has opened NASTY before, which in the real
 * world is everybody after their very first launch.
 *
 * So this seeds the same answer a returning player's phone already carries, in the page's own
 * storage, before any of the app's code runs:
 *
 *     localStorage['nasty-welcome-choice'] = 'guest'
 *
 * It is the REAL key the app reads (see loadWelcomeChoice(), § WELCOME) - there is no test-only
 * back door in the shipped app, and nothing here is stubbed or overridden. A suite that wants the
 * screen simply does not call this, or calls window.__welcome.reset() to clear the answer.
 *
 * The first-run screen's own behaviour - that it appears exactly once, that both paths work, that
 * the website variant has no dead Apple button - is covered by test_ui_v036_2026_07_26.js.
 *
 * Usage, one line, right after the playwright require:
 *
 *     const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
 *     require("./test_ui_v036_welcome_bypass.js").patch(chromium);
 *
 * It wraps launch() so that every context and every page the suite makes afterwards is seeded,
 * however many there are and wherever they are created, with no other edit to the suite.
 */

const WELCOME_KEY = "nasty-welcome-choice";

function seed() {
  try { localStorage.setItem("nasty-welcome-choice", "guest"); } catch (e) {}
}

function patchContext(ctx) {
  const orig = ctx.addInitScript.bind(ctx);
  return orig(seed).then(() => ctx);
}

function patch(browserType) {
  if (!browserType || browserType.__v036WelcomePatched) return browserType;
  const launch = browserType.launch.bind(browserType);
  browserType.launch = async function (...args) {
    const browser = await launch(...args);
    const newContext = browser.newContext.bind(browser);
    const newPage = browser.newPage.bind(browser);
    browser.newContext = async function (...a) {
      const ctx = await newContext(...a);
      await patchContext(ctx);
      return ctx;
    };
    // browser.newPage() makes its own throwaway context, which never passes through newContext
    // above - seed it on the page instead, which is the same thing one level down.
    browser.newPage = async function (...a) {
      const page = await newPage(...a);
      await page.addInitScript(seed);
      return page;
    };
    return browser;
  };
  browserType.__v036WelcomePatched = true;
  return browserType;
}

module.exports = { patch, WELCOME_KEY, seed };
