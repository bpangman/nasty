// NASTY server — Deno Deploy port of ../server.js (the Node/ws version, which stays intact
// for local dev/tests). SAME wire protocol, EXACTLY, as of v0.15: SERVER-AUTHORITATIVE game
// state (protocol v2) — see HANDOFF.md's "v0.15" section, which supersedes the older "Online
// multiplayer"/"Cloud hosting" relay-era descriptions for everything gameplay-related.
//
// v0.15 authoritative design, this file (mirrors server.js's driveTurnLoop design, adapted to
// KV + per-request isolate reality):
//   - The rules engine is imported from ./engine.js — GENERATED from index.html by
//     ../build-engine.js (npm run build-engine in ../), NEVER hand-edited. One authored copy
//     of the rules, three consumers (browser, Node server, this file).
//   - Each started room's live engine instance (holding the authoritative `G`) lives in THIS
//     ISOLATE'S memory (`engines` map below) while the room is active — realistic because the
//     deploy is pinned to a single region where one instance serves everything (the same
//     documented single-instance-in-practice reasoning § RELAY below has always leaned on).
//   - Every game mutation ALSO persists a full `G` snapshot into the room's KV meta key
//     (RoomMeta.G) in the same touchRoom commit that bumps nextSeq — so a cold start, isolate
//     recycle, or genuine multi-isolate handoff restores the game exactly from KV
//     (getEngine() below re-hydrates an engine from meta.G on demand). G for a 6-seat game
//     serializes to a few KB — comfortably under KV's 64KiB per-value limit (verified with a
//     real serialized-size check in the test suite, not assumed).
//   - Game mutations for one room are serialized through a per-room promise chain
//     (`roomChain` below) IN ADDITION to the per-connection msgChain — two different players'
//     near-simultaneous messages for the same room must not interleave their engine mutations.
//     Cross-ISOLATE serialization is not attempted (same accepted single-instance caveat as
//     § RELAY; KV's optimistic concurrency in touchRoom still prevents silent lost writes).
//
// Three real differences from the Node version, all forced by running on a serverless,
// multi-region platform instead of one long-lived process:
//
// 1. PERSISTENCE — Deno KV instead of server/rooms/*.json + server/leaderboard.json.
//    A room's small fields (lobby, seatOwners, started, paused, player list) live in one KV
//    key (["room", CODE]); the action log — which can grow large over a long game — is
//    stored as one KV entry PER action (["roomlog", CODE, seq]) so no single KV value ever
//    approaches the 64KiB per-value limit. Leaderboard stats are stored as Deno.KvU64
//    counters (["leaderboard", name, statKey]) updated with kv.atomic().sum(...) — an
//    atomic increment with no read-modify-write race, which is actually SAFER than the
//    Node version's in-memory `r[k] = (r[k]||0) + v`.
// 2. PRUNING — native KV expiry (`expireIn`) replaces the Node version's 5-minute
//    setInterval sweep. Every write that touches a room refreshes its meta key's expiry to
//    the same two-tier policy (30 min for a never-started lobby, 7 days for a started game) —
//    so an idle room just falls out of KV on its own; no polling loop needed. Log entries
//    carry a longer backstop TTL so they always outlive the meta key they belong to.
// 3. CROSS-ISOLATE RELAY — this is the one that actually matters for correctness. Deno
//    Deploy can run each WebSocket connection on whichever regional instance is nearest that
//    client; instances do NOT share in-memory state. If this were ported naively (one
//    in-memory `rooms` Map, like Node), two family members connecting from different
//    regions could land on two different instances and never see each other's moves — the
//    relay would silently only work for players who happen to share an instance. Guarded with
//    BroadcastChannel (documented cross-isolate fanout on the OLD/classic Deploy platform this
//    file was originally written for; the NEW platform's docs don't document it either way —
//    see HANDOFF.md "Cloud hosting" for what was actually verified). Every broadcast/
//    targeted-send goes out to this isolate's own locally-connected sockets AND is posted to
//    a per-room BroadcastChannel so every OTHER isolate holding a live socket for that room
//    delivers it too — but every BroadcastChannel call is try/caught (see getChannel()/
//    postToChannel() below): if it's unsupported/misbehaves on the new platform, that just
//    means cross-instance delivery silently doesn't happen instead of crashing the process,
//    which is a non-issue given deploy runs the app pinned to a single region (see
//    HANDOFF.md) where, at this app's traffic level, one instance serves everything anyway.
//    New-platform addition: a § HEARTBEAT interval (below) sends periodic 'ping' frames over
//    every open socket so the platform's idle-instance teardown (as short as 5s of total
//    silence, per its docs) never fires mid-game, AND (v0.16) so a socket that never echoes
//    one back gets detected as half-dead and force-closed server-side, same spirit as
//    server.js's Node-`ws`-library ping/pong/terminate() heartbeat.
//
// Admin token: read from the NASTY_ADMIN_TOKEN env var (a Deno Deploy secret) instead of a
// file — set it to the SAME value as server/admin-token.txt so Blake's existing token in the
// admin panel keeps working after the migration. Falls back to a logged, isolate-local
// random token if the secret isn't set (dev convenience only — never rely on that in prod).
//
// Run locally: `deno run --allow-net --allow-env --allow-read --allow-write --unstable-kv
// server.ts` (NASTY_PORT / NASTY_KV_PATH / NASTY_ADMIN_TOKEN env vars mirror the Node
// version's NASTY_PORT / NASTY_ROOMS_DIR+NASTY_LEADERBOARD_FILE / NASTY_ADMIN_TOKEN_FILE —
// always point NASTY_KV_PATH at a private scratch file for tests, never the default/prod KV).
// Deploy: `deno deploy --org <org> --app <app> --prod` from this directory (see HANDOFF.md
// "Cloud hosting" for the full new-platform CLI walkthrough — deployctl/classic is retired).

// v0.15: the generated rules engine — see this file's header and ../build-engine.js. Plain JS,
// no types (Deno imports it fine; the engine object is treated as `any`-shaped on purpose,
// its API is documented in the generated file's own header).
// deno-lint-ignore-file no-explicit-any
import { createEngine } from "./engine.js";
import { sendTurnPush } from "./apns.ts";

const PORT = Number(Deno.env.get("NASTY_PORT") ?? 8484);
const KV_PATH = Deno.env.get("NASTY_KV_PATH") || undefined; // undefined = Deploy's managed KV / local default

/* v0.15 § PROTOCOL VERSION — twin of server.js's matching block, byte-identical semantics.
   Breaking wire-protocol change: pre-v0.15 (lockstep) clients cannot talk to this server and
   vice versa. host/join/rejoin/reclaim all carry protocolVersion from the client; anything
   missing/below current gets a plain-language rejection (no dashes — standing rule). */
/* v0.23 (2026-07-20): 2 -> 3 for the "you can NOT take out your own pegs" rule change - twin
   of server.js's matching comment. Protocol-2 clients (builds 16-29) get the friendly update
   message; the engine's legalMoves() validation still rejects any stale move gracefully. */
/* v0.23.1 (2026-07-20, Blake's confirmed partner-peg ruling): 3 -> 4 - twin of server.js's
   matching comment. Partner-landing is now a legal LAST RESORT (kicks the partner peg instead
   of bowing out); a protocol-3 client (build 30 / v0.23 website) would find zero local moves
   in that situation and softlock on "Catching up..." while this server waits for its move, so
   protocol-3 clients get the same friendly update message. */
/* v0.25 (2026-07-21): 4 -> 5 - twin of server.js's matching comment. The online START flow
   changed shape: readiness is collected IN THE LOBBY now (a guest's "Ready up" on the seat
   screen; the host's Start acting as their own ready) and the post-Start readyCheck phase is
   gone from the wire, plus the new v0.25 rejoin-lobby flow (takeOverSeat). A protocol-4
   client (build 32 / v0.24 website) is not safe in either direction, so it gets the same
   friendly update message at host/join/rejoin/reclaim. */
const PROTOCOL_VERSION = 5;
const PROTOCOL_MISMATCH_MESSAGE =
  "This game needs the newest version of NASTY. Please refresh the page (website) or update the app (App Store) and try again.";
function protocolOk(msg: Record<string, unknown>): boolean {
  return typeof msg.protocolVersion === "number" && (msg.protocolVersion as number) >= PROTOCOL_VERSION;
}

/* v0.15.1 hotfix (2026-07-16), twin of server.js's matching block — see that file's comment
   for the full derivation. Short version: a pre-v0.15 client understands NONE of the v0.15
   wire types, including 'protocolMismatch' itself, so the plain-language rejection above
   never reaches the user on an old app — it silently falls through that client's message
   switch to `default: return`. Send a SECOND reply, alongside the modern one, shaped like an
   error type the OLD client's own switch already renders for that flow. */
const LEGACY_CLIENT_MESSAGE =
  "This game needs the newest version of NASTY - please update the app in TestFlight, or refresh the website, then try again.";
function sendLegacyMismatch(ws: WebSocket | null | undefined, kind: "host" | "join" | "rejoin" | "reclaim") {
  const type = kind === "host" ? "kicked" : kind === "join" ? "joinError" : kind === "rejoin" ? "rejoinError" : "reclaimError";
  send(ws, { type, message: LEGACY_CLIENT_MESSAGE });
}

/* v0.15.1 hotfix, part 2 — old-format (pre-v0.15) rooms have no `meta.G` even though
   `meta.started` is true, so this server has no rules engine state to drive them with (live
   examples on prod at the time of this fix: HWRK, MNDW, XKTH). A rejoin/reclaim against one
   used to silently send `G: null` inside a 'sync'/'reclaimed' message — a second silent-
   failure shape. Twin of server.js's isUnmigratableRoom/pruneUnmigratableRoom. */
const OLD_ROOM_MESSAGE =
  "That game was from the old version and can't be continued - please start a fresh one.";
function isUnmigratableRoom(meta: RoomMeta | null | undefined): boolean {
  return !!(meta && meta.started && !meta.G);
}
async function pruneUnmigratableRoom(code: string) {
  forceCloseRoomSockets(code);
  dropEngine(code);
  await kv.delete(roomKey(code));
  for await (const e of kv.list({ prefix: ["roomlog", code] })) await kv.delete(e.key);
  log("pruned unmigratable pre-v0.15 room", code);
}

/* v0.15.1 hotfix 2/2, twin of server.js's matching block (2026-07-16, Blake's report on iOS
   build 16: hosting a NEW game bounces straight back to the menu). Root-caused via an
   exact-build-16 client reproduction: build 16 is v0.15 (protocolVersion 2, already
   understands protocolMismatch fine - NOT the pre-v0.15 sendLegacyMismatch case above) but was
   built before commit c86a253, so it never clears its nasty-last-room pointer or SAVED_GAME
   menu state on a 'rejoinError'/'reclaimError' for a dead room. Left uncleared, every later
   Start/Host/Join tap on that build routes through its confirmOverwriteThenRun(), which pops an
   unexpected "you have a saved game" warning; tapping Cancel drops straight back to a bare menu
   with nothing hosted - Blake's exact symptom. A dead/unmigratable room, or a room/player/token
   that plain doesn't exist, can never legitimately be an in-progress game for ANY client build,
   so it's always safe to ALSO send a 'kicked'-shaped follow-up: that handler
   (leaveOnlineToMenu(), index.html) unconditionally clears nasty-last-room, resets NET state,
   closes any open overlay, and lands on a clean menu - build 16 already had this handler, it
   just never got called for a dead-room rejoin/reclaim before now. A post-c86a253 client (which
   already runs rejoinError through the same leaveOnlineToMenu() path when no game is in
   progress) treats this as a harmless no-op repeat - verified against both client builds. */
function sendDeadRoomFollowup(ws: WebSocket | null | undefined, message: string) {
  send(ws, { type: "kicked", message });
}

const ROOM_TTL_MS = 30 * 60 * 1000; // never-started lobby, fully disconnected
const STARTED_ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // started-but-unfinished game
const LOG_TTL_MS = STARTED_ROOM_TTL_MS + 24 * 60 * 60 * 1000; // backstop: always outlives the meta key

// v0.10.3: token-less recovery ("reclaim by name") — ONLY implemented/tested locally (`deno
// run`, see file header) per this session's server-change rule, NOT deployed. Kept in-memory
// per-isolate (like server.js), which is only fully correct when the reclaim request and the
// host's approval land on the SAME isolate — consistent with this file's existing
// single-instance-in-practice reasoning for BroadcastChannel (see § RELAY below); if a FUTURE
// deploy ever needs true cross-isolate correctness here, this would need to move into KV the
// same way rooms did. The common, uncontested case (the named seat is already disconnected)
// needs no cross-isolate coordination at all — it's a normal touchRoom mutation.
type PendingReclaim = { code: string; targetPlayerId: number; socket: WebSocket; expires: number };
const pendingReclaims = new Map<string, PendingReclaim>();
const RECLAIM_TIMEOUT_MS = 30 * 1000;

const CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXZ"; // no vowels/Y, no 0/O/1/I/L confusion

// LAZY KV INIT — new-platform adaptation, 2026-07-11, load-bearing (not just defensive).
// `const kv = await Deno.openKv(...)` at module top level made every deploy to the new
// platform fail its build step, 100% reproducibly, confirmed by bisecting a series of probe
// apps down to this exact line: a bare `const kv = await Deno.openKv();` with NOTHING else in
// the file was enough to fail "building" on its own, while the identical file with `kv`
// wrapped in a function that's merely DEFINED (never called at module scope) built and
// deployed fine. Conclusion: the new platform's build step fully imports/evaluates the
// entrypoint module (probably to validate it, discover exports, etc.) but does not simulate a
// request against it — so top-level `await` on something build-time doesn't have access to
// (KV needs the app's database link, not yet resolved during build) fails the whole
// deployment, while code that only RUNS on an actual incoming request is untouched. Fix:
// `kv` is opened lazily, on the first real request, via ensureKv() — called once at the top
// of handler() (below), which every code path (HTTP routes AND the WebSocket upgrade, which
// handler() dispatches to synchronously after that await resolves) is reached through, so by
// the time anything below actually touches `kv` it's always already open. Locally under
// `deno run` this is a no-op behavior change (no separate build phase there either way).
let kv: Deno.Kv;
let kvReady: Promise<void> | null = null;
function ensureKv(): Promise<void> {
  if (!kvReady) kvReady = Deno.openKv(KV_PATH).then((k) => { kv = k; });
  return kvReady;
}

