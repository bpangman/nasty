#!/usr/bin/env node
"use strict";
/*
 * run-all.js - run EVERY real test suite in this folder, one after another, and print a single
 * pass/fail matrix at the end.
 *
 *   cd /Users/jarvis/nasty-game/server && npm run test:all
 *
 * Why this exists: `npm test` only ever ran 4 of the ~39 suites here (the two engine checks
 * plus two fast unit files). Everything else had to be remembered and typed by hand, so in
 * practice most of the bar never got run before a ship. This runs the whole thing with one
 * command.
 *
 * Options (all optional):
 *   --quick            skip the suites marked slow below (the long soaks and audits)
 *   --only=a,b,c       run only suites whose file name contains one of these substrings
 *   --server=node      which relay server the dual-mode suites run against (default: node)
 *   --server=deno      ... use deno instead (needs the deno binary; slower)
 *   --list             print the plan and exit without running anything
 *
 * HOW FAILURE IS DECIDED
 *   A suite passes if its process exits 0. Anything else is a FAIL, except:
 *     - STALL: the suite blew past its own time cap and was killed. Reported as its own
 *       outcome, not lumped in with FAIL, because a stall is usually the environment (a
 *       browser that never came up, a socket that never closed) rather than a real regression.
 *     - SKIP: the suite exited 0 but told us it skipped (e.g. no iOS Simulator on this Mac).
 *   The whole run exits nonzero if anything FAILED or STALLED.
 *
 * TIME CAPS
 *   macOS has no `timeout` command, so the cap is implemented here: each suite gets its own
 *   child process, and if it is still alive at its cap we send SIGTERM, wait briefly, then
 *   SIGKILL, and record STALL. This is what keeps one hung suite from eating the whole night.
 *   Caps are deliberately generous - they are a safety net, not a performance budget.
 *
 * KNOWN FLAKY
 *   test_knockout_leaderboard.js's live 2-human WebSocket leg (Part E) is documented as flaky
 *   and can stall. It is run in its client-only mode here by default so a full-bar run stays
 *   trustworthy; run it by hand in `all` mode when you are specifically working on knockouts.
 *
 * NOT SUITES (deliberately not in the list below)
 *   freeze_proxy.js         - a helper module used by test_freeze_recovery.js, not a test
 *   run-all.js              - this file
 */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const TESTS_DIR = __dirname;
const SERVER_DIR = path.resolve(TESTS_DIR, "..");

// ---- options ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const QUICK = argv.includes("--quick");
const LIST_ONLY = argv.includes("--list");
const onlyArg = argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? onlyArg.slice(7).split(",").map((s) => s.trim()).filter(Boolean) : null;
const serverArg = argv.find((a) => a.startsWith("--server="));
const SRV = serverArg ? serverArg.slice(9) : "node";
if (SRV !== "node" && SRV !== "deno") { console.error(`--server must be node or deno (got ${SRV})`); process.exit(2); }

const MIN = 60 * 1000;

