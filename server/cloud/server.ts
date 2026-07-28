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
import { getApnsStats, sendTurnPush } from "./apns.ts";

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
/* 2026-07-24 (Blake's items 9+14, "2026-07-23 list") - twin of server.js's matching comment.
   STAYS at 5, not bumped. Item 9's two new stat keys ride the existing result-recording shape,
   no new message/changed shape. Item 14 needed zero server changes - `teams` already rode the
   `host` message and RoomMeta since it existed; this session's fix is client-side display only.
   See index.html's PROTOCOL_VERSION comment for the full reasoning. */
/* 2026-07-25 § ACCOUNTS (server plumbing, four sign-in methods) - twin of server.js's matching
   comment, which carries the full case-by-case reasoning. STAYS at 5, not bumped: everything
   added is new HTTP endpoints under /account/*, plus /leaderboard/v2 and two /admin/* routes,
   plus exactly ONE optional websocket field (`acct` on host/join) that no shipped client sends
   and that an older server would simply ignore. No reply changed shape in either direction;
   /leaderboard's and /solo-result's bodies are unchanged; and the room playerId/token rejoin
   credential was not touched at all. An old client never calls the new routes, and a new client
   treats any non-200 from them as "accounts unavailable, stay a guest" - it is never left
   waiting on a reply it cannot interpret, which is this project's actual bar for a bump. */
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
type PendingReclaim = { code: string; targetPlayerId: number; socket: WebSocket; accountId: string | null; expires: number };
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
/* 2026-07-25 § LEADERBOARD NAME FOLDING (bug 6) - twin of server.js's matching helper, see that
   file for the full reasoning. cleanName() keeps what the player typed (it is the DISPLAY name);
   this fold is used ONLY for leaderboard identity, so one human on a phone and an iPad
   ("Blake" / "blake" / "BLAKE") is one lifetime row. */
function leaderboardNameKey(cleanedName: string): string {
  return String(cleanedName || "").toLowerCase();
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
// 2026-07-24 (Blake's item 9): hkoDealt/hkoTaken added - lifetime, human-only knockout stats, no
// legacy predecessor so no migration function needed (a missing key just reads as 0) - see
// server.js's matching comment + the § KNOCKOUT TALLY block below.
const NUMERIC_STAT_KEY = /^(hg[46][st]|hw[46][st]|hptsS|hptsT|hkoDealt|hkoTaken)$/;
/* 2026-07-25 § STAT DELTA VALIDATION (bug 4) - twin of server.js's block, see that file for the
   full reasoning and the exact rules. The bug bit HARDEST here: the old code fed Number(v)
   straight into BigInt() and then into an UNSIGNED KvU64 sum, so a negative value threw, the
   whole /solo-result handler 500'd, any sibling keys later in the same delta were silently LOST
   (the loop aborted mid-way), and because the throw happened before the soloSeenKey write the
   gameId was never marked seen - so that device retried the same poisoned game forever. Node
   meanwhile answered 200 and cheerfully APPLIED the negative. Both servers now apply exactly the
   same rules, skip an invalid key instead of throwing, and always reach a final answer.
   MAX_STAT_DELTA is an absurdity ceiling, not a game rule - see server.js's comment for the
   arithmetic behind the number. */
const MAX_STAT_DELTA = 1000;
type SanitizedEntry = { clean: string; keys: Record<string, number> };
function sanitizeLeaderboardDelta(name: unknown, delta: unknown): SanitizedEntry | null {
  const clean = cleanName(name, "");
  if (!clean || isBadName(clean) || !delta || typeof delta !== "object") return null;
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
  const out: Record<string, number> = {};
  let any = false;
  for (const k of Object.keys(d)) {
    const key = k === "hpts" ? legacyPtsTarget : k;
    if (!key || !NUMERIC_STAT_KEY.test(key)) continue;
    const raw = d[k];
    if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0 || raw > MAX_STAT_DELTA) {
      log("leaderboard delta key rejected", clean, key + "=" + JSON.stringify(raw));
      continue;
    }
    out[key] = (out[key] || 0) + raw;   // two aliases landing on one key (hpts + hptsS) still sum
    any = true;
  }
  if (!any) return null;
  return { clean, keys: out };
}
/* 2026-07-25 (bug 6): the lower-cased name index. KV has no case-insensitive lookup, so one tiny
   key per player maps the folded name to the DISPLAY name its stat counters live under. Twin of
   server.js's in-memory lbNameIndex Map (that file can afford to hold the whole board in
   memory; this one cannot, so the index is stored). The display capitalization is STICKY - the
   first spelling to reach the board keeps the row for good. Rewriting it later would mean moving
   up to ten separate KV counters non-atomically on an ordinary game finish, risking real stat
   loss for a purely cosmetic gain. */
