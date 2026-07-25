"use strict";
/*
 * 2026-07-25 § LEADERBOARD NAME CASE + STAT DELTA VALIDATION - two confirmed server-side bugs,
 * reproduced here first and then proved fixed, on BOTH servers with identical expectations.
 *
 * Bug 4 - negative/oversized stat deltas behaved DIFFERENTLY on each server, and Deno wrote
 *   partially. applyLeaderboardEntry() only checked Number.isFinite(v). Proven before the fix:
 *     - a pure negative delta was ACCEPTED and APPLIED on Node (a lifetime stat could go DOWN)
 *       and returned HTTP 200;
 *     - the same delta made Deno throw (BigInt(negative) into an unsigned KvU64 sum) -> HTTP 500;
 *     - a MIXED negative-then-positive delta aborted Deno's loop mid-way, so the sibling
 *       POSITIVE key was silently LOST, and because the throw happened before the soloSeenKey
 *       write the gameId was never marked seen - so a client's offline queue would retry that
 *       same game forever.
 *   Fix (identical in both): reject non-finite, non-integer, zero, negative, and absurdly large
 *   values per key; validate the WHOLE submission before writing anything; write the seen
 *   marker before applying so a partial failure can never double-count on retry.
 *
 * Bug 6 - the board treated "Blake", "blake" and "BLAKE" as three different people. cleanName()
 *   trims and caps length but never case-folds; normalizeName() (which does fold case) is only
 *   used for the profanity blocklist. Proven before the fix: three separate lifetime rows for
 *   one human, which is very likely in practice (same person on a phone vs an iPad).
 *   Fix (identical in both): the board is keyed case-insensitively via a lower-cased name index;
 *   the display capitalization already on the board is kept (sticky), plus a ONE-TIME,
 *   IDEMPOTENT boot migration that MERGES existing duplicate-case rows by SUMMING their numeric
 *   stats, in the same style as migrateLegacyLeaderboardPoints().
 *
 * Never touches prod - private port, private leaderboard file / KV path, throwaway admin token.
 * Usage:
 *   node test_leaderboard_names_and_deltas.js node
 *   node test_leaderboard_names_and_deltas.js deno
 */
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const KIND = process.argv[2] || "node";
const PORT = 26400 + Math.floor(Math.random() * 700);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-lbnames-${KIND}-`));
const ADMIN_TOKEN = "lbnames-admin-token";
const BASE = `http://localhost:${PORT}`;
// Two entirely separate storage locations, same reasoning as test_leaderboard_split.js: the
// live POST scenarios must not contaminate the "boot against pre-existing duplicate rows"
// migration scenario.
const LB_FILE_LIVE = path.join(SCRATCH, "leaderboard-live.json");
const KV_PATH_LIVE = path.join(SCRATCH, "live.kv");
const LB_FILE_MIGRATION = path.join(SCRATCH, "leaderboard-migration.json");
const KV_PATH_MIGRATION = path.join(SCRATCH, "migration.kv");