// ---- the plan --------------------------------------------------------------------------
// Ordered cheapest-and-most-fundamental first, so a broken engine shows up in seconds rather
// than an hour in. Groups: engine -> pure unit -> wire protocol -> offline UI -> online UI ->
// long soaks and audits.
//
//   file    path relative to server/tests
//   args    argv passed to the suite ("$SRV" is substituted with node/deno)
//   cap     time cap in ms
//   slow    true = skipped by --quick
const PLAN = [
  // --- engine: no server, no browser, seconds ---
  { file: "../test-engine-sync.js",            args: [],             cap: 2 * MIN,  note: "generated engine files match index.html" },
  { file: "../test-engine-headless.js",        args: [],             cap: 5 * MIN,  note: "full CPU-vs-CPU games against the engine module" },
  { file: "test_own_landing_illegal.js",       args: [],             cap: 2 * MIN,  note: "own-peg landing illegal, partner-peg last resort" },
  { file: "test_deck_conservation.js",         args: [],             cap: 5 * MIN,  note: "52 cards conserved at every checkpoint" },

  // --- wire protocol / server behavior ---
  { file: "smoke_server.js",                   args: [],             cap: 5 * MIN,  note: "raw wire basics vs the Node server" },
  { file: "smoke_deno.js",                     args: [],             cap: 5 * MIN,  note: "same vs the Deno server + KV snapshot size" },
  { file: "restart_deno.js",                   args: [],             cap: 6 * MIN,  note: "SIGKILL mid-game, restart, resume from KV" },
  { file: "protocol_checklist.js",             args: ["$SRV"],       cap: 8 * MIN,  note: "the full protocol surface" },
  { file: "test_seat_gate.js",                 args: ["$SRV"],       cap: 6 * MIN,  note: "first deal waits for every promised seat" },
  { file: "test_v16_features.js",              args: ["$SRV"],       cap: 8 * MIN,  note: "ready-up gate, leave-for-good, non-host pause" },
  { file: "test_push_notifications.js",        args: ["$SRV"],       cap: 6 * MIN,  note: "push registered, sent exactly once on disconnect" },
  { file: "test_jack_swap_index.js",           args: ["$SRV"],       cap: 8 * MIN,  note: "THE Jack bug - swap uses the tapped piece" },
  { file: "test_reunion_gate_hardening.js",    args: ["$SRV"],       cap: 8 * MIN,  note: "the reunion gate cannot be bypassed, wedged, or opened by the wrong person" },

  // --- leaderboard ---
  { file: "test_leaderboard_scenarios.js",     args: [],             cap: 8 * MIN,  note: "leaderboard exactly-once, incl. queue drain" },
  { file: "test_leaderboard_split.js",         args: ["$SRV"],       cap: 8 * MIN,  note: "solo/teams point split + boot migration" },
  { file: "test_leaderboard_ui_split.js",      args: [],             cap: 8 * MIN,  note: "Solo/Teams tab UI + 320px fit" },
  { file: "test_leaderboard_names_and_deltas.js", args: ["$SRV"],    cap: 8 * MIN,  note: "name case-folding + stat delta validation, both servers" },
  { file: "test_knockout_leaderboard.js",      args: [],             cap: 10 * MIN, note: "KO tab math + tallyKnockout (client-only mode; see KNOWN FLAKY above)" },

  // --- offline / client-only UI regressions (file://, no server at all) ---
  { file: "test_topbar_buttons.js",            args: [],             cap: 8 * MIN,  note: "topbar text/height uniformity + Save button" },
  { file: "test_overlay_sizing.js",            args: [],             cap: 10 * MIN, note: "confirm cards fit with real iPhone safe areas" },
  { file: "test_stable_bubbles.js",            args: [],             cap: 8 * MIN,  note: "stable tee bubbles immune to board congestion" },
  { file: "test_card_linger.js",               args: [],             cap: 8 * MIN,  note: "one lingering last-played card, larger rank text" },
  { file: "test_ui_v024.js",                   args: [],             cap: 8 * MIN,  note: "rules dealing text + seat rename affordance" },
  { file: "test_spotlight_v024.js",            args: [],             cap: 8 * MIN,  note: "SPOTLIGHT two-tier pacing + gold glow" },
  { file: "test_postgame_review.js",           args: [],             cap: 12 * MIN, note: "post-game review popup, KO stats, hand reveal" },

  // --- online UI flows (real browser + private server) ---
  { file: "test_recalibration.js",             args: ["$SRV"],       cap: 12 * MIN, note: "the resync message + drift self-heal" },
  { file: "test_reconnect_retry.js",           args: ["$SRV"],       cap: 10 * MIN, note: "failed tile-tap reconnect retries automatically" },
  { file: "test_reunion_readyup.js",           args: ["$SRV"],       cap: 10 * MIN, note: "the reunion ready-up gate, survives restart" },
  { file: "test_table_speed_lock.js",          args: ["$SRV"],       cap: 10 * MIN, note: "host speed rides the deal and the restart" },
  { file: "test_online_teams.js",              args: ["$SRV"],       cap: 12 * MIN, note: "choosing a Teams game online through real clicks" },
  { file: "test_online_cpu_difficulty.js",     args: ["$SRV"],       cap: 12 * MIN, note: "host sets CPU difficulty from the room screen" },
  { file: "test_surrender.js",                 args: ["$SRV"],       cap: 20 * MIN, note: "every path that permanently ends a game", slow: true },
  { file: "test_v025_ui_flows.js",             args: ["$SRV"],       cap: 20 * MIN, note: "the v0.25 item 1-9 acceptance bar", slow: true },

  // --- simulator (skips cleanly when no iOS Simulator is present) ---
  { file: "sim_paused_room_gate.js",           args: ["$SRV"],       cap: 12 * MIN, note: "a paused room is never silently sat down at" },

  // --- long soaks and audits (--quick skips these) ---
  { file: "soak_offline.js",                   args: ["both"],       cap: 20 * MIN, note: "offline 4P+6P soak, bit-identical regression", slow: true },
  { file: "chaos_v15.js",                      args: ["full"],       cap: 15 * MIN, note: "one clean Playwright game end to end", slow: true },
  { file: "chaos_v15.js",                      args: ["hostbg"],     cap: 15 * MIN, note: "the host-background repro of Blake's bug", slow: true, id: "chaos_v15.js hostbg" },
  { file: "reconnect_storm.js",                args: ["18"],         cap: 25 * MIN, note: "18 rotating drop/reconnect cycles", slow: true },
  { file: "test_menu_bubble_race.js",          args: ["$SRV"],       cap: 30 * MIN, note: "60-rep menu/toast race soak", slow: true },
  { file: "test_freeze_recovery.js",           args: ["$SRV"],       cap: 30 * MIN, note: "60s silent freeze + away ladder + old-build lockout", slow: true },
  { file: "test_dealer_random.js",             args: [],             cap: 20 * MIN, note: "first dealer genuinely randomized (offline trials)", slow: true },
  { file: "test_ai_difficulty.js",             args: [],             cap: 45 * MIN, note: "the AI tier ladder measurement", slow: true },
  { file: "test_cpu_kick_fairness_audit.js",   args: [],             cap: 45 * MIN, note: "kick fairness audit, 300+ games", slow: true },
];