function log(...a: unknown[]) { console.log(new Date().toISOString(), ...a); }

/* ---------------------------------------------------------------------------------------
 * § NAMES — duplicated from server.js on purpose (that file is standalone Node with zero
 * shared modules; this is standalone Deno). Keep both copies in sync if the rules change.
 * ------------------------------------------------------------------------------------- */
const NAME_MAX = 10;
const NAME_BLOCKLIST = ["fuck","shit","bitch","asshole","bastard","dick","pussy","cunt",
  "nigger","nigga","fag","faggot","retard","whore","slut","cock","twat","coon","spic",
  "chink","kike","tranny","rape","nazi","dyke","cracker"];
function normalizeName(s: unknown): string {
  return String(s || "").toLowerCase()
    .replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a")
    .replace(/5/g, "s").replace(/7/g, "t").replace(/\$/g, "s").replace(/@/g, "a")
    .replace(/[^a-z]/g, "");
}
function isBadName(raw: unknown): boolean {
  const n = normalizeName(raw);
  return !!n && NAME_BLOCKLIST.some((w) => n.includes(w));
}
function cleanName(raw: unknown, fallback?: string): string {
  const s = String(raw || "").trim().slice(0, NAME_MAX);
  return s || fallback || "";
}

/* ---------------------------------------------------------------------------------------
 * § ADMIN — token from env (Deploy secret), not a file. See file header.
 * ------------------------------------------------------------------------------------- */
const ADMIN_TOKEN = Deno.env.get("NASTY_ADMIN_TOKEN") || (() => {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  const t = Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
  console.warn("NASTY_ADMIN_TOKEN not set — using an ephemeral isolate-local token (won't " +
    "survive a restart, won't match other isolates). Set the NASTY_ADMIN_TOKEN secret to " +
    "server/admin-token.txt's value before relying on god mode. Ephemeral token:", t);
  return t;
})();
function checkAdminToken(req: Request, url: URL): boolean {
  const header = req.headers.get("x-admin-token");
  const q = url.searchParams.get("token");
  const given = header || q || "";
  return !!given && given === ADMIN_TOKEN;
}

/* ---------------------------------------------------------------------------------------
 * § LEADERBOARD — Deno.KvU64 atomic counters, see file header point 1.
 * ------------------------------------------------------------------------------------- */
// v0.21: leaderboard split into Solo/Teams tabs client-side - the aggregate "hpts" key is
// replaced going forward by hptsS (solo/free-for-all wins) and hptsT (team wins). hpts itself
// is deliberately NOT in this regex anymore - see applyLeaderboardEntry()'s legacy-attribution
// logic just below for how an OLD client's plain "hpts" delta still gets accepted and
// redirected into the correct split key, and migrateLegacyLeaderboardPoints() further below
// for the one-time startup migration of points already in KV from before this split. Twin of
// server.js's matching block - keep both in sync.
const NUMERIC_STAT_KEY = /^(hg[46][st]|hw[46][st]|hptsS|hptsT)$/;
async function applyLeaderboardEntry(name: unknown, delta: unknown) {
  const clean = cleanName(name, "");
  if (!clean || isBadName(clean) || !delta || typeof delta !== "object") return;
  const d = delta as Record<string, unknown>;
  // Legacy pre-split clients (already shipped, can't be changed) still send a plain "hpts" key
  // instead of hptsS/hptsT. Every delta this app has ever produced always carries exactly one
  // "hg"+mode key alongside it - use THAT sibling key's mode (last char 's'/'t') to redirect a
  // legacy "hpts" value into the correct split bucket. If there's no sibling mode key to read
  // from, the points can't be safely attributed to either bucket, so they're dropped rather
  // than guessed - twin of server.js's matching logic.
  let legacyPtsTarget: string | null = null;
  if (Object.prototype.hasOwnProperty.call(d, "hpts")) {
    const modeKey = Object.keys(d).find((k) => /^h[gw][46][st]$/.test(k));
    if (modeKey) legacyPtsTarget = modeKey.endsWith("t") ? "hptsT" : "hptsS";
  }
  for (const k of Object.keys(d)) {
    const key = k === "hpts" ? legacyPtsTarget : k;
    if (!key || !NUMERIC_STAT_KEY.test(key)) continue;
    const v = Number(d[k]);
    if (!Number.isFinite(v)) continue;
    await kv.atomic().sum(["leaderboard", clean, key], BigInt(Math.round(v))).commit();
  }
}
/* v0.21 § LEADERBOARD SPLIT MIGRATION - startup, idempotent. Twin of server.js's matching
   function, adapted to KV having no single "load everything" boot moment: iterate every
   ["leaderboard"] key, group by player name, and for each player missing BOTH hptsS and hptsT
   but holding a nonzero legacy "hpts" counter, derive the split the same way server.js does
   (unambiguous if only one side has nonzero games; otherwise split proportionally by each
   side's wins ratio, falling back to a games-ratio split if wins are all zero on both sides).
   Guarded by ensureLeaderboardMigrated() below so it only actually runs once per isolate -
   safe to call it unconditionally from every request. */
async function migrateLegacyLeaderboardPoints(): Promise<void> {
  const byName: Record<string, Record<string, number>> = {};
  for await (const e of kv.list<Deno.KvU64>({ prefix: ["leaderboard"] })) {
    const name = String(e.key[1]);
    const statKey = String(e.key[2]);
    byName[name] = byName[name] || {};
    byName[name][statKey] = Number(e.value.value);
  }
  let migrated = 0;
  for (const name of Object.keys(byName)) {
    const r = byName[name];
    if (r.hptsS !== undefined || r.hptsT !== undefined) continue; // already split - idempotent skip
    const hpts = r.hpts || 0;
    if (!hpts) continue; // nothing to split
    const soloGames = (r.hg4s || 0) + (r.hg6s || 0);
    const teamGames = (r.hg4t || 0) + (r.hg6t || 0);
    let hptsS: number;
    if (soloGames > 0 && teamGames === 0) {
      hptsS = hpts;
    } else if (teamGames > 0 && soloGames === 0) {
      hptsS = 0;
    } else {
      const soloWins = (r.hw4s || 0) + (r.hw6s || 0);
      const teamWins = (r.hw4t || 0) + (r.hw6t || 0);
      const totalWins = soloWins + teamWins;
      if (totalWins > 0) {
        hptsS = Math.round(hpts * soloWins / totalWins);
      } else {
        const totalGames = soloGames + teamGames;
        hptsS = totalGames > 0 ? Math.round(hpts * soloGames / totalGames) : 0;
      }
    }
    const hptsT = hpts - hptsS;
    await kv.set(["leaderboard", name, "hptsS"], new Deno.KvU64(BigInt(hptsS)));
    await kv.set(["leaderboard", name, "hptsT"], new Deno.KvU64(BigInt(hptsT)));
    migrated++;
  }
  if (migrated) log("migrated", migrated, "leaderboard entries to split solo/team points");
}
let lbMigrationReady: Promise<void> | null = null;
// Same lazy-once-per-isolate pattern as ensureKv() above (see that comment for why nothing
// here can run at module/top-level scope on this platform) - called from handler() right after
// ensureKv() resolves, so every request path is covered, but the actual KV scan+write only
// ever happens once per isolate.
function ensureLeaderboardMigrated(): Promise<void> {
  if (!lbMigrationReady) lbMigrationReady = migrateLegacyLeaderboardPoints();
  return lbMigrationReady;
}
async function getLeaderboard(): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  for await (const e of kv.list<Deno.KvU64>({ prefix: ["leaderboard"] })) {
    const name = String(e.key[1]);
    const statKey = String(e.key[2]);
    out[name] = out[name] || {};
    out[name][statKey] = Number(e.value.value);
  }
  return out;
}
async function leaderboardEntryExists(name: string): Promise<boolean> {
  for await (const _e of kv.list({ prefix: ["leaderboard", name] }, { limit: 1 })) return true;
  return false;
}
async function deleteLeaderboardEntry(name: string) {
  for await (const e of kv.list({ prefix: ["leaderboard", name] })) await kv.delete(e.key);
}

/* ---------------------------------------------------------------------------------------
 * § LEADERBOARD EPOCH — v0.13, mirrors server.js's matching section (see that file for the
 * full "new season" rationale). One KV key holds the current epoch; starts at 1 if never set.
 * ------------------------------------------------------------------------------------- */
const EPOCH_KEY: Deno.KvKey = ["leaderboardEpoch"];
async function getEpoch(): Promise<number> {
  const e = await kv.get<number>(EPOCH_KEY);
  return typeof e.value === "number" ? e.value : 1;
}
async function resetLeaderboard(): Promise<number> {
  for await (const e of kv.list({ prefix: ["leaderboard"] })) await kv.delete(e.key);
  const epoch = (await getEpoch()) + 1;
  await kv.set(EPOCH_KEY, epoch);
  return epoch;
}
// Sent with EVERY response that touches the leaderboard - public /leaderboard reads, the
// admin equivalent, and every /solo-result reply - so any device that talks to the server for
// ANY of those reasons picks up a reset promptly. Header, not body shape, so old clients that
// don't know about epochs are completely unaffected (see server.js's matching comment).
async function jsonLeaderboard(status: number): Promise<Response> {
  const [board, epoch] = await Promise.all([getLeaderboard(), getEpoch()]);
  return new Response(JSON.stringify(board), {
    status,
    headers: { "content-type": "application/json", "x-leaderboard-epoch": String(epoch), ...CORS_HEADERS },
  });
}

/* ---------------------------------------------------------------------------------------
 * § SOLO RESULTS — v0.13, mirrors server.js's matching section (see that file for the full
 * design rationale). Solo (vs-CPU) and pass-and-play OFFLINE games have no room to ride
 * recordResult through, so this is an unauthenticated HTTP POST sibling (POST /solo-result)
 * with its own idempotency + rate limit. Idempotency is even simpler here than server.js's
 * on-disk Map: KV entries carry a native TTL, so a seen gameId just expires on its own after
 * SOLO_ID_TTL_MS with no manual pruning loop needed.
 * ------------------------------------------------------------------------------------- */
const SOLO_ID_TTL_MS = 180 * 24 * 60 * 60 * 1000; // plenty to catch any realistic retry/replay
function soloSeenKey(gameId: string): Deno.KvKey { return ["soloseen", gameId]; }
const SOLO_RATE_LIMIT = 20;             // max solo-result submits...
const SOLO_RATE_WINDOW_MS = 60 * 1000;  // ...per IP, per rolling minute
const soloRateMap = new Map<string, number[]>();
function underSoloRateLimit(ip: string): boolean {
  const now = Date.now();
  const kept = (soloRateMap.get(ip) || []).filter((t) => now - t < SOLO_RATE_WINDOW_MS);
  if (kept.length >= SOLO_RATE_LIMIT) { soloRateMap.set(ip, kept); return false; }
  kept.push(now);
  soloRateMap.set(ip, kept);
  return true;
}
async function handleSoloResult(req: Request, ip: string): Promise<Response> {
  if (!underSoloRateLimit(ip)) return json(429, { error: "slow down", epoch: await getEpoch() });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const gameId = typeof (body as Record<string, unknown>).gameId === "string"
    ? ((body as Record<string, unknown>).gameId as string).trim().slice(0, 64) : "";
  if (!gameId) return json(400, { error: "missing gameId", epoch: await getEpoch() });
  const existing = await kv.get(soloSeenKey(gameId));
  const epoch = await getEpoch();
  if (existing.value) return json(200, { ok: true, duplicate: true, epoch });
  // v0.13: reject a result recorded under an OLDER season (see "§ LEADERBOARD EPOCH" above) —
  // the board's been reset since this game finished, so applying it would resurrect
  // pre-reset numbers. Still mark the gameId seen so a client that keeps retrying doesn't loop.
  // A MISSING epoch (client has never talked to the server before, see index.html's
  // getKnownLocalEpoch()) is treated as "always current" — never rejected — rather than
  // assumed-stale; a bug in an earlier version of this code defaulted a missing epoch to 1,
  // which wrongly rejected every brand-new device's very first solo win after any reset had
  // ever happened (caught by this session's own live production smoke test).
  const rawEpoch = (body as Record<string, unknown>).epoch;
  const reqEpoch = typeof rawEpoch === "number" && Number.isFinite(rawEpoch) ? rawEpoch : null;
  if (reqEpoch !== null && reqEpoch < epoch) {
    await kv.set(soloSeenKey(gameId), true, { expireIn: SOLO_ID_TTL_MS });
    log("solo result rejected (stale epoch)", gameId, "req=" + reqEpoch, "current=" + epoch);
    return json(409, { error: "stale epoch", epoch });
  }
  const rawEntries = (body as Record<string, unknown>).entries;
  const entries = Array.isArray(rawEntries) ? (rawEntries as Record<string, unknown>[]).slice(0, 6) : [];
  for (const e of entries) { if (e && e.name) await applyLeaderboardEntry(e.name, e.delta); }
  await kv.set(soloSeenKey(gameId), true, { expireIn: SOLO_ID_TTL_MS });
  log("solo result recorded", gameId, entries.map((e) => e && (e.name as string)).filter(Boolean).join(","));
  return json(200, { ok: true, epoch });
}

/* ---------------------------------------------------------------------------------------
 * § ROOMS — KV-backed room state, see file header points 1-2.
 * ------------------------------------------------------------------------------------- */