function log(...a) { console.log("[lbnames]", ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(lbFile, kvPath) {
  let child;
  if (KIND === "deno") {
    child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
      cwd: "/Users/jarvis/nasty-game/server/cloud",
      env: Object.assign({}, process.env, { NASTY_PORT: String(PORT), NASTY_KV_PATH: kvPath, NASTY_ADMIN_TOKEN: ADMIN_TOKEN }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    fs.writeFileSync(path.join(SCRATCH, "admin-token.txt"), ADMIN_TOKEN + "\n");
    child = spawn(process.execPath, ["server.js"], {
      cwd: "/Users/jarvis/nasty-game/server",
      env: Object.assign({}, process.env, {
        NASTY_PORT: String(PORT), NASTY_ROOMS_DIR: SCRATCH,
        NASTY_ADMIN_TOKEN_FILE: path.join(SCRATCH, "admin-token.txt"),
        NASTY_LEADERBOARD_FILE: lbFile,
        NASTY_LEADERBOARD_EPOCH_FILE: path.join(SCRATCH, "leaderboard-epoch.json"),
        NASTY_SOLO_IDS_FILE: path.join(SCRATCH, "solo-ids.json"),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { if (process.env.LBNAMES_VERBOSE) process.stderr.write("[srv-err] " + d); });
  return child;
}
async function waitHealthy() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + "/health"); if (r.ok) return; } catch (e) {}
    await sleep(400);
  }
  throw new Error("server never became healthy");
}
async function stopServer(child) {
  child.kill("SIGTERM");
  await sleep(600);
}
let gidCounter = 0;
async function postSoloResult(entries, gameIdOverride) {
  const gameId = gameIdOverride || `lbnames-${KIND}-${Date.now()}-${gidCounter++}`;
  const r = await fetch(BASE + "/solo-result", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ gameId, entries }),
  });
  let body = null;
  try { body = await r.json(); } catch (e) {}
  return { status: r.status, body, gameId };
}
async function getLeaderboard() {
  const r = await fetch(BASE + "/leaderboard");
  return await r.json();
}
// Seed a leaderboard BEFORE the server under test ever boots, so the boot migration is what's
// being measured. Node: write the JSON file. Deno: a tiny separate `deno run` writing the same
// raw KvU64 counters the real server uses. Both lifted verbatim from test_leaderboard_split.js.
function seedNode(data) { fs.writeFileSync(LB_FILE_MIGRATION, JSON.stringify(data)); }
function seedDeno(data) {
  const seedScript = `
    const kvPath = Deno.args[0];
    const data = JSON.parse(Deno.args[1]);
    const kv = await Deno.openKv(kvPath);
    for (const name of Object.keys(data)) {
      for (const statKey of Object.keys(data[name])) {
        await kv.set(["leaderboard", name, statKey], new Deno.KvU64(BigInt(data[name][statKey])));
      }
    }
    kv.close();
  `;
  const seedFile = path.join(SCRATCH, "seed.ts");
  fs.writeFileSync(seedFile, seedScript);
  const res = spawnSync("deno", ["run", "--allow-read", "--allow-write", "--unstable-kv", seedFile, KV_PATH_MIGRATION, JSON.stringify(data)], { encoding: "utf8" });
  if (res.status !== 0) throw new Error("deno seed failed: " + res.stderr);
}
function seed(data) { if (KIND === "deno") seedDeno(data); else seedNode(data); }

// Case-insensitive row lookup so the assertions read the same whichever capitalization the
// server settled on as the display name.
function rowFor(lb, name) {
  const k = Object.keys(lb).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? { key: k, row: lb[k] } : null;
}
function rowsFor(lb, name) {
  return Object.keys(lb).filter((x) => x.toLowerCase() === name.toLowerCase());
}