function lbNameIndexKey(clean: string): Deno.KvKey { return ["lbname", leaderboardNameKey(clean)]; }
async function boardKeyFor(clean: string): Promise<string> {
  const idx = await kv.get<string>(lbNameIndexKey(clean));
  if (typeof idx.value === "string" && idx.value) return idx.value;
  await kv.set(lbNameIndexKey(clean), clean);
  return clean;
}
async function applyLeaderboardEntry(name: unknown, delta: unknown) {
  const s = sanitizeLeaderboardDelta(name, delta);
  if (!s) return;
  const bk = await boardKeyFor(s.clean);
  for (const key of Object.keys(s.keys)) {
    await kv.atomic().sum(["leaderboard", bk, key], BigInt(s.keys[key])).commit();
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

/* 2026-07-25 § LEADERBOARD NAME-CASE MERGE MIGRATION (bug 6) - twin of server.js's matching
   function; read that one first for the full "why" and the winner-selection rules (most games
   wins the display capitalization; ties break on total stats, then alphabetically). This is the
   KV-shaped version, and it also (re)builds the ["lbname", lower] index every row needs.

   THE SAFETY ARGUMENT, which is why this looks different from server.js's straightforward
   in-memory sum. Node holds the whole board in memory and persists it with ONE write, so a crash
   mid-merge simply leaves the on-disk file untouched. KV has no such all-or-nothing moment: a
   naive "read every duplicate, write the summed total onto the winner, then delete the losers"
   would DOUBLE-COUNT if it were interrupted between the write and the deletes, because a second
   run would find the winner already holding the merged total AND the losers still holding
   theirs. So nothing here ever writes a computed total. Instead each losing counter is MOVED,
   one key at a time, in a single atomic transaction that is conditional on that loser key not
   having changed:
       check(loserEntry).sum(winnerKey, loserValue).delete(loserKey)
   Either both halves land or neither does. Interrupt it anywhere and the not-yet-moved counters
   are all still sitting untouched on their original rows, so the next boot simply finishes the
   job - resumable, and exactly-once per counter no matter how many times it runs.
   Idempotency is then structural, exactly as in server.js: once no two rows share a folded name,
   there is nothing to merge and later boots write nothing at all. */
async function migrateLeaderboardNameCase(): Promise<void> {
  const rows: Record<string, Record<string, number>> = {};
  for await (const e of kv.list<Deno.KvU64>({ prefix: ["leaderboard"] })) {
    const name = String(e.key[1]);
    rows[name] = rows[name] || {};
    rows[name][String(e.key[2])] = Number(e.value.value);
  }
  const groups = new Map<string, string[]>();
  for (const name of Object.keys(rows)) {
    const lower = leaderboardNameKey(name);
    if (!groups.has(lower)) groups.set(lower, []);
    groups.get(lower)!.push(name);
  }
  const totalGames = (r: Record<string, number>) => ["hg4s", "hg6s", "hg4t", "hg6t"].reduce((a, k) => a + (Number(r[k]) || 0), 0);
  const totalAll = (r: Record<string, number>) => Object.keys(r).reduce((a, k) => a + (Number.isFinite(r[k]) ? r[k] : 0), 0);
  let merged = 0;
  for (const [lower, names] of groups) {
    const sorted = names.slice().sort((a, b) => {
      const ga = totalGames(rows[a]), gb = totalGames(rows[b]);
      if (ga !== gb) return gb - ga;
      const ta = totalAll(rows[a]), tb = totalAll(rows[b]);
      if (ta !== tb) return tb - ta;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    const winner = sorted[0];
    // The index has to exist for EVERY row, duplicates or not - that is what routes a future
    // game submitted under a different capitalization onto this row.
    const idx = await kv.get<string>(["lbname", lower]);
    if (idx.value !== winner) await kv.set(["lbname", lower], winner);
    if (sorted.length < 2) continue;   // nothing to merge - the normal case, and the idempotency guard
    for (const loser of sorted.slice(1)) {
      for (const statKey of Object.keys(rows[loser])) {
        // Re-read each loser counter inside the loop so the atomic `check` is against its
        // CURRENT version, not the (possibly stale) value from the scan above.
        const cur = await kv.get<Deno.KvU64>(["leaderboard", loser, statKey]);
        if (!cur.value) continue;
        const ok = await kv.atomic()
          .check(cur)
          .sum(["leaderboard", winner, statKey], cur.value.value)
          .delete(["leaderboard", loser, statKey])
          .commit();
        if (!ok.ok) log("name-case merge lost a race on", loser, statKey, "- it will be finished on the next boot");
      }
      merged++;
    }
    log("merged leaderboard rows", JSON.stringify(sorted.slice(1)), "into", JSON.stringify(winner));
  }
  if (merged) log("merged", merged, "duplicate-capitalization leaderboard rows");
}

let lbMigrationReady: Promise<void> | null = null;
// Same lazy-once-per-isolate pattern as ensureKv() above (see that comment for why nothing
// here can run at module/top-level scope on this platform) - called from handler() right after
// ensureKv() resolves, so every request path is covered, but the actual KV scan+write only
// ever happens once per isolate.
function ensureLeaderboardMigrated(): Promise<void> {
  // 2026-07-25 (bug 6): ORDER IS LOAD-BEARING, exactly as in server.js - the solo/teams split
  // must run BEFORE the name-case merge, so a legacy pre-split row's plain "hpts" is turned into
  // hptsS/hptsT while that row still stands alone. Merging first would fold it into a sibling
  // that already has hptsS/hptsT, and the split migration's own "already split, skip" guard
  // would then leave those legacy points stranded.
  if (!lbMigrationReady) lbMigrationReady = migrateLegacyLeaderboardPoints().then(() => migrateLeaderboardNameCase());
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
  // 2026-07-25 (bug 6): drop the folded-name index entry too, or a later game under this name
  // would be routed to a row that no longer exists. Only if it actually points at THIS row -
  // never clobber another capitalization's live index entry.
  const idx = await kv.get<string>(lbNameIndexKey(name));
  if (idx.value === name) await kv.delete(lbNameIndexKey(name));
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
  // 2026-07-25 (bug 6): a new season starts with an empty folded-name index too.
  for await (const e of kv.list({ prefix: ["lbname"] })) await kv.delete(e.key);
  // 2026-07-25 § ACCOUNTS: and with empty account-keyed rows - they are leaderboard rows, just
  // in their own namespace. Accounts, sessions and the name index are deliberately LEFT ALONE:
  // after a reset you are still signed in and still own your name. Twin of server.js's line.
  for await (const e of kv.list({ prefix: ["lbacct"] })) await kv.delete(e.key);
  const epoch = (await getEpoch()) + 1;
  await kv.set(EPOCH_KEY, epoch);
  return epoch;
}
// Sent with EVERY response that touches the leaderboard - public /leaderboard reads, the
// admin equivalent, and every /solo-result reply - so any device that talks to the server for
// ANY of those reasons picks up a reset promptly. Header, not body shape, so old clients that
// don't know about epochs are completely unaffected (see server.js's matching comment).
async function jsonLeaderboard(status: number): Promise<Response> {
  // 2026-07-25 § ACCOUNTS: with the account-only switch OFF (production today, and the default)
  // boardRowsForDisplay() returns getLeaderboard()'s result untouched, so this is byte-for-byte
  // the response it has always been.
  const [rows, epoch] = await Promise.all([boardRowsForDisplay(), getEpoch()]);
  const board = rows.flat;
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
  // 2026-07-25 (bug 4) § SEEN-MARKER ORDERING - twin of server.js's matching block, and the
  // reason it exists at all is this file: the old order (apply, THEN mark seen) meant a throw
  // part-way through applying left the gameId unmarked, so the device retried the same
  // submission forever while some of its keys had already landed. Validate everything first
  // (sanitizeLeaderboardDelta writes nothing), then mark seen, then apply - at-most-once, and
  // always a final answer for the client's offline queue.
  const sanitized: SanitizedEntry[] = [];
  for (const e of entries) { if (e && e.name) { const s = sanitizeLeaderboardDelta(e.name, e.delta); if (s) sanitized.push(s); } }
  await kv.set(soloSeenKey(gameId), true, { expireIn: SOLO_ID_TTL_MS });
  /* 2026-07-25 § ACCOUNTS: attribution, twin of server.js's.
     SWITCH OFF (production today, and the default): every entry lands on its name row exactly as
     it always has, and the `auth` field a future client may send is accepted and ignored.
     SWITCH ON: only the SIGNED-IN player's own result reaches the shared board, credited to
     their account. Everything else on that device is a guest result - it still counted in the
     device's own local stats, and the answer is still a plain 200 so nothing retries forever. */
  let credited: string[] = [];
  if (accountsOnlyBoard()) {
    const me = await resolveSession((body as Record<string, unknown>).auth);
    if (me && me.account && me.account.nameFolded) {
      for (const s of sanitized) {
        if (leaderboardNameKey(s.clean) !== me.account.nameFolded) continue;
        await applyAccountLeaderboardEntry(me.uid, s.clean, s.keys);
        credited.push(s.clean);
      }
    }
  } else {
    for (const s of sanitized) await applyLeaderboardEntry(s.clean, s.keys);
    credited = sanitized.map((s) => s.clean);
  }
  log("solo result recorded", gameId, credited.join(","));
  /* v0.40 (2026-07-26): the reply now SAYS what it did. Until now this was a bare
     {ok:true,epoch}, so a client could not tell the difference between "recorded" and "accepted
     and silently dropped because the account-only switch is on and you did not send `auth`" -
     which is exactly the failure that lost a run of real games. Both keys are additive; an older
     client simply ignores them, so no protocol bump. Twin of server.js's. */
  return json(200, { ok: true, epoch, accountsOnly: accountsOnlyBoard(), credited });
}

/* =======================================================================================
 * 2026-07-25 § ACCOUNTS - SERVER PLUMBING, DORMANT.
 *
 * EXACT TWIN of server.js's § ACCOUNTS section - same routes, same rules, same plain-language
 * strings, same numbers. Read that file's block comment for the full reasoning: what "dormant"
 * means, why the kill switch is an env flag rather than a data restore, why the account rows
 * live in their own namespace, why there is no JWT library, why a verified email IS now stored
 * (a deliberate reversal of Stage 1, forced by having four sign-in methods instead of one), why
 * the leaderboard becomes account-only going forward, and why the name claim is a one-time
 * migration window whose unclaimed rows are frozen rather than deleted.
 * This file is the PRODUCTION server; server.js is local/dev/tests. They must not diverge.
 *
 * The only differences here are storage-shaped, because Deno Deploy has KV and no disk:
 *
 *   server.js file                     this file's KV keys
 *   ---------------------------------  ----------------------------------------------------
 *   accounts.json                      ["account", uid]
 *   account-index.json                 ["acctidx","apple",sub] and ["acctidx","name",folded]
 *   sessions.json                      ["session", token]         (native expireIn)
 *   auth-nonces.json                   ["authnonce", nonce]       (native expireIn, 10 min)
 *   accounts-leaderboard.json          ["lbacct", uid, statKey]   (Deno.KvU64, like ["leaderboard"])
 *   claims.json                        ["claimjournal", uid]
 *   email-codes.json                   ["emailcode", folded]      (native expireIn, 24 h)
 *
 * The account-index prefix now holds one entry per LINKED SIGN-IN METHOD, not just Apple:
 *   ["acctidx","apple",sub] ["acctidx","google",sub] ["acctidx","facebook",id]
 *   ["acctidx","email",addr]   the email sign-in method's own identity
 *   ["acctidx","mail",addr]    the verified-email LINKING index (deliberately a different word
 *                              from the provider named "email", so the two never collide)
 *   ["acctidx","name",folded]  game-name uniqueness, unchanged
 *
 * Two KV-specific care points, both deliberate:
 *   - the nonce is consumed with an ATOMIC check+delete, so two isolates racing the same nonce
 *     cannot both win. (server.js is single-threaded, so a plain delete is already atomic there.)
 *   - the claim writes the account row with `set`, never `sum`. Deno.KvU64 is UNSIGNED, so a
 *     rollback that lowers a counter would throw on a sum; and because the merge is a pure
 *     function of the journal, `set` is also what makes re-running it safe after a crash.
 * ===================================================================================== */

function accountsEnvFlagOn(raw: string | undefined, dflt: string): boolean {
  const s = String(raw == null || raw === "" ? dflt : raw).trim().toLowerCase();
  return !(s === "0" || s === "false" || s === "off" || s === "no");
}
function accountsEnvMs(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
const ACCOUNTS_ENABLED = accountsEnvFlagOn(Deno.env.get("NASTY_ACCOUNTS_ENABLED"), "1");
function accountsEnvList(raw: string | undefined): string[] {
  return String(raw || "").split(",").map((s) => s.trim()).filter(Boolean);
}
/* --- the four sign-in methods, twin of server.js's block. Every one is INDEPENDENTLY
   configured and every one is OFF until Blake pastes its identifiers into this app's Deno
   Deploy environment, which is what keeps this whole section inert in production today. --- */
const APPLE_ISSUERS = accountsEnvList(Deno.env.get("NASTY_APPLE_ISSUER") || "https://appleid.apple.com");
const APPLE_JWKS_URL = (Deno.env.get("NASTY_APPLE_JWKS_URL") || "https://appleid.apple.com/auth/keys").trim();
const APPLE_AUDIENCES = accountsEnvList(Deno.env.get("NASTY_APPLE_AUDIENCES"));
const GOOGLE_ISSUERS = accountsEnvList(Deno.env.get("NASTY_GOOGLE_ISSUER") || "https://accounts.google.com,accounts.google.com");
const GOOGLE_JWKS_URL = (Deno.env.get("NASTY_GOOGLE_JWKS_URL") || "https://www.googleapis.com/oauth2/v3/certs").trim();
const GOOGLE_AUDIENCES = accountsEnvList(Deno.env.get("NASTY_GOOGLE_AUDIENCES"));
const FACEBOOK_ISSUERS = accountsEnvList(Deno.env.get("NASTY_FACEBOOK_ISSUER") || "https://www.facebook.com,https://facebook.com");
const FACEBOOK_JWKS_URL = (Deno.env.get("NASTY_FACEBOOK_JWKS_URL") || "https://www.facebook.com/.well-known/oauth/openid/jwks/").trim();
const FACEBOOK_APP_ID = (Deno.env.get("NASTY_FACEBOOK_APP_ID") || "").trim();
const FACEBOOK_APP_SECRET = (Deno.env.get("NASTY_FACEBOOK_APP_SECRET") || "").trim();
const FACEBOOK_GRAPH_URL = (Deno.env.get("NASTY_FACEBOOK_GRAPH_URL") || "https://graph.facebook.com/v21.0").trim().replace(/\/+$/, "");
const EMAIL_PROVIDER = String(Deno.env.get("NASTY_EMAIL_PROVIDER") || "").trim().toLowerCase();
const EMAIL_API_KEY = (Deno.env.get("NASTY_EMAIL_API_KEY") || "").trim();
const EMAIL_API_URL = (Deno.env.get("NASTY_EMAIL_API_URL") || "").trim();
const EMAIL_FROM = (Deno.env.get("NASTY_EMAIL_FROM") || "").trim();

type OidcProviderConfig = { name: string; issuers: string[]; jwksUrl: string; audiences: string[] };
const OIDC_PROVIDERS: Record<string, OidcProviderConfig> = {
  apple: { name: "apple", issuers: APPLE_ISSUERS, jwksUrl: APPLE_JWKS_URL, audiences: APPLE_AUDIENCES },
  google: { name: "google", issuers: GOOGLE_ISSUERS, jwksUrl: GOOGLE_JWKS_URL, audiences: GOOGLE_AUDIENCES },
  facebook: { name: "facebook", issuers: FACEBOOK_ISSUERS, jwksUrl: FACEBOOK_JWKS_URL, audiences: FACEBOOK_APP_ID ? [FACEBOOK_APP_ID] : [] },
};
function emailSenderConfigured(): boolean {
  if (!EMAIL_PROVIDER || EMAIL_PROVIDER === "off" || EMAIL_PROVIDER === "none") return false;
  if (EMAIL_PROVIDER === "console") return true;
  return !!(EMAIL_API_KEY && EMAIL_FROM);
}
function providerConfigured(p: string): boolean {
  if (p === "apple") return APPLE_AUDIENCES.length > 0;
  if (p === "google") return GOOGLE_AUDIENCES.length > 0;
  if (p === "facebook") return !!FACEBOOK_APP_ID;
  if (p === "email") return emailSenderConfigured();
  return false;
}
function configuredProviders(): string[] { return ["apple", "google", "facebook", "email"].filter(providerConfigured); }
function anyProviderConfigured(): boolean { return configuredProviders().length > 0; }
function accountsConfigured(): boolean { return ACCOUNTS_ENABLED && anyProviderConfigured(); }

const SESSION_TTL_MS = accountsEnvMs(Deno.env.get("NASTY_SESSION_TTL_MS"), 400 * 24 * 60 * 60 * 1000);
const SESSION_SLIDE_AFTER_MS = accountsEnvMs(Deno.env.get("NASTY_SESSION_SLIDE_AFTER_MS"), 30 * 24 * 60 * 60 * 1000);
const NAME_COOLDOWN_MS = accountsEnvMs(Deno.env.get("NASTY_NAME_COOLDOWN_MS"), 30 * 24 * 60 * 60 * 1000);
const AUTH_NONCE_TTL_MS = accountsEnvMs(Deno.env.get("NASTY_AUTH_NONCE_TTL_MS"), 10 * 60 * 1000);
const APPLE_JWKS_TTL_MS = 6 * 60 * 60 * 1000;
const APPLE_CLOCK_SKEW_MS = 10 * 60 * 1000;
const APPLE_TOKEN_MAX_CHARS = 8192;
const ACCOUNT_RATE_LIMIT = accountsEnvMs(Deno.env.get("NASTY_ACCOUNT_RATE_LIMIT"), 120);
const ACCOUNT_RATE_WINDOW_MS = 60 * 1000;
const EMAIL_CODE_TTL_MS = accountsEnvMs(Deno.env.get("NASTY_EMAIL_CODE_TTL_MS"), 10 * 60 * 1000);
const EMAIL_CODE_MAX_ATTEMPTS = accountsEnvMs(Deno.env.get("NASTY_EMAIL_CODE_MAX_ATTEMPTS"), 5);
const EMAIL_CODE_RESEND_MS = accountsEnvMs(Deno.env.get("NASTY_EMAIL_CODE_RESEND_MS"), 60 * 1000);
const EMAIL_CODE_MAX_PER_DAY = accountsEnvMs(Deno.env.get("NASTY_EMAIL_CODE_MAX_PER_DAY"), 12);
const ACCOUNTS_UNAVAILABLE_BODY = {
  error: "accounts unavailable",
  message: "Signing in isn't set up yet. You can keep playing without an account.",
};
const SIGNED_OUT_BODY = {
  error: "signedout",
  message: "You've been signed out. You can keep playing - sign in again any time.",
};

/* --- THE CLAIM SUNSET, twin of server.js's. The one-time migration window in which somebody
   who already has history on the family board can move it onto a brand-new account. After it
   closes, /account/claim answers 410 and /account/name stops offering it - and every row nobody
   claimed stays on the board as a FROZEN HISTORICAL entry. Nothing is ever deleted. --- */
function accountsEnvDeadline(raw: string | undefined): number {
  const s = String(raw || "").trim();
  if (!s) return 0;
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return n;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}
const CLAIM_WINDOW_OPEN = accountsEnvFlagOn(Deno.env.get("NASTY_CLAIM_WINDOW_OPEN"), "1");
const CLAIM_DEADLINE_MS = accountsEnvDeadline(Deno.env.get("NASTY_CLAIM_DEADLINE"));
function claimWindowOpen(): boolean { return CLAIM_WINDOW_OPEN && (!CLAIM_DEADLINE_MS || Date.now() < CLAIM_DEADLINE_MS); }
function claimWindowView() { return { open: claimWindowOpen(), closesAt: CLAIM_DEADLINE_MS || 0 }; }
const CLAIM_CLOSED_BODY = {
  error: "claimclosed",
  message: "The one-time window for moving an older name onto an account has closed. Older names stay on the board as history - new games count on your account from here.",
};

/* --- THE ACCOUNT-ONLY LEADERBOARD SWITCH, twin of server.js's. Accounts stay OPTIONAL for
   playing; going forward only a signed-in account accrues on and appears on the shared board.
   Gated three ways (kill switch, at least one configured provider, its own flag which defaults
   OFF) so it is completely dormant right now. --- */
const LEADERBOARD_ACCOUNTS_ONLY = accountsEnvFlagOn(Deno.env.get("NASTY_LEADERBOARD_ACCOUNTS_ONLY"), "0");
function accountsOnlyBoard(): boolean { return ACCOUNTS_ENABLED && LEADERBOARD_ACCOUNTS_ONLY && anyProviderConfigured(); }

/* =======================================================================================
 * 2026-07-28 § POINTS WALLET - twin of server.js's. A per-account SPENDABLE BALANCE, separate
 * from the leaderboard's LIFETIME EARNED points (hptsS/hptsT), which rank the leaderboard and
 * must never decrease. balance = lifetime earned - lifetime spent, computed live on every read
 * (see accountEarnedPoints()/walletView() further down, right after boardRowsForDisplay() since
 * they reuse its exact per-account shadowing rule) rather than stored redundantly.
 *
 * SERVER-OWNED CATALOG - the client is never trusted for prices; a purchase re-reads the cost
 * from this array every time. Byte-identical item list to server.js's SHOP_CATALOG - keep both in
 * sync if it ever changes, same convention as pointsForWinServer/buildResultEntriesServer.
 * ===================================================================================== */
// Palette entries carry colors4/colors6 - full replacement sets for the client's
// COLORS4/COLORS6 arrays, same {name,c,dark} shape per seat (the per-seat NAME feeds
// team-pairing text like "Green + Pink"). Felt c/dark are the two radial-gradient stops,
// replacements for the client's --felt1/--felt2 (default #256b46/#0e3421).
type SeatColor = { name: string; c: string; dark: string };
type ShopItem = {
  id: string; category: string; name: string; cost: number; consumable?: boolean;
  colors4?: SeatColor[]; colors6?: SeatColor[]; c?: string; dark?: string;
};
const SHOP_CATALOG: ShopItem[] = [
  {
    id: "palette_sunset", category: "palette", name: "Sunset", cost: 40,
    colors4: [
      { name: "Coral", c: "#e8604c", dark: "#9c3423" },
      { name: "Dusk", c: "#3e4e7e", dark: "#232e4e" },
      { name: "Rose", c: "#e08bb0", dark: "#9c4f74" },
      { name: "Gold", c: "#f2a93b", dark: "#a56f12" },
    ],
    colors6: [
      { name: "Coral", c: "#e8604c", dark: "#9c3423" },
      { name: "Dusk", c: "#3e4e7e", dark: "#232e4e" },
      { name: "Rose", c: "#e08bb0", dark: "#9c4f74" },
      { name: "Cream", c: "#f2e4c4", dark: "#b5a377" },
      { name: "Violet", c: "#8a5ba6", dark: "#54326a" },
      { name: "Gold", c: "#f2a93b", dark: "#a56f12" },
    ],
  },
  {
    id: "palette_ocean", category: "palette", name: "Ocean Breeze", cost: 40,
    colors4: [
      { name: "Teal", c: "#2a9d8f", dark: "#175a52" },
      { name: "Deep Blue", c: "#2d4f8f", dark: "#182c55" },
      { name: "Coral", c: "#ee6352", dark: "#a2372a" },
      { name: "Sand", c: "#edd9a3", dark: "#ab9354" },
    ],
    colors6: [
      { name: "Teal", c: "#2a9d8f", dark: "#175a52" },
      { name: "Deep Blue", c: "#2d4f8f", dark: "#182c55" },
      { name: "Coral", c: "#ee6352", dark: "#a2372a" },
      { name: "Sand", c: "#edd9a3", dark: "#ab9354" },
      { name: "Anemone", c: "#8f68b8", dark: "#553a74" },
      { name: "Seafoam", c: "#9fd8c5", dark: "#5d9a85" },
    ],
  },
  {
    id: "palette_forest", category: "palette", name: "Forest", cost: 60,
    colors4: [
      { name: "Moss", c: "#6f9a3d", dark: "#425e1f" },
      { name: "Sky", c: "#7fb6d9", dark: "#41708f" },
      { name: "Berry", c: "#b04a72", dark: "#6e2543" },
      { name: "Amber", c: "#e2a83c", dark: "#96690f" },
    ],
    colors6: [
      { name: "Moss", c: "#6f9a3d", dark: "#425e1f" },
      { name: "Sky", c: "#7fb6d9", dark: "#41708f" },
      { name: "Berry", c: "#b04a72", dark: "#6e2543" },
      { name: "Birch", c: "#efe7d4", dark: "#b7ab88" },
      { name: "Bark", c: "#8a5a34", dark: "#54351d" },
      { name: "Amber", c: "#e2a83c", dark: "#96690f" },
    ],
  },
  {
    id: "palette_royal", category: "palette", name: "Royal", cost: 90,
    colors4: [
      { name: "Emerald", c: "#1f8a5c", dark: "#0f5236" },
      { name: "Sapphire", c: "#3a55b4", dark: "#1f2f6e" },
      { name: "Crimson", c: "#b12a3c", dark: "#6d1220" },
      { name: "Gold", c: "#d4af37", dark: "#8a6d14" },
    ],
    colors6: [
      { name: "Emerald", c: "#1f8a5c", dark: "#0f5236" },
      { name: "Sapphire", c: "#3a55b4", dark: "#1f2f6e" },
      { name: "Crimson", c: "#b12a3c", dark: "#6d1220" },
      { name: "Ivory", c: "#f1e9d5", dark: "#b6ab89" },
      { name: "Amethyst", c: "#7d3fa8", dark: "#4a2166" },
      { name: "Gold", c: "#d4af37", dark: "#8a6d14" },
    ],
  },
  {
    id: "palette_midnight", category: "palette", name: "Midnight", cost: 130,
    colors4: [
      { name: "Cyan", c: "#3fc5d1", dark: "#20707a" },
      { name: "Violet", c: "#7a63d9", dark: "#463693" },
      { name: "Magenta", c: "#d955a8", dark: "#8c2f68" },
      { name: "Amber", c: "#f0a832", dark: "#a06d10" },
    ],
    colors6: [
      { name: "Cyan", c: "#3fc5d1", dark: "#20707a" },
      { name: "Violet", c: "#7a63d9", dark: "#463693" },
      { name: "Magenta", c: "#d955a8", dark: "#8c2f68" },
      { name: "Silver", c: "#c9ced9", dark: "#848b9c" },
      { name: "Lime", c: "#9ed14b", dark: "#5e8422" },
      { name: "Amber", c: "#f0a832", dark: "#a06d10" },
    ],
  },
  { id: "felt_burgundy", category: "felt", name: "Burgundy Felt", cost: 15, c: "#6b2433", dark: "#35101a" },
  { id: "felt_navy", category: "felt", name: "Navy Felt", cost: 15, c: "#23456b", dark: "#0e1f35" },
  { id: "felt_charcoal", category: "felt", name: "Charcoal Felt", cost: 20, c: "#3a4048", dark: "#16191d" },
  { id: "felt_sunflower", category: "felt", name: "Sunflower Felt", cost: 20, c: "#c99a1e", dark: "#6b4e08" },
  { id: "title_rookie", category: "title", name: "Rookie", cost: 10 },
  { id: "title_shark", category: "title", name: "Card Shark", cost: 30 },
  { id: "title_legend", category: "title", name: "Legend", cost: 60 },
  { id: "title_nasty", category: "title", name: "Certified Nasty", cost: 90 },
  { id: "namechange_credit", category: "namechange", name: "Name Change Token", cost: 25, consumable: true },
];
function shopItemById(id: string): ShopItem | null { return SHOP_CATALOG.find((it) => it.id === id) || null; }

type AccountIdentity = { provider: string; sub: string; linkedAt: number };
type AccountRecord = {
  uid: string; provider: string; sub: string;
  identities?: AccountIdentity[];
  // 2026-07-25: a VERIFIED email is now stored, and it is the linking key that stops one human
  // with four sign-in methods becoming four accounts. This reverses Stage 1's "store no email"
  // decision - see server.js's LINKING block for the full reasoning and its honest limits.
  email?: string | null; emailSource?: string | null; emailPrivateRelay?: boolean;
  gameName: string | null; nameFolded: string | null; nameChangedAt: number;
  nameHistory: { name: string | null; from: number; to: number }[];
  claimDeclined: boolean; created: number; lastSeen: number; refreshToken: string | null;
  // 2026-07-28 § POINTS WALLET - twin of server.js's. Optional so an account record written
  // before this feature existed still parses; every read defaults these with `|| 0` / `|| []`.
  walletSpent?: number;
  walletOwned?: string[];
  walletNamechangeCredits?: number;
};
type SessionRecord = { uid: string; exp: number };
type EmailChallenge = { hash: string; exp: number; attempts: number; sentAt: number; sentToday: number; dayStart: number };
type ClaimJournal = {
  uid: string; folded: string; ts: number;
  rows: Record<string, Record<string, number>>;
  pre: Record<string, number>;
  state: "pending" | "done" | "undone";
};

function accountKey(uid: string): Deno.KvKey { return ["account", uid]; }
function identityIdxKey(provider: string, sub: string): Deno.KvKey { return ["acctidx", provider, sub]; }
function appleIdxKey(sub: string): Deno.KvKey { return identityIdxKey("apple", sub); }
// Deliberately "mail", not "email" - "email" is also a PROVIDER name, and the identity index
// already lives at ["acctidx", <provider>, <sub>]. Two indexes must not share one key space.
function emailIdxKey(folded: string): Deno.KvKey { return ["acctidx", "mail", folded]; }
function nameIdxKey(folded: string): Deno.KvKey { return ["acctidx", "name", folded]; }
function emailCodeKey(folded: string): Deno.KvKey { return ["emailcode", folded]; }
function sessionKey(token: string): Deno.KvKey { return ["session", token]; }
function authNonceKey(nonce: string): Deno.KvKey { return ["authnonce", nonce]; }
function acctBoardKey(uid: string, statKey: string): Deno.KvKey { return ["lbacct", uid, statKey]; }
function claimJournalKey(uid: string): Deno.KvKey { return ["claimjournal", uid]; }

function accountsRandHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* --- Apple identity token verification. Same six mandatory checks, same order, same hardcoded
   RS256-only verifier as server.js - see that file for the reasoning behind each one, including
   why the alg check is an equality test rather than a blocklist. --- */
// The explicit Uint8Array<ArrayBuffer> is not decoration: crypto.subtle.verify() wants a
// BufferSource backed by a real ArrayBuffer, and a bare `Uint8Array` widens to ArrayBufferLike
// (which could be a SharedArrayBuffer) and fails `deno check`.
function accountsB64uToBytes(s: string): Uint8Array<ArrayBuffer> {
  let t = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function accountsB64uToJson(s: string): unknown {
  return JSON.parse(new TextDecoder().decode(accountsB64uToBytes(s)));
}
// One cache per JWKS URL - Apple, Google and Facebook each publish their own key set at their
// own address and rotate on their own schedules, so they cannot share a single slot.
const jwksCache = new Map<string, { keys: Record<string, string>[]; at: number }>();
async function fetchJwks(url: string): Promise<void> {
  const ctl = new AbortController();
  const timer = setTimeout(() => { try { ctl.abort(); } catch (_e) { /* already done */ } }, 8000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error("jwks http " + r.status);
    const body = await r.json();
    if (!body || !Array.isArray(body.keys)) throw new Error("jwks shape");
    jwksCache.set(url, { keys: body.keys, at: Date.now() });
  } finally { clearTimeout(timer); }
}
async function jwkForKid(url: string, kid: string): Promise<Record<string, string> | null> {
  const cached = jwksCache.get(url);
  if (!cached || Date.now() - cached.at > APPLE_JWKS_TTL_MS) await fetchJwks(url);
  let k = (jwksCache.get(url)?.keys || []).find((j) => j && j.kid === kid);
  if (!k) {   // key rotation: exactly one forced refetch, then fail closed
    await fetchJwks(url);
    k = (jwksCache.get(url)?.keys || []).find((j) => j && j.kid === kid);
  }
  return k || null;
}
type ProviderIdentity = { sub: string; email?: string | null; emailVerified?: boolean; privateRelay?: boolean };
type AppleVerifyResult = ({ ok: true } & ProviderIdentity) | { ok: false; reason: string };
function oidcBool(v: unknown): boolean { return v === true || v === "true"; }
function emailFromOidcPayload(payload: Record<string, unknown>): ProviderIdentity {
  const raw = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!raw || !isPlausibleEmail(raw)) return { sub: "", email: null, emailVerified: false, privateRelay: false };
  return {
    sub: "",
    email: raw,
    emailVerified: oidcBool(payload.email_verified),
    privateRelay: oidcBool(payload.is_private_email) || /@privaterelay\.appleid\.com$/i.test(raw),
  };
}
/* The ONE OpenID Connect verifier, used by Apple, by Google, and by Facebook's Limited Login.
   Twin of server.js's - same checks, same order, same strictness, and deliberately still just
   one implementation. Throws only if the provider's key list is unreachable. */
async function verifyOidcToken(cfg: OidcProviderConfig, rawToken: unknown, expectedNonce: string): Promise<AppleVerifyResult> {
  const token = typeof rawToken === "string" ? rawToken : "";
  if (!token || token.length > APPLE_TOKEN_MAX_CHARS) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  let header: Record<string, unknown>, payload: Record<string, unknown>;
  try {
    header = accountsB64uToJson(parts[0]) as Record<string, unknown>;
    payload = accountsB64uToJson(parts[1]) as Record<string, unknown>;
  } catch (_e) { return { ok: false, reason: "malformed" }; }
  if (!header || typeof header !== "object" || !payload || typeof payload !== "object") return { ok: false, reason: "malformed" };
  if (header.alg !== "RS256") return { ok: false, reason: "alg" };
  if (typeof header.kid !== "string" || !header.kid) return { ok: false, reason: "kid" };
  const jwk = await jwkForKid(cfg.jwksUrl, header.kid);
  if (!jwk || jwk.kty !== "RSA") return { ok: false, reason: "kid" };
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
    );
  } catch (_e) { return { ok: false, reason: "kid" }; }
  let good = false;
  try {
    good = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" }, key,
      accountsB64uToBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]),
    );
  } catch (_e) { good = false; }
  if (!good) return { ok: false, reason: "signature" };
  if (typeof payload.iss !== "string" || !cfg.issuers.includes(payload.iss)) return { ok: false, reason: "issuer" };
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!cfg.audiences.length) return { ok: false, reason: "audience" };
  if (!auds.some((a) => typeof a === "string" && cfg.audiences.includes(a))) return { ok: false, reason: "audience" };
  const now = Date.now();
  const exp = payload.exp, iat = payload.iat;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp * 1000 <= now) return { ok: false, reason: "expired" };
  if (typeof iat !== "number" || !Number.isFinite(iat) || Math.abs(now - iat * 1000) > APPLE_CLOCK_SKEW_MS) return { ok: false, reason: "clock" };
  // Mandatory for all three OIDC providers - see server.js. An exception here is how a replay
  // hole gets introduced.
  if (typeof payload.nonce !== "string" || !payload.nonce || payload.nonce !== expectedNonce) return { ok: false, reason: "nonce" };
  if (typeof payload.sub !== "string" || !payload.sub) return { ok: false, reason: "sub" };
  const mail = emailFromOidcPayload(payload);
  return { ok: true, sub: payload.sub, email: mail.email, emailVerified: mail.emailVerified, privateRelay: mail.privateRelay };
}
function verifyAppleIdentityToken(rawToken: unknown, expectedNonce: string): Promise<AppleVerifyResult> {
  return verifyOidcToken(OIDC_PROVIDERS.apple, rawToken, expectedNonce);
}