type Seat = { name: string; type: "human" | "cpu"; diff: string; claimedBy: number | null };
type Player = {
  id: number; token: string; name: string; isHost: boolean; connected: boolean; leftForGood?: boolean;
  // v0.16 item 5: a registered APNs device token, tied to this SAME player identity a rejoin
  // token/reclaim-by-name already key off - see maybeSendTurnPush() below.
  pushToken?: string | null; pushPlatform?: string | null;
};
type RoomMeta = {
  code: string; createdAt: number; lastActivity: number;
  hostPlayerId: number | null; nextPlayerId: number;
  players: Player[];
  lobby: { n: number; teams: boolean; seats: Seat[] } | null;
  started: boolean; seatOwners: (number | null)[] | null;
  // v0.25 item 1: twin of server.js's room.ready - lobby-phase readiness (guests who tapped
  // "Ready up" on the seat screen; the host never appears here - their Start IS their ready).
  // The v0.16-v0.24 readyCheck phase field is gone. Optional for old persisted metas.
  ready?: number[];
  // Legacy (pre-v0.25) field kept optional purely so an old persisted meta still parses.
  readyCheck?: { requiredPlayerIds: number[]; readyPlayerIds: number[] } | null;
  paused: boolean; logCount: number;
  // v0.15 authoritative fields (twin of server.js's room object additions):
  G: unknown | null;        // full serialized authoritative game state snapshot
  tableSpeed: number;       // shared table pacing, host-controlled
  recorded: boolean;        // leaderboard idempotency flag - see finishGame()
  nextSeq: number;          // monotonic broadcast action seq (logCount's successor concept)
};

function roomKey(code: string): Deno.KvKey { return ["room", code]; }
function logKey(code: string, seq: number): Deno.KvKey { return ["roomlog", code, seq]; }
function ttlFor(meta: RoomMeta) { return meta.started ? STARTED_ROOM_TTL_MS : ROOM_TTL_MS; }

