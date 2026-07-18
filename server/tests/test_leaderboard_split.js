// v0.21 leaderboard solo/teams point-split verification. Usage:
//   node test_leaderboard_split.js node     (server/server.js on a private NASTY_PORT/NASTY_ROOMS_DIR)
//   node test_leaderboard_split.js deno     (server/cloud/server.ts on a private NASTY_PORT/NASTY_KV_PATH)
// Never touches prod. Follows the exact same private-instance shape as test_v16_features.js /
// smoke_deno.js. Covers:
//   (a) a new-style client POSTing split points directly (hptsS/hptsT) - both solo and team modes.
//   (b) a legacy (already-shipped, pre-split) client POSTing a plain "hpts" delta alongside an
//       hg/hw mode key - server must attribute it to the correct split bucket, not store plain
//       "hpts". Also covers a non-win legacy delta (no hpts at all) and a malformed delta (hpts
//       with no sibling mode key - dropped safely, not stored anywhere).
//   (c) boot/startup migration deriving split keys from pre-existing legacy-only stored data -
//       one unambiguous-solo player, one unambiguous-team player, and one genuinely AMBIGUOUS
//       player (both hg4s and hg4t nonzero) requiring the wins-ratio fallback - mirrors the real
//       shape found on production (see HANDOFF.md). Confirms idempotency by restarting the
//       server a second time on the same already-migrated data and checking nothing changes.
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const KIND = process.argv[2] || "node";
const PORT = 18900 + Math.floor(Math.random() * 700);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `nasty-lbsplit-${KIND}-`));
const ADMIN_TOKEN = "lbsplit-admin-token";
const BASE = `http://localhost:${PORT}`;
// Two ENTIRELY separate storage locations, one per scenario group below - scenarios (a)/(b)
// POST live against a fresh empty board; scenario (c) pre-seeds legacy-only data and restarts
// against it. Keeping these on separate files/KV paths means scenario (c) is a genuinely clean
// "boot against pre-existing legacy data" test, uncontaminated by whatever (a)/(b) wrote.
const LB_FILE_LIVE = path.join(SCRATCH, "leaderboard-live.json");
const KV_PATH_LIVE = path.join(SCRATCH, "live.kv");
const LB_FILE_MIGRATION = path.join(SCRATCH, "leaderboard-migration.json");
const KV_PATH_MIGRATION = path.join(SCRATCH, "migration.kv");

function log(...a) { console.log("[lbsplit]", ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK ", label); } else { FAIL++; log("FAIL", label); } }

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
  child.stderr.on("data", (d) => { if (process.env.LBSPLIT_VERBOSE) process.stderr.write("[srv-err] " + d); });
  return child;
}
async function waitHealthy() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + "/health"); if (r.ok) return; } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("server never became healthy");
}
async function stopServer(child) {
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 400));
}
let gidCounter = 0;
async function postSoloResult(entries) {
  const gameId = `lbsplit-${KIND}-${Date.now()}-${gidCounter++}`;
  const r = await fetch(BASE + "/solo-result", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ gameId, entries }),
  });
  return r;
}
async function getLeaderboard() {
  const r = await fetch(BASE + "/leaderboard");
  return await r.json();
}