/* --- Facebook's classic access token: not a JWT, nothing to verify by signature, so the server
   asks Facebook about it directly with an app access token ("<app id>|<app secret>") and
   requires the answer to say the token is valid AND was issued for OUR app. Twin of
   server.js's. --- */
async function inspectFacebookAccessToken(accessToken: unknown): Promise<AppleVerifyResult> {
  const t = typeof accessToken === "string" ? accessToken.trim() : "";
  if (!t || t.length > 4096 || /[\s"']/.test(t)) return { ok: false, reason: "malformed" };
  if (!FACEBOOK_APP_ID) return { ok: false, reason: "unconfigured" };
  if (!FACEBOOK_APP_SECRET) return { ok: false, reason: "nosecret" };
  const appToken = FACEBOOK_APP_ID + "|" + FACEBOOK_APP_SECRET;
  const url = FACEBOOK_GRAPH_URL + "/debug_token?input_token=" + encodeURIComponent(t) +
    "&access_token=" + encodeURIComponent(appToken);
  const ctl = new AbortController();
  const timer = setTimeout(() => { try { ctl.abort(); } catch (_e) { /* already done */ } }, 8000);
  let data: Record<string, unknown>;
  try {
    const r = await fetch(url, { signal: ctl.signal });
    const body = await r.json().catch(() => null);
    if (!body) throw new Error("debug_token unreadable");
    data = body.data;
    if (!data || typeof data !== "object") return { ok: false, reason: "badtoken" };
  } finally { clearTimeout(timer); }
  if (data.is_valid !== true) return { ok: false, reason: "badtoken" };
  if (String(data.app_id || "") !== FACEBOOK_APP_ID) return { ok: false, reason: "audience" };
  const exp = Number(data.expires_at || 0);
  if (exp > 0 && exp * 1000 <= Date.now()) return { ok: false, reason: "expired" };
  const userId = String(data.user_id || "");
  if (!userId) return { ok: false, reason: "sub" };
  let email: string | null = null;
  try {
    const me = await fetch(FACEBOOK_GRAPH_URL + "/me?fields=id,email&access_token=" + encodeURIComponent(t));
    const mb = await me.json().catch(() => null);
    if (mb && String(mb.id || "") === userId && typeof mb.email === "string" && isPlausibleEmail(mb.email.trim().toLowerCase())) {
      email = mb.email.trim().toLowerCase();
    }
  } catch (_e) { /* email is a bonus, never a requirement */ }
  return { ok: true, sub: userId, email, emailVerified: !!email, privateRelay: false };
}

/* =======================================================================================
 * THE PASSWORDLESS EMAIL CODE. Twin of server.js's - read that file's block for the full
 * reasoning, including WHY the mail has to leave over an HTTPS API: this file runs on Deno
 * Deploy, which is an isolate with outbound HTTPS and no SMTP, and Blake's Google Workspace
 * service account is driven by a LOCAL command line tool that this server cannot call and must
 * not hold credentials for. Supported: resend, postmark, and a dev-only console sink. With
 * NASTY_EMAIL_PROVIDER unset - production today - the method is simply not offered.
 * ===================================================================================== */
const EMAIL_MAX_CHARS = 254;
function isPlausibleEmail(s: unknown): boolean {
  const v = String(s || "");
  return v.length >= 6 && v.length <= EMAIL_MAX_CHARS && /^[^\s@,;:<>"']+@[^\s@,;:<>"']+\.[^\s@,;:<>"']{2,}$/.test(v);
}
function foldEmail(s: unknown): string { return String(s || "").trim().toLowerCase(); }
function newEmailCode(): string {
  // Six digits, uniformly: rejection sampling on a 32-bit draw, so there is no modulo bias.
  const buf = new Uint32Array(1);
  const limit = Math.floor(4294967296 / 1000000) * 1000000;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % 1000000).padStart(6, "0");
  }
}
async function hashEmailCode(folded: string, code: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(folded + ":" + code));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Constant-time over equal-length hex digests - a length mismatch is already public information.
function timingSafeHexEqual(a: string, b: string): boolean {
  const x = String(a || ""), y = String(b || "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
/* Retire a code without forgetting that it was sent - twin of server.js's. The hash is wiped and
   the expiry zeroed so it can never be presented again, but sentAt/sentToday survive, which is
   what keeps the resend cooldown and the per-day cap honest. Deleting the record outright would
   let anyone reset both limits just by burning a challenge. KV's own expiry cleans it up. */
async function burnEmailChallenge(folded: string, ch: EmailChallenge): Promise<void> {
  const spent: EmailChallenge = {
    hash: "", exp: 0, attempts: ch.attempts || 0,
    sentAt: ch.sentAt || 0, sentToday: ch.sentToday || 0, dayStart: ch.dayStart || Date.now(),
  };
  await kv.set(emailCodeKey(folded), spent, { expireIn: 24 * 60 * 60 * 1000 });
}
function accountEmailSubject(): string { return "Your NASTY sign-in code"; }
function accountEmailText(code: string): string {
  return "Your NASTY sign-in code is " + code + "\n\n" +
    "It works for the next 10 minutes and only once. If you didn't ask for it, you can ignore this - nothing has changed.\n";
}
async function sendAccountEmail(to: string, code: string): Promise<{ ok: boolean; reason?: string }> {
  if (EMAIL_PROVIDER === "console") { log("EMAIL CODE (console provider, dev only)", to, code); return { ok: true }; }
  const ctl = new AbortController();
  const timer = setTimeout(() => { try { ctl.abort(); } catch (_e) { /* already done */ } }, 10000);
  try {
    let url: string, headers: Record<string, string>, body: string;
    if (EMAIL_PROVIDER === "resend") {
      url = EMAIL_API_URL || "https://api.resend.com/emails";
      headers = { "content-type": "application/json", authorization: "Bearer " + EMAIL_API_KEY };
      body = JSON.stringify({ from: EMAIL_FROM, to: [to], subject: accountEmailSubject(), text: accountEmailText(code) });
    } else if (EMAIL_PROVIDER === "postmark") {
      url = EMAIL_API_URL || "https://api.postmarkapp.com/email";
      headers = { "content-type": "application/json", accept: "application/json", "x-postmark-server-token": EMAIL_API_KEY };
      body = JSON.stringify({ From: EMAIL_FROM, To: to, Subject: accountEmailSubject(), TextBody: accountEmailText(code), MessageStream: "outbound" });
    } else {
      return { ok: false, reason: "unconfigured" };
    }
    const r = await fetch(url, { method: "POST", headers, body, signal: ctl.signal });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      log("email send failed", EMAIL_PROVIDER, r.status, t.slice(0, 200));
      return { ok: false, reason: "sendfailed" };
    }
    return { ok: true };
  } catch (e) {
    log("email send error", EMAIL_PROVIDER, (e as Error).message);
    return { ok: false, reason: "sendfailed" };
  } finally { clearTimeout(timer); }
}

/* --- nonces. Server-issued, single use, 10 minutes, consumed with an ATOMIC check+delete so two
   isolates racing the same nonce cannot both win. This is the replay defence. --- */
async function issueAuthNonce(): Promise<string> {
  const n = accountsRandHex(16);
  await kv.set(authNonceKey(n), Date.now() + AUTH_NONCE_TTL_MS, { expireIn: AUTH_NONCE_TTL_MS });
  return n;
}
async function consumeAuthNonce(n: unknown): Promise<boolean> {
  if (typeof n !== "string" || !n) return false;
  const cur = await kv.get<number>(authNonceKey(n));
  if (!cur.value) return false;
  const ok = await kv.atomic().check(cur).delete(authNonceKey(n)).commit();
  if (!ok.ok) return false;             // somebody else consumed it first - that is a replay
  return cur.value > Date.now();
}

/* --- sessions. Opaque, server-minted, 400 days, sliding. Completely separate from - and
   invisible to - the per-room playerId/token rejoin credential, which this stage does not
   touch. KV's native expireIn does the expiry, and the record carries `exp` too so the sliding
   refresh and the client both have a number to read. --- */
async function issueSession(uid: string): Promise<{ token: string; exp: number }> {
  const token = accountsRandHex(32);
  const exp = Date.now() + SESSION_TTL_MS;
  await kv.set(sessionKey(token), { uid, exp } as SessionRecord, { expireIn: SESSION_TTL_MS });
  return { token, exp };
}
type ResolvedSession = { token: string; uid: string; exp: number; account: AccountRecord };
async function resolveSession(auth: unknown): Promise<ResolvedSession | null> {
  if (typeof auth !== "string" || !auth) return null;
  const cur = await kv.get<SessionRecord>(sessionKey(auth));
  const s = cur.value;
  if (!s) return null;
  const now = Date.now();
  if (!(s.exp > now)) { await kv.delete(sessionKey(auth)); return null; }
  const acctRes = await kv.get<AccountRecord>(accountKey(s.uid));
  const account = acctRes.value;
  if (!account) { await kv.delete(sessionKey(auth)); return null; }
  let exp = s.exp;
  if (s.exp - now < SESSION_TTL_MS - SESSION_SLIDE_AFTER_MS) {
    exp = now + SESSION_TTL_MS;
    await kv.set(sessionKey(auth), { uid: s.uid, exp } as SessionRecord, { expireIn: SESSION_TTL_MS });
  }
  // Once a minute at most - see server.js's matching comment. Here it saves a KV write per
  // authenticated request, which on Deno Deploy is the more expensive half of that trade.
  if (now - (account.lastSeen || 0) > 60 * 1000) {
    account.lastSeen = now;
    await kv.set(accountKey(s.uid), account);
  }
  return { token: auth, uid: s.uid, exp, account };
}
async function revokeAllSessionsFor(uid: string): Promise<number> {
  let n = 0;
  for await (const e of kv.list<SessionRecord>({ prefix: ["session"] })) {
    if (e.value && e.value.uid === uid) { await kv.delete(e.key); n++; }
  }
  return n;
}

/* --- accounts. A provider's `sub` is an INDEX KEY, never the account id - see server.js. --- */
function newAccountRecord(provider: string, sub: string): AccountRecord {
  const now = Date.now();
  return {
    uid: accountsRandHex(16), provider, sub,
    identities: [{ provider, sub, linkedAt: now }],
    email: null, emailSource: null, emailPrivateRelay: false,
    gameName: null, nameFolded: null, nameChangedAt: 0, nameHistory: [],
    claimDeclined: false, created: now, lastSeen: now, refreshToken: null,
    // 2026-07-28 § POINTS WALLET - see server.js's newAccountRecord() for the full reasoning.
    walletSpent: 0, walletOwned: [], walletNamechangeCredits: 0,
  };
}
// Stage 1 records have provider/sub and no identities array - read through this everywhere.
function accountIdentities(acct: AccountRecord): AccountIdentity[] {
  if (Array.isArray(acct.identities) && acct.identities.length) return acct.identities;
  if (acct.provider && acct.sub) return [{ provider: acct.provider, sub: acct.sub, linkedAt: acct.created || 0 }];
  return [];
}
async function accountForIdentity(provider: string, sub: string): Promise<AccountRecord | null> {
  const idx = await kv.get<string>(identityIdxKey(provider, sub));
  if (typeof idx.value !== "string" || !idx.value) return null;
  const existing = await kv.get<AccountRecord>(accountKey(idx.value));
  return existing.value || null;
}
async function accountForEmail(folded: string): Promise<AccountRecord | null> {
  const idx = await kv.get<string>(emailIdxKey(folded));
  if (typeof idx.value !== "string" || !idx.value) return null;
  const existing = await kv.get<AccountRecord>(accountKey(idx.value));
  return existing.value || null;
}

/* --- LINKING. Twin of server.js's block - read that one for the full reasoning, the reversal it
   represents, and the honest limit around Apple private-relay addresses. Rules, in order:
   a known provider identity always wins; otherwise a VERIFIED, non-relay email that we already
   hold links the new identity onto the existing account; otherwise it is a new person. --- */
function linkableEmail(v: ProviderIdentity): boolean {
  return !!(v && v.email && v.emailVerified && !v.privateRelay && isPlausibleEmail(v.email));
}
async function rememberAccountEmail(acct: AccountRecord, provider: string, v: ProviderIdentity): Promise<boolean> {
  if (!v || !v.email || !v.emailVerified || !isPlausibleEmail(v.email)) return false;
  const folded = foldEmail(v.email);
  const owner = await kv.get<string>(emailIdxKey(folded));
  if (typeof owner.value === "string" && owner.value && owner.value !== acct.uid) return false;
  const haveReal = !!acct.email && !acct.emailPrivateRelay;
  if (acct.email === folded && !!acct.emailPrivateRelay === !!v.privateRelay) return false;
  if (haveReal && v.privateRelay) return false;
  const old = acct.email;
  acct.email = folded;
  acct.emailSource = provider;
  acct.emailPrivateRelay = !!v.privateRelay;
  if (old && old !== folded) await kv.delete(emailIdxKey(old));
  await kv.set(accountKey(acct.uid), acct);
  await kv.set(emailIdxKey(folded), acct.uid);
  return true;
}
async function attachIdentity(acct: AccountRecord, provider: string, sub: string): Promise<void> {
  if (!Array.isArray(acct.identities)) acct.identities = accountIdentities(acct).slice();
  if (!acct.identities.some((i) => i.provider === provider && i.sub === sub)) {
    acct.identities.push({ provider, sub, linkedAt: Date.now() });
  }
  await kv.set(accountKey(acct.uid), acct);
  await kv.set(identityIdxKey(provider, sub), acct.uid);
}
type ResolvedAccount = { account: AccountRecord; created: boolean; linked: boolean };
async function resolveAccountForIdentity(provider: string, v: ProviderIdentity): Promise<ResolvedAccount> {
  const idx = await kv.get<string>(identityIdxKey(provider, v.sub));
  if (typeof idx.value === "string" && idx.value) {
    const existing = await kv.get<AccountRecord>(accountKey(idx.value));
    if (existing.value) {
      await rememberAccountEmail(existing.value, provider, v);
      return { account: existing.value, created: false, linked: false };
    }
  }
  if (linkableEmail(v)) {
    const byEmail = await accountForEmail(foldEmail(v.email as string));
    if (byEmail) {
      await attachIdentity(byEmail, provider, v.sub);
      log("linked a second sign-in method to an existing account", byEmail.uid, provider);
      return { account: byEmail, created: false, linked: true };
    }
  }
  const rec = newAccountRecord(provider, v.sub);
  // check() on the index so two isolates racing a brand-new sub cannot both create an account.
  const ok = await kv.atomic().check(idx).set(accountKey(rec.uid), rec).set(identityIdxKey(provider, v.sub), rec.uid).commit();
  if (!ok.ok) {
    const again = await kv.get<string>(identityIdxKey(provider, v.sub));
    if (typeof again.value === "string" && again.value) {
      const existing = await kv.get<AccountRecord>(accountKey(again.value));
      if (existing.value) { await rememberAccountEmail(existing.value, provider, v); return { account: existing.value, created: false, linked: false }; }
    }
    await kv.set(accountKey(rec.uid), rec);
    await kv.set(identityIdxKey(provider, v.sub), rec.uid);
  }
  await rememberAccountEmail(rec, provider, v);
  log("new account created", rec.uid, provider);
  return { account: rec, created: true, linked: false };
}
async function accountForAppleSub(sub: string): Promise<AccountRecord> {
  return (await resolveAccountForIdentity("apple", { sub })).account;
}
async function accountOwningFoldedName(folded: string): Promise<string | null> {
  const idx = await kv.get<string>(nameIdxKey(folded));
  if (typeof idx.value !== "string" || !idx.value) return null;
  const acct = await kv.get<AccountRecord>(accountKey(idx.value));
  return acct.value ? idx.value : null;
}

/* --- the name claim. Twin of server.js's, same five ordered steps, same crash-recovery
   argument: the journal is written FIRST and carries both the source snapshot and the account
   row's pre-claim values, which makes step 3 a pure function of the journal and therefore safe
   to re-run any number of times. --- */
async function accountRowFor(uid: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for await (const e of kv.list<Deno.KvU64>({ prefix: ["lbacct", uid] })) {
    out[String(e.key[2])] = Number(e.value.value);
  }
  return out;
}
async function setAccountRow(uid: string, row: Record<string, number>): Promise<void> {
  for await (const e of kv.list({ prefix: ["lbacct", uid] })) {
    if (!Object.prototype.hasOwnProperty.call(row, String(e.key[2]))) await kv.delete(e.key);
  }
  for (const k of Object.keys(row)) {
    // `set`, never `sum` - Deno.KvU64 is unsigned, and this write must be able to go DOWN
    // (a rollback) as well as up. Clamped at zero so an underflow can never throw.
    await kv.set(acctBoardKey(uid, k), new Deno.KvU64(BigInt(Math.max(0, Math.round(row[k])))));
  }
}
async function unclaimedRowsForFolded(folded: string): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  for await (const e of kv.list<Deno.KvU64>({ prefix: ["leaderboard"] })) {
    const name = String(e.key[1]);
    if (leaderboardNameKey(name) !== folded) continue;
    out[name] = out[name] || {};
    out[name][String(e.key[2])] = Number(e.value.value);
  }
  return out;
}
function claimSummary(rows: Record<string, Record<string, number>>) {
  const t: Record<string, number> = {};
  for (const n of Object.keys(rows || {})) for (const k of Object.keys(rows[n])) t[k] = (t[k] || 0) + rows[n][k];
  return {
    games: (t.hg4s || 0) + (t.hg6s || 0) + (t.hg4t || 0) + (t.hg6t || 0),
    wins: (t.hw4s || 0) + (t.hw6s || 0) + (t.hw4t || 0) + (t.hw6t || 0),
    points: (t.hptsS || 0) + (t.hptsT || 0),
    koDealt: t.hkoDealt || 0,
    koTaken: t.hkoTaken || 0,
  };
}
// Test-only crash simulation, twin of server.js's. Unset in production.
function claimFaultPoint(): string { return String(Deno.env.get("NASTY_CLAIM_FAULT") || ""); }
async function runAccountClaim(acct: AccountRecord): Promise<{ alreadyDone: boolean; moved: ReturnType<typeof claimSummary> }> {
  const uid = acct.uid;
  const cur = await kv.get<ClaimJournal>(claimJournalKey(uid));
  let j = cur.value;
  if (j && j.state === "done") return { alreadyDone: true, moved: claimSummary(j.rows) };
  if (!j || j.state !== "pending") {
    const pre = await accountRowFor(uid);
    j = {
      uid, folded: acct.nameFolded || "", ts: Date.now(),
      rows: await unclaimedRowsForFolded(acct.nameFolded || ""), pre, state: "pending",
    };
    // check() on the journal key: two concurrent claim requests for one account cannot both
    // write a fresh journal, so the snapshot can never be taken twice.
    const ok = await kv.atomic().check(cur).set(claimJournalKey(uid), j).commit();
    if (!ok.ok) {
      const again = await kv.get<ClaimJournal>(claimJournalKey(uid));
      if (!again.value) throw new Error("claim journal write lost");
      j = again.value;
      if (j.state === "done") return { alreadyDone: true, moved: claimSummary(j.rows) };
    }
  }
  if (claimFaultPoint() === "after-journal") throw new Error("simulated crash after journal write");
  const target: Record<string, number> = {};
  for (const k of Object.keys(j.pre)) target[k] = j.pre[k];
  for (const n of Object.keys(j.rows)) for (const k of Object.keys(j.rows[n])) target[k] = (target[k] || 0) + j.rows[n][k];
  await setAccountRow(uid, target);
  if (claimFaultPoint() === "after-merge") throw new Error("simulated crash after merge, before source delete");
  for (const n of Object.keys(j.rows)) await deleteLeaderboardEntry(n);
  j.state = "done";
  await kv.set(claimJournalKey(uid), j);
  log("account claim completed", uid, "rows=" + JSON.stringify(Object.keys(j.rows)));
  return { alreadyDone: false, moved: claimSummary(j.rows) };
}
async function undoAccountClaim(uid: string): Promise<{ ok: boolean; error?: string; restored?: string[] }> {
  const cur = await kv.get<ClaimJournal>(claimJournalKey(uid));
  const j = cur.value;
  if (!j) return { ok: false, error: "no claim journal for that account" };
  for (const n of Object.keys(j.rows)) {
    const snap = j.rows[n];
    for (const k of Object.keys(snap)) {
      // Restore verbatim into a vacant name (the normal case); ADD into one that has been
      // written to since the claim, so a rollback never destroys newer data. Twin of server.js.
      const existing = await kv.get<Deno.KvU64>(["leaderboard", n, k]);
      const base = existing.value ? Number(existing.value.value) : 0;
      await kv.set(["leaderboard", n, k], new Deno.KvU64(BigInt(Math.max(0, base + snap[k]))));
    }
    const idx = await kv.get<string>(["lbname", leaderboardNameKey(n)]);
    if (!idx.value) await kv.set(["lbname", leaderboardNameKey(n)], n);
  }
  const pre: Record<string, number> = {};
  for (const k of Object.keys(j.pre)) { const v = j.pre[k]; if (Number.isFinite(v) && v > 0) pre[k] = v; }
  await setAccountRow(uid, pre);
  j.state = "undone";
  await kv.set(claimJournalKey(uid), j);
  log("admin undid account claim", uid);
  return { ok: true, restored: Object.keys(j.rows) };
}