async function newUniqueCode(): Promise<string> {
  let code: string;
  do {
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    code = Array.from(buf, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  } while ((await kv.get(roomKey(code))).value);
  return code;
}
function newToken(): string {
  const buf = new Uint8Array(9);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Optimistic-concurrency read/mutate/commit, retried on contention (two isolates touching
// the same room at once). `mutate(meta)` mutates `meta` in place and returns either:
//   - `false`  -> abort, nothing is written, touchRoom resolves {ok:false}
//   - an object (possibly {}) -> commit; if it has {logKey,logValue}, that log entry is
//     written in the SAME atomic transaction (used for appending an action/log entry).
async function touchRoom(
  code: string,
  mutate: (meta: RoomMeta) => false | { logKey?: Deno.KvKey; logValue?: unknown; [k: string]: unknown },
): Promise<{ ok: true; meta: RoomMeta; extra: Record<string, unknown> } | { ok: false; reason: string }> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await kv.get<RoomMeta>(roomKey(code));
    if (!cur.value) return { ok: false, reason: "no-room" };
    const meta = cur.value;
    const result = mutate(meta);
    if (result === false) return { ok: false, reason: "aborted" };
    meta.lastActivity = Date.now();
    const atomic = kv.atomic().check(cur).set(roomKey(code), meta, { expireIn: ttlFor(meta) });
    if (result.logKey) atomic.set(result.logKey, result.logValue, { expireIn: LOG_TTL_MS });
    const commit = await atomic.commit();
    if (commit.ok) return { ok: true, meta, extra: result as Record<string, unknown> };
    // else: lost the race, reread and retry
  }
  return { ok: false, reason: "contention" };
}

// v0.15: getRoomLog() (the whole-log fetch for replay-based reconnect) is GONE — reconnect is
// snapshot-based now (gameSnapshotFields/RoomMeta.G), so no per-action KV log entries are
// written anymore either. The ["roomlog", code, seq] keyspace and logKey() remain only so
// admin room deletion still sweeps any PRE-v0.15 room's leftover log entries.

function lobbySnapshot(meta: RoomMeta) {
  if (!meta.lobby) return null;
  const snap = JSON.parse(JSON.stringify(meta.lobby));
  snap.hostSeatIndex = snap.seats.findIndex((s: Seat) => s.claimedBy === meta.hostPlayerId);
  // v0.25 item 1: readiness rides every lobby snapshot - twin of server.js.
  snap.readyPlayerIds = Array.from(meta.ready || []);
  return snap;
}
// v0.25 item 1: twin of server.js's guestsAllReady() - the single source of "can Start proceed."
function guestsAllReady(meta: RoomMeta): boolean {
  if (!meta.lobby) return false;
  const ready = meta.ready || [];
  return meta.lobby.seats.every((s) => s.claimedBy == null || s.claimedBy === meta.hostPlayerId || ready.includes(s.claimedBy));
}
function presenceSnapshot(meta: RoomMeta) {
  const out: Record<number, boolean> = {};
  for (const p of meta.players) out[p.id] = !!p.connected;
  return out;
}

/* ---------------------------------------------------------------------------------------
 * v0.15 § AUTHORITATIVE GAME — twin of server.js's § AUTHORITATIVE TURN LOOP, adapted to KV.
 * See this file's header for the storage strategy. The engine instance for an active room
 * lives in this isolate's memory (fast, synchronous mutations exactly like Node's loop);
 * every commit persists the resulting `G` snapshot + nextSeq into RoomMeta so a cold start /
 * isolate recycle / restart restores the game exactly (getEngine() re-hydrates from meta.G).
 * ------------------------------------------------------------------------------------- */
const engines = new Map<string, any>();
function getEngine(code: string, meta: RoomMeta): any | null {
  let e = engines.get(code);
  if (e) return e;
  if (!meta.G) return null;
  e = createEngine();
  e.setLAY(e.buildLayout((meta.G as { n: number }).n));
  e.setG(meta.G);
  engines.set(code, e);
  return e;
}
function dropEngine(code: string) { engines.delete(code); }

// Per-room mutation serializer — see this file's header. Game mutations for one room must not
// interleave (two players' near-simultaneous messages), even though different connections'
// msgChains run independently. Chain is dropped from the map once it settles and nothing else
// queued behind it, so the map can't grow unbounded.
const roomChains = new Map<string, Promise<void>>();
function withRoomChain(code: string, fn: () => Promise<void>): Promise<void> {
  const prev = roomChains.get(code) || Promise.resolve();
  const next = prev.then(fn, fn);
  roomChains.set(code, next);
  next.finally(() => { if (roomChains.get(code) === next) roomChains.delete(code); });
  return next;
}

/* Digest — byte-identical algorithm to server.js's gDigestServer() and index.html's gDigest().
   If it ever changes, change all THREE copies together (documented in HANDOFF.md v0.15). */
function gDigestServer(G: any): string {
  const parts: unknown[] = [G.turn, G.dealer, G.schedRound, G.over ? 1 : 0];
  for (let s = 0; s < G.n; s++) {
    parts.push(G.hands[s].length, G.bowedOut[s] ? 1 : 0);
    for (const p of G.pieces[s]) parts.push(p.state[0], p.steps);
  }
  parts.push(G.deck.length, G.discard.length);
  const str = parts.join(",");
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

function sameMove(legal: any, submitted: any): boolean {
  if (!legal || !submitted) return false;
  if (legal.ci !== submitted.ci || legal.type !== submitted.type || legal.owner !== submitted.owner) return false;
  if (legal.type === "swap") return legal.ts === submitted.ts && legal.tpi === submitted.tpi;
  if (legal.pi !== submitted.pi || legal.to !== submitted.to) return false;
  const a = legal.kick, b = submitted.kick;
  if (!!a !== !!b) return false;
  if (a && (a.seat !== b.seat || a.pi !== b.pi)) return false;
  return true;
}

/* v0.15 § SERVER-SIDE WIN RECORDING — twin of server.js's finishGame(): the server records an
   ONLINE game's result itself the instant its own applyMove() sees G.over flip. Same stat-key
   shape + points formula as index.html's buildResultEntries()/pointsForWin() (hand-ported —
   pure game-result arithmetic, keep all copies in sync if the formula changes). Uses this
   file's existing KvU64 atomic counters via applyLeaderboardEntry(). Idempotency: the caller
   sets meta.recorded=true in the SAME touchRoom commit as the winning action, and checks it
   before calling — survives restarts via KV, a duplicate call can never double-count. */
const DIFF_POINTS: Record<string, number> = { easy: 1, medium: 2, hard: 3 };
function pointsForWinServer(G: any, winSet: Set<number>): number {
  let pts = 0;
  G.seats.forEach((opp: any, j: number) => { if (winSet.has(j)) return; pts += opp.type === "human" ? 3 : (DIFF_POINTS[opp.diff] || 0); });
  return pts;
}
function buildResultEntriesServer(G: any): { name: string; delta: Record<string, number> }[] {
  const mode = (G.n === 4 ? "4" : "6") + (G.teams ? "t" : "s");
  const isTeam = mode.endsWith("t");
  const winSet = new Set<number>(G.winners);
  const entries: { name: string; delta: Record<string, number> }[] = [];
  G.seats.forEach((seat: any, i: number) => {
    if (seat.type !== "human") return;
    const delta: Record<string, number> = {}; delta["hg" + mode] = 1;
    if (winSet.has(i)) { delta["hw" + mode] = 1; delta[isTeam ? "hptsT" : "hptsS"] = pointsForWinServer(G, winSet); }
    entries.push({ name: seat.name, delta });
  });
  return entries;
}
async function recordFinishedGame(code: string, G: any) {
  const entries = buildResultEntriesServer(G);
  for (const e of entries) await applyLeaderboardEntry(e.name, e.delta);
  log("online game finished, recorded to global leaderboard", code,
    entries.map((e) => e.name).join(",") || "(no human seats)");
}

type Broadcastable = { payload: unknown };
/* The authoritative loop itself — mirrors server.js's driveTurnLoop() logic EXACTLY (compare
   the two side by side when changing either; the game-flow decisions must never drift). Runs
   synchronously against the in-memory engine, COLLECTING broadcasts (gameAction + stateCheck,
   in exact order) instead of sending them immediately — the caller persists the resulting G
   to KV first, then sends the collected messages, so a client can never observe an action the
   server could still lose to a crash-before-persist. Returns {actions, finished}. */
const TURN_LOOP_GUARD = 200000;
function driveTurnLoopCollect(E: any, meta: RoomMeta): { out: Broadcastable[]; finished: boolean } {
  const out: Broadcastable[] = [];
  const append = (action: Record<string, unknown>) => {
    const seq = meta.nextSeq++;
    meta.logCount = meta.nextSeq; // kept in step for any legacy reader of logCount
    out.push({ payload: { type: "gameAction", seq, action } });
    return seq;
  };
  const stateCheck = (afterSeq: number) => {
    out.push({ payload: { type: "stateCheck", afterSeq, digest: gDigestServer(E.getG()) } });
  };
  for (let guard = 0; guard < TURN_LOOP_GUARD; guard++) {
    const G = E.getG();
    if (!G || G.over) return { out, finished: !!(G && G.over) };
    if (E.handOver()) {
      for (let s = 0; s < G.n; s++) { if (G.hands[s].length) { G.discard.push(...G.hands[s]); G.hands[s].length = 0; } }
      let seed: Record<string, unknown> = {};
      if (E.needsReshuffle()) seed = { deck: E.freshDeck(), dealer: (G.dealer + 1) % G.n };
      const r = E.dealDecision(seed);
      const seq = append({ kind: "deal", dealer: r.dealer, reshuffled: r.reshuffled, k: r.k, hands: r.hands, deckCount: r.deckCount, turn: E.getG().turn });
      stateCheck(seq);
      continue;
    }
    const seat = G.turn;
    if (G.hands[seat].length === 0) {
      E.advanceTurn();
      append({ kind: "pass", seat, newlyBowedOut: false, threwIn: false, passStreak: G.passStreak, emptyHand: true, turn: E.getG().turn });
      continue;
    }
    if (G.bowedOut[seat]) {
      const r = E.passDecision(seat, false);
      E.advanceTurn();
      append({ kind: "pass", seat, newlyBowedOut: false, threwIn: r.threwIn, passStreak: r.passStreak, turn: E.getG().turn });
      continue;
    }
    const moves = E.legalMoves(seat);
    if (moves.length === 0) {
      const r = E.passDecision(seat, true);
      E.advanceTurn();
      append({ kind: "pass", seat, newlyBowedOut: true, threwIn: r.threwIn, passStreak: r.passStreak, turn: E.getG().turn });
      continue;
    }
    if (G.seats[seat].type === "cpu") {
      const m = E.chooseAI(seat, moves);
      E.applyMove(seat, m);
      if (E.getG().over) { append({ kind: "move", seat, m, turn: G.turn }); return { out, finished: true }; }
      E.advanceTurn();
      const seq = append({ kind: "move", seat, m, turn: E.getG().turn });
      // Digest computed AFTER advanceTurn(), tagged with the broadcast seq — both halves of the
      // v0.15 digest-checkpoint fix, see server.js's matching comments (bug #3/#4 in HANDOFF).
      if (m.kick || m.type === "swap") stateCheck(seq);
      continue;
    }
    // Human seat with a legal move: stop and wait for their validated `action` message.
    return { out, finished: false };
  }
  log("driveTurnLoopCollect guard tripped (possible infinite loop)", meta.code);
  return { out, finished: false };
}

/* Persist the engine's current G into the room meta and send the collected broadcasts. The
   single choke point every game mutation (start + human action) funnels through. */
async function commitAndBroadcast(code: string, E: any, out: Broadcastable[], finished: boolean): Promise<boolean> {
  const G = E.getG();
  const r = await touchRoom(code, (meta) => {
    meta.G = G;
    // nextSeq was already advanced on the in-memory meta object the loop ran against, but a
    // touchRoom contention retry rereads a FRESH meta from KV — recompute from the collected
    // payload seqs so a retry still lands on the right value instead of an earlier one.
    meta.nextSeq = Math.max(meta.nextSeq || 0, 0);
    for (const b of out) {
      const p = b.payload as { type?: string; seq?: number };
      if (p.type === "gameAction" && typeof p.seq === "number" && p.seq >= meta.nextSeq) meta.nextSeq = p.seq + 1;
    }
    meta.logCount = meta.nextSeq;
    let needRecord = false;
    if (finished && !meta.recorded) { meta.recorded = true; needRecord = true; }
    return { needRecord };
  });
  if (!r.ok) { log("commitAndBroadcast failed", code, (r as { reason: string }).reason); return false; }
  for (const b of out) broadcastRoom(code, b.payload);
  if (r.extra.needRecord) await recordFinishedGame(code, G); // idempotent — flag committed above
  return true;
}

/* ---------------------------------------------------------------------------------------
 * v0.16 item 5 § PUSH — twin of server.js's maybeSendTurnPush(). "It's your turn in NASTY."
 * Fires exactly once per genuine turn-start event: this is only ever CALLED (from the three
 * call sites below, always right after a successful commitAndBroadcast()) after a real
 * mutation, and driveTurnLoopCollect() only reaches its "stop, waiting on a human" return
 * point fresh on each such call - no extra dedupe bookkeeping needed. Fire-and-forget (never
 * awaited by its callers) - a push failure/misconfiguration must never slow down or affect
 * anyone's turn. See server/cloud/apns.ts for the no-op-until-key-exists design.
 * ------------------------------------------------------------------------------------- */
async function maybeSendTurnPush(code: string, E: any, finished: boolean): Promise<void> {
  if (finished) return; // game over - nobody's turn is pending
  const G = E.getG();
  if (!G) return;
  const seat = G.turn;
  if (!G.seats[seat] || G.seats[seat].type !== "human") return; // defensive - the loop only stops here for a human seat
  const cur = await kv.get<RoomMeta>(roomKey(code));
  if (!cur.value || !cur.value.seatOwners) return;
  const ownerId = cur.value.seatOwners[seat];
  if (ownerId == null) return;
  const player = cur.value.players.find((p) => p.id === ownerId);
  // v0.22: was `player.connected` alone - now the shared away test (twin of server.js), so a
  // silent zombie socket also counts as "not right there" and still gets buzzed.
  if (!player || !playerLooksAway(code, player)) return;   // they're right there - no need to buzz their phone
  if (!player.pushToken) {
    // v0.25 item 3: twin of server.js - the tokenless case was the field failure's hiding
    // place; log it so a "no push arrived" report is diagnosable from the deploy logs alone.
    log("turn push skipped - no token registered", code, "playerId=" + ownerId, "name=" + player.name);
    return;
  }
  await sendTurnPush({
    token: player.pushToken, playerName: G.seats[seat].name,
    title: "NASTY", body: "It's your turn in NASTY",
  });
}

/* ---------------------------------------------------------------------------------------
 * v0.25 item 1 § LOBBY READINESS - twin of server.js's design: readiness is collected ON THE
 * SEAT SCREEN (a guest's "Ready up" locks their seat in); the host's Start tap is their own
 * ready. The v0.16-v0.24 post-Start readyCheck phase is gone. actuallyStartGame() is now
 * triggered directly from the "start" case once guestsAllReady() holds.
 * ------------------------------------------------------------------------------------- */
async function actuallyStartGame(code: string, pre: RoomMeta): Promise<void> {
  if (!pre.lobby) return;
  const lobby = pre.lobby;
  const n = lobby.n === 6 ? 6 : 4;
  const seatsCfg = lobby.seats.map((s) => ({ name: s.name, diff: s.diff || "medium", type: s.claimedBy != null ? "human" : "cpu" }));
  const engine = createEngine();
  engine.setLAY(engine.buildLayout(n));
  engine.newGame({ n, teams: !!lobby.teams, seats: seatsCfg }, { deck: engine.freshDeck(), dealer: Math.floor(Math.random() * n) });
  engines.set(code, engine);
  const G = engine.getG();
  const startAction = { kind: "start", n: G.n, teams: G.teams, seats: seatsCfg, dealer: G.dealer, deck: [], tableSpeed: pre.tableSpeed || 1 };
  const r = await touchRoom(code, (meta) => {
    if (meta.started || !meta.lobby) return false;
    meta.started = true;
    meta.ready = [];   // v0.25 item 1: lobby readiness is consumed by the start
    meta.seatOwners = meta.lobby.seats.map((s) => s.claimedBy);
    meta.G = G;
    meta.recorded = false;
    meta.nextSeq = 1;   // 'start' is broadcast seq 0
    meta.logCount = 1;
    return { seatOwners: meta.seatOwners };
  });
  if (!r.ok) { dropEngine(code); return; }
  broadcastRoom(code, { type: "gameAction", seq: 0, action: startAction, seatOwners: r.meta.seatOwners });
  log("room started", code, `n=${n}`, lobby.teams ? "teams" : "ffa");
  // v0.22 P0b § SEAT GATE: only players who PROMISED a 'seated' signal (new clients) are ever
  // waited for; a table of old clients (empty set) deals immediately, exactly as before. A
  // promiser who has ALREADY disconnected again (their close ran before this gate existed)
  // is skipped up front - their overlays are moot and their close can't release them anymore.
  const seatOwnersNow = r.meta.seatOwners || [];
  const waiting = new Set(Array.from(willSeatMap.get(code) || []).filter((id) =>
    seatOwnersNow.includes(id) && !!(r.meta.players.find((p) => p.id === id) || {}).connected));
  willSeatMap.delete(code);
  if (waiting.size === 0) {
    // Drive the opening stretch (first deal + any leading CPU turns) immediately.
    const metaForLoop = r.meta; // nextSeq=1, the loop advances it as it appends
    const { out, finished } = driveTurnLoopCollect(engine, metaForLoop);
    const ok = await commitAndBroadcast(code, engine, out, finished);
    if (ok) maybeSendTurnPush(code, engine, finished).catch((e) => log("push check failed", code, (e as Error).message));
    return;
  }
  const timer = setTimeout(() => {
    if (!seatGates.has(code)) return;
    seatGates.delete(code);
    log("seat gate cap expired - dealing anyway", code);
    withRoomChain(code, () => releaseFirstDeal(code)).catch((e) => log("seat gate cap release failed", code, (e as Error).message));
  }, SEAT_GATE_CAP_MS);
  seatGates.set(code, { waiting, timer });
  log("holding the first deal until everyone is seated", code, "waiting=" + waiting.size);
}

// v0.15 snapshot fields for sync/reclaimed — twin of server.js's gameSnapshotFields().
function gameSnapshotFields(meta: RoomMeta, isHost: boolean) {
  const hostP = meta.players.find((p) => p.id === meta.hostPlayerId);
  return {
    G: meta.G,
    appliedSeq: (meta.nextSeq || 1) - 1,
    isHost,
    hostConnected: !!(hostP && hostP.connected),
    paused: !!meta.paused,
    presence: presenceSnapshot(meta),
    tableSpeed: meta.tableSpeed || 1,
    protocolVersion: PROTOCOL_VERSION,
  };
}

/* ---------------------------------------------------------------------------------------
 * § RELAY — cross-isolate fanout via BroadcastChannel, see file header point 3.
 * `localSockets`: code -> playerId -> WebSocket, only the sockets THIS isolate is holding.
 * `channels`: code -> BroadcastChannel, one per room this isolate currently cares about.
 * ------------------------------------------------------------------------------------- */
const localSockets = new Map<string, Map<number, WebSocket>>();
const channels = new Map<string, BroadcastChannel>();
// v0.16: last time ANY message arrived on a given socket — the proof-of-life clock the §
// HEARTBEAT loop below uses to find and close half-dead sockets (see that section for why this
// platform needs an app-level substitute for real WS-frame ping/pong). WeakMap so a closed
// socket's entry is GC'd on its own, no explicit cleanup needed alongside unregisterLocalSocket.
const socketLastSeen = new WeakMap<WebSocket, number>();

function send(ws: WebSocket | null | undefined, obj: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (_e) { /* ignore */ }
  }
}
type Envelope = { payload?: unknown; exceptPlayerId?: number | null; to?: number; control?: "close" };
function deliverLocal(code: string, msg: Envelope) {
  const socks = localSockets.get(code);
  if (!socks) return;
  if (msg.control === "close") {
    for (const ws of socks.values()) { try { ws.close(); } catch (_e) { /* ignore */ } }
    localSockets.delete(code);
    return;
  }
  for (const [pid, ws] of socks) {
    if (msg.to != null && msg.to !== pid) continue;
    if (msg.exceptPlayerId != null && msg.exceptPlayerId === pid) continue;
    send(ws, msg.payload);
  }
}
// BroadcastChannel guard (new-platform adaptation, 2026-07-11): the classic Deno Deploy docs
// explicitly documented BroadcastChannel as the cross-isolate fanout primitive this code was
// originally written against; the NEW platform's docs don't mention it at all (that page is
// tagged classic-only, sunsetting 2026-07-20). It may still work, may be a same-instance no-op,
// or may throw — untested by Deno for the new platform, so treat it as optional. If it's
// unavailable/misbehaves, every getChannel()/postMessage() call below degrades to a silent
// no-op instead of crashing the process; relay then falls back to "this isolate's own local
// sockets only" (deliverLocal), which is exactly correct whenever there's a single running
// instance — the common case for this app's traffic — and merely misses cross-instance
// delivery (not a crash, not data loss; KV stays the source of truth and rejoin/sync replays
// the log) in the rare case multiple instances are up AND BroadcastChannel doesn't relay.
let bcWarned = false;
function warnBcOnce(e: unknown) {
  if (bcWarned) return;
  bcWarned = true;
  log("BroadcastChannel unavailable/failed on this platform — falling back to " +
    "single-instance-only relay for cross-isolate delivery:", e);
}
function getChannel(code: string): BroadcastChannel | null {
  const existing = channels.get(code);
  if (existing) return existing;
  try {
    const ch = new BroadcastChannel("nasty-room-" + code);
    ch.onmessage = (ev) => deliverLocal(code, ev.data as Envelope);
    channels.set(code, ch);
    return ch;
  } catch (e) {
    warnBcOnce(e);
    return null;
  }
}
function postToChannel(code: string, msg: unknown) {
  const ch = getChannel(code);
  if (!ch) return;
  try { ch.postMessage(msg); } catch (e) { warnBcOnce(e); }
}
function closeChannel(code: string) {
  const ch = channels.get(code);
  if (ch) { try { ch.close(); } catch (_e) { /* ignore */ } channels.delete(code); }
}
function broadcastRoom(code: string, payload: unknown, exceptPlayerId?: number | null) {
  const envelope: Envelope = { payload, exceptPlayerId: exceptPlayerId ?? null };
  deliverLocal(code, envelope); // this isolate's own local sockets (BroadcastChannel doesn't loop back to self)
  postToChannel(code, envelope); // every other isolate's local sockets, if BroadcastChannel works here
}
function sendToPlayer(code: string, playerId: number, payload: unknown) {
  const envelope: Envelope = { payload, to: playerId };
  deliverLocal(code, envelope);
  postToChannel(code, envelope);
}
function forceCloseRoomSockets(code: string) {
  deliverLocal(code, { control: "close" });
  postToChannel(code, { control: "close" });
  closeChannel(code);
}
function registerLocalSocket(code: string, playerId: number, ws: WebSocket) {
  let m = localSockets.get(code);
  if (!m) { m = new Map(); localSockets.set(code, m); }
  m.set(playerId, ws);
  getChannel(code); // ensure subscribed even before this player's first broadcast
}
function unregisterLocalSocket(code: string, playerId: number) {
  const m = localSockets.get(code);
  if (!m) return;
  m.delete(playerId);
  if (m.size === 0) { localSockets.delete(code); closeChannel(code); }
}

/* ---------------------------------------------------------------------------------------
 * § RATE LIMIT — in-memory per-isolate, same generous policy as server.js. Deploy note: an
 * isolate can restart and forget counters, which only makes the limit MORE generous, never
 * less — acceptable per HANDOFF.md's cloud migration notes.
 * ------------------------------------------------------------------------------------- */
function remoteIp(req: Request, info?: Deno.ServeHandlerInfo): string {
  const h = req.headers;
  const raw = h.get("cf-connecting-ip") || h.get("x-forwarded-for") ||
    (info && (info.remoteAddr as Deno.NetAddr).hostname) || "unknown";
  return String(raw).split(",")[0].trim();
}
const HOST_RATE_LIMIT = 5;
const HOST_RATE_WINDOW_MS = 60 * 1000;
const hostRateMap = new Map<string, number[]>();
function underHostRateLimit(ip: string): boolean {
  const now = Date.now();
  const kept = (hostRateMap.get(ip) || []).filter((t) => now - t < HOST_RATE_WINDOW_MS);
  if (kept.length >= HOST_RATE_LIMIT) { hostRateMap.set(ip, kept); return false; }
  kept.push(now);
  hostRateMap.set(ip, kept);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hostRateMap) {
    const kept = arr.filter((t) => now - t < HOST_RATE_WINDOW_MS);
    if (kept.length) hostRateMap.set(ip, kept); else hostRateMap.delete(ip);
  }
}, HOST_RATE_WINDOW_MS);

/* ---------------------------------------------------------------------------------------
 * § HEARTBEAT — new-platform adaptation, 2026-07-11; extended v0.16 to also detect and clean
 * up half-dead client sockets. The new Deno Deploy platform tears an instance down after "no
 * new incoming requests ... or responses ... for a period of time" as short as 5 SECONDS in
 * the worst case (docs: "between 5 seconds and 10 minutes"), but explicitly says WebSocket
 * connections that actively transmit data — including ping/pong frames — count as activity
 * and keep the instance (and the socket) alive. Real games have long idle gaps (someone's
 * deciding a move, a phone's just sitting on the board), so without this, a family member who
 * steps away for a couple minutes could come back to a silently dropped connection.
 *
 * v0.16: this loop now sends 'ping' (not an unsolicited 'pong') and expects every live client
 * to echo it straight back as 'pong' — see the client's own `case 'ping'` in handleNetMessage,
 * index.html § NET. This platform's native `WebSocket` (from Deno.upgradeWebSocket) has no
 * `.ping()`/'pong'-event pair the way server.js's Node `ws` library does (see that file's
 * HEARTBEAT/isAlive/terminate()), so there's no protocol-frame-level way to detect a socket
 * that reports OPEN but is actually dead (the exact real-device failure mode this whole v0.16
 * pass exists to catch — see HANDOFF.md's "reconnect glitch" writeup). This app-level
 * ping/pong round trip is the substitute: `socketLastSeen` (set on every inbound message, see
 * `socket.onmessage` above) is checked before each ping; a socket that's gone SOCKET_STALE_MS
 * without producing so much as one reply gets force-closed here, same spirit as server.js's
 * `ws.terminate()` — this doesn't wait for the room's own rejoin flow to notice, it proactively
 * frees the seat's connection slot so presence/hostConnected broadcasts stay accurate for
 * everyone else at the table, and so a genuine reconnect from that same player isn't fighting
 * a socket the server itself still thinks is fine. (Old/unmodified pre-v0.16 clients silently
 * ignored an unsolicited 'pong' with no reply — this coupled client+server change is safe
 * exactly because index.html and server.ts always deploy together, HANDOFF's standing rule.)
 * ------------------------------------------------------------------------------------- */