// Pre-seed LEGACY (pre-split) leaderboard data before the server ever boots/migrates it, so we
// can verify the boot/startup migration pass. Node: write the JSON file directly. Deno: use a
// tiny separate `deno run` invocation to open the same KV path and write the raw counters
// (mirrors how the real server stores them - Deno.KvU64 atomic counters keyed
// ["leaderboard", name, statKey]) BEFORE the real server under test ever touches that path.
function seedLegacyNode(data) {
  fs.writeFileSync(LB_FILE_MIGRATION, JSON.stringify(data));
}
function seedLegacyDeno(data) {
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

async function main() {
  // ================= scenarios (a) + (b): fresh empty server, POST /solo-result directly =================
  {
    const child = startServer(LB_FILE_LIVE, KV_PATH_LIVE);
    await waitHealthy();

    // (a) new-style client sends split points directly - solo mode.
    await postSoloResult([{ name: "NewSolo", delta: { hg4s: 1, hw4s: 1, hptsS: 9 } }]);
    // (a) new-style client sends split points directly - team mode.
    await postSoloResult([{ name: "NewTeam", delta: { hg6t: 1, hw6t: 1, hptsT: 12 } }]);
    await new Promise((r) => setTimeout(r, 300));
    let lb = await getLeaderboard();
    log("(a) NewSolo:", JSON.stringify(lb.NewSolo), "NewTeam:", JSON.stringify(lb.NewTeam));
    check(lb.NewSolo && lb.NewSolo.hptsS === 9 && lb.NewSolo.hg4s === 1 && lb.NewSolo.hw4s === 1, "a: new-style solo client's hptsS recorded directly");
    check(!("hpts" in (lb.NewSolo || {})), "a: no stray legacy hpts field written for a new-style solo submit");
    check(lb.NewTeam && lb.NewTeam.hptsT === 12 && lb.NewTeam.hg6t === 1 && lb.NewTeam.hw6t === 1, "a: new-style team client's hptsT recorded directly");
    check(!("hpts" in (lb.NewTeam || {})), "a: no stray legacy hpts field written for a new-style team submit");

    // (b) legacy (already-shipped) client sends a plain "hpts" delta - solo mode.
    await postSoloResult([{ name: "LegacySolo", delta: { hg4s: 1, hw4s: 1, hpts: 9 } }]);
    // (b) legacy client - team mode.
    await postSoloResult([{ name: "LegacyTeam", delta: { hg6t: 1, hw6t: 1, hpts: 12 } }]);
    // (b) legacy client - a NON-win delta (no hpts at all, just the games counter). Name kept
    // to the game's own 10-character name cap (NAME_MAX), same as every real player name.
    await postSoloResult([{ name: "NoWinLeg", delta: { hg4t: 1 } }]);
    // (b) malformed edge case: "hpts" with no hg/hw sibling in the same delta - can't be safely
    // attributed to either bucket, must be dropped rather than guessed (see applyLeaderboardEntry()).
    await postSoloResult([{ name: "OrphanPts", delta: { hpts: 5 } }]);
    await new Promise((r) => setTimeout(r, 300));
    lb = await getLeaderboard();
    log("(b) LegacySolo:", JSON.stringify(lb.LegacySolo), "LegacyTeam:", JSON.stringify(lb.LegacyTeam),
      "NoWinLeg:", JSON.stringify(lb.NoWinLeg), "OrphanPts:", JSON.stringify(lb.OrphanPts));
    check(lb.LegacySolo && lb.LegacySolo.hptsS === 9 && lb.LegacySolo.hg4s === 1, "b: legacy solo delta's plain hpts attributed to hptsS");
    check(!("hpts" in (lb.LegacySolo || {})), "b: legacy solo delta does not leave a stray literal hpts field");
    check(!lb.LegacySolo || !lb.LegacySolo.hptsT, "b: legacy solo delta did not also bleed into hptsT");
    check(lb.LegacyTeam && lb.LegacyTeam.hptsT === 12 && lb.LegacyTeam.hg6t === 1, "b: legacy team delta's plain hpts attributed to hptsT");
    check(!("hpts" in (lb.LegacyTeam || {})), "b: legacy team delta does not leave a stray literal hpts field");
    check(!lb.LegacyTeam || !lb.LegacyTeam.hptsS, "b: legacy team delta did not also bleed into hptsS");
    check(lb.NoWinLeg && lb.NoWinLeg.hg4t === 1 && !lb.NoWinLeg.hptsS && !lb.NoWinLeg.hptsT, "b: legacy non-win delta just records the game, no points either bucket");
    check(!lb.OrphanPts || (!lb.OrphanPts.hptsS && !lb.OrphanPts.hptsT && !("hpts" in lb.OrphanPts)), "b: orphan hpts (no sibling mode key) dropped safely, not stored anywhere");

    await stopServer(child);
  }

  // ================= scenario (c): boot/startup migration of pre-existing legacy data =================
  {
    // Mirrors the REAL production /leaderboard shape found before this feature shipped (see
    // HANDOFF.md/final report): a player with wins in ONLY one mode (unambiguous), and a player
    // with wins in BOTH modes (genuinely ambiguous - requires the wins-ratio fallback). Also one
    // team-only unambiguous player for symmetry.
    const legacyData = {
      UnambiguousSolo: { hg4s: 5, hw4s: 2, hpts: 10 },
      UnambiguousTeam: { hg6t: 4, hw6t: 1, hpts: 3 },
      // Same shape as production's real "Anthony": hg4s=3,hg4t=37,hw4s=1,hw4t=26,hpts=165 ->
      // expected hptsS=round(165*1/27)=6, hptsT=165-6=159.
      AmbiguousBothModes: { hg4s: 3, hg4t: 37, hw4s: 1, hw4t: 26, hpts: 165 },
      // Both hg4s and hg4t nonzero (ambiguous by the games check) but ALL wins are on one side -
      // wins-ratio fallback should cleanly land 100% on that side. Mirrors production's real
      // "Baker Sr." (hg4s=2,hg4t=3,hw4t=1,hpts=6, no hw4s) -> expected hptsS=0, hptsT=6.
      AmbiguousWinsAllTeam: { hg4s: 2, hg4t: 3, hw4t: 1, hpts: 6 },
      // No hpts at all (e.g. production's real "Tom": hg4t=1, never won, never had a legacy
      // hpts field) - migration must leave this alone (nothing to split), no crash.
      NeverWon: { hg4t: 1 },
    };
    if (KIND === "deno") seedLegacyDeno(legacyData); else seedLegacyNode(legacyData);

    let child = startServer(LB_FILE_MIGRATION, KV_PATH_MIGRATION);
    await waitHealthy();
    let lb = await getLeaderboard();
    log("(c) after first boot migration:", JSON.stringify(lb));
    check(lb.UnambiguousSolo && lb.UnambiguousSolo.hptsS === 10 && (lb.UnambiguousSolo.hptsT || 0) === 0, "c: unambiguous solo-only legacy player split entirely into hptsS");
    check(lb.UnambiguousTeam && lb.UnambiguousTeam.hptsT === 3 && (lb.UnambiguousTeam.hptsS || 0) === 0, "c: unambiguous team-only legacy player split entirely into hptsT");
    check(lb.AmbiguousBothModes && lb.AmbiguousBothModes.hptsS === 6 && lb.AmbiguousBothModes.hptsT === 159, "c: genuinely ambiguous legacy player split by wins ratio (6/159, matches real prod shape)");
    check(lb.AmbiguousBothModes.hptsS + lb.AmbiguousBothModes.hptsT === 165, "c: ambiguous split sums back exactly to the original legacy hpts (no rounding drift)");
    check(lb.AmbiguousWinsAllTeam && lb.AmbiguousWinsAllTeam.hptsS === 0 && lb.AmbiguousWinsAllTeam.hptsT === 6, "c: ambiguous-by-games-but-all-wins-one-side player split entirely by the wins ratio");
    check(lb.NeverWon && (lb.NeverWon.hptsS || 0) === 0 && (lb.NeverWon.hptsT || 0) === 0, "c: a legacy player with no hpts at all is left alone, no crash");

    await stopServer(child);

    // Restart on the SAME (now-migrated) data and confirm idempotency: values must be
    // byte-for-byte identical to the post-migration values above, not re-derived or doubled.
    child = startServer(LB_FILE_MIGRATION, KV_PATH_MIGRATION);
    await waitHealthy();
    const lb2 = await getLeaderboard();
    log("(c) after SECOND boot (idempotency check):", JSON.stringify(lb2));
    check(lb2.AmbiguousBothModes && lb2.AmbiguousBothModes.hptsS === 6 && lb2.AmbiguousBothModes.hptsT === 159, "c: idempotent - ambiguous player's split unchanged on a second boot");
    check(lb2.UnambiguousSolo && lb2.UnambiguousSolo.hptsS === 10, "c: idempotent - unambiguous solo player's split unchanged on a second boot");
    check(lb2.UnambiguousTeam && lb2.UnambiguousTeam.hptsT === 3, "c: idempotent - unambiguous team player's split unchanged on a second boot");
    await stopServer(child);
  }

  console.log(`\n${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