async function main() {
  /* =====================================================================================
   * PART A (bug 4): stat delta validation, live POSTs against a fresh empty board.
   * ===================================================================================== */
  {
    const child = startServer(LB_FILE_LIVE, KV_PATH_LIVE);
    await waitHealthy();
    log("--- A (bug 4): stat delta validation ---");

    // A1: a legitimate delta still works exactly as before (guard against over-tight rules).
    await postSoloResult([{ name: "Legit", delta: { hg4s: 1, hw4s: 1, hptsS: 9, hkoDealt: 3, hkoTaken: 2 } }]);
    await sleep(400);
    {
      const r = rowFor(await getLeaderboard(), "Legit");
      check(!!r && r.row.hg4s === 1 && r.row.hw4s === 1 && r.row.hptsS === 9 && r.row.hkoDealt === 3 && r.row.hkoTaken === 2,
        "A1: an ordinary, legitimate delta is recorded unchanged");
    }

    // A2: a PURE NEGATIVE delta. Before the fix: Node returned 200 and APPLIED it (a lifetime
    // stat went DOWN); Deno threw and returned 500. After: identical 200 + no change at all.
    await postSoloResult([{ name: "Neg", delta: { hg4s: 4, hw4s: 2 } }]);
    await sleep(300);
    const negRes = await postSoloResult([{ name: "Neg", delta: { hg4s: -3 } }]);
    await sleep(400);
    {
      const r = rowFor(await getLeaderboard(), "Neg");
      check(negRes.status === 200, `A2: a negative delta answers HTTP 200 on both servers (got ${negRes.status})`);
      check(!!r && r.row.hg4s === 4, `A2: a negative delta is REJECTED - the stat never goes down (hg4s=${r && r.row.hg4s}, want 4)`);
    }

    // A3: MIXED negative + positive in the SAME delta. Before the fix Deno aborted mid-loop, so
    // the sibling positive key was lost AND the gameId was never marked seen (infinite retry).
    const mixed = await postSoloResult([{ name: "Mixed", delta: { hg4s: -1, hw4s: 1, hptsS: 5 } }]);
    await sleep(400);
    {
      const r = rowFor(await getLeaderboard(), "Mixed");
      check(mixed.status === 200, `A3: a mixed delta answers HTTP 200 (got ${mixed.status})`);
      check(!!r && r.row.hw4s === 1 && r.row.hptsS === 5, "A3: the VALID sibling keys in a mixed delta still land (no partial-write loss)");
      check(!!r && (r.row.hg4s === undefined || r.row.hg4s === 0), "A3: the invalid negative key in that same delta is dropped");
      // The seen marker must have been written, or the client's offline queue retries forever.
      const again = await postSoloResult([{ name: "Mixed", delta: { hg4s: -1, hw4s: 1, hptsS: 5 } }], mixed.gameId);
      check(again.body && again.body.duplicate === true, "A3: that same gameId is now marked SEEN (no forever-retry loop for the client)");
      await sleep(300);
      const r2 = rowFor(await getLeaderboard(), "Mixed");
      check(r2 && r2.row.hw4s === 1 && r2.row.hptsS === 5, "A3: ...and the retry did not double-count the valid keys");
    }

    // A4: zero, fractional, absurdly large, NaN-ish and non-numeric values are all rejected,
    // with the legitimate sibling in the same delta still landing.
    await postSoloResult([{ name: "Junk", delta: { hg4s: 1 } }]);
    await sleep(300);
    const junk = await postSoloResult([{ name: "Junk", delta: { hw4s: 0, hptsS: 2.5, hkoDealt: 1e9, hkoTaken: "3", hg6s: 1 } }]);
    await sleep(400);
    {
      const r = rowFor(await getLeaderboard(), "Junk");
      check(junk.status === 200, `A4: a junk-laden delta answers HTTP 200 (got ${junk.status})`);
      check(r && (r.row.hw4s === undefined || r.row.hw4s === 0), "A4: a ZERO value is rejected (nothing to record)");
      check(r && (r.row.hptsS === undefined || r.row.hptsS === 0), "A4: a FRACTIONAL value is rejected");
      check(r && (r.row.hkoDealt === undefined || r.row.hkoDealt === 0), "A4: an ABSURDLY LARGE value is rejected (no single game can produce it)");
      check(r && (r.row.hkoTaken === undefined || r.row.hkoTaken === 0), "A4: a non-numeric string value is rejected");
      check(r && r.row.hg6s === 1, "A4: the one legitimate key in that same delta still lands");
    }

    // A5: the biggest value a real game can legitimately produce is still accepted - the cap
    // must be absurd-only, never in the way of a genuine 6-player win.
    const bigOk = await postSoloResult([{ name: "BigWin", delta: { hg6s: 1, hw6s: 1, hptsS: 15, hkoDealt: 40 } }]);
    await sleep(400);
    {
      const r = rowFor(await getLeaderboard(), "BigWin");
      check(bigOk.status === 200 && r && r.row.hptsS === 15 && r.row.hkoDealt === 40,
        "A5: the largest values a real game can produce (15 points, dozens of knockouts) are still accepted");
    }
    await stopServer(child);
  }

  /* =====================================================================================
   * PART B (bug 6): case-folded identity, live POSTs against a fresh empty board.
   * ===================================================================================== */
  {
    const child = startServer(path.join(SCRATCH, "leaderboard-names.json"), path.join(SCRATCH, "names.kv"));
    await waitHealthy();
    log("--- B (bug 6): one human, one row, whatever they capitalized ---");

    await postSoloResult([{ name: "Blake", delta: { hg4s: 1, hw4s: 1, hptsS: 6 } }]);
    await sleep(250);
    await postSoloResult([{ name: "blake", delta: { hg4s: 1, hptsS: 0 } }]);
    await sleep(250);
    await postSoloResult([{ name: "BLAKE", delta: { hg4s: 1, hw4s: 1, hptsS: 4 } }]);
    await sleep(500);
    const lb = await getLeaderboard();
    const keys = rowsFor(lb, "Blake");
    check(keys.length === 1, `B1: "Blake"/"blake"/"BLAKE" produce exactly ONE row (got ${keys.length}: ${JSON.stringify(keys)})`);
    if (keys.length === 1) {
      const row = lb[keys[0]];
      check(row.hg4s === 3, `B1: all three games are on that one row (hg4s=${row.hg4s}, want 3)`);
      check(row.hw4s === 2, `B1: both wins are on that one row (hw4s=${row.hw4s}, want 2)`);
      check(row.hptsS === 10, `B1: the points are summed, not split across rows (hptsS=${row.hptsS}, want 10)`);
      check(keys[0] === "Blake", `B1: the display name keeps the capitalization already on the board (got "${keys[0]}", want "Blake")`);
    }
    // Leading/trailing whitespace must fold the same way (cleanName already trims).
    await postSoloResult([{ name: "  bLaKe  ", delta: { hg4s: 1 } }]);
    await sleep(400);
    const lb2 = await getLeaderboard();
    check(rowsFor(lb2, "Blake").length === 1, "B2: a padded, mixed-case spelling still lands on the same single row");
    // A genuinely different person is untouched.
    await postSoloResult([{ name: "Blakely", delta: { hg4s: 1 } }]);
    await sleep(400);
    const lb3 = await getLeaderboard();
    check(!!rowFor(lb3, "Blakely") && rowsFor(lb3, "Blake").length === 1,
      "B3: a genuinely different name is NOT merged in (the fold is exact-match-after-lowercasing, not fuzzy)");
    await stopServer(child);
  }

  /* =====================================================================================
   * PART C (bug 6): the one-time, idempotent boot MERGE MIGRATION against a fixture holding
   * real-shaped duplicate rows (including a legacy pre-split row, to prove the two migrations
   * compose). Merging must SUM the numeric stat keys, never overwrite.
   * ===================================================================================== */
  {
    log("--- C (bug 6): boot merge migration on pre-existing duplicate-case rows ---");
    const fixture = {
      // The busy, "real" row - already split (post-v0.21 shape).
      "Blake":  { hg4s: 10, hw4s: 4, hptsS: 22, hg4t: 2, hw4t: 1, hptsT: 5, hkoDealt: 7, hkoTaken: 3 },
      // The iPad's row - same human, different capitalization, LEGACY pre-split shape (plain
      // hpts, no hptsS/hptsT). Proves the two boot migrations compose in the right order.
      "blake":  { hg4s: 3, hw4s: 1, hpts: 6 },
      // A third capitalization with only knockout stats - proves keys missing on the winner
      // still carry over, and keys present on both are SUMMED.
      "BLAKE":  { hg4s: 1, hkoDealt: 2 },
      // A different human with no duplicates at all - must come through untouched.
      "Sydney": { hg6t: 5, hw6t: 2, hptsT: 11 },
      // Two capitalizations of ANOTHER human where the busier row is the lower-case one -
      // proves the winner is chosen by activity, not by which spelling looks nicer.
      "kate":   { hg4s: 8, hw4s: 3, hptsS: 14 },
      "Kate":   { hg4s: 1, hptsS: 2 },
    };
    seed(fixture);
    let child = startServer(LB_FILE_MIGRATION, KV_PATH_MIGRATION);
    await waitHealthy();
    await sleep(900);   // let the debounced persist / lazy KV migration settle
    const after = await getLeaderboard();
    log("C: after first boot:", JSON.stringify(after));

    const blakeKeys = rowsFor(after, "Blake");
    check(blakeKeys.length === 1, `C1: the three "Blake" rows merged into one (got ${blakeKeys.length})`);
    if (blakeKeys.length === 1) {
      const r = after[blakeKeys[0]];
      check(blakeKeys[0] === "Blake", `C1: the BUSIEST row's capitalization is kept (got "${blakeKeys[0]}")`);
      check(r.hg4s === 14, `C2: hg4s summed 10+3+1 (got ${r.hg4s})`);
      check(r.hw4s === 5, `C2: hw4s summed 4+1 (got ${r.hw4s})`);
      check(r.hg4t === 2 && r.hw4t === 1, "C2: keys that existed on only ONE row carry over intact");
      check(r.hkoDealt === 9 && r.hkoTaken === 3, `C2: knockout stats summed 7+2 (got ${r.hkoDealt}/${r.hkoTaken})`);
      // The legacy row's 6 plain points were split to hptsS by the v0.21 migration first
      // (solo-only games), then summed in: 22 + 6 = 28.
      check(r.hptsS === 28, `C3: the legacy pre-split row's points were split THEN merged (hptsS=${r.hptsS}, want 28)`);
      check(r.hptsT === 5, `C3: the team points side is untouched by the merge (hptsT=${r.hptsT}, want 5)`);
    }
    const kateKeys = rowsFor(after, "Kate");
    check(kateKeys.length === 1 && kateKeys[0] === "kate", `C4: the busier lower-case "kate" wins the display name (got ${JSON.stringify(kateKeys)})`);
    if (kateKeys.length === 1) check(after[kateKeys[0]].hg4s === 9 && after[kateKeys[0]].hptsS === 16, "C4: ...with both rows' stats summed");
    check(!!after["Sydney"] && after["Sydney"].hg6t === 5 && after["Sydney"].hptsT === 11, "C5: a player with no duplicates is completely untouched");

    // Idempotency: reboot on the ALREADY-migrated data and require byte-identical values.
    await stopServer(child);
    child = startServer(LB_FILE_MIGRATION, KV_PATH_MIGRATION);
    await waitHealthy();
    await sleep(900);
    const after2 = await getLeaderboard();
    check(JSON.stringify(after2) === JSON.stringify(after), "C6: rebooting on already-merged data changes NOTHING (idempotent, no double-count)");

    // ...and a fresh POST under yet another capitalization still lands on the merged row.
    await postSoloResult([{ name: "BLAKE", delta: { hg4s: 1 } }]);
    await sleep(500);
    const after3 = await getLeaderboard();
    check(rowsFor(after3, "Blake").length === 1 && rowFor(after3, "Blake").row.hg4s === 15,
      "C7: a new game under a different capitalization lands on the merged row (no new row created)");
    await stopServer(child);
  }

  console.log(`\n[${KIND}] ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}
const WATCHDOG_MS = 180000;
const watchdog = setTimeout(() => {
  console.error(`[lbnames] WATCHDOG: suite did not finish within ${WATCHDOG_MS}ms - forcing exit`);
  process.exit(1);
}, WATCHDOG_MS);
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => clearTimeout(watchdog));