const HEARTBEAT_MS = 4000;
const SOCKET_STALE_MS = HEARTBEAT_MS * 3;   // ~1 missed reply is tolerated, 2 in a row is not -
                                             // proportionally similar margin to server.js's own
                                             // 2-missed-30s-pings-before-terminate pattern.
setInterval(() => {
  const now = Date.now();
  for (const socks of localSockets.values()) {
    for (const ws of socks.values()) {
      const lastSeen = socketLastSeen.get(ws) ?? now;
      if (now - lastSeen > SOCKET_STALE_MS) {
        // Half-dead: readyState may still read OPEN (this platform has no lower-level signal
        // to check), but nothing — not even an app-level pong — has come back in a while.
        // Force it closed; onclose (below) does the normal disconnect cleanup from there, and
        // a real reconnect from this player just registers a fresh socket over it.
        try { ws.close(); } catch (_e) { /* ignore */ }
        continue;
      }
      send(ws, { type: "ping", t: now });
    }
  }
  // v0.10.3: a contested reclaim (see PendingReclaim above) the host never answered — tell the
  // requester instead of leaving them hanging forever.
  for (const [reqId, pending] of pendingReclaims) {
    if (now > pending.expires) {
      pendingReclaims.delete(reqId);
      send(pending.socket, { type: "reclaimError", message: "The host didn't respond in time - try again." });
    }
  }
}, HEARTBEAT_MS);

/* ---------------------------------------------------------------------------------------
 * v0.22 § AWAY LADDER - twin of server.js's matching block, keep the two in sync. While the
 * on-turn HUMAN's socket is disconnected (or app-level silent - socketLastSeen), escalate:
 * AWAY_NUDGE_MS -> turn push (no-op until the APNs key lands) + {awayStatus stage:'nudged'};
 * AWAY_CPU_OFFER_MS -> {awayStatus stage:'cpuOffer'} (one-tap server-played single turn via
 * 'playTurnForAway', any player, no vote - seat STAYS human); target back / turn moved on /
 * room paused -> {awayStatus stage:'clear'}. Additive messages old builds 16-28 ignore. No
 * automatic forfeits, no automatic CPU conversion. State is isolate-local + transient on
 * purpose (an isolate recycle just restarts the clock) - same single-instance-in-practice
 * reasoning as § RELAY. The sweep is gated on kvReady so it can never run during the
 * platform's build-time module evaluation (see ensureKv()'s load-bearing comment).
 * ------------------------------------------------------------------------------------- */
function envInt(name: string, dflt: number): number {
  const v = Number(Deno.env.get(name));
  return Number.isFinite(v) && v > 0 ? v : dflt;
}
const AWAY_NUDGE_MS = envInt("NASTY_AWAY_NUDGE_MS", 30 * 1000);
const AWAY_CPU_OFFER_MS = envInt("NASTY_AWAY_CPU_MS", 150 * 1000);
const AWAY_SILENT_MS = envInt("NASTY_AWAY_SILENT_MS", 60 * 1000);
const AWAY_SWEEP_MS = envInt("NASTY_AWAY_SWEEP_MS", Math.min(5000, Math.max(500, Math.floor(AWAY_NUDGE_MS / 3))));
const AWAY_REPUSH_MIN_MS = 25 * 1000;
type AwayState = { seat: number; since: number; nudgeSent: boolean; offerSent: boolean; announced: boolean; lastPushAt: number };
const awayStates = new Map<string, AwayState>();
function playerLooksAway(code: string, p: Player | undefined): boolean {
  if (!p) return true;
  if (!p.connected) return true;
  const ws = localSockets.get(code)?.get(p.id);
  if (ws && Date.now() - (socketLastSeen.get(ws) ?? Date.now()) > AWAY_SILENT_MS) return true;
  return false;
}
function clearAwayState(code: string) {
  const a = awayStates.get(code);
  if (!a) return;
  if (a.announced) broadcastRoom(code, { type: "awayStatus", stage: "clear", seat: a.seat });
  awayStates.delete(code);
}
async function awaySweep() {
  if (!kvReady) return;   // no request has initialized KV yet - nothing can be in play
  await ensureKv();
  const now = Date.now();
  // Rooms with at least one locally-connected socket are the only ones with anyone to show
  // ladder UI to (single-instance-in-practice, same reasoning as § RELAY).
  for (const code of Array.from(localSockets.keys())) {
    const cur = await kv.get<RoomMeta>(roomKey(code));
    const meta = cur.value;
    let target: { seat: number; name: string } | null = null;
    // v0.22 P0b: a room still holding its first deal has nobody meaningfully "on turn" yet.
    if (meta && meta.started && !meta.paused && meta.seatOwners && !seatGates.has(code)) {
      const E = getEngine(code, meta);
      const G = E ? E.getG() : null;
      if (G && !G.over && G.seats[G.turn] && G.seats[G.turn].type === "human") {
        const seat = G.turn;
        const ownerId = meta.seatOwners[seat];
        if (ownerId != null && playerLooksAway(code, meta.players.find((p) => p.id === ownerId))) {
          target = { seat, name: G.seats[seat].name };
        }
      }
    }
    const a = awayStates.get(code);
    if (!target) { if (a) clearAwayState(code); continue; }
    if (!a || a.seat !== target.seat) {
      awayStates.set(code, { seat: target.seat, since: now, nudgeSent: false, offerSent: false, announced: false, lastPushAt: 0 });
    }
    const st = awayStates.get(code)!;
    if (!st.nudgeSent && now - st.since >= AWAY_NUDGE_MS) {
      st.nudgeSent = true; st.announced = true; st.lastPushAt = now;
      const E = getEngine(code, meta!);
      if (E) maybeSendTurnPush(code, E, false).catch((e) => log("push check failed", code, (e as Error).message));
      broadcastRoom(code, { type: "awayStatus", stage: "nudged", seat: target.seat, name: target.name });
      log("away ladder: nudged stage", code, "seat=" + target.seat);
    }
    if (!st.offerSent && now - st.since >= AWAY_CPU_OFFER_MS) {
      st.offerSent = true; st.announced = true;
      broadcastRoom(code, { type: "awayStatus", stage: "cpuOffer", seat: target.seat, name: target.name });
      log("away ladder: cpuOffer stage", code, "seat=" + target.seat);
    }
  }
}
setInterval(() => { awaySweep().catch((e) => log("away sweep failed", (e as Error).message)); }, AWAY_SWEEP_MS);

/* ---------------------------------------------------------------------------------------
 * v0.22 P0b § SEAT GATE - twin of server.js's matching block, keep in sync. Hold the FIRST
 * deal until every human who PROMISED a 'seated' signal (readyUp with willSeat:true - new
 * clients only) is actually looking at the board; old clients (builds 16-28) never promise
 * and are treated as seated immediately, so their behavior is unchanged. Capped so a broken
 * client can never hold the table hostage; a disconnect releases that slot early. State is
 * isolate-local + transient on purpose - an isolate recycle mid-gate degrades to "deal now"
 * via the 'seated' fallback re-drive (releaseFirstDeal no-ops unless the first deal is
 * genuinely still pending, i.e. nextSeq is still 1).
 * ------------------------------------------------------------------------------------- */
const SEAT_GATE_CAP_MS = envInt("NASTY_SEAT_GATE_CAP_MS", 25 * 1000);
const willSeatMap = new Map<string, Set<number>>();
const seatGates = new Map<string, { waiting: Set<number>; timer: ReturnType<typeof setTimeout> }>();
async function releaseFirstDeal(code: string): Promise<void> {
  // Always called inside withRoomChain(code, ...) - same serialization as every game mutation.
  const cur = await kv.get<RoomMeta>(roomKey(code));
  if (!cur.value || !cur.value.started || cur.value.paused) return;
  const meta = cur.value;
  if (meta.nextSeq !== 1) return;   // the first deal already happened - nothing to release
  const E = getEngine(code, meta);
  if (!E) return;
  const G = E.getG();
  if (!G || G.over) return;
  const { out, finished } = driveTurnLoopCollect(E, meta);
  const ok = await commitAndBroadcast(code, E, out, finished);
  if (ok) maybeSendTurnPush(code, E, finished).catch((e) => log("push check failed", code, (e as Error).message));
}
function releaseSeatGateSlot(code: string, playerId: number, why: string) {
  const gate = seatGates.get(code);
  if (!gate || !gate.waiting.has(playerId)) return;
  gate.waiting.delete(playerId);
  if (gate.waiting.size === 0) {
    clearTimeout(gate.timer);
    seatGates.delete(code);
    log("seat gate cleared - dealing", code, "(" + why + ")");
    withRoomChain(code, () => releaseFirstDeal(code)).catch((e) => log("seat gate release failed", code, (e as Error).message));
  }
}

