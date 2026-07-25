"use strict";
/*
 * 2026-07-25 § DENO-ONLY: a room with people in it must not expire, plus the unbiased room-code
 * letters. Two confirmed divergences between server.js and server/cloud/server.ts, reproduced
 * here first and then proved fixed. Both are DENO-ONLY BY NATURE - Node cannot produce either.
 *
 * Bug 3 (the important one, PRODUCTION ONLY) - Deno pruned a room with connected players.
 *   server.js's pruner opens with `if (!roomIsFullyDisconnected(room)) continue;` - it never
 *   prunes a room anyone is connected to, full stop. server.ts had no presence guard at all:
 *   expiry there is purely KV's own `expireIn`, and the ONLY thing that ever refreshed it was a
 *   touchRoom() write, i.e. an actual message. awaySweep() only ever did a kv.get, which
 *   refreshes nothing. Net effect in production: a never-started lobby with the host sitting
 *   there connected and idle silently disappeared after 30 minutes - Blake's exact real-world
 *   flow (open a room, text the link, wait for the family to gather).
 *   Fix: while a room has a live local socket, the away sweep pushes its KV expiry back out.
 *   Proved here by reading the KV SQLite's own `expiration_ms` column directly, NOT by reasoning
 *   about the code - the whole point is that the expiry timestamp itself has to move.
 *
 * Room-code bias (cosmetic, but a real divergence) - server.ts drew a random byte and did
 *   `b % 19` over a 19-character alphabet. 256 = 19*13 + 9, so the first nine letters each had
 *   14 of the 256 byte values and the other ten had 13: about a 7.7% excess for a third of the
 *   alphabet. server.js has never had this (Node's crypto.randomInt rejection-samples
 *   internally). Fix: the same rejection sampling in server.ts.
 *   Proved here by extracting the SHIPPED randomCodeChar() out of server.ts and running it a
 *   few hundred thousand times - see part B's own comment for why it is done that way.
 *
 * Usage: node test_deno_room_ttl_presence.js        (deno only - there is nothing to run on node)
 */
const WebSocket = require("/Users/jarvis/nasty-game/server/node_modules/ws");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PORT = 27900 + Math.floor(Math.random() * 600);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "nasty-denottl-"));
const KV_PATH = path.join(SCRATCH, "ttl.kv");
const SERVER_TS = "/Users/jarvis/nasty-game/server/cloud/server.ts";
// Short refresh cadence + sweep so the suite measures in seconds instead of minutes. Both are
// env-tunable in the server for exactly this reason (same pattern as the away ladder's own
// thresholds, which have been env-tunable since v0.22).
const REFRESH_MS = 2000;