// ---- select ----------------------------------------------------------------------------
let plan = PLAN.filter((s) => !(QUICK && s.slow));
if (ONLY) plan = plan.filter((s) => ONLY.some((frag) => s.file.includes(frag)));
plan = plan.map((s) => {
  const args = s.args.map((a) => (a === "$SRV" ? SRV : a));
  return { ...s, args, id: s.id || (args.length ? `${s.file} ${args.join(" ")}` : s.file) };
});

// Fail loudly if the plan references a file that is not there any more - a silently-dropped
// suite is exactly the failure mode this runner is supposed to prevent.
const missing = plan.filter((s) => !fs.existsSync(path.resolve(TESTS_DIR, s.file)));
if (missing.length) {
  console.error("run-all.js: these planned suites do not exist:\n  " + missing.map((s) => s.file).join("\n  "));
  process.exit(2);
}

// And warn about any *.js in this folder that the plan never mentions, so a newly added suite
// gets noticed instead of quietly never running.
const KNOWN_NON_SUITES = new Set(["run-all.js", "freeze_proxy.js"]);
const planned = new Set(PLAN.map((s) => path.basename(s.file)));
const orphans = fs.readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith(".js") && !KNOWN_NON_SUITES.has(f) && !planned.has(f));

if (LIST_ONLY) {
  console.log(`Plan (${plan.length} suites, server=${SRV}${QUICK ? ", --quick" : ""}):`);
  plan.forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. ${s.id.padEnd(44)} cap ${Math.round(s.cap / MIN)}m  ${s.note}`));
  if (orphans.length) console.log("\nNot in the plan: " + orphans.join(", "));
  process.exit(0);
}

// ---- run -------------------------------------------------------------------------------
function runOne(suite) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.resolve(TESTS_DIR, suite.file), ...suite.args], {
      cwd: TESTS_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";        // keep only the last few KB - some suites print a LOT
    let sawSkip = false;
    const eat = (buf) => {
      const s = buf.toString();
      process.stdout.write(s);
      // Only a real "SKIP: <reason>" counts. Plain "SKIP" is far too loose - SKIP is also the
      // name of a game feature, so test_spotlight_v024.js's own section headers say it.
      if (/\bSKIP:/.test(s)) sawSkip = true;
      tail = (tail + s).slice(-4000);
    };
    child.stdout.on("data", eat);
    child.stderr.on("data", eat);

    let killed = false;
    const capTimer = setTimeout(() => {
      killed = true;
      console.log(`\n[run-all] TIME CAP (${Math.round(suite.cap / MIN)}m) hit for ${suite.id} - terminating.`);
      try { child.kill("SIGTERM"); } catch (e) {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} }, 10000);
    }, suite.cap);

    child.on("error", (e) => {
      clearTimeout(capTimer);
      resolve({ ...suite, status: "FAIL", ms: Date.now() - t0, detail: `could not start: ${e.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(capTimer);
      const ms = Date.now() - t0;
      if (killed) return resolve({ ...suite, status: "STALL", ms, detail: `no exit within ${Math.round(suite.cap / MIN)}m` });
      if (code === 0) return resolve({ ...suite, status: sawSkip ? "SKIP" : "PASS", ms, detail: sawSkip ? "suite reported SKIP" : "" });
      resolve({ ...suite, status: "FAIL", ms, detail: signal ? `killed by ${signal}` : `exit ${code}`, tail });
    });
  });
}