/* ---------------------------------------------------------------------------------------
 * § HTTP — CORS + /health, /leaderboard, /admin/*. See server.js's CORS_HEADERS comment for
 * why this is needed (bpangman.github.io and the relay are different origins).
 * ------------------------------------------------------------------------------------- */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, x-admin-token",
  "access-control-expose-headers": "x-leaderboard-epoch",
};
function json(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

// v0.14 § UNIVERSAL LINKS — protocol twin of server.js's matching section (see its comment
// for the full rationale). Invite links are now https://play.nastyboardgame.com/join/CODE —
// this is the live production server for that domain, so THIS is the copy that actually
// matters for the AASA file Apple's CDN fetches; server.js's copy exists so local dev/tests
// against the Node server behave identically.
const TEAM_APP_ID = "YJU5U6VX8V.com.pangman.nasty";
const AASA_BODY = JSON.stringify({
  applinks: {
    apps: [],
    details: [{ appID: TEAM_APP_ID, appIDs: [TEAM_APP_ID], paths: ["/join/*"] }],
  },
});
const JOIN_CODE_RE = /^\/join\/([A-Za-z0-9]{1,8})\/?$/;
function joinRedirectHtml(code: string): string {
  const safe = String(code).replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  const dest = `https://nastyboardgame.com/?join=${encodeURIComponent(safe)}`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${dest}">
<title>Joining NASTY…</title></head>
<body style="font-family:sans-serif;background:#0e3421;color:#fff;text-align:center;padding-top:40px">
<p>Taking you to the game…</p>
<script>location.replace(${JSON.stringify(dest)});</script>
</body></html>`;
}

async function handleAdminRoute(req: Request, url: URL): Promise<Response> {
  if (!checkAdminToken(req, url)) return json(401, { error: "unauthorized" });
  const parts = url.pathname.split("/").filter(Boolean); // ["admin", ...]

  if (parts.length === 2 && parts[1] === "rooms" && req.method === "GET") {
    const out = [];
    for await (const e of kv.list<RoomMeta>({ prefix: ["room"] })) {
      const meta = e.value;
      out.push({
        code: meta.code, started: meta.started, playerCount: meta.players.length,
        paused: !!meta.paused,   // v0.22: lets the lifecycle test assert "never paused" server-side
        // v0.25 item 3: `push` - twin of server.js's per-player token diagnostic for the panel.
        players: meta.players.map((p) => ({ id: p.id, name: p.name, isHost: p.isHost, connected: !!p.connected, push: !!p.pushToken })),
      });
    }
    return json(200, out);
  }
  if (parts.length === 3 && parts[1] === "rooms" && req.method === "DELETE") {
    const code = parts[2].toUpperCase();
    const cur = await kv.get<RoomMeta>(roomKey(code));
    if (cur.value) {
      forceCloseRoomSockets(code);
      dropEngine(code); // v0.15: clear the in-memory authoritative engine too
      await kv.delete(roomKey(code));
      for await (const e of kv.list({ prefix: ["roomlog", code] })) await kv.delete(e.key);
      log("admin deleted room", code);
    }
    return json(200, { ok: true });
  }
  if (parts.length === 4 && parts[1] === "rooms" && parts[3] === "rename" && req.method === "POST") {
    const code = parts[2].toUpperCase();
    const cur = await kv.get<RoomMeta>(roomKey(code));
    if (!cur.value) return json(404, { error: "no such room" });
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const pid = Number((body as Record<string, unknown>).playerId);
    const existing = cur.value.players.find((p) => p.id === pid);
    if (!existing) return json(404, { error: "no such player" });
    const name = cleanName((body as Record<string, unknown>).name, existing.name);
    if (isBadName(name)) return json(400, { error: "that name is blocked" });
    const r = await touchRoom(code, (meta) => {
      const p = meta.players.find((pp) => pp.id === pid);
      if (!p) return false;
      p.name = name;
      let hadLobby = false;
      if (meta.lobby) {
        const seat = meta.lobby.seats.find((s) => s.claimedBy === pid);
        if (seat) seat.name = name;
        hadLobby = true;
      }
      return { hadLobby };
    });
    if (!r.ok) return json(404, { error: "no such player" });
    if (r.extra.hadLobby) broadcastRoom(code, { type: "lobby", lobby: lobbySnapshot(r.meta) });
    log("admin renamed player", code, pid, "->", name);
    return json(200, { ok: true });
  }
  if (parts.length === 2 && parts[1] === "leaderboard" && req.method === "GET") {
    return await jsonLeaderboard(200);
  }
  if (parts.length === 3 && parts[1] === "leaderboard" && parts[2] === "reset" && req.method === "POST") {
    // v0.13: "new season" god-mode action — wipes every entry AND bumps the epoch in the same
    // breath (see "§ LEADERBOARD EPOCH" above), so every device that talks to the server after
    // this clears its own local cache too, not just the shared board.
    const epoch = await resetLeaderboard();
    log("admin reset the leaderboard - new epoch", epoch);
    return json(200, { ok: true, epoch });
  }
  if (parts.length === 3 && parts[1] === "leaderboard" && req.method === "PATCH") {
    const name = decodeURIComponent(parts[2]);
    if (!(await leaderboardEntryExists(name))) return json(404, { error: "no such entry" });
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    for (const k of Object.keys(body as Record<string, unknown>)) {
      if (!NUMERIC_STAT_KEY.test(k)) continue;
      const v = Number((body as Record<string, unknown>)[k]);
      if (Number.isFinite(v)) await kv.set(["leaderboard", name, k], new Deno.KvU64(BigInt(Math.round(v))));
    }
    log("admin edited leaderboard entry", name);
    const lb = await getLeaderboard();
    return json(200, lb[name] || {});
  }
  if (parts.length === 3 && parts[1] === "leaderboard" && req.method === "DELETE") {
    const name = decodeURIComponent(parts[2]);
    await deleteLeaderboardEntry(name);
    log("admin deleted leaderboard entry", name);
    return json(200, { ok: true });
  }
  return json(404, { error: "no such admin route" });
}

/* ---------------------------------------------------------------------------------------
 * § WEBSOCKET — the actual game relay. Structured to mirror server.js's
 * wss.on("connection", ...) closure 1:1 (same `ctx`/`identify`/`handleMessage` shape) so the
 * two files stay easy to diff against each other for protocol parity.
 * ------------------------------------------------------------------------------------- */
function handleWsUpgrade(req: Request, ip: string): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);
  socketLastSeen.set(socket, Date.now());   // v0.16: starts the § HEARTBEAT stale-socket clock
  let ctx: { code: string; playerId: number } | null = null;

  function identify(code: string, playerId: number) {
    ctx = { code, playerId };
    registerLocalSocket(code, playerId, socket);
  }
  // v0.10.3: lets a reclaimApprove processed on a DIFFERENT connection (the host's) identify
  // THIS socket once approved — see "reclaimApprove" below, which can't reach into another
  // connection's local `ctx` closure any other way. Same pattern as server.js's `ws.identify`.
  (socket as WebSocket & { identify?: typeof identify }).identify = identify;

  async function handleMessage(msg: Record<string, unknown>) {
    switch (msg.type) {
      case "ping":
        send(socket, { type: "pong", t: msg.t });
        return;

      case "host": {
        // v0.15: {type:'host', protocolVersion, name, n, teams, seats}
        if (!protocolOk(msg)) { send(socket, { type: "protocolMismatch", message: PROTOCOL_MISMATCH_MESSAGE }); sendLegacyMismatch(socket, "host"); return; }
        if (!underHostRateLimit(ip)) {
          send(socket, { type: "error", message: "Too many rooms created from here - wait a minute and try again." });
          log("rate-limited host attempt", "ip=" + ip);
          return;
        }
        if (isBadName(msg.name)) { send(socket, { type: "error", message: "Pick a nicer name and try hosting again." }); return; }
        const code = await newUniqueCode();
        const playerId = 1;
        const token = newToken();
        const hostName = cleanName(msg.name, "Host");
        const seats: Seat[] = Array.isArray(msg.seats) ? (msg.seats as Record<string, unknown>[]).map((s) => ({
          name: isBadName(s.name) ? cleanName("", "Player") : cleanName(s.name, ""),
          type: s.type === "cpu" ? "cpu" : "human", diff: (s.diff as string) || "medium", claimedBy: null,
        })) : [];
        const firstHuman = seats.findIndex((s) => s.type === "human");
        if (firstHuman >= 0) { seats[firstHuman].claimedBy = playerId; seats[firstHuman].name = hostName; }
        // v0.25 item 2: the host's chosen table speed seeds tableSpeed at creation - twin of
        // server.js's validation (the v0.19-flagged "never seeded" gap).
        const hostSpeed = Number(msg.speed);
        const seededSpeed = Number.isFinite(hostSpeed) && hostSpeed > 0 && hostSpeed <= 4 ? hostSpeed : 1;
        const meta: RoomMeta = {
          code, createdAt: Date.now(), lastActivity: Date.now(),
          hostPlayerId: playerId, nextPlayerId: 2,
          players: [{ id: playerId, token, name: hostName, isHost: true, connected: true }],
          lobby: { n: msg.n === 6 ? 6 : 4, teams: !!msg.teams, seats },
          started: false, seatOwners: null, ready: [], paused: false, logCount: 0,
          G: null, tableSpeed: seededSpeed, recorded: false, nextSeq: 0,
        };
        await kv.set(roomKey(code), meta, { expireIn: ROOM_TTL_MS });
        identify(code, playerId);
        send(socket, { type: "created", code, playerId, token, lobby: lobbySnapshot(meta), protocolVersion: PROTOCOL_VERSION });
        log("room created", code, "ip=" + ip);
        return;
      }

      case "join": {
        // v0.15: {type:'join', protocolVersion, code, name}
        if (!protocolOk(msg)) { send(socket, { type: "protocolMismatch", message: PROTOCOL_MISMATCH_MESSAGE }); sendLegacyMismatch(socket, "join"); return; }
        const code = String(msg.code || "").toUpperCase();
        const preCheck = await kv.get<RoomMeta>(roomKey(code));
        if (!preCheck.value) { send(socket, { type: "joinError", message: "That room code doesn't exist. Double check it with the host." }); return; }
        // v0.10.3: `reason:"started"` lets the client fall back to "reclaim" automatically
        // (see the "reclaim" case below) instead of dead-ending — same reasoning as server.js.
        if (preCheck.value.started) { send(socket, { type: "joinError", message: "That game already started. Ask the host to send a new code, or reconnect if you were already playing.", reason: "started" }); return; }
        if (isBadName(msg.name)) { send(socket, { type: "joinError", message: "Pick a nicer name." }); return; }
        const r = await touchRoom(code, (meta) => {
          if (meta.started) return false;
          const playerId = meta.nextPlayerId++;
          const token = newToken();
          meta.players.push({ id: playerId, token, name: cleanName(msg.name, "Player"), isHost: false, connected: true });
          return { playerId, token };
        });
        if (!r.ok) { send(socket, { type: "joinError", message: "That room code doesn't exist. Double check it with the host." }); return; }
        const playerId = r.extra.playerId as number, token = r.extra.token as string;
        identify(code, playerId);
        send(socket, { type: "joined", code, playerId, token, lobby: lobbySnapshot(r.meta), protocolVersion: PROTOCOL_VERSION });
        broadcastRoom(code, { type: "lobby", lobby: lobbySnapshot(r.meta) }, playerId);
        log("player joined", code, playerId, "ip=" + ip);
        return;
      }

      case "rejoin": {
        // v0.15: {type:'rejoin', protocolVersion, code, playerId, token} - snapshot-based sync
        // (no log replay), twin of server.js's rejoin case.
        if (!protocolOk(msg)) { send(socket, { type: "protocolMismatch", message: PROTOCOL_MISMATCH_MESSAGE }); sendLegacyMismatch(socket, "rejoin"); return; }
        const code = String(msg.code || "").toUpperCase();
        const pre = await kv.get<RoomMeta>(roomKey(code));
        const playerId = Number(msg.playerId);
        const preP = pre.value && pre.value.players.find((p) => p.id === playerId);
        // v0.15.1 hotfix 2/2: this room is verifiably gone - see sendDeadRoomFollowup() above.
        if (!pre.value || !preP || preP.token !== msg.token) {
          const deadRoomMsg = "Couldn't reconnect you to that room - it may have ended.";
          send(socket, { type: "rejoinError", message: deadRoomMsg });
          sendDeadRoomFollowup(socket, deadRoomMsg);
          return;
        }
        // v0.16 item 2: twin of server.js's matching check - a player who left for good can
        // never reclaim their old seat via a stored token either.
        if (preP.leftForGood) {
          const leftMsg = "You left that game for good - a computer is playing your seat now.";
          send(socket, { type: "rejoinError", message: leftMsg });
          sendDeadRoomFollowup(socket, leftMsg);
          return;
        }
        if (isUnmigratableRoom(pre.value)) {
          send(socket, { type: "rejoinError", message: OLD_ROOM_MESSAGE });
          sendDeadRoomFollowup(socket, OLD_ROOM_MESSAGE);
          await pruneUnmigratableRoom(code);
          return;
        }
        const r = await touchRoom(code, (meta) => {
          const p = meta.players.find((pp) => pp.id === playerId);
          if (!p) return false;
          p.connected = true;
          return {};
        });
        if (!r.ok) {
          const deadRoomMsg = "Couldn't reconnect you to that room - it may have ended.";
          send(socket, { type: "rejoinError", message: deadRoomMsg });
          sendDeadRoomFollowup(socket, deadRoomMsg);
          return;
        }
        identify(code, playerId);
        const isHost = playerId === r.meta.hostPlayerId;
        if (r.meta.started) {
          send(socket, {
            type: "sync", lobby: lobbySnapshot(r.meta), seatOwners: r.meta.seatOwners,
            ...gameSnapshotFields(r.meta, isHost),
          });
        } else {
          // v0.25 item 1: the lobby snapshot carries readyPlayerIds, so a mid-lobby reconnect
          // lands back on the seat screen with everyone's ready state intact.
          send(socket, { type: "lobby", lobby: lobbySnapshot(r.meta), isHost, protocolVersion: PROTOCOL_VERSION });
        }
        broadcastRoom(code, { type: "presence", playerId, connected: true }, playerId);
        if (playerId === r.meta.hostPlayerId) broadcastRoom(code, { type: "hostStatus", connected: true }, playerId);
        log("player rejoined", code, playerId, "ip=" + ip);
        return;
      }

      case "reclaim": {
        // v0.10.3, protocol-versioned in v0.15: {type:'reclaim', protocolVersion, code, name}
        // — token-less recovery, mirrors server.js's "reclaim" case. See the PendingReclaim
        // comment near the top of this file for the known same-isolate caveat on the
        // contested branch.
        if (!protocolOk(msg)) { send(socket, { type: "protocolMismatch", message: PROTOCOL_MISMATCH_MESSAGE }); sendLegacyMismatch(socket, "reclaim"); return; }
        const code = String(msg.code || "").toUpperCase();
        const pre = await kv.get<RoomMeta>(roomKey(code));
        // v0.15.1 hotfix 2/2: same "this room is verifiably gone" follow-up as the rejoin case
        // above - see sendDeadRoomFollowup().
        if (!pre.value) {
          const deadRoomMsg = "That room code doesn't exist or has expired.";
          send(socket, { type: "reclaimError", message: deadRoomMsg });
          sendDeadRoomFollowup(socket, deadRoomMsg);
          return;
        }
        if (!pre.value.started) { send(socket, { type: "reclaimError", message: "That game hasn't started yet - use Join a game instead.", reason: "notStarted" }); return; }
        if (isUnmigratableRoom(pre.value)) {
          send(socket, { type: "reclaimError", message: OLD_ROOM_MESSAGE });
          sendDeadRoomFollowup(socket, OLD_ROOM_MESSAGE);
          await pruneUnmigratableRoom(code);
          return;
        }
        if (isBadName(msg.name)) { send(socket, { type: "reclaimError", message: "Pick a nicer name." }); return; }
        const wantName = String(msg.name || "").trim().toLowerCase();
        const allNamed = pre.value.players.filter((p) => p.name.trim().toLowerCase() === wantName);
        // v0.16 item 2: twin of server.js's matching filter - a player who left for good can
        // never be reclaimed back into their old seat.
        const candidates = allNamed.filter((p) => !p.leftForGood);
        if (candidates.length === 0) {
          if (allNamed.some((p) => p.leftForGood)) {
            send(socket, { type: "reclaimError", message: `${cleanName(msg.name, "That player")} left that game for good - a computer is playing their seat now.` });
          } else {
            send(socket, { type: "reclaimError", message: `No one named "${cleanName(msg.name, "that")}" is in that game.` });
          }
          return;
        }
        const targetPre = candidates.find((p) => !p.connected) || candidates[0];
        if (targetPre.connected) {
          const hostP = pre.value.players.find((p) => p.id === pre.value!.hostPlayerId);
          if (!hostP || !hostP.connected) {
            send(socket, { type: "reclaimError", message: `${targetPre.name} is already connected and the host isn't reachable to confirm a takeover - try again in a bit.` });
            return;
          }
          const reqId = newToken();
          pendingReclaims.set(reqId, { code, targetPlayerId: targetPre.id, socket, expires: Date.now() + RECLAIM_TIMEOUT_MS });
          sendToPlayer(code, hostP.id, { type: "reclaimRequest", reqId, name: targetPre.name });
          send(socket, { type: "reclaimPending", message: `${targetPre.name} looks like they're already connected - asking the host to confirm.` });
          log("reclaim contested, asked host", code, targetPre.id, "ip=" + ip);
          return;
        }
        const r = await touchRoom(code, (meta) => {
          const p = meta.players.find((pp) => pp.id === targetPre.id);
          if (!p || p.connected) return false; // lost the race since the pre-check above
          p.token = newToken();
          p.connected = true;
          return { playerId: p.id, token: p.token };
        });
        if (!r.ok) { send(socket, { type: "reclaimError", message: "Try again - that seat just changed state." }); return; }
        identify(code, r.extra.playerId as number);
        const isHost = (r.extra.playerId as number) === r.meta.hostPlayerId;
        send(socket, {
          type: "reclaimed", code, playerId: r.extra.playerId, token: r.extra.token,
          lobby: lobbySnapshot(r.meta), seatOwners: r.meta.seatOwners,
          ...gameSnapshotFields(r.meta, isHost),
        });
        broadcastRoom(code, { type: "presence", playerId: r.extra.playerId as number, connected: true }, r.extra.playerId as number);
        if (isHost) broadcastRoom(code, { type: "hostStatus", connected: true }, r.extra.playerId as number);
        log("player reclaimed seat by name", code, r.extra.playerId, "ip=" + ip);
        return;
      }

      case "reclaimApprove": {
        // host-only: {type:'reclaimApprove', reqId, approve:true|false}
        if (!ctx) return;
        const { code, playerId } = ctx;
        const cur0 = await kv.get<RoomMeta>(roomKey(code));
        if (!cur0.value || playerId !== cur0.value.hostPlayerId) return;
        const pending = pendingReclaims.get(msg.reqId as string);
        if (!pending || pending.code !== code) return; // not found here — see same-isolate caveat above
        pendingReclaims.delete(msg.reqId as string);
        if (!msg.approve) { send(pending.socket, { type: "reclaimError", message: "The host didn't approve that." }); return; }
        const r = await touchRoom(code, (meta) => {
          const p = meta.players.find((pp) => pp.id === pending.targetPlayerId);
          if (!p) return false;
          p.token = newToken();
          p.connected = true;
          return { playerId: p.id, token: p.token };
        });
        if (!r.ok) { send(pending.socket, { type: "reclaimError", message: "That seat is gone now." }); return; }
        const targetPlayerId = r.extra.playerId as number;
        // Tell (and, if it's local to THIS isolate, forcibly close) whatever connection
        // currently holds that playerId BEFORE re-registering it to the new one — otherwise
        // the old connection's eventual "close" would race the takeover (see the onclose guard
        // below, added alongside this for the same reason server.js needed one).
        const oldLocalWs = localSockets.get(code)?.get(targetPlayerId);
        sendToPlayer(code, targetPlayerId, { type: "kicked", message: "Someone else took over your seat." });
        if (oldLocalWs && oldLocalWs !== pending.socket) { try { oldLocalWs.close(); } catch (_e) { /* ignore */ } }
        // Same connection that's about to receive "reclaimed" also needs its OWN ctx set so
        // its future 'action'/etc. messages are authorized — call ITS OWN identify() (exposed
        // as socket.identify, see handleWsUpgrade's top) since this code is running inside the
        // HOST's connection, not the reclaiming one.
        const pendingSocket = pending.socket as WebSocket & { identify?: (code: string, playerId: number) => void };
        if (pendingSocket.identify) pendingSocket.identify(code, targetPlayerId);
        else registerLocalSocket(code, targetPlayerId, pending.socket); // best-effort fallback
        const isHost = targetPlayerId === r.meta.hostPlayerId;
        send(pending.socket, {
          type: "reclaimed", code, playerId: targetPlayerId, token: r.extra.token,
          lobby: lobbySnapshot(r.meta), seatOwners: r.meta.seatOwners,
          ...gameSnapshotFields(r.meta, isHost),
        });
        broadcastRoom(code, { type: "presence", playerId: targetPlayerId, connected: true }, targetPlayerId);
        log("reclaim approved by host", code, targetPlayerId);
        return;
      }

      case "claimSeat": {
        if (!ctx) return;
        const { code, playerId } = ctx;
        const r = await touchRoom(code, (meta) => {
          if (!meta.lobby || meta.started) return false;
          // v0.25 item 1: "Ready up" locks the seat choice in - a ready player can't move.
          if ((meta.ready || []).includes(playerId)) return false;
          const seat = meta.lobby.seats[msg.seatIndex as number];
          if (!seat) return false;
          if (seat.claimedBy === meta.hostPlayerId) return false;
          if (seat.claimedBy != null && seat.claimedBy !== playerId) return false;
          meta.lobby.seats.forEach((s) => { if (s.claimedBy === playerId) s.claimedBy = null; });
          seat.claimedBy = playerId;
          seat.type = "human";
          if (msg.name && !isBadName(msg.name)) seat.name = cleanName(msg.name, seat.name);
          return {};
        });
        if (r.ok) broadcastRoom(code, { type: "lobby", lobby: lobbySnapshot(r.meta) });
        return;
      }

      case "setSeat": {
        if (!ctx) return;
        const { code, playerId } = ctx;
        let kicked: number | null = null;
        const r = await touchRoom(code, (meta) => {
          if (playerId !== meta.hostPlayerId || !meta.lobby || meta.started) return false;
          const seat = meta.lobby.seats[msg.seatIndex as number];
          if (!seat) return false;
          const patch = (msg.patch as Record<string, unknown>) || {};
          if (patch.type === "cpu" && seat.claimedBy != null) {
            kicked = seat.claimedBy; seat.claimedBy = null;
            // v0.25 item 1: a kicked guest's ready mark goes with them - twin of server.js.
            if (meta.ready) meta.ready = meta.ready.filter((id) => id !== kicked);
          }
          if (patch.type) seat.type = patch.type === "cpu" ? "cpu" : "human";
          if (patch.diff) seat.diff = patch.diff as string;
          if (patch.name != null && !isBadName(patch.name)) seat.name = cleanName(patch.name, seat.name);
          return {};
        });
        if (r.ok) {
          if (kicked != null) sendToPlayer(code, kicked, { type: "kicked", message: "The host turned your seat into a CPU." });
          broadcastRoom(code, { type: "lobby", lobby: lobbySnapshot(r.meta) });
        }
        return;
      }

      case "start": {
        // v0.25 item 1: {type:'start', willSeat} - host-only, and only once every claimed
        // NON-HOST seat's player is ready (guestsAllReady()). Twin of server.js's case: the
        // v0.16-v0.24 readyCheck phase is gone; this starts (via the v0.22 seat gate)
        // directly. The host's own willSeat rides this message - Start is their ready-up.
        if (!ctx) return;
        const { code, playerId } = ctx;
        await withRoomChain(code, async () => {
          const cur = await kv.get<RoomMeta>(roomKey(code));
          if (!cur.value) return;
          const meta = cur.value;
          if (playerId !== meta.hostPlayerId || meta.started || !meta.lobby) return;
          if (!guestsAllReady(meta)) {
            send(socket, { type: "error", message: "Waiting for everyone to tap Ready up first." });
            return;
          }
          if (msg.willSeat) {
            let s = willSeatMap.get(code);
            if (!s) { s = new Set(); willSeatMap.set(code, s); }
            s.add(playerId);
          }
          await actuallyStartGame(code, meta);
        });
        return;
      }

      case "readyUp": {
        // v0.25 item 1: {type:'readyUp', willSeat} - a guest on the seat screen locks their
        // seat choice in. Twin of server.js's case: valid any time in the lobby, requires an
        // actually-claimed seat. willSeat still carries the v0.22 seat-gate promise.
        if (!ctx) return;
        const { code, playerId } = ctx;
        if (msg.willSeat) {
          let s = willSeatMap.get(code);
          if (!s) { s = new Set(); willSeatMap.set(code, s); }
          s.add(playerId);
        }
        await withRoomChain(code, async () => {
          const r = await touchRoom(code, (meta) => {
            if (!meta.lobby || meta.started) return false;
            if (!meta.lobby.seats.some((s) => s.claimedBy === playerId)) return false;
            if (!meta.ready) meta.ready = [];
            if (!meta.ready.includes(playerId)) meta.ready.push(playerId);
            return {};
          });
          if (!r.ok) return;
          broadcastRoom(code, { type: "lobby", lobby: lobbySnapshot(r.meta) });
        });
        return;
      }

      case "action": {
        // v0.15: {type:'action', action:{kind:'move', seat, m}} — the ONLY action a client
        // may originate now (twin of server.js's "action" case; CPU moves/reshuffles are
        // server-generated, any other kind silently ignored).
        if (!ctx) return;
        const { code, playerId } = ctx;
        const action = msg.action as Record<string, unknown>;
        if (!action || action.kind !== "move") return;
        await withRoomChain(code, async () => {
          const pre = await kv.get<RoomMeta>(roomKey(code));
          if (!pre.value || !pre.value.started || !pre.value.seatOwners) return;
          const meta = pre.value;
          const E = getEngine(code, meta);
          if (!E) return;
          const G = E.getG();
          if (!G || G.over) return;
          const seat = action.seat as number;
          const owner = meta.seatOwners![seat];
          if (owner == null || owner !== playerId) return; // not authorized for this seat
          const resyncThisClient = () => send(socket, {
            type: "sync", lobby: lobbySnapshot(meta), seatOwners: meta.seatOwners,
            ...gameSnapshotFields(meta, playerId === meta.hostPlayerId),
          });
          if (seat !== G.turn) { resyncThisClient(); return; } // stale/out-of-turn — resync, don't crash
          const legal = E.legalMoves(seat);
          const match = legal.find((lm: any) => sameMove(lm, action.m));
          if (!match) {
            log("rejected illegal/stale move", code, "playerId=" + playerId, "seat=" + seat);
            resyncThisClient();
            return;
          }
          const out: Broadcastable[] = [];
          E.applyMove(seat, match);
          if (E.getG().over) {
            out.push({ payload: { type: "gameAction", seq: meta.nextSeq++, action: { kind: "move", seat, m: match, turn: G.turn } } });
            await commitAndBroadcast(code, E, out, true);
            return;
          }
          E.advanceTurn();
          const moveSeq = meta.nextSeq++;
          out.push({ payload: { type: "gameAction", seq: moveSeq, action: { kind: "move", seat, m: match, turn: E.getG().turn } } });
          // Digest AFTER advanceTurn(), tagged with the broadcast seq — v0.15 fixes #3/#4.
          if (match.kick || match.type === "swap") {
            out.push({ payload: { type: "stateCheck", afterSeq: moveSeq, digest: gDigestServer(E.getG()) } });
          }
          const cont = driveTurnLoopCollect(E, meta);
          const ok = await commitAndBroadcast(code, E, out.concat(cont.out), cont.finished);
          if (ok) maybeSendTurnPush(code, E, cont.finished).catch((e) => log("push check failed", code, (e as Error).message));
        });
        return;
      }

      case "leaveForGood": {
        // v0.16 item 2: {type:'leaveForGood'} — twin of server.js's case. A human seat
        // permanently converts to a CPU for the rest of THIS game; no "host is special" branch
        // (a host leaving for good is handled identically to any other seat — see HANDOFF.md
        // v0.16 for the host-lifecycle audit that confirmed nothing else depends on the host
        // staying human/connected past this point).
        if (!ctx) return;
        const { code, playerId } = ctx;
        await withRoomChain(code, async () => {
          const pre = await kv.get<RoomMeta>(roomKey(code));
          if (!pre.value) { send(socket, { type: "leftForGood" }); return; }
          const meta = pre.value;
          let seat = -1;
          if (meta.started && meta.seatOwners) seat = meta.seatOwners.indexOf(playerId);
          const E = seat >= 0 ? getEngine(code, meta) : null;
          const G = E ? E.getG() : null;
          let converted = false;
          if (E && G && seat >= 0 && G.seats[seat] && G.seats[seat].type === "human") {
            const leaverName = G.seats[seat].name;
            G.seats[seat].type = "cpu";
            G.seats[seat].diff = "medium";   // "Tricky" - see engine.js chooseAI()'s diff naming
            converted = true;
            const out: Broadcastable[] = [{ payload: { type: "gameAction", seq: meta.nextSeq++, action: { kind: "seatToCpu", seat, diff: "medium", name: leaverName } } }];
            // The seat may be sitting mid-turn waiting on exactly this human's move right now -
            // drive it forward immediately instead of stalling the table.
            const cont = driveTurnLoopCollect(E, meta);
            const ok = await commitAndBroadcast(code, E, out.concat(cont.out), cont.finished);
            if (ok) maybeSendTurnPush(code, E, cont.finished).catch((e) => log("push check failed", code, (e as Error).message));
          } else {
            seat = -1; // nothing converted - don't touch seatOwners below
          }
          // Invalidate this player's session for THIS room permanently (covers leaving mid-lobby
          // too, before any seat/engine exists) and null out the seatOwners slot if converted -
          // done in a follow-up commit so it lands even when commitAndBroadcast above already
          // persisted a fresh meta.G that this read predates.
          await touchRoom(code, (m) => {
            const p = m.players.find((pp) => pp.id === playerId);
            if (p) p.leftForGood = true;
            if (seat >= 0 && m.seatOwners) m.seatOwners[seat] = null;
            return {};
          });
          send(socket, { type: "leftForGood" });
          log("player left for good", code, playerId, converted ? "(seat converted to CPU)" : "(no active seat)");
        });
        return;
      }

      case "requestStateCheck": {
        // v0.15: the server answers directly (it IS the authority) — no more relaying to the
        // host's phone. Tagged with the most recent broadcast seq, same as server.js.
        // v0.20: superseded as the client's own foreground-trigger by "resync" below (a direct
        // fresh snapshot, not a digest compare that can only resolve once a LATER action
        // arrives — see HANDOFF.md v0.20's root-cause writeup). Kept working, unmodified, so a
        // pre-v0.20 client (build 16-26) still self-heals via its existing path.
        if (!ctx) return;
        const { code } = ctx;
        const cur = await kv.get<RoomMeta>(roomKey(code));
        if (!cur.value || !cur.value.started) return;
        const E = getEngine(code, cur.value);
        if (!E) return;
        broadcastRoom(code, { type: "stateCheck", afterSeq: (cur.value.nextSeq || 1) - 1, digest: gDigestServer(E.getG()) });
        return;
      }

      case "seated": {
        // v0.22 P0b § SEAT GATE: this client's board is genuinely on screen with no pre-game
        // overlay in the way - release its slot; the last one out releases the first deal.
        // With no gate present this still runs the fallback re-drive (isolate-recycle
        // recovery: releaseFirstDeal no-ops unless the first deal is genuinely pending).
        if (!ctx) return;
        const { code, playerId } = ctx;
        const gate = seatGates.get(code);
        if (gate) { releaseSeatGateSlot(code, playerId, "all seated"); return; }
        await withRoomChain(code, () => releaseFirstDeal(code));
        return;
      }

      case "resync": {
        // v0.20: lightweight "give me a fresh full snapshot right now" for a client with an
        // already-identified, presumed-healthy connection — twin of server.js's "resync" case,
        // see HANDOFF.md v0.20. Deliberately skips every side effect "rejoin" has (no
        // p.connected/presence/hostStatus churn) since nothing about the connection actually
        // needed re-establishing — a client can call this on every foreground without ever
        // rippling a spurious "X reconnected" to the rest of the table. Old (pre-v0.20) clients
        // never send this — fully additive, no protocolVersion gate needed. Same response
        // shape as "rejoin"'s success reply ('sync'), so the EXISTING client-side onSync()/
        // bootGameFromSnapshot() handles it with zero new client-side message-type handling.
        if (!ctx) return;
        const { code, playerId } = ctx;
        const cur = await kv.get<RoomMeta>(roomKey(code));
        if (!cur.value || !cur.value.started) return;
        const p = cur.value.players.find((pp) => pp.id === playerId);
        if (!p) return;
        const isHost = playerId === cur.value.hostPlayerId;
        send(socket, {
          type: "sync", lobby: lobbySnapshot(cur.value), seatOwners: cur.value.seatOwners,
          ...gameSnapshotFields(cur.value, isHost),
        });
        return;
      }

      case "setTableSpeed": {
        // v0.15: host-only shared table pacing — twin of server.js's case.
        if (!ctx) return;
        const { code, playerId } = ctx;
        const speed = Number(msg.speed);
        if (!Number.isFinite(speed) || speed <= 0) return;
        const r = await touchRoom(code, (meta) => {
          if (playerId !== meta.hostPlayerId || !meta.started) return false;
          meta.tableSpeed = speed;
          return {};
        });
        if (r.ok) broadcastRoom(code, { type: "tableSpeed", speed: r.meta.tableSpeed });
        return;
      }

      case "pauseToggle": {
        if (!ctx) return;
        const { code } = ctx;
        const r = await touchRoom(code, (meta) => {
          if (!meta.started) return false;
          meta.paused = !!msg.paused;
          return {};
        });
        if (r.ok) broadcastRoom(code, { type: "paused", paused: r.meta.paused });
        return;
      }

      // v0.15: "recordResult" is RETIRED — the server records a finished online game itself
      // (recordFinishedGame(), called from commitAndBroadcast() when G.over flips) instead of
      // waiting for the host's phone to notice the win screen. An old client that still sends
      // it lands in the default no-op case below (it can't have gotten this far anyway — the
      // protocol handshake rejects pre-v2 clients at host/join/rejoin/reclaim).

      case "nudge": {
        if (!ctx) return;
        const { code, playerId } = ctx;
        const cur = await kv.get<RoomMeta>(roomKey(code));
        if (!cur.value || !cur.value.started) return;
        const target = cur.value.players.find((p) => p.id === msg.targetPlayerId);
        const sender = cur.value.players.find((p) => p.id === playerId);
        if (target) sendToPlayer(code, target.id, { type: "nudged", fromPlayerId: playerId, fromName: sender ? sender.name : "Someone" });
        // v0.22 § AWAY LADDER: twin of server.js's re-nudge extension - a nudge aimed at the
        // disconnected/silent ON-TURN player also re-fires the turn push, rate-limited.
        if (target && cur.value.seatOwners) {
          const E = getEngine(code, cur.value);
          const G = E ? E.getG() : null;
          if (E && G && !G.over && cur.value.seatOwners[G.turn] === target.id && playerLooksAway(code, target)) {
            const a = awayStates.get(code);
            const now = Date.now();
            if (!a || now - (a.lastPushAt || 0) > AWAY_REPUSH_MIN_MS) {
              if (a) a.lastPushAt = now;
              maybeSendTurnPush(code, E, false).catch((e) => log("push check failed", code, (e as Error).message));
            }
          }
        }
        return;
      }

      case "playTurnForAway": {
        // v0.22 § AWAY LADDER: twin of server.js's case - see that file's comment for the full
        // design. Any connected player, once the cpuOffer stage is reached for this exact
        // seat's current turn, may have the server play that ONE turn with the Tricky AI. The
        // seat STAYS human; first tap wins (the turn advances, later taps fail seat===G.turn).
        if (!ctx) return;
        const { code } = ctx;
        const wantSeat = Number(msg.seat);
        await withRoomChain(code, async () => {
          const pre = await kv.get<RoomMeta>(roomKey(code));
          if (!pre.value || !pre.value.started || pre.value.paused || !pre.value.seatOwners) return;
          const meta = pre.value;
          const E = getEngine(code, meta);
          if (!E) return;
          const G = E.getG();
          if (!G || G.over) return;
          if (wantSeat !== G.turn) return;                 // stale tap - the turn already moved on
          if (!G.seats[wantSeat] || G.seats[wantSeat].type !== "human") return;
          const ownerId = meta.seatOwners![wantSeat];
          if (ownerId == null) return;
          if (!playerLooksAway(code, meta.players.find((p) => p.id === ownerId))) return;   // they're back
          const a = awayStates.get(code);
          if (!a || a.seat !== wantSeat || !a.offerSent) return;   // only after the offer stage
          const moves = E.legalMoves(wantSeat);
          if (moves.length === 0) return;   // defensive - the loop would have auto-passed this seat
          const savedDiff = G.seats[wantSeat].diff;
          G.seats[wantSeat].diff = "medium";   // "Tricky" - one-turn assist, restored right after
          const m = E.chooseAI(wantSeat, moves);
          G.seats[wantSeat].diff = savedDiff;
          E.applyMove(wantSeat, m);
          log("away ladder: computer played one turn for seat", wantSeat, "room", code);
          clearAwayState(code);
          const out: Broadcastable[] = [];
          if (E.getG().over) {
            out.push({ payload: { type: "gameAction", seq: meta.nextSeq++, action: { kind: "move", seat: wantSeat, m, turn: G.turn } } });
            await commitAndBroadcast(code, E, out, true);
            return;
          }
          E.advanceTurn();
          const moveSeq = meta.nextSeq++;
          out.push({ payload: { type: "gameAction", seq: moveSeq, action: { kind: "move", seat: wantSeat, m, turn: E.getG().turn } } });
          if (m.kick || m.type === "swap") {
            out.push({ payload: { type: "stateCheck", afterSeq: moveSeq, digest: gDigestServer(E.getG()) } });
          }
          const cont = driveTurnLoopCollect(E, meta);
          const ok = await commitAndBroadcast(code, E, out.concat(cont.out), cont.finished);
          if (ok) maybeSendTurnPush(code, E, cont.finished).catch((e) => log("push check failed", code, (e as Error).message));
        });
        return;
      }

      case "registerPush": {
        // v0.16 item 5: {type:'registerPush', token, platform} — twin of server.js's case. The
        // iOS app registers (or RE-registers, after every reconnect) its APNs device token
        // here, tied to the SAME per-connection identity (this playerId's player record) that
        // a rejoin token/reclaim-by-name already key off - see maybeSendTurnPush() above.
        if (!ctx) return;
        const { code, playerId } = ctx;
        const token = typeof msg.token === "string" ? (msg.token as string).trim().slice(0, 512) : "";
        if (!token) return;
        const r = await touchRoom(code, (meta) => {
          const p = meta.players.find((pp) => pp.id === playerId);
          if (!p) return false;
          p.pushToken = token;
          p.pushPlatform = "ios"; // only iOS ships right now - a real value once a second platform ever exists
          return {};
        });
        if (r.ok) log("push token registered", code, "playerId=" + playerId);
        return;
      }

      default:
        return;
    }
  }

  // server.js's Node handler is fully synchronous (no `await` inside handleMessage), so
  // messages arriving back-to-back on the SAME socket are always processed strictly in
  // arrival order — a guarantee the game protocol leans on (e.g. two actions from the same
  // sender must be logged in the order they were sent). This port's handleMessage DOES await
  // (KV reads/commits), so without care, two messages arriving close together on one socket
  // could start concurrently and finish in either order. `msgChain` is a promise chain that
  // forces strict in-order processing per connection, matching Node's guarantee, while still
  // allowing DIFFERENT connections to proceed independently/concurrently (their relative
  // order was never guaranteed anyway — see touchRoom's optimistic-concurrency retry).
  let msgChain: Promise<void> = Promise.resolve();
  socket.onmessage = (ev) => {
    socketLastSeen.set(socket, Date.now());   // v0.16: ANY inbound frame counts as proof of life,
    // even one that fails to parse below - a garbled frame still proves the pipe is live.
    msgChain = msgChain.then(async () => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch (_e) { return; }
      if (!msg || typeof msg.type !== "string") return;
      try { await handleMessage(msg); } catch (e) {
        log("message handler error", e);
        send(socket, { type: "error", message: "server error" });
      }
    });
  };

  socket.onclose = () => {
    (async () => {
      if (!ctx) return;
      const { code, playerId } = ctx;
      // v0.10.3 fix (found via the reclaim wire-protocol test, same root cause as server.js's
      // identical fix): a contested "reclaim" approval hands this playerId to a NEW socket and
      // closes this old one (see "reclaimApprove" above) — this "close" handler can fire AFTER
      // that handover, and without this guard would wrongly mark the (now different) live
      // connection as disconnected, since both sockets shared the same playerId by design.
      // Only apply a disconnect if THIS closing socket is still the one THIS isolate has
      // locally registered for that player. (Known limitation, same shape as this file's
      // documented BroadcastChannel caveat: if the takeover happened on a DIFFERENT isolate,
      // this isolate's own localSockets map was never updated, so this guard can't see it —
      // acceptable given the whole feature is local-only/undeployed pending the app being
      // pinned to a single instance, same reasoning as § RELAY above.)
      const stillCurrent = localSockets.get(code)?.get(playerId) === socket;
      if (!stillCurrent) return; // a takeover already replaced us locally — don't unregister IT
      unregisterLocalSocket(code, playerId);
      // v0.22 P0b: never hold the first deal for a phone that's gone - its overlays are moot.
      releaseSeatGateSlot(code, playerId, "unseated player disconnected");
      const r = await touchRoom(code, (meta) => {
        const p = meta.players.find((pp) => pp.id === playerId);
        if (!p) return false;
        p.connected = false;
        return {};
      }).catch(() => ({ ok: false as const, reason: "error" }));
      if (r.ok) {
        broadcastRoom(code, { type: "presence", playerId, connected: false });
        if (playerId === r.meta.hostPlayerId) broadcastRoom(code, { type: "hostStatus", connected: false });
        // v0.16 item 5: twin of server.js's matching close-handler addition - covers a player
        // who was connected when their turn started but backgrounds/drops mid-turn (nothing
        // else mutates the game to re-enter driveTurnLoopCollect on its own in that case).
        // Mutually exclusive with the turn-start check in maybeSendTurnPush()'s other call
        // sites - never a double push for the same turn.
        if (r.meta.started && r.meta.seatOwners) {
          const E = getEngine(code, r.meta);
          if (E) {
            const G = E.getG();
            if (G && !G.over && r.meta.seatOwners[G.turn] === playerId) {
              maybeSendTurnPush(code, E, false).catch((e) => log("push check failed", code, (e as Error).message));
            }
          }
        }
      }
    })();
  };

  return response;
}