function log(...a) { console.log("[deno-ttl]", new Date().toISOString(), ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const child = spawn("deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "server.ts"], {
    cwd: "/Users/jarvis/nasty-game/server/cloud",
    env: Object.assign({}, process.env, {
      NASTY_PORT: String(PORT), NASTY_KV_PATH: KV_PATH, NASTY_ADMIN_TOKEN: "denottl-admin-token",
      NASTY_AWAY_SWEEP_MS: "500",
      NASTY_ROOM_TTL_REFRESH_MS: String(REFRESH_MS),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { if (process.env.DENOTTL_VERBOSE) process.stdout.write("[srv] " + d); });
  child.stderr.on("data", (d) => { if (process.env.DENOTTL_VERBOSE) process.stderr.write("[srv-err] " + d); });
  return child;
}
async function waitHealthy() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/health`); if (r.ok) return; } catch (e) {}
    await sleep(400);
  }
  throw new Error("server never became healthy");
}
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.msgs = [];
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      ws.msgs.push(m);
      // The whole point of this suite is a socket that sits there doing NOTHING except staying
      // connected - which is precisely what the app-level heartbeat is for. Answer it, or the
      // server hangs up on us for being stale and the test measures the wrong thing entirely.
      if (m.type === "ping") { try { ws.send(JSON.stringify({ type: "pong", t: m.t })); } catch (e) {} }
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
const sendJ = (ws, obj) => ws.send(JSON.stringify(obj));
function waitFor(ws, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = ws.msgs.find(predicate);
      if (hit) { clearInterval(iv); resolve(hit); return; }
      if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error("timeout: " + predicate.toString())); }
    }, 40);
  });
}

/*
 * Read the KV expiry (milliseconds since the epoch) of the ["room", CODE] key, straight out of
 * Deno's own SQLite file. There is no Deno KV API that exposes an entry's expiry, so this reads
 * the storage layer directly - which is the only way to prove the fix rather than assume it.
 * A KV key part is encoded as 0x02, the UTF-8 bytes, then 0x00, so ["room","ABCD"] is exactly
 * 02 'room' 00 02 'ABCD' 00 - built here rather than pattern-matched, so a wrong row can never
 * be picked up by accident. The database is read live (WAL mode allows concurrent readers) and
 * read-only.
 */
function hexOf(s) { return Buffer.from(s, "utf8").toString("hex").toUpperCase(); }
function roomKeyHex(code) { return "02" + hexOf("room") + "00" + "02" + hexOf(code) + "00"; }
function roomExpiry(code) {
  const out = execFileSync("sqlite3", ["-readonly", KV_PATH,
    `SELECT expiration_ms FROM kv WHERE hex(k) = '${roomKeyHex(code)}';`], { encoding: "utf8" }).trim();
  if (!out) return null;
  const n = Number(out.split("\n")[0]);
  return Number.isFinite(n) ? n : null;
}

async function partA() {
  log("=== A (bug 3): a lobby nobody has touched, but somebody is sitting in, must not expire ===");
  const child = startServer();
  await waitHealthy();

  const host = await connect();
  sendJ(host, { type: "host", protocolVersion: 5, name: "Blake", n: 4, teams: false, seats: [
    { name: "Blake", type: "human" }, { name: "S2", type: "human" }, { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" },
  ] });
  const created = await waitFor(host, (m) => m.type === "created");
  const code = created.code;
  log("room", code, "created; host is connected and will now sit completely idle");

  const t0 = roomExpiry(code);
  check(Number.isFinite(t0), `A0: the room's KV expiry is readable (got ${t0})`);

  // THE BUG: sit here doing absolutely nothing. No claimSeat, no chat, no start - just a phone
  // on the table with the invite screen open, which is exactly Blake's "text the link and wait"
  // flow. Before the fix, this expiry did not move by a single millisecond.
  await sleep(REFRESH_MS * 3 + 1500);
  const t1 = roomExpiry(code);
  log(`A: expiry before idle wait = ${t0}, after = ${t1}, moved ${t1 - t0}ms`);
  check(t1 > t0 && t1 - Date.now() > 25 * 60 * 1000,
    `A1: an idle-but-CONNECTED lobby's expiry is pushed back out by the full lobby TTL (moved ${t1 - t0}ms - before the fix it moved exactly 0)`);

  // Control: a REAL message has always refreshed the expiry - it must still. Seat 1, because
  // the host already holds seat 0 from room creation and re-claiming it is a no-op that
  // broadcasts nothing.
  const before = roomExpiry(code);
  await sleep(300);
  sendJ(host, { type: "claimSeat", seatIndex: 1, name: "Blake" });
  await waitFor(host, (m) => m.type === "lobby");
  await sleep(300);
  check(roomExpiry(code) > before, "A2: a real message still refreshes the expiry (the existing behavior is untouched)");

  // Negative control: once EVERYONE is gone the expiry must stop moving, or rooms would never
  // be cleaned up at all. This is the half that keeps Node and Deno equivalent - Node prunes an
  // empty room, and Deno must still let an empty room's TTL run out.
  host.close();
  await sleep(1200);
  const afterClose = roomExpiry(code);
  await sleep(REFRESH_MS * 3 + 1500);
  const afterCloseLater = roomExpiry(code);
  check(afterCloseLater === afterClose,
    `A3: once nobody is connected the expiry stops being refreshed, so an abandoned room still expires (${afterClose} -> ${afterCloseLater})`);

  child.kill("SIGKILL");
  await sleep(300);
}

/*
 * PART B: the room-code letters are drawn without modulo bias.
 *
 * There is no way to call the server's generator over the wire enough times to measure this -
 * the real 5-room-creates-per-minute-per-IP limiter (which is a feature, not an obstacle to
 * work around) caps it at a few dozen letters a minute, and detecting a 7.7% skew needs
 * hundreds of thousands. So this extracts the ACTUAL SHIPPED randomCodeChar() and CODE_LIMIT out
 * of server.ts and runs them here. That is deliberate and self-checking: if the function is
 * renamed, reshaped, or the biased one-liner comes back, the extraction fails loudly rather than
 * silently testing a copy that has drifted from the file.
 */
function partB() {
  log("=== B: room-code letters are drawn without modulo bias ===");
  const src = fs.readFileSync(SERVER_TS, "utf8");
  // Matched on the old CALL SITE rather than the bare expression, so this file's own
  // explanatory comment in server.ts (which quotes the biased expression) cannot trip it.
  check(!/Array\.from\(buf, \(b\) =>/.test(src),
    "B0: the old modulo-biased one-liner is gone from server.ts");
  const alphaM = src.match(/const CODE_ALPHABET = "([A-Z]+)"/);
  const limitM = src.match(/const CODE_LIMIT = ([^;]+);/);
  const fnM = src.match(/function randomCodeChar\(\): string \{([\s\S]*?)\n\}/);
  check(!!alphaM && !!limitM && !!fnM, "B0: CODE_ALPHABET, CODE_LIMIT and randomCodeChar() all found in server.ts");
  if (!alphaM || !limitM || !fnM) return;
  const CODE_ALPHABET = alphaM[1];
  // eslint-disable-next-line no-eval
  const randomCodeChar = eval(`(function(){
    const CODE_ALPHABET = ${JSON.stringify(CODE_ALPHABET)};
    const CODE_LIMIT = ${limitM[1]};
    return function randomCodeChar(){${fnM[1]}};
  })()`);

  // 100k expected draws per letter: the standard deviation of any one letter's count is then
  // about 0.3% of its expectation, so the worst of nineteen letters lands under ~1% essentially
  // always. That leaves the 2% threshold below comfortably clear of sampling noise while still
  // being a quarter of the 7.7% bias this is guarding against - it fails on a regression and
  // never flakes. A few million calls to a two-line function costs well under a second.
  const N = 1900000;
  const counts = Object.create(null);
  for (const c of CODE_ALPHABET) counts[c] = 0;
  for (let i = 0; i < N; i++) {
    const c = randomCodeChar();
    if (counts[c] === undefined) { check(false, `B1: generated a character outside the alphabet: ${JSON.stringify(c)}`); return; }
    counts[c]++;
  }
  const expected = N / CODE_ALPHABET.length;
  let worst = 0, worstChar = "";
  for (const c of CODE_ALPHABET) {
    const dev = Math.abs(counts[c] - expected) / expected;
    if (dev > worst) { worst = dev; worstChar = c; }
  }
  log(`B: ${N} draws, expected ${expected.toFixed(0)} each, worst deviation ${(worst * 100).toFixed(2)}% on "${worstChar}"`);
  // The old bias was a systematic 7.7% excess on the first nine letters. Pure sampling noise at
  // this N is well under 1%, so a 2% band is comfortably below the bug and comfortably above the
  // noise - it fails loudly on a regression and never flakes.
  check(worst < 0.02, `B1: every letter is within 2% of uniform (worst was ${(worst * 100).toFixed(2)}% on "${worstChar}") - the old bias was a systematic 7.7%`);
}

async function main() {
  await partA();
  partB();
  console.log(`\n[deno] ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}
const WATCHDOG_MS = 120000;
const watchdog = setTimeout(() => {
  console.error(`[deno-ttl] WATCHDOG: suite did not finish within ${WATCHDOG_MS}ms - forcing exit`);
  process.exit(1);
}, WATCHDOG_MS);
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => clearTimeout(watchdog));