/* --- deletion. Twin of server.js's: by default the leaderboard row SURVIVES, converted back
   into an ordinary unclaimed name row; `eraseBoard:true` removes the counters too. Apple token
   revocation waits on the .p8 key Blake has not created yet, which Apple's own guidance
   explicitly allows - so in-app deletion is compliant from day one. --- */
async function deleteAccountRecord(acct: AccountRecord, eraseBoard: boolean): Promise<{ keptOnBoard: boolean }> {
  const uid = acct.uid;
  const row = await accountRowFor(uid);
  let keptOnBoard = false;
  if (!eraseBoard && acct.gameName && Object.keys(row).length) {
    const bk = await boardKeyFor(acct.gameName);
    for (const k of Object.keys(row)) {
      if (!NUMERIC_STAT_KEY.test(k)) continue;
      const v = row[k];
      if (Number.isFinite(v) && v > 0) { await kv.atomic().sum(["leaderboard", bk, k], BigInt(Math.round(v))).commit(); keptOnBoard = true; }
    }
  }
  await setAccountRow(uid, {});
  if (acct.nameFolded) await kv.delete(nameIdxKey(acct.nameFolded));
  // Every linked sign-in method goes, not just the first one.
  for (const id of accountIdentities(acct)) await kv.delete(identityIdxKey(id.provider, id.sub));
  if (acct.email) await kv.delete(emailIdxKey(acct.email));
  const killed = await revokeAllSessionsFor(uid);
  await kv.delete(accountKey(uid));
  // The claim journal is deliberately KEPT, so an already-run claim stays reversible.
  log("account deleted", uid, "sessions=" + killed, "boardRowKept=" + keptOnBoard);
  return { keptOnBoard };
}

/* =======================================================================================
 * THE ACCOUNT-ONLY LEADERBOARD. Twin of server.js's block - account rows are the only ones that
 * ever grow from here on; the ordinary name rows already there keep being SERVED as FROZEN
 * HISTORICAL entries so the family's real pre-accounts history is never lost, and an account
 * whose game name folds to the same thing shadows its own historical row so nobody appears
 * twice. /leaderboard's flat body shape does not change; /leaderboard/v2 carries the extra
 * "frozen" detail for a client that wants to label it.
 * ===================================================================================== */
async function applyAccountLeaderboardEntry(uid: string, name: unknown, delta: unknown): Promise<void> {
  const s = sanitizeLeaderboardDelta(name, delta);
  if (!s) return;
  for (const key of Object.keys(s.keys)) {
    await kv.atomic().sum(acctBoardKey(uid, key), BigInt(Math.round(s.keys[key]))).commit();
  }
}
type BoardDetailRow = { name: string; stats: Record<string, number>; account: boolean; frozen: boolean };
async function boardRowsForDisplay(): Promise<{ flat: Record<string, Record<string, number>>; detail: BoardDetailRow[] | null }> {
  const board = await getLeaderboard();
  if (!accountsOnlyBoard()) return { flat: board, detail: null };
  const flat: Record<string, Record<string, number>> = {};
  const detail: BoardDetailRow[] = [];
  const accountsList: AccountRecord[] = [];
  for await (const e of kv.list<AccountRecord>({ prefix: ["account"] })) {
    if (e.value) accountsList.push(e.value);
  }
  // Every historical row indexed by its folded name, so an account owning that same name shows as
  // ONE row rather than colliding with it. Twin of server.js's.
  const frozenByFold = new Map<string, { name: string; row: Record<string, number> }>();
  for (const name of Object.keys(board)) frozenByFold.set(leaderboardNameKey(name), { name, row: board[name] });
  const consumed = new Set<string>();
  for (const a of accountsList) {
    if (!a.gameName || !a.nameFolded) continue;
    const own = await accountRowFor(a.uid);
    // History the account owns the name for but has not yet CLAIMED is still displayed, so
    // nothing appears to vanish between picking a name and confirming the history is yours. An
    // explicit decline leaves the old row exactly where it is instead.
    const frozen = a.claimDeclined ? null : frozenByFold.get(a.nameFolded);
    const shown: Record<string, number> = {};
    if (frozen) for (const k of Object.keys(frozen.row)) shown[k] = (shown[k] || 0) + frozen.row[k];
    for (const k of Object.keys(own)) shown[k] = (shown[k] || 0) + own[k];
    if (!Object.keys(shown).length) continue;   // nothing to show, so nothing is shadowed either
    flat[a.gameName] = shown;
    detail.push({ name: a.gameName, stats: shown, account: true, frozen: false });
    consumed.add(a.nameFolded);
  }
  for (const [fold, entry] of frozenByFold) {
    if (consumed.has(fold)) continue;           // shadowed by the account row above
    flat[entry.name] = entry.row;
    detail.push({ name: entry.name, stats: entry.row, account: false, frozen: true });
  }
  return { flat, detail };
}

/* --- § POINTS WALLET (2026-07-28), continued from the SHOP_CATALOG block above. Twin of
   server.js's - accountEarnedPoints() deliberately mirrors boardRowsForDisplay()'s own
   per-account shadowing rule (frozen name-matched row, if any and not declined, PLUS this
   account's own accountRowFor() row) so the wallet's idea of "earned" can never disagree with
   what /leaderboard already shows for this account's name, in either state of the
   NASTY_LEADERBOARD_ACCOUNTS_ONLY switch. No epoch scoping anywhere in this feature - see the
   file header note near EPOCH_KEY for why. --- */
async function accountEarnedPoints(acct: AccountRecord): Promise<number> {
  let hptsS = 0, hptsT = 0;
  if (acct && acct.nameFolded && !acct.claimDeclined) {
    const board = await getLeaderboard();
    for (const name of Object.keys(board)) {
      if (leaderboardNameKey(name) !== acct.nameFolded) continue;
      const r = board[name];
      if (!r) continue;
      hptsS += Number(r.hptsS) || 0;
      hptsT += Number(r.hptsT) || 0;
    }
  }
  const own = acct ? await accountRowFor(acct.uid) : {};
  hptsS += Number(own.hptsS) || 0;
  hptsT += Number(own.hptsT) || 0;
  return hptsS + hptsT;
}
type WalletView = {
  uid: string; lifetimeEarned: number; spent: number; balance: number;
  owned: string[]; namechangeCredits: number;
};
async function walletView(acct: AccountRecord): Promise<WalletView> {
  const earned = await accountEarnedPoints(acct);
  const spent = Math.max(0, Number(acct.walletSpent) || 0);
  return {
    uid: acct.uid,
    lifetimeEarned: earned,
    spent,
    balance: Math.max(0, earned - spent),
    owned: Array.isArray(acct.walletOwned) ? acct.walletOwned.slice() : [],
    namechangeCredits: Math.max(0, Number(acct.walletNamechangeCredits) || 0),
  };
}
/* Idempotency for a double-submitted/retried purchase - twin of the Node solo-result `soloSeen`
   gameId dedupe. A client-supplied `requestId` is remembered (native KV expiry, 24h) against the
   FULL response body it got the first time, so a retry gets back the exact same answer instead of
   being charged twice. Ownership is also a natural double-spend guard for every NON-consumable
   category; `requestId` exists specifically for the namechange credit, which is consumable/
   stackable and so can't rely on an ownership check. */
