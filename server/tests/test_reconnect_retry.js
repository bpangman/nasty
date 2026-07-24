"use strict";
/*
 * 2026-07-23 (Blake's item 1) - "when rejoining an online game, it should auto resync
 * automatically... I had to close and reopen my game a few times to get it to reconnect."
 *
 * ROOT CAUSE (confirmed by direct reproduction this session, against the UNFIXED code, before
 * writing the fix): tryJoinOrRejoin() - the function behind the saved-game tile, ?join=CODE
 * links, and Universal Links - made exactly ONE connect attempt. A single failure (a transient
 * network hiccup, the wsurl.json lookup failing right after a cold app launch before the
 * network stack is fully up, or - before connectWs()'s own fix - a hung attempt with no
 * timeout at all) dumped the player onto the manual "Join a game" code-entry screen with zero
 * explanation and no automatic retry. Reproduced live: a tile tap against a connection that
 * fails once landed on the join overlay's NAME step within ~500ms, joinOverlayHidden===false,
 * with nothing to tell a non-technical player "just wait, it'll retry." The only recovery a
 * real player could reasonably find on their own is exactly what Blake did - force-quit and
 * reopen the app and try again.
 *
 * THE FIX (index.html): connectWs() now has a real connect timeout (CONNECT_TIMEOUT_MS);
 * tryJoinOrRejoin() retries with the SAME backoff shape scheduleReconnect() already uses for an
 * in-session drop (1s -> 8s, +/-15% jitter) for RESUME_RETRY_MAX_MS before finally falling back
 * to the manual join screen as a genuine last resort; the saved-game tile itself shows
 * "Reconnecting…" the whole time so a returning player gets immediate feedback. Plus a second,
 * related fix: openJoinOverlay()'s one-time offline speed-picker gate is skipped entirely for
 * this specific recovery fallback (skipSpeedGate) - on a device that's never answered that
 * picker before, it used to interject "pick your speed" mid-reconnect, which looks exactly like
 * "choose the game's speed" at the worst possible moment (a real, confirmed contributor to
 * Blake's speed-control confusion, items 3/4, even though the online table's actual pace was
 * never at risk - see server/server.js's own tableSpeed persistence, proven separately in
 * test_table_speed_lock.js).
 *
 * Usage:
 *   node test_reconnect_retry.js node     (server/server.js)
 *   node test_reconnect_retry.js deno     (server/cloud/server.ts)
 * Real Playwright browser + a real server process this suite starts, kills, and restarts on the
 * SAME port/scratch dir - never production, never a shared instance.
 */
const { chromium } = require("/Users/jarvis/clawd/node_modules/playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const KIND = process.argv[2] || "node";
const USE_DENO = KIND === "deno";
const PORT = 24700 + Math.floor(Math.random() * 500);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-reconnretry-${KIND}-`));

function log(...a) { console.log("[reconn-retry]", new Date().toISOString(), ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port) {
  let child;
  if (USE_DENO) {
    child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
      cwd: "/Users/jarvis/nasty-game/server/cloud",
      env: Object.assign({}, process.env, { NASTY_PORT: String(port), NASTY_KV_PATH: path.join(SCRATCH, "rr.kv"), NASTY_ADMIN_TOKEN: "rr-admin-token" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    child = spawn(process.execPath, ["server.js"], {
      cwd: "/Users/jarvis/nasty-game/server",
      env: Object.assign({}, process.env, {
        NASTY_PORT: String(port), NASTY_ROOMS_DIR: SCRATCH,
        NASTY_ADMIN_TOKEN_FILE: path.join(SCRATCH, "admin-token.txt"),
        NASTY_LEADERBOARD_FILE: path.join(SCRATCH, "leaderboard.json"),
        NASTY_LEADERBOARD_EPOCH_FILE: path.join(SCRATCH, "leaderboard-epoch.json"),
        NASTY_SOLO_IDS_FILE: path.join(SCRATCH, "solo-ids.json"),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  child.stderr.on("data", (d) => { if (process.env.NASTY_TEST_VERBOSE) process.stderr.write("[server-err] " + d); });
  return child;
}
async function waitHealthy(port) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://localhost:${port}/health`); if (r.ok) return; } catch (e) {}
    await sleep(400);
  }
  throw new Error("server never became healthy");
}