/* ---------------------------------------------------------------------------------------
 * § ENTRYPOINT
 * ------------------------------------------------------------------------------------- */
async function handler(req: Request, info: Deno.ServeHandlerInfo): Promise<Response> {
  await ensureKv(); // see the lazy-init comment above `let kv` — must happen before ANY of
  // this request's code paths (HTTP routes below, or the WS upgrade they dispatch to) touch kv.
  await ensureLeaderboardMigrated(); // v0.21: one-time-per-isolate split-points migration, see above
  const url = new URL(req.url);
  const ip = remoteIp(req, info);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return handleWsUpgrade(req, ip);
  }
  if (url.pathname === "/health") {
    let rooms = 0;
    for await (const _e of kv.list({ prefix: ["room"] })) rooms++;
    return json(200, { ok: true, rooms, uptime: Math.round(performance.now() / 1000), epoch: await getEpoch(), protocolVersion: PROTOCOL_VERSION });
  }
  if (url.pathname === "/.well-known/apple-app-site-association") {
    // No CORS headers (Apple's CDN fetches this directly, not a browser) — content-type MUST
    // be application/json despite the extension-less path, and this must NOT redirect.
    return new Response(AASA_BODY, { status: 200, headers: { "content-type": "application/json" } });
  }
  {
    const jm = url.pathname.match(JOIN_CODE_RE);
    if (jm) {
      return new Response(joinRedirectHtml(jm[1].toUpperCase()), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  }
  if (url.pathname === "/leaderboard") {
    // v0.13: also reports the current leaderboard epoch via header, see "§ LEADERBOARD EPOCH".
    return await jsonLeaderboard(200);
  }
  if (url.pathname.startsWith("/admin/")) {
    try { return await handleAdminRoute(req, url); }
    catch (e) { log("admin route error", e); return json(500, { error: "server error" }); }
  }
  if (url.pathname === "/solo-result" && req.method === "POST") {
    // v0.13: solo/pass-and-play offline games sync to the shared board through here — see
    // "§ SOLO RESULTS" above.
    try { return await handleSoloResult(req, ip); }
    catch (e) { log("solo-result route error", e); return json(500, { error: "server error" }); }
  }
  return new Response("nasty relay - see /health", { status: 404, headers: { "content-type": "text/plain", ...CORS_HEADERS } });
}

log(`admin token source: ${Deno.env.get("NASTY_ADMIN_TOKEN") ? "NASTY_ADMIN_TOKEN env" : "ephemeral (dev only)"}`);

if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
  // Running on Deno Deploy — it manages the port; don't specify one.
  Deno.serve(handler);
} else {
  Deno.serve({ port: PORT }, handler);
  log(`nasty relay (deno) listening on :${PORT}`);
}