function purchaseKey(uid: string, requestId: string): Deno.KvKey { return ["purchase", uid, requestId]; }
const PURCHASE_ID_TTL_MS = 24 * 60 * 60 * 1000;
type PurchaseSeen = { status: number; body: unknown };

/* --- the three token-based providers, one body of code, three front doors. Twin of
   server.js's verifyProviderCredential. --- */
const SIGNIN_ROUTES: Record<string, string> = { "/account/apple": "apple", "/account/google": "google", "/account/facebook": "facebook" };
type CredentialResult = { fail: { status: number; body: unknown }; v?: undefined } | { fail?: undefined; v: { ok: true } & ProviderIdentity };
async function verifyProviderCredential(provider: string, reqBody: Record<string, unknown>): Promise<CredentialResult> {
  if (!providerConfigured(provider)) return { fail: { status: 503, body: ACCOUNTS_UNAVAILABLE_BODY } };
  const nonce = typeof reqBody.nonce === "string" ? reqBody.nonce : "";
  if (!(await consumeAuthNonce(nonce))) {
    return { fail: { status: 401, body: { error: "badnonce", message: "That sign-in took too long. Please try again." } } };
  }
  let v: AppleVerifyResult;
  try {
    if (provider === "facebook" && typeof reqBody.identityToken !== "string" && typeof reqBody.accessToken === "string") {
      v = await inspectFacebookAccessToken(reqBody.accessToken);
    } else {
      v = await verifyOidcToken(OIDC_PROVIDERS[provider], reqBody.identityToken, nonce);
    }
  } catch (e) {
    log(provider + " verification unavailable", (e as Error).message);
    return { fail: { status: 503, body: ACCOUNTS_UNAVAILABLE_BODY } };
  }
  if (!v.ok) {
    log(provider + " sign-in rejected", v.reason);
    return { fail: { status: 401, body: { error: "badtoken", reason: v.reason, message: "That sign-in couldn't be verified. Please try again." } } };
  }
  return { v };
}

/* --- HTTP. Twin of server.js's handleAccountRoute, same paths, same status codes, same
   plain-language strings. --- */
const accountRateMap = new Map<string, number[]>();
function underAccountRateLimit(ip: string): boolean {
  const now = Date.now();
  const kept = (accountRateMap.get(ip) || []).filter((t) => now - t < ACCOUNT_RATE_WINDOW_MS);
  if (kept.length >= ACCOUNT_RATE_LIMIT) { accountRateMap.set(ip, kept); return false; }
  kept.push(now);
  accountRateMap.set(ip, kept);
  return true;
}
function accountPublicView(acct: AccountRecord, exp: number) {
  return {
    uid: acct.uid,
    gameName: acct.gameName,
    needsName: !acct.gameName,
    claimDeclined: !!acct.claimDeclined,
    nameChangedAt: acct.nameChangedAt || 0,
    nameHistory: Array.isArray(acct.nameHistory) ? acct.nameHistory : [],
    identities: accountIdentities(acct).map((i) => i.provider),
    email: acct.email || null,
    emailPrivateRelay: !!acct.emailPrivateRelay,
    claimWindow: claimWindowView(),
    providers: configuredProviders(),
    exp: exp || 0,
  };
}
async function handleAccountRoute(req: Request, url: URL, ip: string): Promise<Response> {
  if (!underAccountRateLimit(ip)) {
    return json(429, { error: "slow down", message: "Too many sign-in tries. Wait a minute and try again." });
  }
  if (!accountsConfigured()) return json(503, ACCOUNTS_UNAVAILABLE_BODY);
  const p = url.pathname;
  if (p === "/account/nonce") {
    if (req.method !== "GET") return json(405, { error: "method not allowed" });
    return json(200, { nonce: await issueAuthNonce() });
  }
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  if (SIGNIN_ROUTES[p]) {
    const provider = SIGNIN_ROUTES[p];
    const r = await verifyProviderCredential(provider, body);
    if (r.fail) return json(r.fail.status, r.fail.body);
    const resolved = await resolveAccountForIdentity(provider, r.v);
    const s = await issueSession(resolved.account.uid);
    return json(200, {
      sessionToken: s.token, provider, linkedToExisting: resolved.linked,
      ...accountPublicView(resolved.account, s.exp),
    });
  }

  /* --- adding a SECOND sign-in method to the account you are already signed in to. The escape
     hatch for the one case email matching cannot solve - Apple's private-relay address will
     never equal the same person's real Gmail, so only the person themselves can join those
     two up. --- */
  if (p === "/account/link") {
    const me = await resolveSession(body.auth);
    if (!me) return json(401, SIGNED_OUT_BODY);
    const provider = String(body.provider || "");
    if (!SIGNIN_ROUTES["/account/" + provider]) return json(400, { error: "badprovider", message: "That sign-in method isn't one we use." });
    const r = await verifyProviderCredential(provider, body);
    if (r.fail) return json(r.fail.status, r.fail.body);
    const owner = await accountForIdentity(provider, r.v.sub);
    if (owner && owner.uid !== me.uid) {
      return json(409, { error: "linkedelsewhere", message: "That sign-in is already attached to a different NASTY account. Sign in with it instead, or remove it there first." });
    }
    await attachIdentity(me.account, provider, r.v.sub);
    await rememberAccountEmail(me.account, provider, r.v);
    return json(200, { ok: true, provider, ...accountPublicView(me.account, me.exp) });
  }

  if (p === "/account/unlink") {
    const me = await resolveSession(body.auth);
    if (!me) return json(401, SIGNED_OUT_BODY);
    const provider = String(body.provider || "");
    const list = accountIdentities(me.account);
    const keep = list.filter((i) => i.provider !== provider);
    if (keep.length === list.length) return json(404, { error: "notlinked", message: "That sign-in isn't attached to this account." });
    // Never remove the last one - an account with no way in is a lost account, and the family's
    // leaderboard history is attached to it.
    if (!keep.length) return json(409, { error: "lastidentity", message: "That's the only way into this account, so it has to stay. Add another sign-in first." });
    for (const i of list) { if (i.provider === provider) await kv.delete(identityIdxKey(i.provider, i.sub)); }
    me.account.identities = keep;
    if (me.account.provider === provider) { me.account.provider = keep[0].provider; me.account.sub = keep[0].sub; }
    if (me.account.emailSource === provider && me.account.email) {
      await kv.delete(emailIdxKey(me.account.email));
      me.account.email = null; me.account.emailSource = null; me.account.emailPrivateRelay = false;
    }
    await kv.set(accountKey(me.account.uid), me.account);
    return json(200, { ok: true, ...accountPublicView(me.account, me.exp) });
  }

  /* --- the passwordless email code, in two halves. Twin of server.js's. --- */
  if (p === "/account/email/start") {
    if (!providerConfigured("email")) return json(503, ACCOUNTS_UNAVAILABLE_BODY);
    const email = foldEmail(body.email);
    if (!isPlausibleEmail(email)) return json(400, { error: "bademail", message: "That doesn't look like an email address. Check it and try again." });
    const now = Date.now();
    const cur = await kv.get<EmailChallenge>(emailCodeKey(email));
    const prev = cur.value;
    if (prev && prev.sentAt && now - prev.sentAt < EMAIL_CODE_RESEND_MS) {
      const waitS = Math.max(1, Math.ceil((EMAIL_CODE_RESEND_MS - (now - prev.sentAt)) / 1000));
      return json(429, { error: "toosoon", waitSeconds: waitS, message: "We just sent one. Check your email, or try again in " + waitS + " seconds." });
    }
    const dayStart = prev && prev.dayStart && now - prev.dayStart < 24 * 60 * 60 * 1000 ? prev.dayStart : now;
    const sentToday = (prev && prev.dayStart === dayStart ? (prev.sentToday || 0) : 0) + 1;
    if (sentToday > EMAIL_CODE_MAX_PER_DAY) {
      return json(429, { error: "toomany", message: "That's a lot of codes for one day. Try again tomorrow, or sign in with Apple, Google or Facebook." });
    }
    const code = newEmailCode();
    const sent = await sendAccountEmail(email, code);
    if (!sent.ok) {
      // Nothing is stored when nothing was sent, so a mail outage leaves no half-open challenge.
      return json(503, { error: "emailunavailable", message: "We couldn't send that code right now. Try again in a minute, or sign in with Apple, Google or Facebook." });
    }
    const ch: EmailChallenge = { hash: await hashEmailCode(email, code), exp: now + EMAIL_CODE_TTL_MS, attempts: 0, sentAt: now, sentToday, dayStart };
    // The record outlives the code itself only so the per-day send counter survives; KV's native
    // expiry then throws it away with no pruning loop.
    await kv.set(emailCodeKey(email), ch, { expireIn: 24 * 60 * 60 * 1000 });
    return json(200, { ok: true, sent: true, expiresInSeconds: Math.round(EMAIL_CODE_TTL_MS / 1000) });
  }

  if (p === "/account/email/verify") {
    if (!providerConfigured("email")) return json(503, ACCOUNTS_UNAVAILABLE_BODY);
    const email = foldEmail(body.email);
    const code = String(body.code || "").trim();
    const badCode = { error: "badcode", message: "That code didn't match. Check it, or ask for a new one." };
    const cur = await kv.get<EmailChallenge>(emailCodeKey(email));
    const ch = cur.value;
    if (!isPlausibleEmail(email) || !ch || !(ch.exp > Date.now())) return json(401, badCode);
    if ((ch.attempts || 0) >= EMAIL_CODE_MAX_ATTEMPTS) {
      await burnEmailChallenge(email, ch);
      return json(429, { error: "toomanytries", message: "Too many wrong tries. Ask for a new code." });
    }
    ch.attempts = (ch.attempts || 0) + 1;
    await kv.set(emailCodeKey(email), ch, { expireIn: 24 * 60 * 60 * 1000 });
    if (!/^[0-9]{6}$/.test(code) || !timingSafeHexEqual(ch.hash, await hashEmailCode(email, code))) return json(401, badCode);
    await burnEmailChallenge(email, ch);       // single use, exactly like the sign-in nonce
    const resolved = await resolveAccountForIdentity("email", { sub: email, email, emailVerified: true, privateRelay: false });
    const s = await issueSession(resolved.account.uid);
    return json(200, {
      sessionToken: s.token, provider: "email", linkedToExisting: resolved.linked,
      ...accountPublicView(resolved.account, s.exp),
    });
  }

  if (p === "/account/me") {
    const me = await resolveSession(body.auth);
    if (!me) return json(401, SIGNED_OUT_BODY);
    return json(200, accountPublicView(me.account, me.exp));
  }

  /* --- 2026-07-28 § POINTS WALLET. Twin of server.js's - same auth convention (session token in
     the JSON body as `auth`), and a guest gets the same clean 401 SIGNED_OUT_BODY every other
     account route answers with. A guest has no wallet; it is not an error, just nothing to show. */
  if (p === "/account/wallet") {
    const me = await resolveSession(body.auth);
    if (!me) return json(401, SIGNED_OUT_BODY);
    return json(200, await walletView(me.account));
  }

  if (p === "/account/purchase") {
    const me = await resolveSession(body.auth);
    if (!me) return json(401, SIGNED_OUT_BODY);
    const itemId = typeof body.itemId === "string" ? body.itemId : "";
    const requestId = typeof body.requestId === "string" && body.requestId ? body.requestId.slice(0, 128) : null;
    const item = shopItemById(itemId);
    if (!item) return json(404, { error: "noitem", message: "That item doesn't exist." });
    // Compare-and-swap loop: Deno Deploy runs many isolates, so two "simultaneous" purchases for
    // the same account are a real possibility (unlike Node, which serializes them for free).
    //
    // The requestId dedupe check is INSIDE the loop, and re-checked on every attempt, on purpose:
    // for a NON-consumable item, a lost race harmlessly re-resolves to "alreadyowned" on retry -
    // but for the CONSUMABLE namechange credit there is no ownership check to catch a second
    // attempt, so two concurrent identical requests could otherwise both successfully add a
    // credit. The fix is making the requestId claim part of the SAME atomic commit as the actual
    // purchase (`check({key: purchaseKey, versionstamp: null})` - "nobody has recorded a result
    // for this requestId yet"): only ONE of two concurrent identical requests can ever win that
    // check, so only one purchase is ever actually applied. The loser's commit fails, it loops
    // back to the TOP of the loop, and the re-check there finds the winner's now-recorded result
    // and replays it - never attempts the purchase a second time.
    for (let attempt = 0; attempt < 8; attempt++) {
      if (requestId) {
        const seen = await kv.get<PurchaseSeen>(purchaseKey(me.uid, requestId));
        if (seen.value) return json(seen.value.status, { ...(seen.value.body as Record<string, unknown>), duplicate: true });
      }
      const cur = await kv.get<AccountRecord>(accountKey(me.uid));
      const acct = cur.value;
      if (!acct) return json(401, SIGNED_OUT_BODY);
      const owned = Array.isArray(acct.walletOwned) ? acct.walletOwned : [];
      if (!item.consumable && owned.includes(item.id)) {
        // No account mutation on this path, so a plain best-effort record is fine - a race here
        // can at worst leave a slightly-stale cached duplicate body, never a double spend.
        const failBody = { error: "alreadyowned", message: "You already own that.", wallet: await walletView(acct) };
        if (requestId) await kv.set(purchaseKey(me.uid, requestId), { status: 409, body: failBody } as PurchaseSeen, { expireIn: PURCHASE_ID_TTL_MS });
        return json(409, failBody);
      }
      const earned = await accountEarnedPoints(acct);
      const spentSoFar = Math.max(0, Number(acct.walletSpent) || 0);
      const balance = Math.max(0, earned - spentSoFar);
      if (balance < item.cost) {
        const failBody = { error: "cantafford", message: "Not enough points for that yet.", cost: item.cost, balance, wallet: await walletView(acct) };
        if (requestId) await kv.set(purchaseKey(me.uid, requestId), { status: 409, body: failBody } as PurchaseSeen, { expireIn: PURCHASE_ID_TTL_MS });
        return json(409, failBody);
      }
      const updated: AccountRecord = { ...acct, walletSpent: spentSoFar + item.cost };
      if (item.consumable) updated.walletNamechangeCredits = Math.max(0, Number(acct.walletNamechangeCredits) || 0) + 1;
      else updated.walletOwned = [...owned, item.id];
      const okBody = { ok: true, purchased: item.id, wallet: await walletView(updated) };
      let txn = kv.atomic().check(cur).set(accountKey(me.uid), updated);
      if (requestId) {
        // The account CAS and the requestId claim are ONE atomic commit - either both land or
        // neither does, so a race can never charge without recording, or record without charging.
        txn = txn.check({ key: purchaseKey(me.uid, requestId), versionstamp: null })
          .set(purchaseKey(me.uid, requestId), { status: 200, body: okBody } as PurchaseSeen, { expireIn: PURCHASE_ID_TTL_MS });
      }
      const ok = await txn.commit();
      if (!ok.ok) continue;   // lost the race (account changed, or another request already claimed this requestId) - retry from the top
      return json(200, okBody);
    }
    return json(500, { error: "server error", message: "Couldn't complete that purchase right now. Try again." });
  }

  if (p === "/account/name-available") {
    const clean = cleanName(body.name, "");
    if (!clean) return json(200, { available: false, reason: "empty", message: "Type a name first." });
    if (isBadName(clean)) return json(200, { available: false, reason: "blocked", message: "That name is blocked. Please pick another one." });
    const folded = leaderboardNameKey(clean);
    const owner = await accountOwningFoldedName(folded);
    const me = await resolveSession(body.auth);
    if (owner && (!me || owner !== me.uid)) {
      return json(200, { available: false, reason: "taken", message: "Somebody already has that name. Please pick another one." });
    }
    return json(200, { available: true, name: clean });
  }

  if (p === "/account/name") {
    const me = await resolveSession(body.auth);
    if (!me) return json(401, SIGNED_OUT_BODY);
    const acct = me.account;
    const clean = cleanName(body.name, "");
    if (!clean) return json(400, { error: "empty", message: "Pick a name first." });
    if (isBadName(clean)) return json(400, { error: "blocked", message: "That name is blocked. Please pick another one." });
    const folded = leaderboardNameKey(clean);
    const owner = await accountOwningFoldedName(folded);
    if (owner && owner !== acct.uid) {
      return json(409, { error: "taken", message: "Somebody already has that name. Please pick another one." });
    }
    const now = Date.now();
    // 2026-07-28 § POINTS WALLET: whether THIS call spent a purchased namechange credit to bypass
    // the cooldown below. Twin of server.js's - surfaced on the success response.
    let usedNamechangeCredit = false;
    if (acct.nameFolded === folded) {
      if (acct.gameName !== clean) { acct.gameName = clean; await kv.set(accountKey(acct.uid), acct); }
    } else if (!acct.nameFolded) {
      acct.gameName = clean;
      acct.nameFolded = folded;
      acct.nameChangedAt = 0;   // the FIRST rename after this is free - see server.js
      await kv.set(accountKey(acct.uid), acct);
      await kv.set(nameIdxKey(folded), acct.uid);
    } else {
      if (acct.nameChangedAt && now - acct.nameChangedAt < NAME_COOLDOWN_MS) {
        const credits = Math.max(0, Number(acct.walletNamechangeCredits) || 0);
        // A purchased credit bypasses the cooldown ONCE, consuming it - only when the client
        // explicitly asks (`useNamechangeCredit:true`), so it is never silently spent on an
        // ordinary rename attempt. Twin of server.js's.
        if (body.useNamechangeCredit === true && credits > 0) {
          acct.walletNamechangeCredits = credits - 1;
          usedNamechangeCredit = true;
        } else {
          const daysLeft = Math.max(1, Math.ceil((NAME_COOLDOWN_MS - (now - acct.nameChangedAt)) / (24 * 60 * 60 * 1000)));
          return json(429, { error: "cooldown", daysLeft, message: "You can change your name again in " + daysLeft + (daysLeft === 1 ? " day." : " days."), namechangeCredits: credits });
        }
      }
      const oldFolded = acct.nameFolded;
      if (!Array.isArray(acct.nameHistory)) acct.nameHistory = [];
      acct.nameHistory.push({ name: acct.gameName, from: acct.nameChangedAt || acct.created, to: now });
      if (acct.nameHistory.length > 20) acct.nameHistory = acct.nameHistory.slice(-20);
      acct.gameName = clean;
      acct.nameFolded = folded;
      acct.nameChangedAt = now;
      await kv.delete(nameIdxKey(oldFolded));   // the old folded name goes back in the pool
      await kv.set(accountKey(acct.uid), acct);
      await kv.set(nameIdxKey(folded), acct.uid);
    }
    // Only offered while the one-time migration window is open - see THE CLAIM SUNSET above.
    let pendingClaim = null;
    const j = await kv.get<ClaimJournal>(claimJournalKey(acct.uid));
    if (claimWindowOpen() && !acct.claimDeclined && (!j.value || j.value.state !== "done")) {
      const rows = await unclaimedRowsForFolded(folded);
      if (Object.keys(rows).length) pendingClaim = claimSummary(rows);
    }
    return json(200, {
      gameName: acct.gameName, pendingClaim, claimWindow: claimWindowView(),
      usedNamechangeCredit, namechangeCredits: Math.max(0, Number(acct.walletNamechangeCredits) || 0),
    });
  }

  if (p === "/account/claim") {
    const me = await resolveSession(body.auth);
    if (!me) return json(401, SIGNED_OUT_BODY);
    const acct = me.account;
    if (!acct.gameName) return json(400, { error: "noname", message: "Pick your game name first." });
    // THE SUNSET. An already-"done" journal is still allowed through so a retry of a completed
    // claim answers the same way it did the first time; it moves nothing either way.
    {
      const prior = await kv.get<ClaimJournal>(claimJournalKey(acct.uid));
      if (!claimWindowOpen() && !(prior.value && prior.value.state === "done")) {
        return json(410, { ...CLAIM_CLOSED_BODY, claimWindow: claimWindowView() });
      }
    }
    if (body.decline === true) {
      acct.claimDeclined = true;
      await kv.set(accountKey(acct.uid), acct);
      return json(200, { ok: true, declined: true });
    }
    try {
      const r = await runAccountClaim(acct);
      return json(200, { ok: true, alreadyDone: r.alreadyDone, moved: r.moved });
    } catch (e) {
      log("account claim failed", acct.uid, (e as Error).message);
      return json(500, { error: "server error" });
    }
  }

  if (p === "/account/signout") {
    if (typeof body.auth === "string" && body.auth) await kv.delete(sessionKey(body.auth));
    return json(200, { ok: true });
  }

  if (p === "/account/delete") {
    const me = await resolveSession(body.auth);
    if (!me) return json(401, SIGNED_OUT_BODY);
    const r = await deleteAccountRecord(me.account, body.eraseBoard === true);
    return json(200, {
      ok: true,
      appleRevoked: false,
      keptOnBoard: r.keptOnBoard,
      message: "Your account is deleted. You can also remove NASTY under Settings, your name, Sign in with Apple.",
    });
  }

  return json(404, { error: "no such account route" });
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
  // 2026-07-25 § ACCOUNTS: the account this player signed in as, captured ONCE at the front door
  // (the optional `acct` field on host/join) and read back at game end. Persisted for the same
  // reason the rejoin token is - a restart mid-game must not turn a signed-in player back into a
  // guest and lose their result. Optional so an older persisted meta still parses; null for every
  // guest and for every client that has ever shipped.
  accountId?: string | null;
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
  // v0.27.1: sticky per-game-instance flag, twin of server.js's room.anySurrenderOccurred - true
  // once ANY human has surrendered/conceded THIS still-unfinished game. See § SURRENDER's
  // leaveSeatForGoodInternal() comment below. Reset false in actuallyStartGame(), same lifecycle
  // as `recorded`. Optional purely so an old persisted meta (from before this field existed)
  // still parses - treated as false wherever read.
  anySurrenderOccurred?: boolean;
  // 2026-07-23 (Blake's item 2) § REUNION READY GATE - twin of server.js's room.reunionActive/
  // room.tableReady, persisted here for the same reason server.js persists it (see that file's
  // roomToDisk() comment: losing an OPEN gate mid ready-up would strand the table paused with
  // no way to auto-resume). Optional so an old persisted meta still parses - treated as
  // false/empty wherever read.
  reunionActive?: boolean;
  tableReadyIds?: number[];
  // 2026-07-25 (bug 2): when the CURRENT reunion gate opened. REUNION_GATE_CAP_MS is enforced
  // from this timestamp by the away sweep, deliberately NOT from a setTimeout - an isolate
  // recycle would lose a timer, and losing it would strand exactly the stuck table the cap
  // exists to rescue. Optional so an older persisted meta still parses (the sweep starts its
  // clock on first sight rather than expiring it instantly). Twin of server.js's field.
  reunionOpenedAt?: number;
};