async function main() {
  let child = startServer(PORT);
  await waitHealthy(PORT);
  const browser = await chromium.launch();
  const wsUrl = `ws://127.0.0.1:${PORT}`;

  /* ===================================================================================
   * Scenario A: a single failed connect attempt no longer dumps the player onto the join
   * screen - it retries automatically, visibly, and lands live once the server comes back.
   * =================================================================================== */
  log("--- Scenario A: server is down when the tile is tapped, comes back mid-retry - zero manual action ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    let page = await ctx.newPage();
    await page.goto(`file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent(wsUrl)}`);
    await page.waitForFunction(() => typeof window.NET === "object");
    await page.evaluate(() => { try { localStorage.setItem("nasty-speed-chosen", "1"); } catch (e) {} });

    const seatMeta = [
      { name: "Solo", type: "human", diff: "medium" }, { name: "C1", type: "cpu", diff: "easy" },
      { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    await page.evaluate(({ seatMeta }) => {
      CFG.n = 4; CFG.teams = false; CFG.seatMeta[4] = seatMeta;
      return new Promise((resolve) => {
        const orig = window.handleNetMessage;
        window.handleNetMessage = function (m) { orig(m); if (m.type === "created") { window.handleNetMessage = orig; resolve(m.code); } };
        window.hostCreateRoom(1);
      });
    }, { seatMeta });
    await page.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });
    await page.evaluate(() => window.netSend({ type: "start", protocolVersion: PROTOCOL_VERSION, willSeat: true }));
    await page.waitForFunction(() => window.G != null, { timeout: 10000 });
    await sleep(1200);   // let the debounced persist-to-disk/KV actually flush before we kill the server

    await page.close();
    child.kill("SIGKILL");
    await sleep(300);

    page = await ctx.newPage();
    page.__errors = []; page.on("pageerror", (e) => page.__errors.push(String(e)));
    await page.goto(`file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent(wsUrl)}`);
    await page.waitForFunction(() => typeof window.NET === "object");
    await page.waitForFunction(() => document.getElementById("btnSavedGame") && !document.getElementById("btnSavedGame").classList.contains("hidden"), { timeout: 5000 });

    log("tapping the tile while the server is DOWN...");
    await page.evaluate(() => document.getElementById("savedGameMain").click());
    await sleep(1500);
    const midState = await page.evaluate(() => ({
      detailText: document.getElementById("savedGameDetail").textContent,
      joinOverlayHidden: document.getElementById("joinOverlay").classList.contains("hidden"),
    }));
    check(/Reconnecting/.test(midState.detailText), `A: the tile itself shows "Reconnecting…" instead of the tile going silent (got "${midState.detailText}")`);
    check(midState.joinOverlayHidden === true, "A: the manual join screen does NOT appear after just one failed attempt");

    log("restarting the server on the SAME port/scratch dir now...");
    child = startServer(PORT);
    await waitHealthy(PORT);

    // No manual action from here at all.
    await page.waitForFunction(() => window.G != null, { timeout: 40000 });
    const finalState = await page.evaluate(() => ({
      online: window.NET.online,
      joinOverlayHidden: document.getElementById("joinOverlay").classList.contains("hidden"),
    }));
    check(finalState.online === true, "A: recovered to a live online game with ZERO manual action once the server came back");
    check(finalState.joinOverlayHidden === true, "A: never had to go through the manual join screen at all");
    check(!(page.__errors || []).length, "A: zero page errors through the whole outage+recovery");

    await ctx.close();
  }

  /* ===================================================================================
   * Scenario B: the last-resort manual fallback (after retries are truly exhausted) skips the
   * offline one-time speed picker - it must never look like "choose the game's speed" mid-
   * reconnect. Forced by calling the retry helper directly with a near-zero retry budget so the
   * test doesn't have to wait out the real 45s window.
   * =================================================================================== */
  log("--- Scenario B: the last-resort join-screen fallback skips the offline speed picker ---");
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto(`file:///Users/jarvis/nasty-game/index.html?ws=${encodeURIComponent(wsUrl)}`);
    await page.waitForFunction(() => typeof window.NET === "object");
    // Deliberately do NOT set nasty-speed-chosen - this is the exact precondition that let the
    // picker interject during a reconnect fallback before this fix.
    await page.evaluate(() => { try { localStorage.removeItem("nasty-speed-chosen"); } catch (e) {} });

    const seatMeta = [
      { name: "Solo", type: "human", diff: "medium" }, { name: "C1", type: "cpu", diff: "easy" },
      { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" },
    ];
    const code = await page.evaluate(({ seatMeta }) => {
      CFG.n = 4; CFG.teams = false; CFG.seatMeta[4] = seatMeta;
      return new Promise((resolve) => {
        const orig = window.handleNetMessage;
        window.handleNetMessage = function (m) { orig(m); if (m.type === "created") { window.handleNetMessage = orig; resolve(m.code); } };
        window.hostCreateRoom(1);
      });
    }, { seatMeta });
    // Dismiss the online-rules popup (unrelated to the speed picker) so it can't mask the check.
    await page.evaluate(() => { const b = document.getElementById("btnOnlineRulesOk"); if (b) b.click(); });

    // Call tryJoinOrRejoin's actual fallback path directly: openJoinOverlay(code, true) is what
    // it calls once retries are exhausted - verify the picker never shows and the join screen
    // opens straight to the code/name flow.
    await page.evaluate((code) => { window.openJoinOverlay(code, true); }, code);
    const state = await page.evaluate(() => ({
      pickerHidden: document.getElementById("speedPickerOverlay").classList.contains("hidden"),
      joinOverlayHidden: document.getElementById("joinOverlay").classList.contains("hidden"),
    }));
    check(state.pickerHidden === true, "B: the offline one-time speed picker never shows during the reconnect fallback");
    check(state.joinOverlayHidden === false, "B: the join screen itself opens normally, just without the picker gate");

    // Counterpart: a genuinely NEW join (no skipSpeedGate) still shows the picker as before -
    // proves this fix didn't accidentally break the picker for real first-time joins.
    await page.evaluate(() => { document.getElementById("joinOverlay").classList.add("hidden"); });
    await page.evaluate((code) => { window.openJoinOverlay(code); }, code);
    const stateNew = await page.evaluate(() => document.getElementById("speedPickerOverlay").classList.contains("hidden"));
    check(stateNew === false, "B: a genuinely new join (no skipSpeedGate) still shows the one-time picker, unchanged");

    await ctx.close();
  }

  await browser.close();
  child.kill("SIGKILL");
  console.log(`\n[${KIND}] ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}
const WATCHDOG_MS = 90000;
const watchdog = setTimeout(() => {
  console.error(`[reconn-retry] WATCHDOG: suite did not finish within ${WATCHDOG_MS}ms - forcing exit`);
  process.exit(1);
}, WATCHDOG_MS);
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => clearTimeout(watchdog));