function fmt(ms) {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

(async () => {
  const started = new Date();
  console.log(`\n=== NASTY full test bar ===`);
  console.log(`start   ${started.toISOString()}`);
  console.log(`server  ${SRV}${QUICK ? "   (--quick: long soaks and audits skipped)" : ""}`);
  console.log(`suites  ${plan.length}\n`);
  if (orphans.length) console.log(`[run-all] NOTE: not in the plan (add them if they are real suites): ${orphans.join(", ")}\n`);

  const results = [];
  for (let i = 0; i < plan.length; i++) {
    const s = plan[i];
    console.log(`\n${"=".repeat(78)}\n[${i + 1}/${plan.length}] ${s.id}\n         ${s.note}\n${"=".repeat(78)}`);
    const r = await runOne(s);
    console.log(`[run-all] ${r.status}  ${r.id}  (${fmt(r.ms)})${r.detail ? "  - " + r.detail : ""}`);
    results.push(r);
  }

  // ---- matrix ----
  const w = Math.max(...results.map((r) => r.id.length), 20);
  console.log(`\n\n${"=".repeat(78)}\n RESULTS\n${"=".repeat(78)}`);
  for (const r of results) {
    console.log(` ${r.status.padEnd(6)} ${r.id.padEnd(w)}  ${fmt(r.ms).padStart(7)}${r.detail ? "  " + r.detail : ""}`);
  }
  const count = (st) => results.filter((r) => r.status === st).length;
  const failed = results.filter((r) => r.status === "FAIL");
  const stalled = results.filter((r) => r.status === "STALL");
  console.log(`${"-".repeat(78)}`);
  console.log(` ${count("PASS")} passed, ${failed.length} failed, ${stalled.length} stalled, ${count("SKIP")} skipped   (total ${fmt(Date.now() - started.getTime())})`);

  if (failed.length) {
    console.log(`\nFAILED:`);
    for (const r of failed) console.log(`  - ${r.id}  (${r.detail})`);
  }
  if (stalled.length) {
    console.log(`\nSTALLED (hit their time cap - check the environment before assuming a regression):`);
    for (const r of stalled) console.log(`  - ${r.id}`);
  }
  console.log("");
  process.exit(failed.length || stalled.length ? 1 : 0);
})();