/* 2026-07-25 § ACCOUNTS: the account rides along ONCE, at the front door, as an OPTIONAL `acct`
   session token on `host`/`join`. Twin of server.js's - `rejoin` is not touched at all and never
   re-asserts identity, a client that never sends `acct` is a guest exactly as today, and an
   invalid token is silently ignored rather than being an error, because a sign-in problem must
   never stop somebody joining a family game. Returns null WITHOUT touching KV when the field is
   absent, which is every client shipped to date. */
async function resolveAcctField(msg: Record<string, unknown>): Promise<string | null> {
  if (!ACCOUNTS_ENABLED) return null;
  const t = msg && typeof msg.acct === "string" ? msg.acct : "";
  if (!t) return null;
  const me = await resolveSession(t);
  return me ? me.uid : null;
}

function roomKey(code: string): Deno.KvKey { return ["room", code]; }
function logKey(code: string, seq: number): Deno.KvKey { return ["roomlog", code, seq]; }
function ttlFor(meta: RoomMeta) { return meta.started ? STARTED_ROOM_TTL_MS : ROOM_TTL_MS; }

/* 2026-07-25 (DENO-ONLY BY NATURE) § UNBIASED ROOM-CODE LETTERS. This used to be
   `CODE_ALPHABET[b % CODE_ALPHABET.length]` over a random byte. 256 is not a multiple of 19, so
   that is modulo-biased: 256 = 19*13 + 9, meaning the first NINE letters of the alphabet each
   had 14 of the 256 byte values and the remaining ten had 13 - about a 7.7% excess for a third
   of the alphabet. server.js has never had this (it uses Node's crypto.randomInt, which does
   rejection sampling internally), so this was a straight divergence between two files whose
   whole contract is identical behavior. Purely cosmetic in effect - four-letter codes out of
   130k are collision-checked against KV anyway - but divergence is divergence.
   The fix is the same rejection sampling randomInt does: throw away any byte at or above the
   largest exact multiple of 19 (247) and draw again, so every remaining value maps to exactly
   one letter with equal probability. The reject rate is 9/256, about 3.5%, so this practically
   never loops more than once. */
const CODE_LIMIT = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;   // 247
function randomCodeChar(): string {
  const buf = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < CODE_LIMIT) return CODE_ALPHABET[buf[0] % CODE_ALPHABET.length];
  }
}
async function newUniqueCode(): Promise<string> {
  let code: string;
  do {
    code = randomCodeChar() + randomCodeChar() + randomCodeChar() + randomCodeChar();
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
  // THE JACK BUG (found 2026-07-24, Blake's item 13) - see server.js's twin copy of this
  // function for the full root-cause writeup: this used to skip the `pi` check for swap moves
  // entirely, so whenever the owner had 2+ of their own tees on the track, the server could
  // silently apply a swap using the WRONG one of the owner's own pieces (always the
  // lowest-array-index eligible one) instead of the one actually tapped. Fix: also require
  // `pi` to match.
  if (legal.type === "swap") return legal.pi === submitted.pi && legal.ts === submitted.ts && legal.tpi === submitted.tpi;
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
/* 2026-07-24 § KNOCKOUT TALLY (Blake's item 9) - twin of server.js's tallyKnockout(); see that
 * function's comment for the full design (why lifetime not per-mode, why a forced partner-kick
 * doesn't count, why this lives outside § ENGINE). Called from every place this file runs a real
 * E.applyMove() against a live room: driveTurnLoopCollect()'s CPU branch, the human "action"
 * case, and the away-ladder assist - see each call site's own comment. */
function tallyKnockout(E: any, m: any) {
  if (!m.kick) return;
  if (E.sameTeam(m.owner, m.kick.seat)) return; // forced partner-kick ("Ouch!") - not a "Nasty!" knockout
  const G = E.getG();
  if (!G.koDealt) G.koDealt = new Array(G.n).fill(0);
  if (!G.koTaken) G.koTaken = new Array(G.n).fill(0);
  if (G.seats[m.owner] && G.seats[m.owner].type === "human") G.koDealt[m.owner] = (G.koDealt[m.owner] || 0) + 1;
  if (G.seats[m.kick.seat] && G.seats[m.kick.seat].type === "human") G.koTaken[m.kick.seat] = (G.koTaken[m.kick.seat] || 0) + 1;
}
function buildResultEntriesServer(G: any): { name: string; delta: Record<string, number>; seat: number }[] {
  const mode = (G.n === 4 ? "4" : "6") + (G.teams ? "t" : "s");
  const isTeam = mode.endsWith("t");
  const winSet = new Set<number>(G.winners);
  const entries: { name: string; delta: Record<string, number>; seat: number }[] = [];
  G.seats.forEach((seat: any, i: number) => {
    if (seat.type !== "human") return;
    const delta: Record<string, number> = {}; delta["hg" + mode] = 1;
    if (winSet.has(i)) { delta["hw" + mode] = 1; delta[isTeam ? "hptsT" : "hptsS"] = pointsForWinServer(G, winSet); }
    // 2026-07-24 item 9: lifetime knockout stats, accrued all game long by tallyKnockout() above.
    if (G.koDealt && G.koDealt[i]) delta.hkoDealt = G.koDealt[i];
    if (G.koTaken && G.koTaken[i]) delta.hkoTaken = G.koTaken[i];
    // 2026-07-25 § ACCOUNTS: the seat index rides along so account attribution can look up who
    // was actually sitting there. Never goes on the wire.
    entries.push({ name: seat.name, delta, seat: i });
  });
  return entries;
}
async function recordFinishedGame(code: string, G: any) {
  const entries = buildResultEntriesServer(G);
  const onlyAccounts = accountsOnlyBoard();
  const credited: string[] = [];
  if (!onlyAccounts) {
    for (const e of entries) { await applyLeaderboardEntry(e.name, e.delta); credited.push(e.name); }
  } else {
    // Attribution comes from the room's OWN stored player record - the accountId captured once
    // at the front door - never from the typed seat name and never from anything the client
    // says at game end. A guest's online result simply does not post to the shared board.
    const meta = (await kv.get<RoomMeta>(roomKey(code))).value;
    const owners = meta ? (meta.seatOwners || (meta.lobby ? meta.lobby.seats.map((s) => s.claimedBy) : null)) : null;
    for (const e of entries) {
      const playerId = owners ? owners[e.seat] : null;
      const p = playerId == null || !meta ? null : meta.players.find((q) => q.id === playerId);
      const uid = (p && p.accountId) || null;
      if (!uid) continue;
      const acct = await kv.get<AccountRecord>(accountKey(uid));
      if (!acct.value) continue;
      await applyAccountLeaderboardEntry(uid, e.name, e.delta);
      credited.push(e.name);
    }
  }
  log("online game finished, recorded to global leaderboard", code,
    credited.join(",") || "(no human seats)");
}

/* v0.27 § SURRENDER — twin of server.js's leaveSeatForGoodInternal(): shared by the
   "leaveForGood" and "surrender" cases below. The seat-conversion + permanent-lockout mechanics
   are IDENTICAL either way — "surrender" only adds a loss record, via the optional
   beforeConvert callback (evaluated on the PRE-conversion state, inside the same withRoomChain
   read, before the seat flips to a CPU) — extracted so the two cases can never drift apart. */
async function leaveSeatForGoodInternal(
  code: string, playerId: number, socket: WebSocket,
  // v0.27.1: beforeConvert also receives `meta` now (the pre-conversion RoomMeta, same read the
  // rest of this function already made) and may return {setSurrenderFlag:true} to ask that
  // meta.anySurrenderOccurred be committed true in the SAME touchRoom write below - see the
  // "surrender" case's § NO-FAULT EXIT comment for why this can't just mutate `meta` directly
  // (touchRoom's own mutate callback always re-reads a FRESH meta from KV, so a value set on
  // this earlier-read `meta` object would never actually persist).
  beforeConvert?: (G: any, seat: number, meta: RoomMeta) => Promise<{ setSurrenderFlag?: boolean } | void> | { setSurrenderFlag?: boolean } | void,
): Promise<boolean> {
  let converted = false;
  let setSurrenderFlag = false;
  await withRoomChain(code, async () => {
    const pre = await kv.get<RoomMeta>(roomKey(code));
    if (!pre.value) { send(socket, { type: "leftForGood" }); return; }
    const meta = pre.value;
    let seat = -1;
    if (meta.started && meta.seatOwners) seat = meta.seatOwners.indexOf(playerId);
    const E = seat >= 0 ? getEngine(code, meta) : null;
    const G = E ? E.getG() : null;
    if (beforeConvert && G && seat >= 0 && G.seats[seat]) {
      const res = await beforeConvert(G, seat, meta);
      if (res && res.setSurrenderFlag) setSurrenderFlag = true;
    }
    if (E && G && seat >= 0 && G.seats[seat] && G.seats[seat].type === "human") {
      const leaverName = G.seats[seat].name;
      G.seats[seat].type = "cpu";
      G.seats[seat].diff = "medium";   // "Tricky" - see engine.js chooseAI()'s diff naming
      converted = true;
      const out: Broadcastable[] = [{ payload: { type: "gameAction", seq: meta.nextSeq++, action: { kind: "seatToCpu", seat, diff: "medium", name: leaverName } } }];
      // The seat may be sitting mid-turn waiting on exactly this human's move right now - drive
      // it forward immediately instead of stalling the table.
      const cont = driveTurnLoopCollect(E, meta);
      const ok = await commitAndBroadcast(code, E, out.concat(cont.out), cont.finished);
      if (ok) maybeSendTurnPush(code, E, cont.finished).catch((e) => log("push check failed", code, (e as Error).message));
    } else {
      seat = -1; // nothing converted - don't touch seatOwners below
    }
    // Invalidate this player's session for THIS room permanently (covers leaving mid-lobby too,
    // before any seat/engine exists) and null out the seatOwners slot if converted - done in a
    // follow-up commit so it lands even when commitAndBroadcast above already persisted a fresh
    // meta.G that this read predates.
    await touchRoom(code, (m) => {
      const p = m.players.find((pp) => pp.id === playerId);
      if (p) p.leftForGood = true;
      if (seat >= 0 && m.seatOwners) m.seatOwners[seat] = null;
      if (setSurrenderFlag) m.anySurrenderOccurred = true;   // v0.27.1
      return {};
    });
    send(socket, { type: "leftForGood" });
    // v0.27.1: broadcast the INSTANT the flag actually flips true (never re-sent for the 2nd+
    // surrenderer - the hook only returns setSurrenderFlag on the genuine false->true
    // transition) so every other player still at the table sees the no-fault state live, before
    // THEY decide to leave - twin of server.js's matching broadcast() call.
    if (setSurrenderFlag) broadcastRoom(code, { type: "surrenderOccurred" });
  });
  return converted;
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
      tallyKnockout(E, m);   // 2026-07-24 item 9 - see that function's comment
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
    meta.anySurrenderOccurred = false;   // v0.27.1: a genuinely new game/rematch resets the no-fault-exit flag
    meta.reunionActive = false; meta.tableReadyIds = []; meta.reunionOpenedAt = 0;   // 2026-07-23 / 2026-07-25: defensive reset, same lifecycle as `recorded`
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

// 2026-07-23 (Blake's item 2) § REUNION READY GATE - twin of server.js's maybeResolveReunion(),
// see the big comment block above that function for the full design AND for the 2026-07-25
// write-up of the two holes closed since (bug 1: an unpause used to bypass and permanently wedge
// this gate; bug 2: the gate had no cap, so one person who never tapped Ready up froze the table
// forever). Async/KV-shaped: reads a fresh meta and only commits when the gate is genuinely
// ready to resolve (touchRoom's mutate returning `false` is a clean no-op, no write, no
// broadcast - exactly "not resolved yet").
const REUNION_GATE_CAP_MS = envInt("NASTY_REUNION_GATE_CAP_MS", 75 * 1000);
// Shared close-out for both ways a gate ends (everyone readied, or the cap expired) - twin of
// server.js's closeReunionGate().
function clearReunionFields(meta: RoomMeta) {
  meta.paused = false;
  meta.reunionActive = false;
  meta.tableReadyIds = [];
  meta.reunionOpenedAt = 0;
}
function broadcastReunionClosed(code: string, why: string) {
  broadcastRoom(code, { type: "paused", paused: false });
  broadcastRoom(code, { type: "reunionStatus", active: false, readyPlayerIds: [] });
  log("reunion gate closed - table resuming", code, "(" + why + ")");
}
async function maybeResolveReunion(code: string): Promise<void> {
  const r = await touchRoom(code, (meta) => {
    if (!meta.reunionActive || !meta.G) return false;
    const G = meta.G as { seats: { type: string }[] };
    const seatOwners = meta.seatOwners || [];
    const readySet = new Set(meta.tableReadyIds || []);
    const required = seatOwners.filter((pid, seat) => {
      if (pid == null) return false;
      if (!G.seats[seat] || G.seats[seat].type !== "human") return false;   // converted to CPU since the gate opened
      const p = meta.players.find((pp) => pp.id === pid);
      return !!(p && p.connected);   // only players CURRENTLY at the table are required to ready up
    });
    // Never auto-resolve with nobody required - sit tight rather than silently resume an
    // unattended table (mirrors server.js's own guard). The cap below bounds even THIS case.
    if (required.length === 0) return false;
    if (!required.every((pid) => readySet.has(pid as number))) return false;
    clearReunionFields(meta);
    return {};
  });
  if (r.ok) broadcastReunionClosed(code, "everyone readied up");
}
// 2026-07-25 (bug 2): the cap's enforcement. Called from awaySweep() below - the one periodic
// per-room pass this file has, and the only one that already knows which rooms have anyone
// looking at them. Twin of server.js's sweepReunionGates().
async function sweepReunionGate(code: string, meta: RoomMeta | null): Promise<void> {
  if (!meta || !meta.reunionActive) return;
  const now = Date.now();
  if (!meta.reunionOpenedAt) {
    // A gate persisted before this field existed: start its clock rather than expiring it now.
    await touchRoom(code, (m) => { if (!m.reunionActive || m.reunionOpenedAt) return false; m.reunionOpenedAt = now; return {}; });
    return;
  }
  // A gate that has sat UNOBSERVED for far longer than the cap did not have anybody there to tap
  // Ready up, so expiring it the instant somebody finally shows up would flash the check-in
  // lobby for a second and then yank it away. Restart its clock instead, so whoever just came
  // back gets a full-length check-in. This sweep only ever sees rooms with a live local socket,
  // so that is exactly what happens whenever everybody was gone for a while. Same rule, same
  // line, in server.js - see its matching comment.
  if (now - meta.reunionOpenedAt > REUNION_GATE_CAP_MS * 3) {
    await touchRoom(code, (m) => { if (!m.reunionActive) return false; m.reunionOpenedAt = now; return {}; });
    return;
  }
  if (now - meta.reunionOpenedAt < REUNION_GATE_CAP_MS) return;
  const waited = Math.round((now - meta.reunionOpenedAt) / 1000);
  const r = await touchRoom(code, (m) => {
    if (!m.reunionActive) return false;   // somebody resolved it between the read and here
    clearReunionFields(m);
    return {};
  });
  if (r.ok) {
    broadcastReunionClosed(code, "waited " + waited + "s for everyone to tap Ready up");
    // A clean resume, not just an unpaused flag: if the gate happened to open while the very
    // first deal was still pending, releaseFirstDeal() bailed on `paused` and nothing would ever
    // retrigger it. This no-ops unless that deal is genuinely still owed (it checks nextSeq
    // itself). Twin of server.js's matching call.
    await withRoomChain(code, () => releaseFirstDeal(code)).catch((e) => log("post-cap re-drive failed", code, (e as Error).message));
  }
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
    // v0.27.1: twin of server.js's field - see that file's gameSnapshotFields() comment.
    anySurrenderOccurred: !!meta.anySurrenderOccurred,
    // 2026-07-23: twin of server.js's fields - see that file's gameSnapshotFields() comment.
    reunionActive: !!meta.reunionActive,
    tableReadyIds: meta.tableReadyIds || [],
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
  // 2026-07-25 (bug 3): drop this room's TTL-refresh bookkeeping when the last socket goes, so a
  // room somebody comes back to later gets refreshed straight away instead of waiting out a
  // stale timestamp - and so the map can't grow forever across a long-lived isolate.
  if (m.size === 0) { localSockets.delete(code); lastTtlRefresh.delete(code); closeChannel(code); }
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
                                             // twin of server.js's identical constants, which
                                             // were aligned to these on 2026-07-26 (see below).

/* 2026-07-26 § THE DISCONNECT PATH - one function, two callers, and the reason it exists.
 *
 * THE BUG THIS FIXES (found by driving a real online game against a real local instance of this
 * server with a TCP proxy that silently black-holes traffic while leaving the socket open -
 * tests/freeze_proxy.js, the documented iOS/WKWebView zombie shape):
 * every scrap of disconnect bookkeeping used to live inside `socket.onclose`. The stale-socket
 * sweep below did the right thing - it noticed the silence at exactly SOCKET_STALE_MS and called
 * ws.close() - but ws.close() only STARTS the WebSocket closing handshake. It sends a close frame
 * and waits for one back. When the pipe is dead, that frame goes nowhere, nothing comes back, the
 * socket parks in readyState 2 (CLOSING) forever, and `onclose` NEVER FIRES. Measured: the sweep
 * re-fired every 4 seconds on the same stuck socket for the full 120 seconds of the probe, while
 * p.connected stayed true, no 'presence' broadcast was ever sent, and the dropped player's name
 * plate kept its green "they're here" glow on every other phone at the table, indefinitely.
 * That is the exact opposite of what Blake asked for on 2026-07-24: "when online, the other
 * human's names should only be highlighted in red when they're disconnected."
 *
 * Note WHICH shape was broken: a clean close (tab closed, app quit, Leave tapped) always worked
 * and still does - measured at 5ms end to end. It was the shape where the phone stops answering
 * but the socket is never torn down - backgrounded iOS webview, phone asleep, walked out of wifi
 * range - that was invisible. That is the common family case, which is why it mattered.
 *
 * THE FIX: the sweep no longer waits for a handshake that is not coming. It force-closes the
 * socket best-effort AND runs this cleanup itself, immediately. If `onclose` does eventually fire
 * afterwards, the `stillCurrent` guard below sees the socket is no longer the registered one and
 * returns - so this can never run twice for the same connection.
 *
 * Keep this in sync with server.js's own close handler + heartbeat (same constants, same order of
 * operations) - the two servers are held at exact behavioural parity by standing rule. */
function applyDisconnect(code: string, playerId: number, socket: WebSocket) {
  (async () => {
    // v0.10.3 fix (found via the reclaim wire-protocol test, same root cause as server.js's
    // identical fix): a contested "reclaim" approval hands this playerId to a NEW socket and
    // closes this old one (see "reclaimApprove" below) - the close handler can fire AFTER
    // that handover, and without this guard would wrongly mark the (now different) live
    // connection as disconnected, since both sockets shared the same playerId by design.
    // Only apply a disconnect if THIS socket is still the one THIS isolate has locally
    // registered for that player. (Known limitation, same shape as this file's documented
    // BroadcastChannel caveat: if the takeover happened on a DIFFERENT isolate, this isolate's
    // own localSockets map was never updated, so this guard can't see it - acceptable given
    // the whole feature is local-only/undeployed pending the app being pinned to a single
    // instance, same reasoning as § RELAY above.) 2026-07-26: this guard now doubles as the
    // run-once latch between the two callers - whichever gets here first unregisters, the other
    // one falls out right here.
    const stillCurrent = localSockets.get(code)?.get(playerId) === socket;
    if (!stillCurrent) return; // a takeover already replaced us locally - don't unregister IT
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
      // 2026-07-23: a disconnect can complete an open reunion gate too - twin of server.js's
      // matching close-handler addition (see maybeResolveReunion()'s own comment).
      await maybeResolveReunion(code);
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
}

setInterval(() => {
  const now = Date.now();
  // 2026-07-26: collect first, act second. applyDisconnect() unregisters the socket
  // synchronously, which mutates the very maps being walked here - doing it inline would skip
  // entries. (Same reason server.js's twin builds a list before terminating.)
  const stale: Array<{ code: string; playerId: number; ws: WebSocket }> = [];
  for (const [code, socks] of localSockets) {
    for (const [playerId, ws] of socks) {
      const lastSeen = socketLastSeen.get(ws) ?? now;
      if (now - lastSeen > SOCKET_STALE_MS) { stale.push({ code, playerId, ws }); continue; }
      send(ws, { type: "ping", t: now });
    }
  }
  for (const s of stale) {
    // Half-dead: readyState may still read OPEN (this platform has no lower-level signal to
    // check), but nothing - not even an app-level pong - has come back in a while. Ask for a
    // close, then do the disconnect cleanup ourselves without waiting for the handshake to
    // complete, because on a dead pipe it never will (see § THE DISCONNECT PATH above).
    try { s.ws.close(); } catch (_e) { /* ignore */ }
    applyDisconnect(s.code, s.playerId, s.ws);
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
// 2026-07-25 (bug 3): how often the sweep below pushes a still-occupied room's KV expiry out.
// Well under ROOM_TTL_MS (30 min), so a room with anyone connected can never expire between two
// refreshes. Isolate-local + transient like the rest of this section's state - a recycle just
// means the next sweep refreshes early, which is harmless.
const ROOM_TTL_REFRESH_MS = envInt("NASTY_ROOM_TTL_REFRESH_MS", 5 * 60 * 1000);
const lastTtlRefresh = new Map<string, number>();
type AwayState = { seat: number; since: number; nudgeSent: boolean; offerSent: boolean; announced: boolean; lastPushAt: number };
const awayStates = new Map<string, AwayState>();
/* "Looks away" and "disconnected" are DIFFERENT ideas and this file uses both on purpose. This
   one is the softer of the two: it feeds the ladder's escalation, which only ever concerns the
   seat whose turn it is. The HARD one - a socket that is actually gone - is what drives the
   'presence' broadcast, and therefore the red name plate on everybody else's board. Do not wire
   the plate to this function: "hasn't said anything for a minute" is not "has left the table",
   and Blake asked for red to mean the second thing.
   2026-07-26 footnote: at the shipped defaults the third line below no longer decides much.
   AWAY_SILENT_MS is 60s while § HEARTBEAT tears a silent socket down after 12s, so a genuinely
   silent phone trips `!p.connected` on the line above it long before this one. It is kept
   because it still catches the in-between shapes and because the tests turn AWAY_SILENT_MS down
   below the socket window, where it does the work. (Twin of server.js's identical note.) */
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
    // 2026-07-25 (bug 3, DENO-ONLY BY NATURE) § KEEP A ROOM WITH PEOPLE IN IT ALIVE.
    //
    // server.js never prunes a room anyone is connected to - its pruner's very first line is
    // `if (!roomIsFullyDisconnected(room)) continue;`. This file had no equivalent guard at all:
    // expiry here is purely KV's own `expireIn`, and the ONLY thing that ever refreshed it was a
    // touchRoom() write, i.e. an actual message. So a never-started lobby whose host was sitting
    // right there, connected and idle, silently vanished after ROOM_TTL_MS (30 minutes). That is
    // Blake's exact real-world flow: open a room, text the link, wait for the family to gather.
    // Confirmed by reading the local KV SQLite's expiration_ms directly - an idle-but-connected
    // room's expiry did not move; a real message moved it.
    //
    // The fix, matching Node's semantics rather than inventing new ones: while this room has at
    // least one live local socket, keep pushing its expiry out. The rewrite is conditional on the
    // entry not having changed (a plain `check`), so it can never clobber a concurrent write, and
    // it carries the SAME meta forward - it deliberately does NOT touch lastActivity, because
    // "somebody is connected" is not "somebody did something". A room nobody is connected to is
    // not in localSockets at all, so it still expires exactly as it always did.
    // Rate-limited to ROOM_TTL_REFRESH_MS per room (isolate-local bookkeeping, transient by
    // design like every other map in this section) so this costs a handful of tiny KV writes an
    // hour rather than one per sweep. The default is comfortably shorter than the 30-minute
    // lobby TTL, so a room can never slip through the gap between two refreshes.
    if (meta) {
      const last = lastTtlRefresh.get(code) || 0;
      if (now - last >= ROOM_TTL_REFRESH_MS) {
        lastTtlRefresh.set(code, now);
        const ok = await kv.atomic().check(cur).set(roomKey(code), meta, { expireIn: ttlFor(meta) }).commit();
        if (!ok.ok) log("room ttl refresh lost a race", code, "- the next sweep will retry");
      }
    }
    // 2026-07-25 (bug 2): the reunion gate's cap rides this same sweep - see sweepReunionGate().
    await sweepReunionGate(code, meta ?? null);
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
  /* -------------------------------------------------------------------------------------
   * GET /admin/push - twin of server.js's endpoint (2026-07-26 push audit).
   *
   * WHY: /admin/rooms already reports `push: !!p.pushToken` per player, which answers "did a
   * phone ever register a token" - and that flag is exactly what proved the field failure
   * (every real player false, only a test probe true). What NOTHING reported was the other
   * half: whether an attempted send was actually ACCEPTED by Apple. That half was log-only,
   * on a Deno Deploy instance whose logs nobody reads, so a revoked key or a rejected token
   * would have looked identical to everything working. This endpoint closes that gap.
   *
   * Read-only, admin-token-gated, no secrets: the key ID is an identifier (already logged in
   * plaintext by apns.ts), and lastReason is Apple's short reason word only, never a body.
   * ----------------------------------------------------------------------------------- */
  if (parts.length === 2 && parts[1] === "push" && req.method === "GET") {
    let playersWithToken = 0, playersTotal = 0, roomCount = 0;
    for await (const e of kv.list<RoomMeta>({ prefix: ["room"] })) {
      roomCount++;
      for (const p of e.value.players) { playersTotal++; if (p.pushToken) playersWithToken++; }
    }
    return json(200, { rooms: roomCount, playersTotal, playersWithToken, ...getApnsStats() });
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
  /* 2026-07-25 § ACCOUNTS (Stage 1) - twin of server.js's two new admin routes: a god-mode
     listing and the one individual reversal. Both vanish when the kill switch is off. Apple's
     `sub` is deliberately not in the listing. */
  if (ACCOUNTS_ENABLED && parts.length === 2 && parts[1] === "accounts" && req.method === "GET") {
    const out = [];
    for await (const e of kv.list<AccountRecord>({ prefix: ["account"] })) {
      const a = e.value;
      if (!a || !a.uid) continue;
      const j = await kv.get<ClaimJournal>(claimJournalKey(a.uid));
      let sessionCount = 0;
      for await (const se of kv.list<SessionRecord>({ prefix: ["session"] })) { if (se.value && se.value.uid === a.uid) sessionCount++; }
      out.push({
        uid: a.uid, gameName: a.gameName, nameFolded: a.nameFolded, created: a.created, lastSeen: a.lastSeen,
        // Which sign-in methods answer to this one account, and the verified email it links on.
        // The provider ids themselves are still deliberately withheld.
        identities: accountIdentities(a).map((i) => i.provider),
        email: a.email || null, emailPrivateRelay: !!a.emailPrivateRelay,
        nameChangedAt: a.nameChangedAt || 0, nameHistory: a.nameHistory || [], claimDeclined: !!a.claimDeclined,
        sessions: sessionCount,
        claim: j.value ? j.value.state : null,
        row: await accountRowFor(a.uid),
        // 2026-07-28 § POINTS WALLET - purely informational for Blake's own god-mode view.
        wallet: await walletView(a),
      });
    }
    return json(200, out);
  }
  if (ACCOUNTS_ENABLED && parts.length === 3 && parts[1] === "claim" && parts[2] === "undo" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const uid = typeof body.uid === "string" ? body.uid : "";
    const r = await undoAccountClaim(uid);
    if (!r.ok) return json(404, { error: r.error });
    return json(200, r);
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
          players: [{ id: playerId, token, name: hostName, isHost: true, connected: true, accountId: await resolveAcctField(msg) }],
          lobby: { n: msg.n === 6 ? 6 : 4, teams: !!msg.teams, seats },
          started: false, seatOwners: null, ready: [], paused: false, logCount: 0,
          G: null, tableSpeed: seededSpeed, recorded: false, nextSeq: 0,
          anySurrenderOccurred: false,   // v0.27.1
          reunionActive: false, tableReadyIds: [],   // 2026-07-23
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
        // 2026-07-25 § ACCOUNTS: resolved BEFORE touchRoom, never inside its mutate callback -
        // that callback is re-run on contention and must stay a pure, synchronous edit of meta.
        const joinAccountId = await resolveAcctField(msg);
        const r = await touchRoom(code, (meta) => {
          if (meta.started) return false;
          const playerId = meta.nextPlayerId++;
          const token = newToken();
          meta.players.push({ id: playerId, token, name: cleanName(msg.name, "Player"), isHost: false, connected: true, accountId: joinAccountId });
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
        /* v0.40 (2026-07-26) § ACCOUNTS - UPGRADE ONLY, and the "only" is the whole design.
           `acct` was captured once at the front door, which left one real hole: somebody who
           joined as a guest, signed in DURING the game, and then reconnected still had a null
           accountId and lost their result under the account-only switch. A rejoin may therefore
           now FILL a missing accountId - and nothing else. It can never overwrite one that is
           already set and it can never clear one, so an expired or missing session on a
           reconnect still cannot cost anybody their stats, which was the original reason rejoin
           did not touch identity at all. Resolved BEFORE touchRoom() because the mutator it takes
           is synchronous. Twin of server.js's. */
        const rejoinAcct = await resolveAcctField(msg);
        const r = await touchRoom(code, (meta) => {
          const p = meta.players.find((pp) => pp.id === playerId);
          if (!p) return false;
          p.connected = true;
          if (p.accountId == null && rejoinAcct) p.accountId = rejoinAcct;
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
          // v0.40: the contested branch resolves the challenger's identity NOW, while their
          // `acct` field is in hand, and carries it to reclaimApprove below - the host's approval
          // message obviously cannot carry the challenger's session token.
          pendingReclaims.set(reqId, { code, targetPlayerId: targetPre.id, socket, accountId: await resolveAcctField(msg), expires: Date.now() + RECLAIM_TIMEOUT_MS });
          sendToPlayer(code, hostP.id, { type: "reclaimRequest", reqId, name: targetPre.name });
          send(socket, { type: "reclaimPending", message: `${targetPre.name} looks like they're already connected - asking the host to confirm.` });
          log("reclaim contested, asked host", code, targetPre.id, "ip=" + ip);
          return;
        }
        /* v0.40 (2026-07-26) § ACCOUNTS: reclaim is "a DIFFERENT device is taking this seat by
           name", so unlike rejoin it re-asserts identity OUTRIGHT, including to null. Leaving the
           previous occupant's accountId in place would credit their account for a game somebody
           else finished, which is worse than crediting nobody. Twin of server.js's. */
        const reclaimAcct = await resolveAcctField(msg);
        const r = await touchRoom(code, (meta) => {
          const p = meta.players.find((pp) => pp.id === targetPre.id);
          if (!p || p.connected) return false; // lost the race since the pre-check above
          p.token = newToken();
          p.connected = true;
          p.accountId = reclaimAcct;
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
          p.accountId = pending.accountId || null;   // v0.40: see the reclaim case above
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
          // 2026-07-24 (Blake's follow-up: "let me set the cpu difficulty when playing an
          // online game") - host-only (guarded above, unchanged), CPU-seat difficulty patch.
          // Validated against the same three real tiers takeOverSeat already checks below
          // (easy/medium/hard - Easy/Tricky/Nasty are just the display names, see index.html's
          // DIFF_LABEL) - keeps server.js/server.ts parity exact.
          if (patch.diff && ["easy", "medium", "hard"].includes(patch.diff as string)) seat.diff = patch.diff as string;
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
          tallyKnockout(E, match);   // 2026-07-24 item 9 - see that function's comment
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
        const converted = await leaveSeatForGoodInternal(code, playerId, socket);
        log("player left for good", code, playerId, converted ? "(seat converted to CPU)" : "(no active seat)");
        return;
      }

      case "surrender": {
        // v0.27: {type:'surrender'} — twin of server.js's case. Blake's ask: the topbar Quit
        // button, "Leave without saving" and "Have a computer take over my seat" (both under
        // Pause/Save's sheet), and deleting a saved-game tile for a room you're in, ALL
        // permanently abandon an unfinished game now and count as a loss on the leaderboard (see
        // index.html's doSurrenderCurrentGame()/surrenderOnlineTile(), HANDOFF.md v0.27 for the
        // full design). Records exactly one hg<mode>+1 for THIS seat's stored name — no
        // hw<mode>, no points, the same per-seat loss shape buildResultEntriesServer() already
        // writes for a real finish, just recorded without G.over ever becoming true — then
        // reuses the EXACT SAME conversion/lockout machinery as "leaveForGood" via
        // leaveSeatForGoodInternal() above. Additive-safe by construction: old clients simply
        // never send this message type.
        //
        // v0.27.1 § NO-FAULT EXIT — twin of server.js's case. Once ANY human has surrendered in
        // this still-unfinished game, meta.anySurrenderOccurred (see the RoomMeta type,
        // actuallyStartGame()'s reset) is already true — every OTHER human's subsequent
        // departure from this SAME game is then a free, no-fault exit: the leaderboard write is
        // skipped entirely, a true stat-wise no-op, not a disguised win. The flag is read from
        // `meta` (the pre-conversion RoomMeta leaveSeatForGoodInternal() already read inside the
        // withRoomChain lock — safe to trust as current, nothing else can mutate this room
        // concurrently) and, on the genuine first surrender, the hook asks
        // leaveSeatForGoodInternal() to commit it true via {setSurrenderFlag:true} (see that
        // function's comment for why it can't just set meta.anySurrenderOccurred directly here).
        if (!ctx) return;
        const { code, playerId } = ctx;
        const converted = await leaveSeatForGoodInternal(code, playerId, socket, async (G, seat, meta) => {
          if (G.over || G.seats[seat].type !== "human") return;   // already finished, or not actually a human seat — nothing to surrender
          const mode = (G.n === 4 ? "4" : "6") + (G.teams ? "t" : "s");
          if (meta.anySurrenderOccurred) {
            // Someone else already surrendered this same game - free, no-fault exit: no
            // hg<mode>, no loss, no points.
            //
            // 2026-07-25 (bug 5): this branch used to `return` right here, before building any
            // delta, so this player's already-accrued hkoDealt/hkoTaken were lost permanently
            // (their seat becomes a CPU immediately after, so recordFinishedGame() skips it
            // too). A knockout genuinely happened at the table, it is a fun lifetime stat rather
            // than a competitive one, and nobody else's concession should erase it. The free
            // exit now still writes a delta - just one holding ONLY the knockout keys. Twin of
            // server.js's matching branch.
            const koDelta: Record<string, number> = {};
            if (G.koDealt && G.koDealt[seat]) koDelta.hkoDealt = G.koDealt[seat];
            if (G.koTaken && G.koTaken[seat]) koDelta.hkoTaken = G.koTaken[seat];
            if (Object.keys(koDelta).length) await applyLeaderboardEntry(G.seats[seat].name, koDelta);
            log("no-fault exit (someone already surrendered this game)", code, "seat=" + seat, "name=" + G.seats[seat].name, "mode=" + mode, "knockouts kept=" + JSON.stringify(koDelta));
            return;
          }
          const delta: Record<string, number> = {}; delta["hg" + mode] = 1;
          // 2026-07-24 item 9: knockouts already dealt/suffered THIS game before the surrender are
          // real and still count - see server.js's matching comment.
          if (G.koDealt && G.koDealt[seat]) delta.hkoDealt = G.koDealt[seat];
          if (G.koTaken && G.koTaken[seat]) delta.hkoTaken = G.koTaken[seat];
          await applyLeaderboardEntry(G.seats[seat].name, delta);
          log("surrender recorded", code, "seat=" + seat, "name=" + G.seats[seat].name, "mode=" + mode);
          return { setSurrenderFlag: true };
        });
        log("player surrendered", code, playerId, converted ? "(seat converted to CPU)" : "(no active seat)");
        return;
      }

      case "takeOverSeat": {
        // v0.25 items 6+7 § REJOIN LOBBY - twin of server.js's case: any seated player may
        // hand an ABSENT human's seat to a real CPU from the rejoin lobby. Same conversion
        // machinery and permanence as "leaveForGood" (seatToCpu broadcast + lockout).
        if (!ctx) return;
        const { code, playerId } = ctx;
        const seat = Number(msg.seat);
        const diff = ["easy", "medium", "hard"].includes(msg.diff as string) ? (msg.diff as string) : "medium";
        await withRoomChain(code, async () => {
          const pre = await kv.get<RoomMeta>(roomKey(code));
          if (!pre.value || !pre.value.started || !pre.value.seatOwners) return;
          const meta = pre.value;
          if (!meta.seatOwners!.includes(playerId)) return;      // only a seated player may ask
          const ownerId = meta.seatOwners![seat];
          if (ownerId == null || ownerId === playerId) return;   // your own seat has "leaveForGood"
          const owner = meta.players.find((p) => p.id === ownerId);
          if (!playerLooksAway(code, owner)) return;             // they're right there - hands off
          const E = getEngine(code, meta);
          if (!E) return;
          const G = E.getG();
          if (!G || G.over) return;
          const seatCfg = G.seats[seat];
          if (!seatCfg || seatCfg.type !== "human") return;
          const takenName = seatCfg.name;
          seatCfg.type = "cpu";
          seatCfg.diff = diff;
          const out: Broadcastable[] = [{ payload: { type: "gameAction", seq: meta.nextSeq++, action: { kind: "seatToCpu", seat, diff, name: takenName } } }];
          // The seat may be the on-turn seat everyone has been waiting on - drive forward now.
          const cont = driveTurnLoopCollect(E, meta);
          const ok = await commitAndBroadcast(code, E, out.concat(cont.out), cont.finished);
          if (ok) maybeSendTurnPush(code, E, cont.finished).catch((e) => log("push check failed", code, (e as Error).message));
          // Follow-up commit for the lockout + seatOwners slot - same pattern as leaveForGood
          // (it must land even though commitAndBroadcast just persisted a fresh meta.G).
          //
          // 2026-07-25 (DENO-ONLY BY NATURE): gated on `ok`. This used to run unconditionally,
          // so a FAILED commitAndBroadcast (contention, a vanished room) still locked the seat's
          // owner out and blanked their seatOwners slot - while KV still held them as a live
          // HUMAN seat, because the conversion itself never landed. That combination strands the
          // seat: the original player can never get back in, and no CPU is playing it either.
          // server.js cannot produce this at all - its conversion and its lockout are the same
          // synchronous block with nothing that can fail between them.
          if (!ok) { log("takeOverSeat commit failed - leaving the seat untouched", code, "seat=" + seat); return; }
          await touchRoom(code, (m) => {
            const p = m.players.find((pp) => pp.id === ownerId);
            if (p) p.leftForGood = true;
            if (m.seatOwners) m.seatOwners[seat] = null;
            return {};
          });
          log("rejoin lobby: seat handed to a computer", code, "seat=" + seat, "diff=" + diff, "by playerId=" + playerId);
        });
        // 2026-07-23: converting the last missing seat can complete an open reunion gate on its
        // own (nobody left to ready up for) - re-check, outside the chain (maybeResolveReunion
        // does its own touchRoom, same pattern as every other post-withRoomChain follow-up here).
        await maybeResolveReunion(code);
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
        const { code, playerId } = ctx;
        const wantPaused = !!msg.paused;
        // 2026-07-25 (bug 1) § REUNION GATE GUARD - twin of server.js's matching guard; see the
        // big comment above server.js's maybeResolveReunion() for the full root cause. In short:
        // this case set meta.paused unconditionally, so an unpause arriving while the ready-up
        // gate was open BYPASSED the gate and left reunionActive stuck true forever, which made
        // every later reunion a silent no-op for that room's whole life. Cancelling the
        // Pause/Save sheet and an older build's tap-to-resume both send exactly this message.
        // An unpause is refused while a gate is open and the asker is told plainly why; a PAUSE
        // is still fine (the gate has already paused the table, so it changes nothing).
        let refused: RoomMeta | null = null;
        const r = await touchRoom(code, (meta) => {
          if (!meta.started) return false;
          if (!wantPaused && meta.reunionActive) { refused = meta; return false; }
          meta.paused = wantPaused;
          return {};
        });
        if (refused) {
          const m = refused as RoomMeta;
          send(socket, { type: "error", message: "Everyone is checking in first. Tap Ready up when you are ready to keep playing." });
          // Re-state the truth to just this player, so a client that assumed its own tap worked
          // (or an older build with no idea this gate exists) lands back on the real state.
          send(socket, { type: "paused", paused: true });
          send(socket, { type: "reunionStatus", active: true, readyPlayerIds: m.tableReadyIds || [] });
          log("unpause refused - reunion gate open", code, "playerId=" + playerId);
          return;
        }
        if (r.ok) broadcastRoom(code, { type: "paused", paused: r.meta.paused });
        return;
      }

      case "requestReunion": {
        // 2026-07-23 (Blake's item 2) § REUNION READY GATE - twin of server.js's case, see the
        // big comment above that file's maybeResolveReunion() for the full design. A client
        // sends this the moment it deliberately comes back to a game (index.html's onSync()
        // enteringViaResume branch), ALWAYS, not just when someone looks missing - "presence"
        // alone silently standing in for "actually at the table" was Blake's exact report.
        // Idempotent: if a reunion is already open, this is a no-op - the caller gets the SAME
        // gate's state via the reunionActive/tableReadyIds fields already riding their own sync.
        if (!ctx) return;
        const { code, playerId } = ctx;
        const r = await touchRoom(code, (meta) => {
          if (!meta.started || meta.reunionActive) return false;
          // 2026-07-25 (bug 7): the same seat check its sibling "tableReadyUp" below has always
          // had - twin of server.js's guard. Without it a guest who joined the lobby but never
          // claimed a seat could pause the whole table, and then could NOT clear it, because
          // tableReadyUp DOES check seatOwners so their own ready-up was rejected.
          if (!meta.seatOwners || !meta.seatOwners.includes(playerId)) return false;
          meta.paused = true;
          meta.reunionActive = true;
          meta.tableReadyIds = [];
          meta.reunionOpenedAt = Date.now();   // 2026-07-25 (bug 2): starts REUNION_GATE_CAP_MS
          return {};
        });
        if (r.ok) {
          broadcastRoom(code, { type: "paused", paused: true });
          broadcastRoom(code, { type: "reunionStatus", active: true, readyPlayerIds: [] });
          log("reunion opened", code, "by playerId=" + playerId);
        }
        return;
      }

      case "tableReadyUp": {
        // 2026-07-23 (Blake's item 2): {type:'tableReadyUp'} - twin of server.js's case. Requires
        // an actually-seated human and an ACTIVE gate; a stale/late tap after the table already
        // resumed on its own is a harmless no-op.
        if (!ctx) return;
        const { code, playerId } = ctx;
        const r = await touchRoom(code, (meta) => {
          if (!meta.started || !meta.reunionActive) return false;
          if (!meta.seatOwners || !meta.seatOwners.includes(playerId)) return false;
          const s = new Set(meta.tableReadyIds || []);
          s.add(playerId);
          meta.tableReadyIds = Array.from(s);
          return {};
        });
        if (r.ok) {
          broadcastRoom(code, { type: "reunionStatus", active: true, readyPlayerIds: r.meta.tableReadyIds || [] });
          await maybeResolveReunion(code);
        }
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
          tallyKnockout(E, m);   // 2026-07-24 item 9 - see that function's comment
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
    if (!ctx) return;
    // 2026-07-26: the body used to live inline here. It moved out to applyDisconnect() (see §
    // HEARTBEAT) so the stale-socket sweep can run the SAME cleanup for a socket whose closing
    // handshake will never finish. Behaviour for a normal close is unchanged.
    applyDisconnect(ctx.code, ctx.playerId, socket);
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
  // 2026-07-25 § ACCOUNTS: the additive board route - /leaderboard's flat body deliberately
  // never changes shape, so the extra "is this row attached to an account, or is it frozen
  // history" detail lives here. Twin of server.js's.
  if (ACCOUNTS_ENABLED && url.pathname === "/leaderboard/v2") {
    const [rows, epoch] = await Promise.all([boardRowsForDisplay(), getEpoch()]);
    const entries = rows.detail ||
      Object.keys(rows.flat).map((name) => ({ name, stats: rows.flat[name], account: false, frozen: false }));
    return json(200, { epoch, accountsOnly: accountsOnlyBoard(), claimWindow: claimWindowView(), entries });
  }
  // 2026-07-28 § POINTS WALLET - the server-owned shop catalog. Twin of server.js's: a plain,
  // unauthenticated GET, gated on the same accounts kill switch as the rest of this feature.
  if (ACCOUNTS_ENABLED && url.pathname === "/shop" && req.method === "GET") {
    return json(200, { items: SHOP_CATALOG });
  }
  // 2026-07-25 § ACCOUNTS: only routed when the kill switch is ON. With
  // NASTY_ACCOUNTS_ENABLED=0 these paths fall through to the same 404 they hit today - twin of
  // server.js's matching guard.
  if (ACCOUNTS_ENABLED && url.pathname.startsWith("/account/")) {
    try { return await handleAccountRoute(req, url, ip); }
    catch (e) { log("account route error", e); return json(500, { error: "server error" }); }
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
