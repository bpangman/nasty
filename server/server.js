"use strict";
/*
 * NASTY relay server — v0.15: SERVER-AUTHORITATIVE game state.
 *
 * Through v0.14 this was a dumb room registry + message relay: the server never touched game
 * rules, every phone ran the identical rules code against its own copy of G, and the HOST'S
 * phone was the sole source of CPU moves and reshuffle randomness. That design's fatal flaw:
 * when the host's phone backgrounded (a text message, a lock), CPU turns and reshuffles
 * stalled for the WHOLE ROOM — see HANDOFF.md's "v0.15" section for the full writeup and
 * Blake's exact bug report that finally forced this rebuild.
 *
 * As of v0.15, the server holds the ONE authoritative copy of `G` per room (via a private
 * server/engine.js instance — the SAME rules code index.html runs, mechanically extracted, not
 * a hand-maintained second copy — see server/build-engine.js). The server shuffles/deals,
 * validates and applies every human move, runs every CPU turn itself, decides bow-outs and the
 * whole-table-stuck throw-in, and appends+broadcasts the resulting action stream. No host-phone
 * specialness remains anywhere in this file — "host" now only ever means "may Start the room /
 * may change the table speed," lobby-management things, never a gameplay-decision role.
 *
 * Everything else in this file that ISN'T game state is UNCHANGED from v0.14: room codes,
 * rejoin tokens, token-less reclaim-by-name, room persistence to disk, the reunion/regroup
 * lobby + presence + Nudge, the global leaderboard + admin god-mode + CORS + rate limits, the
 * AASA well-known file + /join/:CODE redirect. See HANDOFF.md "v0.15" for the exact list of
 * what changed vs. what was carried forward, and the wire-protocol diff (new action kinds,
 * protocol version handshake, the snapshot-based reconnect shape, the table-speed setting).
 */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { createEngine } = require("./engine.js");
const { sendTurnPush, getApnsStats } = require("./apns.js");

const PORT = process.env.NASTY_PORT ? parseInt(process.env.NASTY_PORT, 10) : 8484;
// v0.8: two different prune windows. A lobby that never started is cheap to lose (nothing
// to come back to) so it keeps the original short fuse; a game that's actually IN PROGRESS
// needs to survive "come back tomorrow" — see PLANNING.md v0.8.
const ROOM_TTL_MS = 30 * 60 * 1000;              // never-started lobby, fully disconnected
const STARTED_ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // started-but-unfinished game, fully disconnected
const PRUNE_EVERY_MS = 5 * 60 * 1000;
// v0.22 P4: 30s -> 25s. Cellular NAT gateways drop idle mappings in as little as ~30s; the
// standard sizing is a heartbeat at ~75% of the shortest infrastructure timeout. The same
// interval also carries an APP-LEVEL {type:'ping'} alongside the protocol-frame ping (see the
// hb interval near the bottom) - a frozen WKWebView's networking process can keep answering
// protocol-frame pings while the page's JS is suspended, so only an app-level echo proves the
// CLIENT is actually alive. That app-level proof feeds the § AWAY LADDER's "silent" detection.
//
// 2026-07-26: 25s -> 4s, and the app-level echo now governs socket teardown too (it used to be
// deliberately excluded, because builds 16-17 never sent one). TWO reasons, both measured:
//   1. PARITY. server/cloud/server.ts - the server Blake's family actually plays on - has run
//      HEARTBEAT_MS 4000 / SOCKET_STALE_MS 12000 keyed off the app-level echo since v0.16.
//      This file sat at 25s keyed off the protocol-frame pong, so the two servers reported a
//      dropped player at wildly different times: ~12-16s there, 25-50s here. The standing rule
//      is exact behavioural parity, so this file now uses the cloud server's numbers and its
//      rule. More frequent pings are strictly safer for the cellular-NAT concern above, not
//      less, so the original sizing reasoning is untouched.
//   2. The old carve-out is obsolete. Builds 16-17 cannot reach a room any more - the protocol
//      gate rejects everything below the current PROTOCOL_VERSION outright (see the
//      protocolMismatch path, and the pinned build 28/30/32 lockout legs in
//      tests/test_freeze_recovery.js). Every client that can get in today echoes app-level
//      pings, so nothing is left to protect.
// The protocol-frame ping is still SENT (it is free and it keeps NAT mappings warm), it just no
// longer decides anything - see the hb interval for why that matters.
const HEARTBEAT_MS = 4 * 1000;
// 2026-07-26: twin of server.ts's constant of the same name. ~1 missed reply is tolerated, 2 in
// a row is not.
const SOCKET_STALE_MS = HEARTBEAT_MS * 3;
// v0.8: rooms directory for on-disk persistence (one JSON file per room). Override via
// NASTY_ROOMS_DIR for tests, so a test server never touches production's saved rooms.
const ROOMS_DIR = process.env.NASTY_ROOMS_DIR
  ? path.resolve(process.env.NASTY_ROOMS_DIR)
  : path.join(__dirname, "rooms");
const PERSIST_DEBOUNCE_MS = 800;

// no vowels/Y and no easily-confused characters -> codes never spell a word, never
// look like 0/O or 1/I/L
const CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXZ";

/* ---------------------------------------------------------------------------------------
 * v0.15 § PROTOCOL VERSION — this is a BREAKING wire-protocol change: a pre-v0.15 client (the
 * old lockstep architecture, which generates its own CPU moves/reshuffles and expects a bare
 * relay) cannot talk to this server, and this server cannot correctly serve a pre-v0.15 client
 * (it would silently never receive the CPU moves/reshuffles it's waiting to generate itself,
 * since this server now generates and pushes complete actions instead). `host`/`join`/
 * `rejoin`/`reclaim` all now carry `protocolVersion` from the client; anything missing or below
 * PROTOCOL_VERSION gets a plain-language, non-technical rejection instead of a confusing
 * silent failure. See index.html's handling of `protocolMismatch` for the client side.
 * ------------------------------------------------------------------------------------- */
/* v0.23 (2026-07-20): 2 -> 3 for the "you can NOT take out your own pegs" rule change - move
 * legality changed (own/partner landings are illegal now), so protocol-2 clients (builds
 * 16-29) would offer/submit moves this server's legalMoves() no longer produces. The gate
 * gives them the plain-language update message below instead of silent desyncs; the engine's
 * own legalMoves() validation in the "action" case still rejects any stale move gracefully
 * (resync, never a crash). */
/* v0.23.1 (2026-07-20, Blake's confirmed partner-peg ruling): 3 -> 4. Landing on a PARTNER's
 * peg is now legal as a LAST RESORT (only possible play in the whole hand - it kicks the
 * partner peg to base instead of the player bowing out). A protocol-3 client (build 30 /
 * v0.23 website) computes its own seat's legal-move list LOCALLY just to decide whether to
 * offer a tappable hand; in the forced-partner-landing situation its v0.23 engine finds ZERO
 * moves and sits passively on "Catching up..." while THIS server waits forever for that
 * player's move - a softlock, so old clients are NOT safe and the gate must turn them away
 * with the same friendly update message. */
/* v0.25 (2026-07-21): 4 -> 5. The online START flow changed shape: readiness is now collected
 * IN THE LOBBY (a guest's "Ready up" on the seat screen, the host's Start acting as their own
 * ready) and the whole post-Start readyCheck phase is GONE from the wire. A protocol-4 client
 * (build 32 / v0.24 website) would (a) as a guest, never ready up in the lobby - it waits for
 * a 'readyCheck' broadcast that never comes, so a new host could never start with them seated;
 * (b) as a host, tap Start expecting the readyCheck phase and deal immediately under guests
 * who were never asked anything; and (c) never understands the v0.25 rejoin-lobby flow
 * (takeOverSeat). Not safe either direction - protocol-4 clients get the same friendly
 * update message at host/join/rejoin/reclaim. */
/* 2026-07-24 (Blake's items 9+14, "2026-07-23 list"): STAYS at 5, not bumped. Item 9's two new
 * leaderboard stat keys (hkoDealt/hkoTaken) ride the EXISTING /solo-result body shape and the
 * server's own internal result recording - no new message type, no changed shape of any existing
 * one; an old server just ignores the two new keys (not in its own NUMERIC_STAT_KEY yet), an old
 * client just never sends them - same additive pattern as the hptsS/hptsT split (see HANDOFF.md
 * v0.21). Item 14 (choosing Teams for an online game) needed ZERO server changes at all - `teams`
 * has ridden the `host` message and `room.lobby.teams` since this field existed; this session's
 * fix is exposing/displaying it client-side, not adding to the wire. See index.html's
 * PROTOCOL_VERSION comment for the full reasoning on both. */
/* 2026-07-25 § ACCOUNTS (server plumbing, four sign-in methods): STAYS at 5, not bumped.
 * The bar this project set itself is index.html's: "an old client can never get stuck waiting on
 * a reply it doesn't know how to interpret." Applied to this batch:
 *   - Everything added is NEW HTTP endpoints under /account/* (plus /leaderboard/v2 and two new
 *     /admin/* routes). An old client never calls them. A new client talking to an old server
 *     gets a plain 404 and treats any non-200 as "accounts unavailable, stay a guest" - it is
 *     never left waiting.
 *   - ONE optional websocket field: `acct` on `host`/`join`. An old client never sends it and is
 *     a guest in that room, exactly as today; a new client sending it to an old server has the
 *     field ignored, exactly as `diff`, `teams` and `speed` were ignored before they existed.
 *     No reply changed shape in either direction, and `rejoin`/`reclaim` and the room
 *     playerId/token credential are untouched.
 *   - /leaderboard's response body is unchanged: still the flat {displayName:{stats}} map. The
 *     account-keyed rows live in a separate namespace that nothing serves unless
 *     NASTY_LEADERBOARD_ACCOUNTS_ONLY is switched on, so every already-shipped TestFlight build
 *     keeps rendering a correct board - and keeps rendering one after the switch, because the
 *     shape still does not change.
 *   - /solo-result's request and response shapes are unchanged.
 * Same additive shape as hkoDealt/hkoTaken (2026-07-24) and hptsS/hptsT (v0.21), both of which
 * this block declined to bump for. The one change that WOULD need a bump is making the account
 * token REQUIRED on `host` or `join`. Never do that - it is written here so a future session
 * does not "tidy it up" into a requirement. */
const PROTOCOL_VERSION = 5;
const PROTOCOL_MISMATCH_MESSAGE =
  "This game needs the newest version of NASTY. Please refresh the page (website) or update the app (App Store) and try again.";
function protocolOk(msg) {
  return typeof msg.protocolVersion === "number" && msg.protocolVersion >= PROTOCOL_VERSION;
}

/* ---------------------------------------------------------------------------------------
 * v0.15.1 hotfix (2026-07-16, Blake's report: hosting bounces to the menu with no
 * explanation; a "Resume" tile that does nothing). A pre-v0.15 client (v0.14 and earlier —
 * everything through iOS TestFlight build 15) does not understand ANY of the wire's v0.15
 * message types, INCLUDING 'protocolMismatch' itself (it's new in this same breaking
 * change) — so the plain-language rejection above never actually reaches the user on an old
 * app; its message switch silently falls through to `default: return`. Fix: alongside the
 * modern 'protocolMismatch' reply (kept as-is, for hygiene and any future client that only
 * understands wire-level types), ALSO send a second reply shaped exactly like an error type
 * the OLD client's own (pre-v0.15) switch already renders for that specific flow — confirmed
 * by reading index.html as it existed at commit 8a186ab (iOS build 15's client):
 *   - host:    no case shows an arbitrary message mid-host-flow (the online overlay already
 *              closes to the bare menu the instant "Host a game" is tapped, before any
 *              server reply can arrive) — 'kicked' is the one generic case that both toasts
 *              a message AND resets to a clean menu regardless of what's on screen, so it
 *              doubles as the host-error display here even though nothing was kicked.
 *   - join:    'joinError' renders inline in the join screen's visible error text.
 *   - rejoin:  'rejoinError' toasts the message (this is the exact path a stale "Resume"
 *              tile's tap takes — the fix for Blake's dead-tile report).
 *   - reclaim: 'reclaimError' renders inline, same spot as joinError.
 * ------------------------------------------------------------------------------------- */
const LEGACY_CLIENT_MESSAGE =
  "This game needs the newest version of NASTY - please update the app in TestFlight, or refresh the website, then try again.";
function sendLegacyMismatch(ws, kind) {
  const type = kind === "host" ? "kicked" : kind === "join" ? "joinError" : kind === "rejoin" ? "rejoinError" : "reclaimError";
  send(ws, { type, message: LEGACY_CLIENT_MESSAGE });
}

/* v0.15.1 hotfix 2/2, server side (2026-07-16, Blake's report on iOS build 16: hosting a NEW
 * game bounces straight back to the menu, no explanation). Root-caused via an exact-build-16
 * client reproduction: a v0.15 client (protocolVersion 2 - this is NOT the pre-v0.15
 * sendLegacyMismatch case above, build 16 already understands protocolMismatch fine) built
 * BEFORE commit c86a253 never clears its `nasty-last-room` pointer or SAVED_GAME menu state on
 * a 'rejoinError'/'reclaimError' for a dead room - that client-side bug is what c86a253 fixes,
 * but build 16 (already submitted to TestFlight review) predates it. Left uncleared, the stale
 * resume tile keeps re-showing, and - the actual blocker - EVERY subsequent "Start"/"Host a
 * game"/"Join a game" tap routes through that build's confirmOverwriteThenRun(), which pops a
 * "You have a saved game - starting a new one will replace it" warning the user never asked for;
 * tapping its Cancel (the natural response to a warning about a game you don't recognize) drops
 * straight back to the bare menu with nothing hosted - Blake's exact symptom.
 *
 * A dead/unmigratable room can NEVER legitimately be an in-progress v0.15+ game for ANY client
 * (see isUnmigratableRoom below - a real v0.15+ room always has `engine` set once started; a
 * generic "room/player/token not found" miss on a rejoin/reclaim likewise means the room is
 * verifiably, permanently gone, not just briefly unreachable). So for these specific "this room
 * is dead" replies, ALSO send a 'kicked'-shaped follow-up alongside the existing
 * rejoinError/reclaimError reply: 'kicked' is the one message type whose handler
 * (leaveOnlineToMenu(), index.html) unconditionally clears nasty-last-room, resets NET state,
 * closes whatever overlay is open (including the join overlay a rejoinError may have already
 * opened), and lands on a clean, immediately-usable menu - build 16 already had this exact
 * handler (it's what 'kicked' has always done), it just never got called for a dead-room
 * rejoin/reclaim before now. A post-c86a253 client (which already runs rejoinError through the
 * same leaveOnlineToMenu() path when no game is in progress) treats this follow-up as a no-op
 * repeat of what it just did - verified harmless by re-running the exact reproduction against
 * the current client too. No em/en dashes in the message text (standing rule). */
function sendDeadRoomFollowup(ws, message) {
  send(ws, { type: "kicked", message });
}

/* v0.15.1 hotfix, part 2: rooms persisted by a pre-v0.15 server (or a v0.15 room that was
 * started before this session's rebuild) have no `G` field at all, so roomFromDisk() above
 * leaves `room.engine` null even though `room.started` is true — this server has no rules
 * engine state to drive that room with. Live examples on prod at the time of this fix: HWRK,
 * MNDW, XKTH. A rejoin/reclaim against one of these used to silently send `G: null` inside a
 * 'sync'/'reclaimed' message, which the client can't boot a game from — a second silent-
 * failure shape, same user-visible symptom as the dead resume tile above. Detected the same
 * way in both entry points: `room.started && !room.engine`. */
const OLD_ROOM_MESSAGE =
  "That game was from the old version and can't be continued - please start a fresh one.";
function isUnmigratableRoom(room) {
  return !!(room && room.started && !room.engine);
}
function pruneUnmigratableRoom(room) {
  rooms.delete(room.code);
  deleteRoomFile(room.code);
  log("pruned unmigratable pre-v0.15 room", room.code);
}

/** @type {Map<string, Room>} */
const rooms = new Map();
// v0.10.3: token-less recovery — {reqId -> {code, targetPlayerId, ws, expires}}. A contested
// "reclaim" (the named seat is still showing connected) parks here waiting for the host to
// approve/deny; see "reclaim"/"reclaimApprove" below and the periodic sweep near the room
// pruner further down this file.
const pendingReclaims = new Map();
const RECLAIM_TIMEOUT_MS = 30 * 1000;

function log(...a) { console.log(new Date().toISOString(), ...a); }

/* ---------------------------------------------------------------------------------------
 * v0.9 § NAMES — same shared limit + modest profanity blocklist as index.html's § NAMES
 * section (duplicated, not imported: this is a standalone Node file with zero dependencies
 * beyond `ws`, on purpose, and index.html is a browser script — no shared module between
 * them). Keep these two copies in sync if the list/limit ever changes.
 * ------------------------------------------------------------------------------------- */
const NAME_MAX = 10;
const NAME_BLOCKLIST = ["fuck","shit","bitch","asshole","bastard","dick","pussy","cunt",
  "nigger","nigga","fag","faggot","retard","whore","slut","cock","twat","coon","spic",
  "chink","kike","tranny","rape","nazi","dyke","cracker"];
function normalizeName(s) {
  return String(s || "").toLowerCase()
    .replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a")
    .replace(/5/g, "s").replace(/7/g, "t").replace(/\$/g, "s").replace(/@/g, "a")
    .replace(/[^a-z]/g, "");
}
function isBadName(raw) {
  const n = normalizeName(raw);
  return !!n && NAME_BLOCKLIST.some(w => n.includes(w));
}
function cleanName(raw, fallback) {
  const s = String(raw || "").trim().slice(0, NAME_MAX);
  return s || fallback || "";
}
/* 2026-07-25 § LEADERBOARD NAME FOLDING (bug 6) - cleanName() trims and caps length but
   deliberately does NOT change what the player typed; it produces the DISPLAY name used
   everywhere (lobby seats, in-game plates, admin renames), so case-folding it would be wrong.
   The LEADERBOARD, though, is a lifetime record of a PERSON, and "Blake" / "blake" / "BLAKE"
   are one person - the same human on a phone and an iPad. leaderboardNameKey() is the fold used
   ONLY for leaderboard identity: lower-cased, nothing else (no digit/symbol substitution - that
   is normalizeName()'s job for the profanity blocklist, and it strips so much that genuinely
   different names could collide). Twin of server.ts's matching helper. */
function leaderboardNameKey(cleanedName) {
  return String(cleanedName || "").toLowerCase();
}

/* ---------------------------------------------------------------------------------------
 * v0.9 § ADMIN — "god mode" for Blake. Unchanged from v0.14.
 * ------------------------------------------------------------------------------------- */
const ADMIN_TOKEN_FILE = process.env.NASTY_ADMIN_TOKEN_FILE
  ? path.resolve(process.env.NASTY_ADMIN_TOKEN_FILE)
  : path.join(__dirname, "admin-token.txt");
function loadOrCreateAdminToken() {
  try {
    const t = fs.readFileSync(ADMIN_TOKEN_FILE, "utf8").trim();
    if (t) return t;
  } catch (e) { /* doesn't exist yet — fall through and create one */ }
  const t = crypto.randomBytes(24).toString("hex");
  try {
    fs.writeFileSync(ADMIN_TOKEN_FILE, t + "\n", { mode: 0o600 });
    fs.chmodSync(ADMIN_TOKEN_FILE, 0o600);
  } catch (e) { log("could not persist admin token", e.message); }
  return t;
}
const ADMIN_TOKEN = loadOrCreateAdminToken();
function checkAdminToken(req, url) {
  const header = req.headers["x-admin-token"];
  const q = url.searchParams.get("token");
  const given = header || q || "";
  return given && given === ADMIN_TOKEN;
}

/* ---------------------------------------------------------------------------------------
 * v0.9 § LEADERBOARD — the shared, all-time, human-only leaderboard. Unchanged from v0.14
 * except WHO calls applyLeaderboardEntry() for an ONLINE game: v0.14 waited for the host's
 * phone to notice the win screen and send `recordResult`; v0.15's server already knows the
 * instant a game ends (it's the one that ran applyMove() and saw G.over flip), so it records
 * directly — see "§ v0.15 SERVER-SIDE WIN RECORDING" below. Solo/offline games are unaffected
 * (still POST /solo-result, see "§ SOLO RESULTS").
 * ------------------------------------------------------------------------------------- */
const LEADERBOARD_FILE = process.env.NASTY_LEADERBOARD_FILE
  ? path.resolve(process.env.NASTY_LEADERBOARD_FILE)
  : path.join(__dirname, "leaderboard.json");
let globalBoard = {};
/* 2026-07-25 (bug 6): lower-cased name -> the DISPLAY key that name's row actually lives under
   in globalBoard. Rebuilt from scratch on every load and kept in step with every write below;
   this is what makes "Blake" and "blake" land on the same lifetime row without changing the
   board's on-disk shape (still keyed by a display name, so index.html needs no change at all).
   Twin of server.ts's ["lbname", lower] KV index - see that file for the KV-shaped version. */
let lbNameIndex = new Map();
function rebuildLbNameIndex() {
  lbNameIndex = new Map();
  for (const k of Object.keys(globalBoard)) lbNameIndex.set(leaderboardNameKey(k), k);
}
/* The row this cleaned name belongs to. If ANY capitalization of it is already on the board,
   that existing row wins - the display capitalization is deliberately STICKY rather than being
   rewritten to whatever spelling happened to submit most recently. Rewriting it would mean
   renaming the row's key on every game, which on the Deno twin means moving up to ten separate
   KV counters non-atomically - a real risk of losing stats for a purely cosmetic benefit. */
function boardKeyFor(clean) {
  const lower = leaderboardNameKey(clean);
  const existing = lbNameIndex.get(lower);
  if (existing && globalBoard[existing]) return existing;
  lbNameIndex.set(lower, clean);
  return clean;
}
function loadLeaderboard() {
  try { globalBoard = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, "utf8")) || {}; }
  catch (e) { globalBoard = {}; }
  rebuildLbNameIndex();
}
let lbPersistTimer = null;
function scheduleLeaderboardPersist() {
  if (lbPersistTimer) return;
  lbPersistTimer = setTimeout(() => { lbPersistTimer = null; persistLeaderboardNow(); }, PERSIST_DEBOUNCE_MS);
}
function persistLeaderboardNow() {
  try { fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(globalBoard)); }
  catch (e) { log("leaderboard persist failed", e.message); }
}
// v0.21: leaderboard split into Solo/Teams tabs client-side - the aggregate "hpts" key is
// replaced going forward by hptsS (solo/free-for-all wins) and hptsT (team wins). hpts itself
// is deliberately NOT in this regex anymore (nothing should be storing fresh points under that
// literal key going forward) - see applyLeaderboardEntry()'s legacy-attribution logic just
// below for how an OLD client's plain "hpts" delta still gets accepted and redirected into the
// correct split key, and migrateLegacyLeaderboardPoints() further below for the one-time boot
// migration of points already on disk from before this split.
// 2026-07-24 (Blake's item 9, "2026-07-23 list"): hkoDealt/hkoTaken added - lifetime, human-only
// knockout stats (see the § KNOCKOUT TALLY block below, right before buildResultEntriesServer()).
// Unlike hptsS/hptsT these have no legacy predecessor to migrate - a brand-new key simply reads
// as 0 for any entry that's never had one written (see applyLeaderboardEntry()'s own `r[key]||0`
// below), so no boot-time migration function was needed for these two, unlike
// migrateLegacyLeaderboardPoints() just below.
const NUMERIC_STAT_KEY = /^(hg[46][st]|hw[46][st]|hptsS|hptsT|hkoDealt|hkoTaken)$/;
/* 2026-07-25 § STAT DELTA VALIDATION (bug 4) - the only thing this used to check was
   Number.isFinite(v), which let a NEGATIVE delta through: a lifetime stat could go DOWN, and
   the Deno twin (unsigned KvU64 counters) threw outright on the same input and answered HTTP
   500 while this file answered 200 - two servers whose whole contract is identical behavior
   disagreeing on a plain POST. Both now apply exactly these rules, per key:
     - must be a finite NUMBER (a numeric string like "3" is rejected, not coerced - a real
       client has never sent one, and coercing is how junk creeps in);
     - must be a whole number (no fractions - every stat this app records is a count);
     - must be strictly POSITIVE (zero is nothing to record; negative is never legitimate -
       nothing in the app has ever decremented a lifetime stat, and the admin god-mode PATCH
       route is the deliberate, authenticated way to correct a number downward);
     - must be <= MAX_STAT_DELTA.
   MAX_STAT_DELTA is an absurdity ceiling, not a game rule. The largest value any single real
   game can produce is small and knowable: games/wins are always 1; points top out at 15 (a
   6-player table, five human opponents at 3 points each - see pointsForWinServer()); knockouts
   are a few dozen at the very most in a long game. 1000 is orders of magnitude above anything
   legitimate while still refusing a garbage or hostile number outright.
   An invalid key is SKIPPED, not fatal: its valid siblings in the same delta still land and the
   submission still answers 200, so a client's offline queue drains instead of retrying a
   poisoned game forever (that retry loop was the nastiest half of this bug on Deno).
   sanitizeLeaderboardDelta() is deliberately PURE - it writes nothing - so a caller can
   validate an entire submission before any storage is touched. See handleSoloResult()'s
   validate-then-mark-seen-then-apply ordering for why that matters. */
const MAX_STAT_DELTA = 1000;
function sanitizeLeaderboardDelta(name, delta) {
  const clean = cleanName(name, "");
  if (!clean || isBadName(clean) || !delta || typeof delta !== "object") return null;
  // Legacy pre-split clients (already shipped, can't be changed) still send a plain "hpts" key
  // instead of hptsS/hptsT. Every delta this app has ever produced always carries exactly one
  // "hg"+mode key alongside it (see buildResultEntries()/buildResultEntriesServer() - every
  // human seat gets an hg<mode>:1 delta whether or not it won) - use THAT sibling key's mode
  // (last char 's'/'t') to redirect a legacy "hpts" value into the correct split bucket. If a
  // delta somehow has "hpts" with no hg/hw sibling to read the mode from (shouldn't happen from
  // any real client), the points can't be safely attributed to either bucket, so they're
  // dropped rather than guessed - the games/wins counters (which already carry their own mode
  // suffix) still get recorded normally either way.
  let legacyPtsTarget = null;
  if (Object.prototype.hasOwnProperty.call(delta, "hpts")) {
    const modeKey = Object.keys(delta).find((k) => /^h[gw][46][st]$/.test(k));
    if (modeKey) legacyPtsTarget = modeKey.endsWith("t") ? "hptsT" : "hptsS";
  }
  const out = {};
  let any = false;
  for (const k of Object.keys(delta)) {
    const key = k === "hpts" ? legacyPtsTarget : k;
    if (!key || !NUMERIC_STAT_KEY.test(key)) continue;
    const raw = delta[k];
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
function applyLeaderboardEntry(name, delta) {
  const s = sanitizeLeaderboardDelta(name, delta);
  if (!s) return;
  // 2026-07-25 (bug 6): route through boardKeyFor() so every capitalization of one human's name
  // lands on that human's single lifetime row.
  const bk = boardKeyFor(s.clean);
  const r = globalBoard[bk] = globalBoard[bk] || {};
  for (const key of Object.keys(s.keys)) r[key] = (r[key] || 0) + s.keys[key];
  scheduleLeaderboardPersist();
  recordMonthlyResult(bk, s.keys);   // 2026-07-28 § MONTHLY RANKING - additive, see that block
}
/* v0.21 § LEADERBOARD SPLIT MIGRATION - boot-time, idempotent. Entries stored before the
   solo/teams split have an aggregate "hpts" and neither hptsS nor hptsT yet. For each such
   player (skipped entirely if hptsS or hptsT is already present - that's what makes this safe
   to run on every boot/deploy):
     - if only one side has nonzero games (hg4s+hg6s for solo, hg4t+hg6t for teams), it's
       unambiguous - all of hpts goes to that side.
     - if BOTH sides have nonzero games, split proportionally by each side's WINS ratio
       (falls back to a games-ratio split if wins are all zero on both sides).
   hptsT is always computed as the exact remainder (hpts - hptsS), never rounded separately, so
   the two split values always sum back to the original legacy hpts exactly. */
function migrateLegacyLeaderboardPoints() {
  let migrated = 0;
  for (const name of Object.keys(globalBoard)) {
    const r = globalBoard[name];
    if (!r || typeof r !== "object") continue;
    if (r.hptsS !== undefined || r.hptsT !== undefined) continue; // already split - idempotent skip
    const hpts = Number(r.hpts) || 0;
    if (!hpts) continue; // nothing to split
    const soloGames = (r.hg4s || 0) + (r.hg6s || 0);
    const teamGames = (r.hg4t || 0) + (r.hg6t || 0);
    let hptsS;
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
    r.hptsS = hptsS;
    r.hptsT = hpts - hptsS;
    migrated++;
  }
  if (migrated) {
    log("migrated", migrated, "leaderboard entries to split solo/team points");
    scheduleLeaderboardPersist();
  }
}

/* 2026-07-25 § LEADERBOARD NAME-CASE MERGE MIGRATION (bug 6) - boot-time, idempotent, same
   conventions as migrateLegacyLeaderboardPoints() just above.

   Before this, cleanName() never case-folded, so one human who typed "Blake" on their phone and
   "blake" on the iPad had TWO lifetime rows (Blake's real board had three for one person). Going
   forward boardKeyFor() prevents new splits; this pass merges the ones already on disk.

   Rules, deliberately conservative:
     - group the existing rows by their lower-cased name;
     - a group of one is left completely alone (that is the overwhelming majority of rows, and
       it is why re-running this is free);
     - within a group, the WINNER (the surviving display capitalization) is the row with the most
       recorded games, since that is the spelling this person has actually played under most.
       Ties break on the largest total of all numeric stats, then alphabetically, so the outcome
       is fully deterministic and does not depend on object key order;
     - every numeric key from the losing rows is SUMMED into the winner, never overwritten, and
       keys the winner has never seen are created. Non-numeric junk (there should be none) is
       left behind rather than copied.
     - "hpts" is summed too, even though nothing writes it anymore: this runs AFTER
       migrateLegacyLeaderboardPoints(), so a legacy-only row has already had its plain hpts
       split into hptsS/hptsT and the leftover hpts is just carried along rather than dropped.

   Idempotency/safety: the migration is structurally self-guarding - after it runs, no two rows
   share a lower-cased name, so a second boot finds no groups of size 2+ and writes nothing at
   all. That is a stronger guard than a stored flag (which could be lost or forged) and it is why
   there is no "already migrated" marker to keep in sync. And because Node holds the whole board
   in memory and persists it with one write, a crash mid-merge leaves the ON-DISK file exactly as
   it was - there is no partially-merged state to resume from or double-count. */
function migrateLeaderboardNameCase() {
  const groups = new Map();
  for (const name of Object.keys(globalBoard)) {
    const r = globalBoard[name];
    if (!r || typeof r !== "object") continue;
    const lower = leaderboardNameKey(name);
    if (!groups.has(lower)) groups.set(lower, []);
    groups.get(lower).push(name);
  }
  const totalGames = (r) => ["hg4s", "hg6s", "hg4t", "hg6t"].reduce((a, k) => a + (Number(r[k]) || 0), 0);
  const totalAll = (r) => Object.keys(r).reduce((a, k) => a + (typeof r[k] === "number" && Number.isFinite(r[k]) ? r[k] : 0), 0);
  let merged = 0;
  for (const [, names] of groups) {
    if (names.length < 2) continue;   // nothing to merge - the normal case, and what makes this idempotent
    const sorted = names.slice().sort((a, b) => {
      const ga = totalGames(globalBoard[a]), gb = totalGames(globalBoard[b]);
      if (ga !== gb) return gb - ga;
      const ta = totalAll(globalBoard[a]), tb = totalAll(globalBoard[b]);
      if (ta !== tb) return tb - ta;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    const winner = sorted[0];
    const target = globalBoard[winner];
    for (const loser of sorted.slice(1)) {
      const src = globalBoard[loser];
      for (const k of Object.keys(src)) {
        const v = src[k];
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        target[k] = (Number(target[k]) || 0) + v;
      }
      delete globalBoard[loser];
      merged++;
    }
    log("merged leaderboard rows", JSON.stringify(sorted.slice(1)), "into", JSON.stringify(winner));
  }
  rebuildLbNameIndex();
  if (merged) {
    log("merged", merged, "duplicate-capitalization leaderboard rows");
    scheduleLeaderboardPersist();
  }
}

/* v0.13 § LEADERBOARD EPOCH — unchanged from v0.14. */
const LEADERBOARD_EPOCH_FILE = process.env.NASTY_LEADERBOARD_EPOCH_FILE
  ? path.resolve(process.env.NASTY_LEADERBOARD_EPOCH_FILE)
  : path.join(__dirname, "leaderboard-epoch.json");
let leaderboardEpoch = 1;
function loadLeaderboardEpoch() {
  try {
    const obj = JSON.parse(fs.readFileSync(LEADERBOARD_EPOCH_FILE, "utf8"));
    if (obj && Number.isFinite(obj.epoch)) leaderboardEpoch = obj.epoch;
  } catch (e) { leaderboardEpoch = 1; }
}
function persistLeaderboardEpoch() {
  try { fs.writeFileSync(LEADERBOARD_EPOCH_FILE, JSON.stringify({ epoch: leaderboardEpoch })); }
  catch (e) { log("leaderboard-epoch persist failed", e.message); }
}
function sendLeaderboard(res, status) {
  res.writeHead(status, Object.assign(
    { "content-type": "application/json", "x-leaderboard-epoch": String(leaderboardEpoch) },
    CORS_HEADERS,
  ));
  // 2026-07-25 § ACCOUNTS: with the account-only switch OFF (production today, and the default)
  // boardRowsForDisplay() hands back globalBoard itself, so this line is byte-for-byte the
  // JSON.stringify(globalBoard) it has always been.
  res.end(JSON.stringify(boardRowsForDisplay().flat));
}

/* ---------------------------------------------------------------------------------------
 * 2026-07-28 § MONTHLY RANKING - Blake's ask: "a Monthly Ranking that shows wins and losses for
 * the month and resets each month automatically - starting August 1... just a mini ranking for
 * people to reengage each month." Read the wallet backend's "epoch/season-reset" note above
 * before touching any of this - the SAME "no season resets, ever" decision governs here.
 * "Resets each month" means the VIEW is scoped to a calendar month; a month rollover NEVER
 * deletes anything. Lifetime counters (globalBoard/accountBoard, hg-, hw- and hpts-prefixed stat keys) are completely
 * untouched by anything in this block - additive, dated history recorded ALONGSIDE them.
 *
 * WHY NEW STORAGE IS UNAVOIDABLE: the existing leaderboard only ever stores a running LIFETIME
 * total per stat key - once a win lands in hptsS it carries no timestamp, so it can never be
 * sliced back out into "August's wins" after the fact. From the moment this deploys, every
 * finished game's result is recorded a second time, dated, so a monthly view can be built
 * without ever touching the lifetime rows. History starts accumulating at deploy time - nothing
 * is or can be backfilled.
 *
 * SHAPE: monthlyBoard["YYYY-MM"][displayName] = {games, wins, pts}. Aggregated at WRITE time
 * (not a growing list of individual game records) - the only view this ever needs to serve is
 * "totals for calendar month X", so bucketing directly at write time serves that exactly as well
 * as a list would, at a small, bounded size instead of one that grows with every game ever
 * played. `displayName` is the SAME key /leaderboard already uses for this player (the board key
 * from boardKeyFor(), or the account's own clean name) - so a client can match rows across both
 * endpoints with zero translation.
 *
 * TIMEZONE: Blake is on Central time, so a month flips at LOCAL midnight in America/Chicago, not
 * UTC. chicagoMonthKey() asks Intl for the wall-clock year/month "right now, in America/Chicago"
 * - that pulls from the real IANA tzdata, which already encodes exactly when CST/CDT changes
 * each year, so this needs no manual DST arithmetic and stays correct automatically across any
 * DST transition, including one that happened to land on the 1st (current US rules mean it
 * never does, but the calculation is correct even if that ever changed) - it always computes the
 * actual local calendar date, never a fixed UTC offset.
 *
 * PRUNING: kept to the most recent 13 calendar months (the current one plus a full trailing
 * year) - enough for a future year-over-year view to compare against a full 12 prior months even
 * in January. This bound applies ONLY to this monthly-history file; it never touches
 * globalBoard/accountBoard, which stay lifetime and unpruned forever (Blake's "one season"
 * decision, unchanged).
 *
 * NASTY_MONTHLY_NOW_MS is a test-only override (a server-side env var, never reachable from any
 * client request) so a suite can prove "a month rollover changes the view without deleting
 * anything" deterministically instead of waiting for a real month boundary. Unset in every real
 * deployment, where chicagoMonthKey() always uses the real clock.
 * ------------------------------------------------------------------------------------- */
const MONTHLY_HISTORY_FILE = process.env.NASTY_MONTHLY_HISTORY_FILE
  ? path.resolve(process.env.NASTY_MONTHLY_HISTORY_FILE)
  : path.join(__dirname, "monthly-leaderboard.json");
const MONTHLY_MAX_MONTHS = 13;
let monthlyBoard = {};   // "YYYY-MM" -> { displayName: {games, wins, pts} }
function loadMonthlyHistory() {
  try { monthlyBoard = JSON.parse(fs.readFileSync(MONTHLY_HISTORY_FILE, "utf8")) || {}; }
  catch (e) { monthlyBoard = {}; }
  pruneMonthlyHistory(); // in case the retention window itself ever shrinks, or time passed
}
let monthlyPersistTimer = null;
function scheduleMonthlyPersist() {
  if (monthlyPersistTimer) return;
  monthlyPersistTimer = setTimeout(() => { monthlyPersistTimer = null; persistMonthlyHistoryNow(); }, PERSIST_DEBOUNCE_MS);
}
function persistMonthlyHistoryNow() {
  try { fs.writeFileSync(MONTHLY_HISTORY_FILE, JSON.stringify(monthlyBoard)); }
  catch (e) { log("monthly history persist failed", e.message); }
}
function monthlyNowMs() {
  const override = Number(process.env.NASTY_MONTHLY_NOW_MS);
  return Number.isFinite(override) && override > 0 ? override : Date.now();
}
function chicagoMonthKey(ms) {
  const d = new Date(ms === undefined ? monthlyNowMs() : ms);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit" }).formatToParts(d);
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  return `${y}-${m}`;
}
// Deletes ONLY entries falling off the trailing-13-month window - on a normally-running server
// this runs at most once per real calendar month (called right after a write that just created
// this month's first entry).
function pruneMonthlyHistory() {
  const keys = Object.keys(monthlyBoard).sort();
  while (keys.length > MONTHLY_MAX_MONTHS) delete monthlyBoard[keys.shift()];
}
/* Called from applyLeaderboardEntry()/applyAccountLeaderboardEntry() - the SAME two functions
   BOTH the online path (finishGame -> buildResultEntriesServer) and the offline path
   (/solo-result -> handleSoloResult) already funnel every finished game's per-player delta
   through, so hooking in here covers both without a second call site or any risk of the two
   drifting apart. `keys` is the ALREADY-VALIDATED, already-sanitized delta
   (sanitizeLeaderboardDelta's own output) - reuses the exact same win/points shape the lifetime
   counters do; this just additionally files one dated result under today's Chicago month. */
function recordMonthlyResult(name, keys) {
  if (!name) return;
  const hasGame = Object.keys(keys).some((k) => /^hg[46][st]$/.test(k));
  if (!hasGame) return; // every real delta carries exactly one of these; defensive, not expected
  const won = Object.keys(keys).some((k) => /^hw[46][st]$/.test(k));
  const pts = (keys.hptsS || 0) + (keys.hptsT || 0);
  const month = chicagoMonthKey();
  const bucket = monthlyBoard[month] = monthlyBoard[month] || {};
  const row = bucket[name] = bucket[name] || { games: 0, wins: 0, pts: 0 };
  row.games += 1;
  if (won) row.wins += 1;
  row.pts += pts;
  pruneMonthlyHistory();
  scheduleMonthlyPersist();
}
function monthlyLeaderboardView(month) {
  const bucket = monthlyBoard[month] || {};
  const players = {};
  for (const name of Object.keys(bucket)) {
    const r = bucket[name];
    const games = r.games || 0, wins = r.wins || 0;
    players[name] = { games, wins, losses: games - wins, pts: r.pts || 0 };
  }
  return players;
}
const MONTH_PARAM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
// GET /leaderboard/monthly - public, no auth, same CORS as /leaderboard. A month with no data
// (including every month before this feature deployed) answers 200 with an empty players object,
// never a 404 or an error - a brand-new client asking about a brand-new feature must never see a
// failure state just because nobody has finished a game yet this month.
function sendMonthlyLeaderboard(res, status, monthParam) {
  const month = (typeof monthParam === "string" && MONTH_PARAM_RE.test(monthParam)) ? monthParam : chicagoMonthKey();
  res.writeHead(status, Object.assign({ "content-type": "application/json" }, CORS_HEADERS));
  res.end(JSON.stringify({ month, players: monthlyLeaderboardView(month) }));
}

/* ---------------------------------------------------------------------------------------
 * v0.15 § SERVER-SIDE WIN RECORDING (ONLINE games) — added per Blake's "the shared
 * leaderboard still shows nobody else" report. Diagnosis: the global-board pipeline itself
 * already worked, but (a) online games have literally never once completed (the whole reason
 * this rebuild exists), so the OLD host-sends-recordResult path never fired even once in
 * production, and (b) a device's own solo-game stats got double-counted in the MERGED display
 * (that half of the fix is client-side — see index.html's mergeQueuedIntoGlobal(), replacing
 * mergeStats()).
 *
 * The server now records an ONLINE game's result itself, directly, the instant its OWN
 * applyMove() call sees G.over flip — see finishGame() below, called from driveTurnLoop() and
 * from the human-move handler. This uses the EXACT SAME stat-key shape and points formula as
 * index.html's buildResultEntries()/pointsForWin() (hand-ported here since server.js has no
 * access to index.html's DOM-adjacent code, and this specific pair of functions is pure
 * game-result arithmetic, not "the rules" in the § ENGINE sense — see HANDOFF.md "v0.15" for
 * the reasoning on why these two small functions are duplicated rather than extracted).
 *
 * Idempotency: `room.recorded` (persisted to disk alongside everything else in roomToDisk/
 * roomFromDisk) is set the FIRST time finishGame() runs for a room and checked before doing
 * anything — a reconnect, a stray duplicate call, or a server restart mid-flush can never
 * double-count the same finished game, because the flag survives restart via the room file.
 * ------------------------------------------------------------------------------------- */
const DIFF_POINTS = { easy: 1, medium: 2, hard: 3 };
function pointsForWinServer(G, winSet) {
  let pts = 0;
  G.seats.forEach((opp, j) => { if (winSet.has(j)) return; pts += opp.type === "human" ? 3 : (DIFF_POINTS[opp.diff] || 0); });
  return pts;
}
/* ---------------------------------------------------------------------------------------
 * 2026-07-24 § KNOCKOUT TALLY (Blake's item 9, "2026-07-23 list") - twin of index.html's
 * tallyKnockout() (see that function's comment for the full design/reasoning; kept in sync by
 * hand, same category as pointsForWinServer/buildResultEntriesServer just above - pure
 * game-result arithmetic, not a rules change, so § ENGINE was never touched).
 *
 * A "Nasty!" takeout (a peg lands on an opponent's peg and sends it back to base) counts toward
 * two lifetime, human-only leaderboard stats: hkoDealt (knockouts dealt) and hkoTaken (times
 * knocked out) - Blake's own words: "how many times they've knocked out another peg, how many
 * times they've been knocked out". Deliberately LIFETIME, not split by mode/board size like
 * hg/hw/hpts are - flagged rather than silently decided, per the task's own instruction, since
 * no strong reason turned up to split a "fun" stat like this one the same way the competitive
 * win/loss stats are split.
 *
 * A FORCED partner-kick (the last-resort "landing on your own partner's peg" rule, teams only -
 * see legalMoves()'s `pk` flag, § ENGINE) is NOT a knockout by this task's own definition -
 * Blake's ask was specifically about "the Nasty! takeout", and the game's own toast text already
 * distinguishes the two ("😬 Ouch!" for a partner kick vs. "💥 NASTY!" for a real one - see
 * index.html's performMoveInner()) - so sameTeam() excludes it here the same way.
 *
 * G.koDealt/G.koTaken are plain extra arrays hung on the engine's G object from HERE, lazily
 * created on first use - this is deliberately OUTSIDE § ENGINE/newGame() (the kick event itself,
 * m.kick, already exists there - this is pure result-bookkeeping) so no engine regeneration was
 * needed for this feature. They ride along inside G exactly like any other G field wherever G
 * itself is persisted/broadcast (roomToDisk, sync, rejoin, reclaimed) - migration-safe by
 * construction: an in-flight room's G from before this code existed simply has no koDealt/
 * koTaken yet, and the lazy `G.koDealt||(...)` below creates them the first real kick after this
 * change, no destructive reset, no special migration step needed.
 *
 * Called from all three places this file ever runs a real applyMove() against a live room: the
 * CPU branch of driveTurnLoop(), the human "action" handler, and the away-ladder assist - see
 * each call site's own comment. */
function tallyKnockout(E, m) {
  if (!m.kick) return;
  if (E.sameTeam(m.owner, m.kick.seat)) return; // forced partner-kick ("Ouch!") - not a "Nasty!" knockout
  const G = E.getG();
  if (!G.koDealt) G.koDealt = new Array(G.n).fill(0);
  if (!G.koTaken) G.koTaken = new Array(G.n).fill(0);
  if (G.seats[m.owner] && G.seats[m.owner].type === "human") G.koDealt[m.owner] = (G.koDealt[m.owner] || 0) + 1;
  if (G.seats[m.kick.seat] && G.seats[m.kick.seat].type === "human") G.koTaken[m.kick.seat] = (G.koTaken[m.kick.seat] || 0) + 1;
}
function buildResultEntriesServer(G, mode, winSet) {
  const entries = [];
  const isTeam = mode.endsWith("t");
  G.seats.forEach((seat, i) => {
    if (seat.type !== "human") return;
    const delta = {}; delta["hg" + mode] = 1;
    if (winSet.has(i)) { delta["hw" + mode] = 1; delta[isTeam ? "hptsT" : "hptsS"] = pointsForWinServer(G, winSet); }
    // 2026-07-24 item 9: lifetime knockout stats, accrued all game long by tallyKnockout() above -
    // only included when nonzero, same "don't write a no-op delta" convention hw<mode>/hpts* use.
    if (G.koDealt && G.koDealt[i]) delta.hkoDealt = G.koDealt[i];
    if (G.koTaken && G.koTaken[i]) delta.hkoTaken = G.koTaken[i];
    // 2026-07-25 § ACCOUNTS: the seat index rides along so account attribution can look up who
    // was actually sitting there. Nothing reads it unless the account-only switch is on, and it
    // never goes on the wire.
    entries.push({ name: seat.name, delta, seat: i });
  });
  return entries;
}
/* 2026-07-25 § ACCOUNTS: which account (if any) owns a seat in this room. Read from the room's
   OWN stored player record - the accountId captured once at the front door (see the `acct` field
   on host/join) - never from anything the client says at game end, and never from the typed seat
   name. A session that expired mid-game therefore cannot cost anyone their stats. */
function accountIdForSeat(room, seatIndex) {
  const owners = room.seatOwners || (room.lobby && room.lobby.seats ? room.lobby.seats.map((s) => s.claimedBy) : null);
  if (!owners) return null;
  const playerId = owners[seatIndex];
  if (playerId == null) return null;
  const p = room.players.get(playerId);
  return (p && p.accountId) || null;
}
function finishGame(room) {
  if (room.recorded) return; // idempotent — see comment block above
  room.recorded = true;
  touch(room);
  const G = room.engine.getG();
  const mode = (G.n === 4 ? "4" : "6") + (G.teams ? "t" : "s");
  const winSet = new Set(G.winners);
  const entries = buildResultEntriesServer(G, mode, winSet);
  const onlyAccounts = accountsOnlyBoard();
  const credited = [];
  for (const e of entries) {
    if (!onlyAccounts) { applyLeaderboardEntry(e.name, e.delta); credited.push(e.name); continue; }
    // Switch on: a guest's online result simply does not post to the shared board. Their game
    // still played, still finished, and still counted on their own device.
    const uid = accountIdForSeat(room, e.seat);
    if (!uid || !accounts[uid]) continue;
    applyAccountLeaderboardEntry(uid, e.name, e.delta);
    credited.push(e.name);
  }
  log("online game finished, recorded to global leaderboard", room.code,
    credited.join(",") || "(no human seats)");
}

/* ---------------------------------------------------------------------------------------
 * v0.27 § SURRENDER — shared by the "leaveForGood" and "surrender" message cases below (see
 * the ws message switch). The seat-conversion + permanent-lockout mechanics are IDENTICAL
 * either way — "surrender" only adds a loss record, via the optional beforeConvert callback,
 * evaluated on the pre-conversion state (so it can still tell whether the seat was genuinely a
 * live human seat in an unfinished game) BEFORE the seat flips to a CPU. Extracted so the two
 * cases can never drift out of sync — a real bug in the old duplicated-by-hand "leaveForGood"
 * case would previously have needed fixing twice, in two ws message handlers no test could ever
 * prove stayed identical; now there is exactly one implementation.
 * ------------------------------------------------------------------------------------- */
function leaveSeatForGoodInternal(ctx, ws, beforeConvert) {
  const { room, playerId } = ctx;
  const p = room.players.get(playerId);
  let seat = -1;
  let G = null;
  if (room.started && room.engine && room.seatOwners) {
    seat = room.seatOwners.indexOf(playerId);
    if (seat >= 0) G = room.engine.getG();
  }
  // v0.27.1: `room` itself is passed as the hook's 3rd arg (not just G/seat) so the "surrender"
  // case below can read/set room.anySurrenderOccurred for the § NO-FAULT EXIT check - safe to
  // hand over directly (no KV/race concerns here, unlike server.ts - this whole handler runs
  // synchronously in one Node event-loop turn, so nothing else can touch this room meanwhile).
  if (beforeConvert && G && seat >= 0 && G.seats[seat]) beforeConvert(G, seat, room);
  let converted = false;
  if (G && seat >= 0 && G.seats[seat] && G.seats[seat].type === "human") {
    const leaverName = G.seats[seat].name;
    G.seats[seat].type = "cpu";
    G.seats[seat].diff = "medium";   // "Tricky" - see engine.js chooseAI()'s diff naming
    room.seatOwners[seat] = null;
    converted = true;
    touch(room);
    appendAction(room, { kind: "seatToCpu", seat, diff: "medium", name: leaverName });
    // The seat may be sitting mid-turn waiting on exactly this human's move right now - drive
    // it forward immediately instead of stalling the table until some other action re-enters
    // driveTurnLoop().
    driveTurnLoop(room);
  }
  // Invalidate this player's session for THIS room permanently, regardless of whether the game
  // has even started yet (covers leaving mid-lobby too) - a token match alone must never let
  // them back into a seat they deliberately gave up.
  if (p) p.leftForGood = true;
  if (!converted) touch(room);
  send(ws, { type: "leftForGood" });
  return converted;
}

/* ---------------------------------------------------------------------------------------
 * v0.13 § SOLO RESULTS — unchanged from v0.14 (offline solo/pass-and-play games have no room,
 * so they POST directly; see the client-side submitOrQueueSoloResult()).
 * ------------------------------------------------------------------------------------- */
const SOLO_IDS_FILE = process.env.NASTY_SOLO_IDS_FILE
  ? path.resolve(process.env.NASTY_SOLO_IDS_FILE)
  : path.join(__dirname, "solo-ids.json");
const SOLO_ID_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
let soloSeen = new Map();
function loadSoloSeen() {
  try {
    const obj = JSON.parse(fs.readFileSync(SOLO_IDS_FILE, "utf8"));
    if (obj && typeof obj === "object") soloSeen = new Map(Object.entries(obj));
  } catch (e) { soloSeen = new Map(); }
}
let soloSeenPersistTimer = null;
function scheduleSoloSeenPersist() {
  if (soloSeenPersistTimer) return;
  soloSeenPersistTimer = setTimeout(() => { soloSeenPersistTimer = null; persistSoloSeenNow(); }, PERSIST_DEBOUNCE_MS);
}
function persistSoloSeenNow() {
  try { fs.writeFileSync(SOLO_IDS_FILE, JSON.stringify(Object.fromEntries(soloSeen))); }
  catch (e) { log("solo-ids persist failed", e.message); }
}
setInterval(() => {
  const now = Date.now();
  let pruned = false;
  for (const [id, ts] of soloSeen) { if (now - ts > SOLO_ID_MAX_AGE_MS) { soloSeen.delete(id); pruned = true; } }
  if (pruned) scheduleSoloSeenPersist();
}, 24 * 60 * 60 * 1000);
setInterval(prunePurchaseSeen, 24 * 60 * 60 * 1000);   // 2026-07-28 § POINTS WALLET

const SOLO_RATE_LIMIT = 20;
const SOLO_RATE_WINDOW_MS = 60 * 1000;
const soloRateMap = new Map();
function underSoloRateLimit(ip) {
  const now = Date.now();
  const kept = (soloRateMap.get(ip) || []).filter(t => now - t < SOLO_RATE_WINDOW_MS);
  if (kept.length >= SOLO_RATE_LIMIT) { soloRateMap.set(ip, kept); return false; }
  kept.push(now);
  soloRateMap.set(ip, kept);
  return true;
}
async function handleSoloResult(req, res) {
  const ip = remoteIp(req);
  if (!underSoloRateLimit(ip)) { sendJson(res, 429, { error: "slow down", epoch: leaderboardEpoch }); return; }
  const body = await readJsonBody(req);
  const gameId = typeof body.gameId === "string" ? body.gameId.trim().slice(0, 64) : "";
  if (!gameId) { sendJson(res, 400, { error: "missing gameId", epoch: leaderboardEpoch }); return; }
  if (soloSeen.has(gameId)) { sendJson(res, 200, { ok: true, duplicate: true, epoch: leaderboardEpoch }); return; }
  const reqEpoch = Number.isFinite(body.epoch) ? body.epoch : null;
  if (reqEpoch !== null && reqEpoch < leaderboardEpoch) {
    soloSeen.set(gameId, Date.now());
    scheduleSoloSeenPersist();
    log("solo result rejected (stale epoch)", gameId, "req=" + reqEpoch, "current=" + leaderboardEpoch);
    sendJson(res, 409, { error: "stale epoch", epoch: leaderboardEpoch });
    return;
  }
  const entries = Array.isArray(body.entries) ? body.entries.slice(0, 6) : [];
  // 2026-07-25 (bug 4) § SEEN-MARKER ORDERING - validate the WHOLE submission first (pure, no
  // writes), then mark the gameId seen, and only then apply. Two things this buys, identically
  // on both servers:
  //   1. at-most-once. If anything failed part-way through applying, the gameId is already
  //      marked seen, so the client's offline-queue retry is answered `duplicate` instead of
  //      re-adding the keys that DID land. A double-count is silent and permanent; a rare
  //      dropped game is neither.
  //   2. no forever-retry. The old Deno path threw mid-loop BEFORE writing the marker, so a
  //      submission holding one bad number was retried by that device on every single launch,
  //      forever. Validation now happens before any of that, and a bad key is skipped rather
  //      than thrown on, so the submission always reaches a final answer.
  const sanitized = [];
  for (const e of entries) { if (e && e.name) { const s = sanitizeLeaderboardDelta(e.name, e.delta); if (s) sanitized.push(s); } }
  soloSeen.set(gameId, Date.now());
  scheduleSoloSeenPersist();
  /* 2026-07-25 § ACCOUNTS: attribution.
     SWITCH OFF (production today, and the default): every entry lands on its name row, exactly
     as it always has. The `auth` field a future client may send is accepted and ignored.
     SWITCH ON: only the SIGNED-IN player's own result reaches the shared board, credited to
     their account. Everything else on this device is a guest result - it still counted in that
     device's own local stats, and the response is still a plain 200 so no client ever retries
     forever, it just does not post to the family board. That is Blake's decision written out:
     accounts stay optional for playing, and required for being on the board. */
  let credited = [];
  if (accountsOnlyBoard()) {
    const me = resolveSession(body.auth);
    if (me && me.account && me.account.nameFolded) {
      for (const s of sanitized) {
        if (leaderboardNameKey(s.clean) !== me.account.nameFolded) continue;
        applyAccountLeaderboardEntry(me.uid, s.clean, s.keys);
        credited.push(s.clean);
      }
    }
  } else {
    for (const s of sanitized) applyLeaderboardEntry(s.clean, s.keys);
    credited = sanitized.map((s) => s.clean);
  }
  log("solo result recorded", gameId, credited.join(","));
  /* v0.40 (2026-07-26): the reply now SAYS what it did. Until now this was a bare
     {ok:true,epoch}, so a client could not tell the difference between "recorded" and "accepted
     and silently dropped because the account-only switch is on and you did not send `auth`" -
     which is exactly the failure that lost a run of real games. Both keys are additive; an older
     client simply ignores them, so no protocol bump. Twin of server.ts's. */
  sendJson(res, 200, { ok: true, epoch: leaderboardEpoch, accountsOnly: accountsOnlyBoard(), credited });
}

/* =======================================================================================
 * 2026-07-25 § ACCOUNTS - SERVER PLUMBING, DORMANT. (Stage 1 shipped in 3fb8f18 as Apple-only;
 * this is the same stage widened to Blake's revised direction, still with no client UI.)
 *
 * WHAT THIS IS. NASTY has never had accounts. The leaderboard is keyed on whatever name a
 * player typed, so anyone can type "Blake" and their wins land on Blake's row. The plan
 * (optional, guest-first accounts that own a game name) adds a real account. THIS BUILDS THE
 * SERVER HALF AND NOTHING ELSE.
 *
 * WHAT CHANGED FROM STAGE 1, and why - all four items are Blake's calls, not mine:
 *
 *   1. FOUR SIGN-IN METHODS instead of one: Apple, Google, Facebook, and a passwordless email
 *      code. There is no password anywhere in this system and there never will be. Apple stays
 *      first and is never dropped - App Store guideline 4.8 requires it to be offered whenever
 *      any other third-party login is. Every one of them is verified SERVER-side; nothing the
 *      client claims about who it is, is ever believed. See verifyOidcToken() and
 *      inspectFacebookAccessToken().
 *   2. ACCOUNT LINKING, and with it a REVERSAL: a verified email address is now STORED. Stage 1
 *      deliberately stored none, to keep "Contact Info" off the App Store privacy label. With
 *      four sign-in methods that decision breaks down - the same human signing in with Apple on
 *      their phone and Google on their laptop would silently become two accounts, two names and
 *      two leaderboard rows. A verified email is the natural key that stops that. The privacy
 *      label now needs a Contact Info > Email Address entry. See the LINKING block below,
 *      including the honest limit around Apple's private-relay addresses.
 *   3. THE LEADERBOARD BECOMES ACCOUNT-ONLY, GOING FORWARD - a second REVERSAL. Stage 1 argued
 *      strongly for keeping guest name rows accruing forever; Blake decided otherwise. Accounts
 *      stay optional for PLAYING (local, pass-and-play and online all work signed out, always),
 *      but only a signed-in account accrues on and appears on the shared board. Gated behind
 *      NASTY_LEADERBOARD_ACCOUNTS_ONLY, which defaults OFF.
 *   4. THE NAME CLAIM IS A ONE-TIME MIGRATION WINDOW. Moving an old name-keyed row onto a new
 *      account exists only for the release that introduces accounts, so everybody with history
 *      gets one chance at it, and then the path is gone. Rows nobody claims are NEVER deleted -
 *      they stay on the board as frozen historical entries. See THE CLAIM SUNSET below.
 *
 * WHAT "DORMANT" MEANS, precisely:
 *   - No client calls any of these routes. index.html is untouched by this stage.
 *   - /leaderboard's response body is byte-for-byte what it has always been. Account rows live
 *     in a SEPARATE namespace (accountBoard here, ["lbacct", uid, stat] on the Deno twin) that
 *     nothing reads yet. That is what makes shipping this a zero-migration change, and what
 *     makes reverting it a flag rather than a data restore.
 *   - Existing leaderboard data is not read, rewritten, or migrated by this stage. The ONE
 *     operation that ever moves existing data is the name claim below, which is reachable only
 *     by an authenticated account holder - and there cannot be one until a provider is
 *     configured.
 *   - The only wire-level addition is an OPTIONAL `acct` field on `host`/`join`. No client that
 *     has ever shipped sends it; when it is absent this file's behavior is byte-identical, and
 *     `rejoin` is not touched at all.
 *
 * THE KILL SWITCH. NASTY_ACCOUNTS_ENABLED=0 (or false/off/no) makes /account/* and
 * /leaderboard/v2 unrouted entirely, so those paths fall through to the same 404 they hit
 * today, the admin account routes disappear, the `acct` field is ignored, and nothing here ever
 * writes a byte. That is the revert: a Deno Deploy environment-variable change, no redeploy, no
 * data restore. It is ON by default because the provider gate below already keeps the whole
 * thing inert in production.
 *
 * THE PROVIDER GATE, following server/apns.js's no-op-gracefully precedent exactly: with none of
 * NASTY_APPLE_AUDIENCES / NASTY_GOOGLE_AUDIENCES / NASTY_FACEBOOK_APP_ID / NASTY_EMAIL_PROVIDER
 * set - which is the state of production today, and stays that way until Blake finishes the
 * developer-portal work in blake-signin-setup.md - every /account/* route answers 503 "accounts
 * unavailable" and touches no storage. Each provider is independently gated, so Apple can go
 * live months before Facebook does. Safe to deploy the moment it is written.
 *
 * PROTOCOL_VERSION IS NOT BUMPED. See the dated note in the § PROTOCOL VERSION block above.
 *
 * NO NEW DEPENDENCY. The providers' identity tokens are signed JWTs, verified here with
 * WebCrypto and core modules only - same house style as server/apns.js, which signs its APNs
 * JWTs with node:crypto rather than pulling in a JWT library. This repo is public; a JWT/JWKS
 * package on the server is exactly the supply-chain surface this project has been right to
 * avoid. Facebook's access-token inspection and the email send are both plain fetch() calls.
 * ===================================================================================== */

/* --- configuration. Every knob defaults to the real provider values, so production behavior is
   whatever Blake's environment says and nothing else. --- */
function accountsEnvFlagOn(raw, dflt) {
  const s = String(raw == null || raw === "" ? dflt : raw).trim().toLowerCase();
  return !(s === "0" || s === "false" || s === "off" || s === "no");
}
const ACCOUNTS_ENABLED = accountsEnvFlagOn(process.env.NASTY_ACCOUNTS_ENABLED, "1");
function accountsEnvList(raw) { return String(raw || "").split(",").map((s) => s.trim()).filter(Boolean); }
/* A secret may come from the environment (how Deno Deploy does it) or from a file on disk next
   to this server (how the dev box does it) - exactly the two-sided pattern server/apns.js already
   uses for the APNs key, and both file names are in .gitignore. Missing = that half of that
   provider is simply off. */
function accountsEnvSecret(envName, fileName) {
  const v = String(process.env[envName] || "").trim();
  if (v) return v;
  try { return fs.readFileSync(path.join(__dirname, fileName), "utf8").trim(); } catch (e) { return ""; }
}

/* --- the four sign-in methods. Every one is INDEPENDENTLY configured and every one is OFF
   until Blake pastes its identifiers in, which is what keeps this entire section inert in
   production today (nothing below is configured there). Apple is deliberately first
   everywhere: App Store guideline 4.8 requires Sign in with Apple to be offered whenever any
   other third-party login is, so Apple is never the one that gets dropped. --- */
const APPLE_ISSUERS = accountsEnvList(process.env.NASTY_APPLE_ISSUER || "https://appleid.apple.com");
const APPLE_JWKS_URL = (process.env.NASTY_APPLE_JWKS_URL || "https://appleid.apple.com/auth/keys").trim();
// Comma separated. The native App ID (com.pangman.nasty) AND the web Services ID
// (com.pangman.nasty.web). Both are accepted from either platform on purpose - the client's
// claimed `platform` is unverified hearsay, and Apple issues the SAME `sub` for both as long as
// the Services ID is configured under the same primary App ID. That is the one-account-across-
// app-and-web guarantee, and blake-signin-setup.md is the click-by-click for making it true.
const APPLE_AUDIENCES = accountsEnvList(process.env.NASTY_APPLE_AUDIENCES);
// Google issues ONE `sub` per Google Account, identical across every OAuth client ID in the same
// project - so the iOS client ID and the web client ID resolve to the same person with no extra
// configuration. Both client IDs go in NASTY_GOOGLE_AUDIENCES. Google's tokens carry `iss` as
// either form, so both are allowed.
const GOOGLE_ISSUERS = accountsEnvList(process.env.NASTY_GOOGLE_ISSUER || "https://accounts.google.com,accounts.google.com");
const GOOGLE_JWKS_URL = (process.env.NASTY_GOOGLE_JWKS_URL || "https://www.googleapis.com/oauth2/v3/certs").trim();
const GOOGLE_AUDIENCES = accountsEnvList(process.env.NASTY_GOOGLE_AUDIENCES);
// Facebook is the odd one out and is handled two ways, both server-verified:
//   - LIMITED LOGIN (what the iOS SDK issues, and what Apple's tracking rules push you toward)
//     hands back a real OIDC id_token, signed RS256, with `nonce`, verified against Facebook's
//     published JWKS exactly like Apple's and Google's;
//   - CLASSIC WEB LOGIN hands back an ACCESS token, which is not a JWT and cannot be verified by
//     signature. For that one the server calls Facebook's token-inspection endpoint
//     (GET /debug_token) with an app access token and requires is_valid AND that the token was
//     issued for OUR app id. Nothing the browser says is trusted either way.
// Facebook user ids are APP-SCOPED: one Facebook app gives one id for a person across iOS and
// web, which is what makes the single-account guarantee hold there too.
const FACEBOOK_ISSUERS = accountsEnvList(process.env.NASTY_FACEBOOK_ISSUER || "https://www.facebook.com,https://facebook.com");
const FACEBOOK_JWKS_URL = (process.env.NASTY_FACEBOOK_JWKS_URL || "https://www.facebook.com/.well-known/oauth/openid/jwks/").trim();
const FACEBOOK_APP_ID = (process.env.NASTY_FACEBOOK_APP_ID || "").trim();
const FACEBOOK_APP_SECRET = accountsEnvSecret("NASTY_FACEBOOK_APP_SECRET", "facebook-app-secret.txt");
const FACEBOOK_GRAPH_URL = (process.env.NASTY_FACEBOOK_GRAPH_URL || "https://graph.facebook.com/v21.0").trim().replace(/\/+$/, "");
// The passwordless email code. There is NO password anywhere in this system and there never will
// be. Deno Deploy cannot open an SMTP socket, so the mail goes out over a plain HTTPS API - see
// sendAccountEmail() below and blake-signin-setup.md for which service and what it costs.
const EMAIL_PROVIDER = String(process.env.NASTY_EMAIL_PROVIDER || "").trim().toLowerCase();
const EMAIL_API_KEY = accountsEnvSecret("NASTY_EMAIL_API_KEY", "email-api-key.txt");
const EMAIL_API_URL = (process.env.NASTY_EMAIL_API_URL || "").trim();
const EMAIL_FROM = (process.env.NASTY_EMAIL_FROM || "").trim();

const OIDC_PROVIDERS = {
  apple: { name: "apple", issuers: APPLE_ISSUERS, jwksUrl: APPLE_JWKS_URL, audiences: APPLE_AUDIENCES },
  google: { name: "google", issuers: GOOGLE_ISSUERS, jwksUrl: GOOGLE_JWKS_URL, audiences: GOOGLE_AUDIENCES },
  facebook: { name: "facebook", issuers: FACEBOOK_ISSUERS, jwksUrl: FACEBOOK_JWKS_URL, audiences: FACEBOOK_APP_ID ? [FACEBOOK_APP_ID] : [] },
};
function emailSenderConfigured() {
  if (!EMAIL_PROVIDER || EMAIL_PROVIDER === "off" || EMAIL_PROVIDER === "none") return false;
  if (EMAIL_PROVIDER === "console") return true;   // dev only, prints the code to the server log
  return !!(EMAIL_API_KEY && EMAIL_FROM);
}
function providerConfigured(p) {
  if (p === "apple") return APPLE_AUDIENCES.length > 0;
  if (p === "google") return GOOGLE_AUDIENCES.length > 0;
  if (p === "facebook") return !!FACEBOOK_APP_ID;
  if (p === "email") return emailSenderConfigured();
  return false;
}
function configuredProviders() { return ["apple", "google", "facebook", "email"].filter(providerConfigured); }
function anyProviderConfigured() { return configuredProviders().length > 0; }
function accountsConfigured() { return ACCOUNTS_ENABLED && anyProviderConfigured(); }

// Session lifetime is deliberately enormous. This is a family board game: being signed out
// because you did not play for a month would be a bug, not security. Sliding - any
// authenticated request on a session older than SESSION_SLIDE_AFTER_MS silently extends it.
// The two _MS overrides exist ONLY so the test suite can prove the slide and the rename
// cooldown without waiting 30 days; nothing sets them in production. Same idea as the existing
// NASTY_TEST_FREEZE_MS knob in the freeze-recovery suite.
function accountsEnvMs(raw, dflt) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
const SESSION_TTL_MS = accountsEnvMs(process.env.NASTY_SESSION_TTL_MS, 400 * 24 * 60 * 60 * 1000);
const SESSION_SLIDE_AFTER_MS = accountsEnvMs(process.env.NASTY_SESSION_SLIDE_AFTER_MS, 30 * 24 * 60 * 60 * 1000);
const NAME_COOLDOWN_MS = accountsEnvMs(process.env.NASTY_NAME_COOLDOWN_MS, 30 * 24 * 60 * 60 * 1000);
const AUTH_NONCE_TTL_MS = accountsEnvMs(process.env.NASTY_AUTH_NONCE_TTL_MS, 10 * 60 * 1000); // a sign-in slower than this restarts
const APPLE_JWKS_TTL_MS = 6 * 60 * 60 * 1000;  // Apple rotates rarely; a kid miss forces one refetch
const APPLE_CLOCK_SKEW_MS = 10 * 60 * 1000;    // allowed iat drift, both directions
const APPLE_TOKEN_MAX_CHARS = 8192;            // a real identity token is ~1KB; refuse a 1MB one outright
const ACCOUNT_RATE_LIMIT = accountsEnvMs(process.env.NASTY_ACCOUNT_RATE_LIMIT, 120); // per IP per minute
const ACCOUNT_RATE_WINDOW_MS = 60 * 1000;
// The passwordless email code: short, short-lived, and cheap to get wrong only five times.
const EMAIL_CODE_TTL_MS = accountsEnvMs(process.env.NASTY_EMAIL_CODE_TTL_MS, 10 * 60 * 1000);
const EMAIL_CODE_MAX_ATTEMPTS = accountsEnvMs(process.env.NASTY_EMAIL_CODE_MAX_ATTEMPTS, 5);
const EMAIL_CODE_RESEND_MS = accountsEnvMs(process.env.NASTY_EMAIL_CODE_RESEND_MS, 60 * 1000);
const EMAIL_CODE_MAX_PER_DAY = accountsEnvMs(process.env.NASTY_EMAIL_CODE_MAX_PER_DAY, 12);
const ACCOUNTS_UNAVAILABLE_BODY = {
  error: "accounts unavailable",
  message: "Signing in isn't set up yet. You can keep playing without an account.",
};
const SIGNED_OUT_BODY = {
  error: "signedout",
  message: "You've been signed out. You can keep playing - sign in again any time.",
};

/* --- 2026-07-25 (Blake's direction) THE CLAIM SUNSET ------------------------------------
   Moving an existing name-keyed leaderboard row onto a brand-new account is a ONE-TIME
   MIGRATION, not a permanent feature. It exists so that everybody who already has history on
   the family board gets exactly one chance to grab it in the release that introduces accounts.
   After that window shuts, the claim path is gone: /account/claim answers 410 with a plain
   sentence, and /account/name stops offering a pendingClaim so the client stops asking.

   Two independent shut-offs, either of which closes it, both settable without a redeploy:
     NASTY_CLAIM_WINDOW_OPEN=0        close it right now
     NASTY_CLAIM_DEADLINE=<ISO date>  close it automatically at a moment in time
   Default: OPEN with no deadline, because the window has not started yet (no client can sign in
   at all until Blake configures a provider). Blake sets the deadline when the update ships.

   WHAT HAPPENS TO STILL-UNCLAIMED ROWS AFTER THE SUNSET: nothing is deleted, ever. They stay
   on the board as FROZEN HISTORICAL entries - visible exactly as they are today, flagged
   `frozen:true` on /leaderboard/v2 so a client can label them, and simply never written to
   again. Destroying the family's real 1993-to-now history to tidy up a data model would be an
   unacceptable trade, and no code path here removes a name row except the journalled, individually
   reversible claim itself. --- */
function accountsEnvDeadline(raw) {
  const s = String(raw || "").trim();
  if (!s) return 0;
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return n;          // raw epoch ms
  const t = Date.parse(s);                            // or any ISO-ish date string
  return Number.isFinite(t) ? t : 0;
}
const CLAIM_WINDOW_OPEN = accountsEnvFlagOn(process.env.NASTY_CLAIM_WINDOW_OPEN, "1");
const CLAIM_DEADLINE_MS = accountsEnvDeadline(process.env.NASTY_CLAIM_DEADLINE);
function claimWindowOpen() { return CLAIM_WINDOW_OPEN && (!CLAIM_DEADLINE_MS || Date.now() < CLAIM_DEADLINE_MS); }
function claimWindowView() { return { open: claimWindowOpen(), closesAt: CLAIM_DEADLINE_MS || 0 }; }
const CLAIM_CLOSED_BODY = {
  error: "claimclosed",
  message: "The one-time window for moving an older name onto an account has closed. Older names stay on the board as history - new games count on your account from here.",
};

/* --- 2026-07-25 (Blake's direction) THE ACCOUNT-ONLY LEADERBOARD SWITCH ------------------
   Blake's decision: accounts stay OPTIONAL for playing - local, pass-and-play and online all
   work with no sign-in, forever - but GOING FORWARD only a signed-in account accrues on and
   appears on the shared family board. A guest's games still count on their own device; they
   just do not post to the shared board.

   This is a REVERSAL of the original design, which recommended keeping guest name rows
   accruing forever. It is implemented because Blake decided it, and the two consequences he
   should know about are written down in the design doc: a child in the family with no account
   stops appearing on the board, and "be on the board" now requires signing in, which is a
   slightly larger compliance surface than "type a name".

   Gated three ways so it stays completely dormant right now: the accounts kill switch, at
   least one configured provider, and its own flag which defaults OFF. With the flag off,
   sendLeaderboard() serializes literally the same object it always has. --- */
const LEADERBOARD_ACCOUNTS_ONLY = accountsEnvFlagOn(process.env.NASTY_LEADERBOARD_ACCOUNTS_ONLY, "0");
function accountsOnlyBoard() { return ACCOUNTS_ENABLED && LEADERBOARD_ACCOUNTS_ONLY && anyProviderConfigured(); }

/* =======================================================================================
 * 2026-07-28 § POINTS WALLET - a per-account SPENDABLE BALANCE, separate from the leaderboard's
 * LIFETIME EARNED points (hptsS/hptsT). Earned points rank the leaderboard and must never
 * decrease - see HANDOFF.md. The wallet never touches them; it only tracks what an account has
 * SPENT, so balance = lifetime earned - lifetime spent, computed live on every read rather than
 * stored redundantly (see accountEarnedPoints()/walletView() below, right after
 * boardRowsForDisplay() since they reuse its exact "own account row + any frozen row this account
 * owns the name for" shadowing logic - the wallet's idea of "earned" is deliberately defined as
 * "whatever this account's row already shows on /leaderboard today", so it stays correct whether
 * NASTY_LEADERBOARD_ACCOUNTS_ONLY is off (today, in production - earned lives in globalBoard,
 * keyed by the account's claimed name) or on (earned lives in accountBoard, keyed by uid).
 *
 * SERVER-OWNED CATALOG - the client is never trusted for prices. Every item's cost lives here,
 * nowhere else, and a purchase re-reads it from this array every time; nothing about a price is
 * ever accepted from the request body. `consumable:true` (namechange and online access) means the
 * item is a stackable credit, not a one-time unlock - it is never "already owned" and can be
 * bought again. Every other category is a permanent, one-time cosmetic unlock.
 *
 * 2026-07-30 REPRICE - Blake's ask, verbatim: "Make 10 credits be $1 so that means the 1 month
 * token for online play would be $5 if it's 50 credits. Change all shop credit pricing to align
 * with this structure (always divideable by 10) and make them aspirational!" So every cost below
 * is now divisible by 10 and sits on the 10-credits-per-dollar anchor (see § REAL-MONEY CREDIT
 * PACKS further down, where that anchor actually meets Apple's price tiers). The original launch
 * prices (felts 15-20, titles 10-90, palettes 40-130, namechange 25) were tuned purely against
 * earned points; these are deliberately higher ("aspirational") because credits can now also be
 * BOUGHT. Risk considered and accepted: players who saved up under the old prices now find some
 * items dearer - but nothing anyone already OWNS is touched (walletOwned stores ids, never
 * prices), and nobody's balance moves (walletSpent is a lifetime sum of prices ALREADY paid;
 * repricing the catalog rewrites neither).
 * ===================================================================================== */
/* ---------------------------------------------------------------------------------------
 * 2026-07-29 § ONLINE ACCESS (monthly online-play entitlement) - Blake's ask: online play
 * becomes a monthly, credit-purchased entitlement. No real money involved anywhere in this -
 * purely spent out of the existing points wallet above, through the SAME /account/purchase
 * flow as every other shop item (it just happens to grant a month of access instead of a
 * cosmetic). Full design lives with the rest of the entitlement logic right after walletView()
 * below; these two constants are pulled up here because SHOP_CATALOG needs the cost at
 * definition time.
 *
 * EASY RETUNING - Blake may well retune both of these once he sees it in use. They are the ONLY
 * two places these numbers live:
 *   ONLINE_ACCESS_COST       - price of one month of online access, in points. Currently 50.
 *   ONLINE_FREE_EXTRA_MONTHS - how many complete calendar months AFTER the signup month are
 *                              free, on top of the (always free) signup month itself. Currently
 *                              1 - i.e. "free through the end of the first full calendar month
 *                              after signup" (Blake's confirmed rule, 2026-07-29).
 * ------------------------------------------------------------------------------------- */
const ONLINE_ACCESS_ITEM_ID = "online_month";
const ONLINE_ACCESS_COST = 50;
const ONLINE_FREE_EXTRA_MONTHS = 1;
// Real enforcement kill switch, same convention as every other feature flag in this file
// (ACCOUNTS_ENABLED, NASTY_LEADERBOARD_ACCOUNTS_ONLY): "1" (default) genuinely blocks an
// unentitled account at host/join; "0" turns the gate off (the entitlement bookkeeping, shop
// item, and status endpoint all keep working either way - this only controls whether host/join
// actually refuse anyone). See HANDOFF.md for why this exists and what it affects.
const ONLINE_ENTITLEMENT_ENFORCED = accountsEnvFlagOn(process.env.NASTY_ONLINE_ENTITLEMENT_ENFORCED, "1");
const SHOP_CATALOG = [
  // palette - alternate FULL-BOARD color palettes. The headline item, Blake's own call over
  // per-player peg colors: the SEAT color identifies the player, and free-pick colors would
  // collide in online games, so a palette is a complete replacement SET of seat colors that
  // stays internally distinct. Each entry carries colors4/colors6 - full replacements for the
  // client's COLORS4/COLORS6 arrays, same {name,c,dark} shape per seat, because the client uses
  // the per-seat NAME in team-pairing text ("Green + Pink") - so every seat here has a name too.
  /* =====================================================================================
   * 2026-08-02 (v0.66) - ALL FIVE PALETTES REBUILT AROUND BRIGHTNESS, pre-launch. Blake,
   * verbatim: "fix the color scheme of the pegs (for all of them). I like some of the new
   * palettes, but the colors are often just too similar to eachother. we need stark contrasts
   * between colors so it's blatantly obvious. I'm giving this fable agent full ability to
   * change all of these color schemes, names, etc. whatever it needs to make sure this is
   * fixed before launch!"
   * THE REAL DIAGNOSIS, found by putting the rejected v0.64 renders next to the Default board
   * (whose six seats everyone tells apart instantly): the three failed passes were never short
   * on hue-separation math - they were too DARK. A peg is a tiny object; below roughly 0.08
   * relative luminance every saturated color collapses into the same near-black blob at phone
   * size, and the rejected palettes each had two to four colors down there (old Midnight
   * #0c1445, Indigo #4B0082, Ocean's Deep Blue #000e47, Sunset's Crimson #8a1a1a). Each pass
   * chased the wood-contrast floor by darkening, and darkness is exactly what erased the hues
   * the math said were far apart. The Default board never has this problem because its colors
   * are vivid MID-brightness colors first and "atmospheric" never.
   * THE THREE RULES THIS REBUILD FOLLOWS, per palette, non-negotiable:
   *   1. Hues spread around the wheel like a real board game's pieces (red/blue/green/yellow/
   *      black/white is the north star - Blake explicitly said to borrow from real games). No
   *      two seats in one palette share a hue family unless a big lightness gap splits them.
   *   2. Every vivid seat lives in the relative-luminance band 0.10-0.195: bright enough to
   *      read as its own color at tee size, still dark enough to clear the WCAG >=2.0
   *      wood-contrast floor against all three wood stops (#f0d9ab/#e2c288/#cfa968 - the
   *      original broken default Yellow measured 1.03-1.32 there; this catalog's worst case
   *      is now 2.02, Forest's Fox, and most colors land 2.1-8).
   *   3. At most ONE deliberate near-black anchor per palette (the "black seat" every classic
   *      board game has) and at most one neutral gray - each is identified by BEING the
   *      darkest or the only unsaturated seat, never by a hue nobody can see at peg size.
   * The colorblind-simulation gate stays WITHDRAWN (Blake confirmed nobody who plays needs
   * it; it is what wrecked two earlier passes). And theme names now BEND to
   * distinguishability instead of the reverse: Midnight was structurally six dark blues, so
   * it is renamed GALAXY (display name ONLY - the id palette_midnight is the ownership key
   * in players' wallets and NEVER changes) and now carries the vivid nebula/comet/aurora
   * colors of astronomy photography instead of six shades of night sky.
   * VERIFIED the only way that has ever worked for this catalog: the real 4-player and
   * 6-player boards rendered with every palette (pegs forced into home, stable, starting
   * block and mid-track for every seat, injected through repaintSeatColors()/COLORS4/COLORS6)
   * and judged by eye at phone size - every pair passed the "instantly obvious from across
   * the table, no comparing" test before shipping. See HANDOFF.md "v0.66" for the renders
   * and the per-color contrast table. Sources per color are inline below - same
   * steal-from-real-palettes discipline as v0.63 (Tailwind CSS tokens, CSS/X11 named colors,
   * real gem and pigment names), with rule 2 above deciding WHICH member of each color's
   * family gets used. dark = c halved per channel, the catalog's established relationship.
   * BYTE-IDENTICAL TWIN in server/cloud/server.ts - keep both in sync, same rule as the rest of
   * this catalog. */
  {
    // Sunset - a tropical sunset: fire orange, hot pink, dusk violet, the last navy of the
    // day, a palm silhouette and smoke gray. One warm seat only (Sunfire) - the old
    // Coral/Crimson/Gold trio packed three warm colors into one dark band and they read as
    // one. Sources: Sunfire = Tailwind orange-700 family, warmed and brightened; Rose =
    // Tailwind pink-600 family, deepened to the wood floor; Violet = Tailwind violet-700
    // verbatim (kept from v0.63, it always read clearly); Palm = Tailwind green-700, nudged
    // warmer; Twilight = the real named "Oxford Blue" family, lightened a touch - this
    // palette's one near-black anchor; Smoke = CSS DimGray, warmed - the one neutral.
    id: "palette_sunset", category: "palette", name: "Marbles", cost: 50,
    colors4: [
      { name: "Sunfire", c: "#cc4a14", dark: "#66250a" },
      { name: "Rose", c: "#c21c7a", dark: "#610e3d" },
      { name: "Violet", c: "#6d28d9", dark: "#37146d" },
      { name: "Twilight", c: "#14224f", dark: "#0a1128" },
    ],
    colors6: [
      { name: "Sunfire", c: "#cc4a14", dark: "#66250a" },
      { name: "Rose", c: "#c21c7a", dark: "#610e3d" },
      { name: "Violet", c: "#6d28d9", dark: "#37146d" },
      { name: "Palm", c: "#217a3c", dark: "#113d1e" },
      { name: "Twilight", c: "#14224f", dark: "#0a1128" },
      { name: "Smoke", c: "#7a7169", dark: "#3d3935" },
    ],
  },
  {
    // Ocean Breeze - reef water, coral, an anemone, kelp, the deep, and driftwood. Sources:
    // Teal = Tailwind cyan-700 family, pushed deeper (the palette's bright cyan, clearly NOT
    // the green - Kelp is yellow-leaning specifically so the two never meet); Coral = the
    // Pantone "Living Coral" lineage the old catalog already used, brightened out of the
    // near-black band; Anemone = CSS SlateBlue verbatim (kept from v0.63, always read
    // clearly); Kelp = CSS OliveDrab family, deepened to the floor; Abyss = a real deep-sea
    // navy (Oxford/Maastricht Blue family) - the one near-black anchor, replacing the old
    // invisible Deep Blue #000e47; Driftwood = the real named color Taupe, lightened until
    // it reads as gray-brown wood rather than black - the one neutral.
    id: "palette_ocean", category: "palette", name: "Ocean Breeze", cost: 50,
    colors4: [
      { name: "Teal", c: "#0b7c88", dark: "#063e44" },
      { name: "Coral", c: "#c0432b", dark: "#602216" },
      { name: "Anemone", c: "#6a5acd", dark: "#352d67" },
      { name: "Abyss", c: "#101f4d", dark: "#081027" },
    ],
    colors6: [
      { name: "Teal", c: "#0b7c88", dark: "#063e44" },
      { name: "Coral", c: "#c0432b", dark: "#602216" },
      { name: "Anemone", c: "#6a5acd", dark: "#352d67" },
      { name: "Kelp", c: "#538021", dark: "#2a4011" },
      { name: "Abyss", c: "#101f4d", dark: "#081027" },
      { name: "Driftwood", c: "#6b5e50", dark: "#362f28" },
    ],
  },
  {
    // Forest - re-themed from "shades of plants" (which kept producing two greens) to THINGS
    // THAT LIVE IN A FOREST, so the palette keeps exactly one green: Pine. Sources: Pine =
    // the real named "Hunter Green", re-saturated brighter so it reads as a living evergreen
    // instead of near-black; Fox = a red fox's coat, Tailwind orange-600 family deepened to
    // the floor; Berry = wild raspberry, Crayola's real "Jazzberry Jam", softened; Bluejay =
    // a blue jay's wing, Tailwind blue-700 family nudged brighter; Bark = the real "Bark
    // Brown" from the old catalog, deepened into this palette's one near-black anchor;
    // Birch = v0.63's birch-bark warm gray, UNCHANGED (hex and all) - it always worked.
    id: "palette_forest", category: "palette", name: "Patchwork Quilt", cost: 80,
    colors4: [
      { name: "Pine", c: "#23703f", dark: "#123820" },
      { name: "Fox", c: "#c05a12", dark: "#602d09" },
      { name: "Berry", c: "#a12866", dark: "#511433" },
      { name: "Bluejay", c: "#2456c4", dark: "#122b62" },
    ],
    colors6: [
      { name: "Pine", c: "#23703f", dark: "#123820" },
      { name: "Fox", c: "#c05a12", dark: "#602d09" },
      { name: "Berry", c: "#a12866", dark: "#511433" },
      { name: "Bluejay", c: "#2456c4", dark: "#122b62" },
      { name: "Bark", c: "#35241a", dark: "#1b120d" },
      { name: "Birch", c: "#7a7671", dark: "#3d3b39" },
    ],
  },
  {
    // Royal - six actual crown jewels, one per seat, every one a different stone. Sources:
    // Amethyst = Tailwind purple-600 verbatim - deliberately LIGHTER and redder than
    // Sapphire (the old #6C3BAA sat in Sapphire's own brightness band and the two read as
    // one dark blob on the v0.64 render); Sapphire = the real named "Sapphire Blue",
    // lightened just enough to never read black; Ruby = v0.63's Crimson hex UNCHANGED (a
    // darkened CSS Crimson - it always read clearly), renamed to stay on the jewel theme;
    // Gold = DarkGoldenrod deepened only to the floor and not one step further - the
    // brightest gold this wood allows, and the palette's only warm seat so nothing can
    // shade into it; Emerald = the real named "Emerald Green", deepened; Onyx = the real
    // named "Onyx", deepened with a blue cast - the one near-black anchor, replacing Pearl
    // (a mid-gray sat too close to Gold's brightness band; a black jewel separates harder).
    id: "palette_royal", category: "palette", name: "Royal", cost: 150,
    colors4: [
      { name: "Amethyst", c: "#9333ea", dark: "#4a1a75" },
      { name: "Sapphire", c: "#1a5fd0", dark: "#0d3068" },
      { name: "Ruby", c: "#b01030", dark: "#580818" },
      { name: "Gold", c: "#96700a", dark: "#4b3805" },
    ],
    colors6: [
      { name: "Amethyst", c: "#9333ea", dark: "#4a1a75" },
      { name: "Sapphire", c: "#1a5fd0", dark: "#0d3068" },
      { name: "Ruby", c: "#b01030", dark: "#580818" },
      { name: "Gold", c: "#96700a", dark: "#4b3805" },
      { name: "Emerald", c: "#1e8449", dark: "#0f4225" },
      { name: "Onyx", c: "#1c1c24", dark: "#0e0e12" },
    ],
  },
  {
    // Galaxy (formerly Midnight - display name only, the palette_midnight id is the
    // ownership key and never changes). "Midnight" as a theme structurally demanded dark
    // blues - three passes proved six night colors cannot be told apart on a small board.
    // Galaxy keeps the premium night-sky romance but takes its colors from what astronomy
    // photos actually show: vivid emission-nebula pink, a comet's ion-tail blue, aurora
    // green, solar amber, ultraviolet nebula violet, and the void. Sources: Nova = Tailwind
    // pink-600 family, re-saturated hotter; Comet = Tailwind blue-600 family, pulled
    // cyan-ward and bright; Aurora = Tailwind green-600 family, deepened to the floor;
    // Solar = Tailwind amber-700, near verbatim; Nebula = Tailwind violet-600 family,
    // deepened slightly - clearly redder AND darker than Comet, clearly bluer than Nova;
    // Void = deep space, a near-black with a violet cast - the one near-black anchor.
    id: "palette_midnight", category: "palette", name: "Galaxy", cost: 250,
    colors4: [
      { name: "Nova", c: "#d1187e", dark: "#690c3f" },
      { name: "Comet", c: "#1b74d8", dark: "#0e3a6c" },
      { name: "Aurora", c: "#1c8740", dark: "#0e4420" },
      { name: "Solar", c: "#b35f07", dark: "#5a3004" },
    ],
    colors6: [
      { name: "Nova", c: "#d1187e", dark: "#690c3f" },
      { name: "Comet", c: "#1b74d8", dark: "#0e3a6c" },
      { name: "Aurora", c: "#1c8740", dark: "#0e4420" },
      { name: "Solar", c: "#b35f07", dark: "#5a3004" },
      { name: "Nebula", c: "#7a2fd6", dark: "#3d186b" },
      { name: "Void", c: "#171129", dark: "#0c0915" },
    ],
  },
  // felt - table background colors. c/dark are the two radial-gradient stops, direct
  // replacements for the client's --felt1/--felt2 CSS variables (default #256b46/#0e3421).
  { id: "felt_burgundy", category: "felt", name: "Burgundy Felt", cost: 20, c: "#6b2433", dark: "#35101a" },
  { id: "felt_navy", category: "felt", name: "Navy Felt", cost: 20, c: "#23456b", dark: "#0e1f35" },
  { id: "felt_charcoal", category: "felt", name: "Charcoal Felt", cost: 30, c: "#3a4048", dark: "#16191d" },
  { id: "felt_sunflower", category: "felt", name: "Sunflower Felt", cost: 30, c: "#c99a1e", dark: "#6b4e08" },
  // title - a short label shown next to the player's name on the leaderboard.
  { id: "title_rookie", category: "title", name: "Rookie", cost: 20 },
  { id: "title_shark", category: "title", name: "Card Shark", cost: 50 },
  { id: "title_legend", category: "title", name: "Legend", cost: 100 },
  { id: "title_nasty", category: "title", name: "Certified Nasty", cost: 200 },
  // namechange - a one-shot credit that lets a player change their nickname despite the existing
  // 30-day cooldown. Consumable/stackable, not a one-time unlock - see /account/name below.
  { id: "namechange_credit", category: "namechange", name: "Name Change Token", cost: 30, consumable: true },
  // online - a month of online-play entitlement. Consumable/stackable exactly like the
  // namechange credit above (never "alreadyowned" - see § ONLINE ACCESS below, right after
  // walletView()), not a one-time unlock. Buying it grants the earliest calendar month the
  // account isn't already entitled to, starting with the current month - repeat purchases stack
  // forward into future months rather than being wasted.
  { id: ONLINE_ACCESS_ITEM_ID, category: "online", name: "Online Access (1 month)", cost: ONLINE_ACCESS_COST, consumable: true },
];
function shopItemById(id) { return SHOP_CATALOG.find((it) => it.id === id) || null; }

/* =======================================================================================
 * 2026-07-30 § REAL-MONEY CREDIT PACKS (Apple In-App Purchase) - Blake's ask, verbatim: "Now is
 * the time! please add functionality for people to purchase things outright with real money (CC
 * transaction) if they don't have enough credits earned or would simply just rather purchase
 * instead of earning the credits. Make 10 credits be $1 so that means the 1 month token for
 * online play would be $5 if it's 50 credits."
 *
 * THE SHAPE, and why it is credit packs rather than per-item products: Apple forbids a credit
 * card / Stripe checkout inside an iOS app for digital goods (App Review Guideline 3.1.1), so
 * real money means StoreKit In-App Purchase, and every IAP product must be created in App Store
 * Connect and pass Apple review. One product PER SHOP ITEM would mean an App Store Connect
 * round trip every time Blake adds a felt - so the products are a small fixed ladder of
 * CONSUMABLE CREDIT PACKS instead, and the client presents "buy this item outright": it offers
 * the smallest pack that covers the shortfall, buys the pack through Apple, this server credits
 * the wallet, and the client immediately completes the normal credit purchase. Leftover credits
 * simply stay on the account. Credits bought with money ARE just credits - they spend through
 * the exact same /account/purchase path as earned ones; nothing about spending is forked.
 *
 * THE LADDER sits on Blake's 10-credits-per-dollar anchor. The base pack is exactly the anchor
 * (50 credits / $4.99 - Apple's tier for "$5"); the bigger packs carry a modest bonus so they
 * are the visibly better deal, the standard consumable-pack convention (and every pack size is
 * still divisible by 10, per the same ask):
 *   50  credits  $4.99   the anchor - exactly one Online Access month
 *   110 credits  $9.99   +10% bonus
 *   280 credits  $24.99  +12% bonus - covers Galaxy (250, nee Midnight) outright from zero
 *   600 credits  $49.99  +20% bonus
 * `usd` here is DISPLAY/BOOKKEEPING ONLY (what the App Store Connect price was set to at the
 * time of writing) - Apple owns the real charged price, per storefront and after any tier
 * changes; nothing in this server ever computes money from it. The `credits` number is the only
 * field that has authority, and it is server-owned exactly like every SHOP_CATALOG cost.
 * BYTE-IDENTICAL TWIN in server/cloud/server.ts - keep both in sync, same rule as SHOP_CATALOG.
 * ===================================================================================== */
const IAP_BUNDLE_ID = "com.pangman.nasty";
const CREDIT_PACKS = [
  { productId: "com.pangman.nasty.credits50", credits: 50, usd: 4.99, name: "50 Credits" },
  { productId: "com.pangman.nasty.credits110", credits: 110, usd: 9.99, name: "110 Credits" },
  { productId: "com.pangman.nasty.credits280", credits: 280, usd: 24.99, name: "280 Credits" },
  { productId: "com.pangman.nasty.credits600", credits: 600, usd: 49.99, name: "600 Credits" },
];
function creditPackByProductId(id) { return CREDIT_PACKS.find((p) => p.productId === id) || null; }
// Emergency kill switch, same convention as ACCOUNTS_ENABLED: "0" makes /account/iap/verify and
// /appstore/notifications answer 503/404 without touching any other route. Default ON.
const IAP_ENABLED = accountsEnvFlagOn(process.env.NASTY_IAP_ENABLED, "1");
// Which Apple environments may CREDIT a wallet. TestFlight purchases arrive with
// environment:"Sandbox" (they are free - Apple charges nobody for them), and there is only ONE
// production server, so sandbox acceptance defaults ON so Blake's TestFlight family can test the
// whole flow end to end. THE TRADE, stated plainly: while sandbox is accepted, a TestFlight
// tester's purchases mint real spendable credits without real money changing hands. Before the
// real App Store launch Blake must decide whether to flip NASTY_IAP_ALLOW_SANDBOX to "0"
// (breaks TestFlight purchase testing) or accept free credits for TestFlight testers.
const IAP_ALLOW_SANDBOX = accountsEnvFlagOn(process.env.NASTY_IAP_ALLOW_SANDBOX, "1");
const IAP_ALLOW_PRODUCTION = accountsEnvFlagOn(process.env.NASTY_IAP_ALLOW_PRODUCTION, "1");
// A real Apple signed transaction (JWS with a 3-cert x5c chain) is ~4-6KB; refuse absurd input
// outright, same philosophy as APPLE_TOKEN_MAX_CHARS above.
const IAP_JWS_MAX_CHARS = 32768;
/* Apple Root CA - G3, DER, base64 - the PINNED trust anchor every signed transaction's x5c
   chain must terminate in. Downloaded 2026-07-30 from
   https://www.apple.com/certificateauthority/AppleRootCA-G3.cer and verified against Apple's
   published SHA-256 fingerprint 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:
   6F:30:17:B3:A8:C4:88:C3:65:3E:91:79 (valid to 2039). Env-overridable ONLY so the test suite
   can substitute its own throwaway root (same convention as NASTY_APPLE_JWKS_URL for sign-in) -
   never set NASTY_IAP_ROOT_CA_B64 in production. */
const APPLE_ROOT_CA_G3_B64 =
  "MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEcz" +
  "MSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkG" +
  "A1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENB" +
  "IC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMu" +
  "MQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWm" +
  "BSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEK" +
  "MaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQD" +
  "AgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4" +
  "at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==";
function iapPinnedRootDer() {
  const b64 = process.env.NASTY_IAP_ROOT_CA_B64 || APPLE_ROOT_CA_G3_B64;
  return Buffer.from(b64, "base64");
}
/* Apple marks its App Store signing leaf certificates with OID 1.2.840.113635.100.6.11.1 and
   the WWDR intermediate with OID 1.2.840.113635.100.6.2.1 (the same checks Apple's own
   app-store-server-library makes). Node's X509Certificate does not expose arbitrary extensions,
   so presence is checked by scanning the raw DER for the encoded OID bytes - a belt-and-braces
   check ON TOP of the pinned-root chain verification above it, not the primary boundary. */
const IAP_LEAF_OID_DER = Buffer.from([0x06, 0x0a, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x06, 0x0b, 0x01]);
const IAP_INTERMEDIATE_OID_DER = Buffer.from([0x06, 0x0a, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x06, 0x02, 0x01]);

/* --- the verifier. Takes the raw JWS string a client (or Apple's notification service) sent,
 * returns { ok:true, payload } with the VERIFIED payload object, or { ok:false, reason } with a
 * machine-readable reason. Nothing the client claims is ever trusted: the payload only counts
 * after (1) the x5c chain verifies cert-by-cert and terminates byte-for-byte in the pinned
 * Apple root, (2) every cert is inside its validity window, (3) the Apple marker OIDs are
 * present, and (4) the ES256 signature verifies against the LEAF key. verifyReceipt (the
 * long-deprecated endpoint) is deliberately not used anywhere.
 * WHY LOCAL VERIFICATION and not a server-to-Apple API call: App Store Server Notifications V2
 * (the refund path below) arrive as exactly this same signed-JWS shape and MUST be verified
 * locally anyway - so one verifier covers both, works offline, and needs no App Store Connect
 * API key material on either server. --- */
function verifyAppleSignedJws(raw) {
  if (typeof raw !== "string" || !raw || raw.length > IAP_JWS_MAX_CHARS) return { ok: false, reason: "badjws" };
  const parts = raw.split(".");
  if (parts.length !== 3) return { ok: false, reason: "badjws" };
  let header;
  try { header = JSON.parse(accountsB64uToBuf(parts[0]).toString("utf8")); }
  catch (e) { return { ok: false, reason: "badjws" }; }
  // alg is REQUIRED to be ES256 before any key material is touched - the classic alg-confusion
  // attacks ("none", HS256-with-a-public-key) die right here, same rule as verifyOidcToken.
  if (!header || header.alg !== "ES256" || !Array.isArray(header.x5c)) return { ok: false, reason: "badalg" };
  if (header.x5c.length < 2 || header.x5c.length > 5) return { ok: false, reason: "badchain" };
  let certs;
  try { certs = header.x5c.map((c) => new crypto.X509Certificate(Buffer.from(String(c), "base64"))); }
  catch (e) { return { ok: false, reason: "badchain" }; }
  // The chain must TERMINATE in the pinned Apple root - byte-identical DER, not just same name.
  const root = certs[certs.length - 1];
  if (Buffer.compare(root.raw, iapPinnedRootDer()) !== 0) return { ok: false, reason: "untrustedroot" };
  const now = Date.now();
  for (let i = 0; i < certs.length; i++) {
    // Every cert inside its own validity window...
    const from = Date.parse(certs[i].validFrom), to = Date.parse(certs[i].validTo);
    if (!(Number.isFinite(from) && Number.isFinite(to) && from <= now && now <= to)) return { ok: false, reason: "certexpired" };
    // ...and every cert actually SIGNED by the next one up (the root self-check is skipped -
    // its authority comes from the pin above, not from its self-signature).
    if (i < certs.length - 1) {
      try { if (!certs[i].verify(certs[i + 1].publicKey)) return { ok: false, reason: "badchain" }; }
      catch (e) { return { ok: false, reason: "badchain" }; }
    }
  }
  // Apple's marker OIDs (see the constants above) - only enforced against the REAL Apple root,
  // because the test suite's throwaway chain carries them too (its openssl config adds them),
  // but a future test root without them should not silently weaken what production checks.
  if (!certs[0].raw.includes(IAP_LEAF_OID_DER)) return { ok: false, reason: "badleafoid" };
  if (!certs[1].raw.includes(IAP_INTERMEDIATE_OID_DER)) return { ok: false, reason: "badinteroid" };
  // Finally the JWS signature itself, ES256 (raw r||s per JOSE, hence ieee-p1363), LEAF key only.
  let sigOk = false;
  try {
    sigOk = crypto.verify(
      "sha256",
      Buffer.from(parts[0] + "." + parts[1], "ascii"),
      { key: certs[0].publicKey, dsaEncoding: "ieee-p1363" },
      accountsB64uToBuf(parts[2]),
    );
  } catch (e) { sigOk = false; }
  if (!sigOk) return { ok: false, reason: "badsig" };
  let payload;
  try { payload = JSON.parse(accountsB64uToBuf(parts[1]).toString("utf8")); }
  catch (e) { return { ok: false, reason: "badpayload" }; }
  if (!payload || typeof payload !== "object") return { ok: false, reason: "badpayload" };
  return { ok: true, payload };
}
function iapEnvironmentAllowed(env) {
  if (env === "Sandbox") return IAP_ALLOW_SANDBOX;
  if (env === "Production") return IAP_ALLOW_PRODUCTION;
  return false;
}

/* --- THE REPLAY LEDGER - the single most safety-critical structure in this feature. Every
 * Apple transaction id that has EVER credited a wallet lives here, keyed
 * "<environment>:<transactionId>" (environments are separate id spaces), and is NEVER pruned -
 * unlike purchaseSeen's 24-hour requestIds, a transaction replayed a month later must still be
 * refused, forever. A missing guard here is players minting free credits from one real receipt.
 *
 * WHY THE CHECK-THEN-CREDIT IS SAFE ON THIS SERVER: everything between reading the ledger and
 * writing it back is synchronous - verifyAppleSignedJws() is pure sync crypto, and there is no
 * `await` anywhere between the ledger lookup and the ledger write in the /account/iap/verify
 * handler below - so Node's single thread serializes two "simultaneous" submissions of the
 * same transaction; the second always sees the first's ledger entry. (The Deno twin cannot rely
 * on that and uses one atomic KV commit instead - see server.ts.)
 *
 * CRASH ORDERING, thought through: the ledger is persisted to disk BEFORE the credited account
 * is. If the process dies between the two writes, the surviving state is "ledger says credited,
 * wallet missed it" - an UNDER-credit a resubmission will answer alreadyProcessed for (and the
 * ledger entry has enough detail for Blake to hand-fix via /admin/wallet). The opposite order
 * would leave "wallet credited, ledger empty" - a replay would then credit AGAIN, i.e. minting.
 * Under-credit is recoverable; minting is not. That is why both writes are persist-NOW (never
 * the debounced scheduleAccountStorePersist convention every cosmetic feature uses). --- */
const IAP_LEDGER_FILE = process.env.NASTY_IAP_LEDGER_FILE
  ? path.resolve(process.env.NASTY_IAP_LEDGER_FILE)
  : path.join(__dirname, "iap-ledger.json");
let iapLedger = {};   // "<env>:<txnId>" -> {uid, productId, credits, environment, ts, refunded?, clawedBack?, shortfall?}
function loadIapLedger() {
  try {
    const o = JSON.parse(fs.readFileSync(IAP_LEDGER_FILE, "utf8"));
    if (o && typeof o === "object") iapLedger = o;
  } catch (e) { iapLedger = {}; }
}
function persistIapLedgerNow() {
  try { fs.writeFileSync(IAP_LEDGER_FILE, JSON.stringify(iapLedger)); }
  catch (e) { log("iap ledger persist failed", e.message); }
}
function iapLedgerKey(environment, transactionId) { return environment + ":" + transactionId; }

/* --- the notification audit log (App Store Server Notifications V2). Everything Apple sends -
 * refunds, revocations, its TEST ping, types this server has never heard of - is recorded here
 * after signature verification, capped at the newest 500, so "what did Apple tell us and when"
 * is always answerable even for types this code takes no action on. --- */
const IAP_EVENTS_FILE = process.env.NASTY_IAP_EVENTS_FILE
  ? path.resolve(process.env.NASTY_IAP_EVENTS_FILE)
  : path.join(__dirname, "iap-events.json");
let iapEvents = [];
function loadIapEvents() {
  try {
    const o = JSON.parse(fs.readFileSync(IAP_EVENTS_FILE, "utf8"));
    if (Array.isArray(o)) iapEvents = o;
  } catch (e) { iapEvents = []; }
}
function recordIapEvent(ev) {
  iapEvents.push(Object.assign({ ts: Date.now() }, ev));
  if (iapEvents.length > 500) iapEvents = iapEvents.slice(-500);
  try { fs.writeFileSync(IAP_EVENTS_FILE, JSON.stringify(iapEvents)); }
  catch (e) { log("iap events persist failed", e.message); }
}

/* --- storage. Six small JSON files, all env-overridable exactly like NASTY_LEADERBOARD_FILE so
   tests point them at scratch paths, all debounce-persisted like the leaderboard, and all in
   .gitignore (accounts.json holds Apple's per-app identifier and sessions.json holds live
   session tokens - the repo is public). The Deno twin stores the same six things as KV key
   prefixes; see server.ts's matching section. --- */
function accountsFilePath(envName, base) {
  return process.env[envName] ? path.resolve(process.env[envName]) : path.join(__dirname, base);
}
let accounts = {};        // uid -> account record (shape documented at newAccountRecord() below)
let accountIndex = {};    // "apple:<sub>" -> uid, and "name:<foldedName>" -> uid
let sessions = {};        // opaque session token -> {uid, exp}
let authNonces = {};      // server-issued sign-in nonce -> expiry ms (single use, deleted on sight)
let accountBoard = {};    // uid -> {statKey: number} - the SEPARATE leaderboard namespace
let claimJournal = {};    // uid -> the reversible record of that account's one-time name claim
// folded email -> {hash, exp, attempts, sentAt, sentToday, dayStart}. The CODE ITSELF IS NEVER
// STORED - only a SHA-256 of "<folded email>:<code>", so this file leaking gives an attacker
// nothing usable inside the ten-minute life of a six-digit code.
let emailCodes = {};

const accountStores = [];
function registerAccountStore(file, get, set) {
  const s = { file, get, set, timer: null };
  accountStores.push(s);
  return s;
}
function loadAccountStore(s) {
  try {
    const o = JSON.parse(fs.readFileSync(s.file, "utf8"));
    if (o && typeof o === "object") s.set(o);
  } catch (e) { /* missing file is the normal, expected state - stay empty, create nothing */ }
}
function persistAccountStoreNow(s) {
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  try { fs.writeFileSync(s.file, JSON.stringify(s.get())); }
  catch (e) { log("account store persist failed", s.file, e.message); }
}
function scheduleAccountStorePersist(s) {
  if (s.timer) return;
  s.timer = setTimeout(() => { s.timer = null; persistAccountStoreNow(s); }, PERSIST_DEBOUNCE_MS);
}
const STORE_ACCOUNTS = registerAccountStore(accountsFilePath("NASTY_ACCOUNTS_FILE", "accounts.json"), () => accounts, (o) => { accounts = o; });
const STORE_ACCT_INDEX = registerAccountStore(accountsFilePath("NASTY_ACCOUNT_INDEX_FILE", "account-index.json"), () => accountIndex, (o) => { accountIndex = o; });
const STORE_SESSIONS = registerAccountStore(accountsFilePath("NASTY_SESSIONS_FILE", "sessions.json"), () => sessions, (o) => { sessions = o; });
const STORE_NONCES = registerAccountStore(accountsFilePath("NASTY_AUTH_NONCES_FILE", "auth-nonces.json"), () => authNonces, (o) => { authNonces = o; });
const STORE_ACCT_BOARD = registerAccountStore(accountsFilePath("NASTY_ACCOUNTS_LEADERBOARD_FILE", "accounts-leaderboard.json"), () => accountBoard, (o) => { accountBoard = o; });
const STORE_CLAIMS = registerAccountStore(accountsFilePath("NASTY_ACCOUNT_CLAIMS_FILE", "claims.json"), () => claimJournal, (o) => { claimJournal = o; });
const STORE_EMAIL_CODES = registerAccountStore(accountsFilePath("NASTY_EMAIL_CODES_FILE", "email-codes.json"), () => emailCodes, (o) => { emailCodes = o; });
// 2026-07-31 v0.68 § FREE MONTH TOMBSTONE - see the block above deleteAccountRecord() for the
// full design. hash -> {freeThroughMonth, ts}, nothing else. NEVER pruned (Blake: "an infinite
// record") - only the § LAUNCH RESET clears it. Persisted with persistAccountStoreNow (never
// the debounce) because losing one of these on a crash reopens the exact loophole it closes.
let freeMonthUsed = {};
const STORE_FREE_MONTHS = registerAccountStore(accountsFilePath("NASTY_FREE_MONTHS_FILE", "free-months.json"), () => freeMonthUsed, (o) => { freeMonthUsed = o; });
function loadAccountStores() { for (const s of accountStores) loadAccountStore(s); pruneAuthNonces(); pruneEmailCodes(); }
function flushAccountStores() { for (const s of accountStores) if (s.timer) persistAccountStoreNow(s); }

/* --- Apple identity token verification ------------------------------------------------
   Apple hands the client a signed JWT ("identity token"). The server trusts NOTHING the client
   says except this token, and verifies it itself. Every one of these checks is mandatory and
   they run in this order:

     1. the nonce (checked by the caller BEFORE any crypto - see handleAccountRoute) must be one
        this server issued and has not seen before. That is the replay defence.
     2. size + shape: exactly three dot-separated segments, and short enough that a hostile 1MB
        "token" is refused before anything parses it.
     3. header.alg === "RS256", as a hardcoded EQUALITY CHECK. This verifier never branches on
        what the token claims its algorithm is, so alg:"none" and the classic alg-confusion
        attack (an HS256 token MAC'd with the RSA public key as the shared secret) are closed by
        construction, not by a blocklist.
     4. the signing key comes from Apple's published JWKS, looked up by the header's `kid`,
        cached 6 hours. A kid we have never seen forces exactly ONE refetch (Apple rotates keys),
        then gives up. There is deliberately no "could not fetch keys, skip the signature" path.
     5. the RSASSA-PKCS1-v1_5 / SHA-256 signature itself, via WebCrypto.
     6. the claims: issuer, audience against an allowlist, exp in the future, iat within ten
        minutes either way, the nonce echoed back exactly, and a non-empty string `sub`.

   `sub` is Apple's stable per-app-per-user identifier and is the ONLY thing taken from the
   token. Deliberately NOT read, and deliberately not even a field in the account record:
   `email`, `is_private_email`, and anything the client sends about the user's name. Nothing in
   this design needs an email (there is no password to reset and no mail to send), Apple only
   returns one on the very first authorization anyway, and not collecting it keeps
   "Contact Info > Email Address" off the App Store privacy label entirely.
   --------------------------------------------------------------------------------------- */
const webcrypto = crypto.webcrypto;
function accountsB64uToBuf(s) {
  return Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function accountsB64uToJson(s) {
  return JSON.parse(accountsB64uToBuf(s).toString("utf8"));
}
// One cache per JWKS URL. Apple, Google and Facebook each publish their own key set at their own
// address, and they rotate on their own schedules, so they cannot share a single slot.
const jwksCache = new Map();   // url -> {keys, at}
async function fetchJwks(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 8000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error("jwks http " + r.status);
    const body = await r.json();
    if (!body || !Array.isArray(body.keys)) throw new Error("jwks shape");
    const entry = { keys: body.keys, at: Date.now() };
    jwksCache.set(url, entry);
    return entry.keys;
  } finally { clearTimeout(timer); }
}
async function jwkForKid(url, kid) {
  const cached = jwksCache.get(url);
  if (!cached || Date.now() - cached.at > APPLE_JWKS_TTL_MS) await fetchJwks(url);
  let k = ((jwksCache.get(url) || {}).keys || []).find((j) => j && j.kid === kid);
  // Key rotation: one forced refetch on a miss, then fail closed. Never a signature-less fallback.
  if (!k) {
    await fetchJwks(url);
    k = ((jwksCache.get(url) || {}).keys || []).find((j) => j && j.kid === kid);
  }
  return k || null;
}
/* The ONE OpenID Connect verifier, used by Apple, by Google, and by Facebook's Limited Login.
   Generalized from the Apple-only version that shipped in Stage 1: the checks, their order and
   their strictness are unchanged, the provider's issuer list / key set / audience list are now
   parameters instead of constants. There is deliberately still exactly one verifier - three
   near-copies is how one of them quietly ends up missing a check.

   Returns {ok:true, sub, email, emailVerified, privateRelay} or {ok:false, reason}. Throws ONLY
   if the provider's key list is unreachable, which the caller turns into 503 "accounts
   unavailable" - never into a partial verification. */
async function verifyOidcToken(cfg, rawToken, expectedNonce) {
  const token = typeof rawToken === "string" ? rawToken : "";
  if (!token || token.length > APPLE_TOKEN_MAX_CHARS) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  let header, payload;
  try { header = accountsB64uToJson(parts[0]); payload = accountsB64uToJson(parts[1]); }
  catch (e) { return { ok: false, reason: "malformed" }; }
  if (!header || typeof header !== "object" || !payload || typeof payload !== "object") return { ok: false, reason: "malformed" };
  if (header.alg !== "RS256") return { ok: false, reason: "alg" };
  if (typeof header.kid !== "string" || !header.kid) return { ok: false, reason: "kid" };
  const jwk = await jwkForKid(cfg.jwksUrl, header.kid);
  if (!jwk || jwk.kty !== "RSA") return { ok: false, reason: "kid" };
  let key;
  try {
    key = await webcrypto.subtle.importKey(
      "jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
    );
  } catch (e) { return { ok: false, reason: "kid" }; }
  let good = false;
  try {
    good = await webcrypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" }, key,
      accountsB64uToBuf(parts[2]), Buffer.from(parts[0] + "." + parts[1], "ascii"),
    );
  } catch (e) { good = false; }
  if (!good) return { ok: false, reason: "signature" };
  if (typeof payload.iss !== "string" || !cfg.issuers.includes(payload.iss)) return { ok: false, reason: "issuer" };
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!cfg.audiences.length) return { ok: false, reason: "audience" };
  if (!auds.some((a) => typeof a === "string" && cfg.audiences.includes(a))) return { ok: false, reason: "audience" };
  const now = Date.now();
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp * 1000 <= now) return { ok: false, reason: "expired" };
  if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat) || Math.abs(now - payload.iat * 1000) > APPLE_CLOCK_SKEW_MS) return { ok: false, reason: "clock" };
  // The nonce is mandatory for ALL THREE providers, and it is the single-use one this server
  // issued. Apple, Google and Facebook Limited Login all echo it, so there is no provider that
  // needs an exception - and an exception is exactly how a replay hole gets introduced.
  if (typeof payload.nonce !== "string" || !payload.nonce || payload.nonce !== expectedNonce) return { ok: false, reason: "nonce" };
  if (typeof payload.sub !== "string" || !payload.sub) return { ok: false, reason: "sub" };
  return Object.assign({ ok: true, sub: payload.sub }, emailFromOidcPayload(payload));
}
// Apple sends email_verified/is_private_email as either a real boolean or the STRINGS "true"/
// "false"; Google sends a real boolean. Anything we are not sure about is treated as unverified,
// which means it is never used as a linking key.
function oidcBool(v) { return v === true || v === "true"; }
function emailFromOidcPayload(payload) {
  const raw = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!raw || !isPlausibleEmail(raw)) return { email: null, emailVerified: false, privateRelay: false };
  return {
    email: raw,
    emailVerified: oidcBool(payload.email_verified),
    privateRelay: oidcBool(payload.is_private_email) || /@privaterelay\.appleid\.com$/i.test(raw),
  };
}
// Kept as a named wrapper because the Stage 1 suites and the block comment above both refer to it,
// and because "verify Apple's identity token" is genuinely its own idea even though the body is
// now shared.
function verifyAppleIdentityToken(rawToken, expectedNonce) {
  return verifyOidcToken(OIDC_PROVIDERS.apple, rawToken, expectedNonce);
}

/* --- Facebook's classic access token. This is NOT a JWT and there is nothing to verify by
   signature, so the server asks Facebook about it directly:
     GET <graph>/debug_token?input_token=<the user's token>&access_token=<appid>|<appsecret>
   and requires the answer to say the token is valid AND was issued for OUR app. That app access
   token is the app id and secret joined by a pipe, which is why the secret has to exist on the
   server for the web half of Facebook login to work at all. The user's own token is then used
   once more to read their email, which is what makes Facebook linkable to the other providers.
   Everything here happens server side; the browser's claims are never trusted. --- */
async function inspectFacebookAccessToken(accessToken) {
  const t = typeof accessToken === "string" ? accessToken.trim() : "";
  if (!t || t.length > 4096 || /[\s"']/.test(t)) return { ok: false, reason: "malformed" };
  if (!FACEBOOK_APP_ID) return { ok: false, reason: "unconfigured" };
  if (!FACEBOOK_APP_SECRET) return { ok: false, reason: "nosecret" };
  const appToken = FACEBOOK_APP_ID + "|" + FACEBOOK_APP_SECRET;
  const url = FACEBOOK_GRAPH_URL + "/debug_token?input_token=" + encodeURIComponent(t) +
    "&access_token=" + encodeURIComponent(appToken);
  const ctl = new AbortController();
  const timer = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 8000);
  let data;
  try {
    const r = await fetch(url, { signal: ctl.signal });
    // A 4xx from Graph is Facebook telling us the token is bad, not an outage - that is a
    // rejection, not a 503. Only a network/parse failure is an outage.
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
  let email = null;
  try {
    const me = await fetch(FACEBOOK_GRAPH_URL + "/me?fields=id,email&access_token=" + encodeURIComponent(t));
    const mb = await me.json().catch(() => null);
    // The id from /me must be the SAME app-scoped id debug_token reported, or something is wrong
    // and we take nothing from it.
    if (mb && String(mb.id || "") === userId && typeof mb.email === "string" && isPlausibleEmail(mb.email.trim().toLowerCase())) {
      email = mb.email.trim().toLowerCase();
    }
  } catch (e) { /* email is a bonus, never a requirement - a failure here is not a sign-in failure */ }
  // Facebook only ever hands out an address the person confirmed with Facebook, so it is treated
  // as verified for linking purposes. Stated plainly in the design doc rather than assumed.
  return { ok: true, sub: userId, email, emailVerified: !!email, privateRelay: false };
}

/* --- nonces. The SERVER issues them (GET /account/nonce), stores them single-use with a
   10-minute life, and deletes on first presentation whether or not it was still valid. That
   is what makes replaying a captured identity token impossible. --- */
function pruneAuthNonces() {
  const now = Date.now();
  let pruned = false;
  for (const n of Object.keys(authNonces)) { if (!(authNonces[n] > now)) { delete authNonces[n]; pruned = true; } }
  if (pruned) scheduleAccountStorePersist(STORE_NONCES);
}
function issueAuthNonce() {
  pruneAuthNonces();
  const n = crypto.randomBytes(16).toString("hex");
  authNonces[n] = Date.now() + AUTH_NONCE_TTL_MS;
  scheduleAccountStorePersist(STORE_NONCES);
  return n;
}
function consumeAuthNonce(n) {
  if (typeof n !== "string" || !n) return false;
  const exp = authNonces[n];
  delete authNonces[n];                                   // single use, unconditionally
  scheduleAccountStorePersist(STORE_NONCES);
  return !!(exp && exp > Date.now());
}

/* =======================================================================================
 * THE PASSWORDLESS EMAIL CODE (the fourth sign-in method).
 *
 * You type your email address, we mail you a six-digit number, you type it back. There is no
 * password in this system and there never will be one - no password field, no password hash, no
 * reset flow, no breach surface. This method exists for the relatives who have no Apple, Google
 * or Facebook account, and, just as importantly, it is what makes a VERIFIED EMAIL available as
 * the key that links one human's several sign-in methods to one account (see linking below).
 *
 * HOW THE MAIL ACTUALLY LEAVES THE BUILDING - this is the part that has to be real, not
 * hand-waved. Production runs on Deno Deploy, which is an isolate with outbound HTTPS and no
 * SMTP. So sending has to be an HTTPS API call. Blake's Google Workspace service account
 * (info@pocketcache.app) is driven by gogcli, a LOCAL command line tool on his Mac; the cloud
 * server cannot shell out to it and must not hold Workspace credentials, so it is not an option
 * here. The supported senders are therefore transactional email APIs:
 *
 *   NASTY_EMAIL_PROVIDER=resend    POST https://api.resend.com/emails, Bearer <api key>
 *   NASTY_EMAIL_PROVIDER=postmark  POST https://api.postmarkapp.com/email, X-Postmark-Server-Token
 *   NASTY_EMAIL_PROVIDER=console   dev only - prints the code to the server log, sends nothing
 *
 * Resend is the recommendation and blake-signin-setup.md says exactly what he has to sign up for
 * and which DNS records the domain needs. With NASTY_EMAIL_PROVIDER unset - which is production
 * today - the email method is simply not offered and /account/email/* answers 503 like every
 * other unconfigured provider. Nothing here invents a sender that cannot work.
 * ===================================================================================== */
const EMAIL_MAX_CHARS = 254;
function isPlausibleEmail(s) {
  const v = String(s || "");
  return v.length >= 6 && v.length <= EMAIL_MAX_CHARS && /^[^\s@,;:<>"']+@[^\s@,;:<>"']+\.[^\s@,;:<>"']{2,}$/.test(v);
}
function foldEmail(s) { return String(s || "").trim().toLowerCase(); }
function pruneEmailCodes() {
  const now = Date.now();
  let pruned = false;
  for (const k of Object.keys(emailCodes)) {
    const c = emailCodes[k];
    // A challenge is kept a little past its expiry only while its daily send counter is still
    // meaningful, so "resend me another one" cannot be used as an unlimited mail cannon.
    if (!c || (!(c.exp > now) && !(c.dayStart && now - c.dayStart < 24 * 60 * 60 * 1000))) { delete emailCodes[k]; pruned = true; }
  }
  if (pruned) scheduleAccountStorePersist(STORE_EMAIL_CODES);
}
function newEmailCode() {
  // Six digits, uniformly. crypto.randomInt does rejection sampling internally, so there is no
  // modulo bias and no leading-zero problem (the padStart keeps "000123" six characters).
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}
function hashEmailCode(folded, code) {
  return crypto.createHash("sha256").update(folded + ":" + code, "utf8").digest("hex");
}
function timingSafeHexEqual(a, b) {
  const x = Buffer.from(String(a || ""), "utf8"), y = Buffer.from(String(b || ""), "utf8");
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch (e) { return false; }
}
/* Retire a code without forgetting that it was sent. The hash is wiped and the expiry zeroed, so
   the code can never be presented again (that is the single-use rule) - but sentAt/sentToday
   survive, which is what keeps the resend cooldown and the per-day cap honest. Deleting the
   record outright, which is the obvious thing to write, would let anyone reset both limits just
   by burning a challenge. The record itself is pruned once its day is over. */
function burnEmailChallenge(folded, ch) {
  emailCodes[folded] = { hash: "", exp: 0, attempts: ch.attempts || 0, sentAt: ch.sentAt || 0, sentToday: ch.sentToday || 0, dayStart: ch.dayStart || Date.now() };
  persistAccountStoreNow(STORE_EMAIL_CODES);
}
function accountEmailSubject() { return "Your NASTY sign-in code"; }
function accountEmailText(code) {
  return "Your NASTY sign-in code is " + code + "\n\n" +
    "It works for the next 10 minutes and only once. If you didn't ask for it, you can ignore this - nothing has changed.\n";
}
// Returns {ok:true} or {ok:false, reason}. Never throws: a mail-provider outage must read as
// "we could not send that right now", not as a crashed sign-in.
async function sendAccountEmail(to, code) {
  if (EMAIL_PROVIDER === "console") { log("EMAIL CODE (console provider, dev only)", to, code); return { ok: true }; }
  const ctl = new AbortController();
  const timer = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 10000);
  try {
    let url, headers, body;
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
    log("email send error", EMAIL_PROVIDER, e.message);
    return { ok: false, reason: "sendfailed" };
  } finally { clearTimeout(timer); }
}

/* --- sessions. The server mints its OWN opaque token after a successful Apple verification and
   never shows Apple's token to anything again. Completely separate from - and invisible to -
   the per-room playerId/token rejoin credential in § ROOMS, which this stage does not touch in
   any way. Sent by a future client in the JSON body as `auth`, never as a header, because
   CORS_HEADERS allows exactly "content-type, x-admin-token" and a body field needs no CORS
   change at all. --- */
function issueSession(uid) {
  const token = crypto.randomBytes(32).toString("hex");
  const exp = Date.now() + SESSION_TTL_MS;
  sessions[token] = { uid, exp };
  scheduleAccountStorePersist(STORE_SESSIONS);
  return { token, exp };
}
// null = no session / expired / the account is gone. Otherwise {token, uid, exp, account},
// with the sliding refresh already applied.
function resolveSession(auth) {
  if (typeof auth !== "string" || !auth) return null;
  const s = sessions[auth];
  if (!s) return null;
  const now = Date.now();
  if (!(s.exp > now)) { delete sessions[auth]; scheduleAccountStorePersist(STORE_SESSIONS); return null; }
  const account = accounts[s.uid];
  if (!account) { delete sessions[auth]; scheduleAccountStorePersist(STORE_SESSIONS); return null; }
  if (s.exp - now < SESSION_TTL_MS - SESSION_SLIDE_AFTER_MS) {
    s.exp = now + SESSION_TTL_MS;                          // silently extended, no client dance
    scheduleAccountStorePersist(STORE_SESSIONS);
  }
  // lastSeen is a rough "when did we last hear from this person" for Blake's god-mode panel, so
  // it is only written once a minute at most. Updating it on literally every authenticated
  // request would rewrite the whole accounts store constantly for no benefit (and on the Deno
  // twin that is a KV write per request).
  if (now - (account.lastSeen || 0) > 60 * 1000) {
    account.lastSeen = now;
    scheduleAccountStorePersist(STORE_ACCOUNTS);
  }
  return { token: auth, uid: s.uid, exp: s.exp, account };
}
function revokeSession(token) {
  if (typeof token !== "string" || !token || !sessions[token]) return false;
  delete sessions[token];
  scheduleAccountStorePersist(STORE_SESSIONS);
  return true;
}
function revokeAllSessionsFor(uid) {
  let n = 0;
  for (const t of Object.keys(sessions)) { if (sessions[t] && sessions[t].uid === uid) { delete sessions[t]; n++; } }
  if (n) scheduleAccountStorePersist(STORE_SESSIONS);
  return n;
}

/* --- accounts. The Apple `sub` is an INDEX KEY, not the account id: the leaderboard must never
   be keyed on a provider-specific value, or adding another sign-in method later (or Apple
   changing something) would reach straight into the family's lifetime stats. --- */
// 2026-07-31 v0.68: test-only override for the `created` stamp, same convention (and the same
// warning) as NASTY_MONTHLY_NOW_MS - NEVER set in production. It exists because the § FREE
// MONTH TOMBSTONE cannot be tested honestly without an account whose signup month is genuinely
// in the past, and `created` was previously un-fakeable. This does NOT change the standing
// "every account record has ALWAYS carried a real created timestamp" finding below - with the
// env var unset (production, always) this is byte-for-byte Date.now().
function accountCreatedNowMs() {
  const override = Number(process.env.NASTY_ACCOUNT_CREATED_MS);
  return Number.isFinite(override) && override > 0 ? override : Date.now();
}
function newAccountRecord(provider, sub) {
  const now = accountCreatedNowMs();
  return {
    uid: crypto.randomBytes(16).toString("hex"),
    // `provider`/`sub` are the FIRST identity, kept as their own fields purely so a record
    // written by Stage 1 still reads correctly. `identities` is the real list.
    provider,
    sub,
    identities: [{ provider, sub, linkedAt: now }],
    email: null,            // verified only - see the linking block below
    emailSource: null,      // which sign-in method vouched for it
    emailPrivateRelay: false,
    gameName: null,         // the 10-char display label; null until the player picks one
    nameFolded: null,       // leaderboardNameKey(gameName) - what uniqueness is enforced on
    nameChangedAt: 0,       // 0 = the first rename is free; see handleAccountRoute's /account/name
    nameHistory: [],        // [{name, from, to}] so "who was Ginny in June" is answerable
    claimDeclined: false,   // they were offered the existing name row and said "start fresh"
    created: now,
    lastSeen: now,
    refreshToken: null,     // stays null until Apple's .p8 key exists (revoke-on-delete, Stage 6)
    // 2026-07-28 § WALLET - see the "§ POINTS WALLET" block below. Spendable balance is never
    // stored directly; it is always LIFETIME EARNED (read live off the leaderboard - see
    // accountEarnedPoints()) MINUS walletSpent, computed on every read so it can never drift from
    // the leaderboard it depends on. walletOwned/walletSpent/walletNamechangeCredits are the only
    // three numbers this feature actually needs to persist.
    walletSpent: 0,             // lifetime points spent - NEVER reduces the leaderboard's earned total
    walletOwned: [],            // owned non-consumable shop item ids (palette/felt/title)
    walletNamechangeCredits: 0, // one-shot credits that bypass the 30-day rename cooldown once each
    // 2026-07-30 § REAL-MONEY CREDIT PACKS - lifetime credits BOUGHT with real money (Apple
    // IAP), kept apart from earned points on purpose: the leaderboard ranks on EARNED alone and
    // money must never move it. Balance becomes earned + purchased - spent (see walletView()).
    // A refund subtracts back off this counter (see /appstore/notifications), never off earned.
    walletPurchasedCredits: 0,
    // 2026-07-28 § POINTS WALLET ADMIN GRANT - which currently-owned ids arrived via
    // POST /admin/wallet/grantall rather than a real purchase, so a later revoke can undo
    // EXACTLY what it granted and never touch anything genuinely bought. An id can only ever be
    // owned via one route or the other (a purchase 409s "alreadyowned" for anything already
    // granted), so this small additive list is enough to tell the two apart precisely.
    walletGrantedItems: [],
  };
}
// Stage 1 records have provider/sub and no identities array. Read through this everywhere so the
// two shapes are never handled twice.
function accountIdentities(acct) {
  if (Array.isArray(acct.identities) && acct.identities.length) return acct.identities;
  if (acct.provider && acct.sub) return [{ provider: acct.provider, sub: acct.sub, linkedAt: acct.created || 0 }];
  return [];
}
function identityIndexKey(provider, sub) { return provider + ":" + sub; }
// Deliberately "mail:" and not "email:" - the identity index already uses "<provider>:<sub>",
// and the email sign-in method's provider name IS "email", so "email:" would be two different
// indexes sharing one key space.
function emailIndexKey(folded) { return "mail:" + folded; }
function accountForIdentity(provider, sub) {
  const uid = accountIndex[identityIndexKey(provider, sub)];
  return uid && accounts[uid] ? accounts[uid] : null;
}
function accountForEmail(folded) {
  const uid = accountIndex[emailIndexKey(folded)];
  return uid && accounts[uid] ? accounts[uid] : null;
}
function accountOwningFoldedName(folded) {
  const uid = accountIndex["name:" + folded];
  return uid && accounts[uid] ? uid : null;
}

/* =======================================================================================
 * LINKING - and the reversal it required.
 *
 * Stage 1 stored NO email at all, on purpose: nothing needed one, and leaving it out kept
 * "Contact Info > Email Address" off the App Store privacy label. That decision was correct for
 * a single sign-in method and is WRONG for four. With Apple, Google, Facebook and an email code
 * all available, the same human will sign in with Apple on their phone and Google on their
 * laptop, and with nothing to match on, that is silently two accounts, two game names and two
 * leaderboard rows - the exact problem accounts exist to fix.
 *
 * So a VERIFIED email is now stored and used as the linking key. This is a deliberate reversal,
 * written down as one in the design doc, and it adds a Contact Info category to the App Store
 * privacy labels.
 *
 * The rules, in order, on every sign-in:
 *   1. If this provider identity is already known, that is the account. Nothing else is
 *      consulted - a known identity always wins.
 *   2. Otherwise, if the provider gave us a VERIFIED email that we already hold for an existing
 *      account, the new identity is ATTACHED to that account. Same account, same game name, same
 *      leaderboard row.
 *   3. Otherwise it is a new person, and a new account.
 *
 * Unverified addresses are never used as a key. Neither is an Apple private-relay address,
 * because it is real but it is per-app and will never equal the same person's real Gmail - so
 * matching on it would be a coin flip dressed up as a link. Apple relay addresses ARE stored
 * (they are stable, so they still link Apple-to-Apple across the phone and the website), they
 * are just excluded from cross-provider matching.
 *
 * THE HONEST LIMIT: someone who uses "Hide My Email" with Apple and then signs in with Google
 * gets two accounts, and no amount of cleverness fixes that from the server side. The mitigation
 * is the explicit "link another sign-in method" action - POST /account/link, below - which
 * attaches a second provider to the account you are ALREADY signed in to, no email matching
 * involved. That is the one flow that always works, for every combination.
 * ===================================================================================== */
function linkableEmail(v) {
  return !!(v && v.email && v.emailVerified && !v.privateRelay && isPlausibleEmail(v.email));
}
// Record a verified email on an account if it does not have one yet (or if this one is better -
// a real address beats a private relay). Never overwrites a good address with a worse one, and
// never steals an address that already indexes a different account.
function rememberAccountEmail(acct, provider, v) {
  if (!v || !v.email || !v.emailVerified || !isPlausibleEmail(v.email)) return false;
  const folded = foldEmail(v.email);
  const owner = accountIndex[emailIndexKey(folded)];
  if (owner && owner !== acct.uid) return false;
  const haveReal = acct.email && !acct.emailPrivateRelay;
  if (acct.email === folded && !!acct.emailPrivateRelay === !!v.privateRelay) return false;
  if (haveReal && v.privateRelay) return false;
  if (acct.email && acct.email !== folded) delete accountIndex[emailIndexKey(acct.email)];
  acct.email = folded;
  acct.emailSource = provider;
  acct.emailPrivateRelay = !!v.privateRelay;
  accountIndex[emailIndexKey(folded)] = acct.uid;
  scheduleAccountStorePersist(STORE_ACCOUNTS);
  scheduleAccountStorePersist(STORE_ACCT_INDEX);
  return true;
}
function attachIdentity(acct, provider, sub) {
  if (!Array.isArray(acct.identities)) acct.identities = accountIdentities(acct).slice();
  if (!acct.identities.some((i) => i.provider === provider && i.sub === sub)) {
    acct.identities.push({ provider, sub, linkedAt: Date.now() });
  }
  accountIndex[identityIndexKey(provider, sub)] = acct.uid;
  scheduleAccountStorePersist(STORE_ACCOUNTS);
  scheduleAccountStorePersist(STORE_ACCT_INDEX);
  // 2026-07-31 v0.68 § FREE MONTH TOMBSTONE: a newly linked sign-in method inherits the
  // account's free-month record the moment it is attached - otherwise "link Google, delete the
  // account, come back through Google" would be a fresh free month through the side door. Twin
  // of server.ts's.
  try { writeFreeMonthTombstoneIfAbsent(provider, sub, accountFreeThroughMonth(acct)); }
  catch (e) { log("free-month tombstone write failed on link", acct.uid, provider, e.message); }
}
// v is a verified provider result: {sub, email, emailVerified, privateRelay}.
// Returns {account, created, linked, freeMonthAlreadyUsed?}. 2026-07-31 v0.68:
// freeMonthAlreadyUsed is true only when a BRAND-NEW account inherited a § FREE MONTH
// TOMBSTONE whose free window is already over - i.e. the person the sign-up notice actually
// helps. A returning identity still inside its original free window inherits silently
// (nothing changed for them, so there is nothing to announce). Twin of server.ts's.
function resolveAccountForIdentity(provider, v) {
  const known = accountForIdentity(provider, v.sub);
  if (known) {
    rememberAccountEmail(known, provider, v);
    return { account: known, created: false, linked: false };
  }
  if (linkableEmail(v)) {
    const byEmail = accountForEmail(foldEmail(v.email));
    if (byEmail) {
      attachIdentity(byEmail, provider, v.sub);
      log("linked a second sign-in method to an existing account", byEmail.uid, provider);
      return { account: byEmail, created: false, linked: true };
    }
  }
  const rec = newAccountRecord(provider, v.sub);
  // 2026-07-31 v0.68 § FREE MONTH TOMBSTONE: consulted BEFORE the record is stored, so the
  // inherited cap is part of the very first write and no window exists where the new account
  // reads as freshly entitled. See the block above deleteAccountRecord().
  const tomb = readFreeMonthTombstone(provider, v.sub);
  if (tomb) rec.onlineFreeThrough = tomb.freeThroughMonth;
  accounts[rec.uid] = rec;
  accountIndex[identityIndexKey(provider, v.sub)] = rec.uid;
  scheduleAccountStorePersist(STORE_ACCOUNTS);
  scheduleAccountStorePersist(STORE_ACCT_INDEX);
  rememberAccountEmail(rec, provider, v);
  // No tombstone yet for this identity: write one NOW, at creation, so the record exists even
  // if this account is never deleted (and deletion cannot race or crash it away later).
  if (!tomb) {
    try { writeFreeMonthTombstoneIfAbsent(provider, v.sub, accountFreeThroughMonth(rec)); }
    catch (e) { log("free-month tombstone write failed on create", rec.uid, provider, e.message); }
  }
  log("new account created", rec.uid, provider, tomb ? "(free month already used - through " + tomb.freeThroughMonth + ")" : "");
  return { account: rec, created: true, linked: false, freeMonthAlreadyUsed: !!tomb && !onlineEntitledNow(rec) };
}
// The Stage 1 entry point, kept so nothing that referred to it has to be reworded.
function accountForAppleSub(sub) { return resolveAccountForIdentity("apple", { sub }).account; }

/* --- the name claim. THE ONLY OPERATION IN THIS WHOLE PLAN THAT MOVES EXISTING DATA, so it is
   written to be replayable and individually reversible.

   Order, and why:
     1. snapshot every unclaimed leaderboard row whose folded name matches this account's name;
     2. write the journal FIRST and flush it to disk. The journal holds both the source snapshot
        AND the account row's values from before the claim (`pre`), which is what makes step 3 a
        PURE FUNCTION of the journal - so a crash anywhere can re-run it any number of times
        without ever double-counting;
     3. account row := pre + sum(snapshot);
     4. delete the source rows;
     5. mark the journal done.
   Crash between 2 and 3, 3 and 4, or 4 and 5: re-running from the existing pending journal
   lands on exactly the same numbers. A journal already marked "done" short-circuits at the top.
   Journal entries are never deleted - they are a few bytes each and there will be fewer than
   twenty of them in this app's lifetime. --- */
function unclaimedRowsForFolded(folded) {
  const out = {};
  for (const name of Object.keys(globalBoard)) {
    if (leaderboardNameKey(name) !== folded) continue;
    const r = globalBoard[name];
    if (!r || typeof r !== "object") continue;
    const snap = {};
    for (const k of Object.keys(r)) { const v = r[k]; if (typeof v === "number" && Number.isFinite(v)) snap[k] = v; }
    out[name] = snap;
  }
  return out;
}
// The plain-language summary a future client shows in "There are already 47 games and 19 wins
// on the board under the name Blake. Is that you?"
function claimSummary(rows) {
  const t = {};
  for (const n of Object.keys(rows || {})) for (const k of Object.keys(rows[n])) t[k] = (t[k] || 0) + rows[n][k];
  return {
    games: (t.hg4s || 0) + (t.hg6s || 0) + (t.hg4t || 0) + (t.hg6t || 0),
    wins: (t.hw4s || 0) + (t.hw6s || 0) + (t.hw4t || 0) + (t.hw6t || 0),
    points: (t.hptsS || 0) + (t.hptsT || 0),
    koDealt: t.hkoDealt || 0,
    koTaken: t.hkoTaken || 0,
  };
}
// Test-only crash simulation. Unset in production; the suite sets it to prove the journal really
// does make a half-finished claim recoverable. Values: "after-journal", "after-merge".
function claimFaultPoint() { return String(process.env.NASTY_CLAIM_FAULT || ""); }
function runAccountClaim(acct) {
  const uid = acct.uid;
  let j = claimJournal[uid];
  if (j && j.state === "done") return { ok: true, alreadyDone: true, moved: claimSummary(j.rows) };
  if (!j || j.state !== "pending") {
    const pre = {};
    const cur = accountBoard[uid] || {};
    for (const k of Object.keys(cur)) pre[k] = cur[k];
    j = claimJournal[uid] = { uid, folded: acct.nameFolded, ts: Date.now(), rows: unclaimedRowsForFolded(acct.nameFolded), pre, state: "pending" };
    persistAccountStoreNow(STORE_CLAIMS);   // journal first, on disk, before anything moves
  }
  if (claimFaultPoint() === "after-journal") throw new Error("simulated crash after journal write");
  const target = {};
  for (const k of Object.keys(j.pre)) target[k] = j.pre[k];
  for (const n of Object.keys(j.rows)) for (const k of Object.keys(j.rows[n])) target[k] = (target[k] || 0) + j.rows[n][k];
  if (Object.keys(target).length) accountBoard[uid] = target; else delete accountBoard[uid];
  persistAccountStoreNow(STORE_ACCT_BOARD);
  if (claimFaultPoint() === "after-merge") throw new Error("simulated crash after merge, before source delete");
  let removed = 0;
  for (const n of Object.keys(j.rows)) { if (globalBoard[n]) { delete globalBoard[n]; removed++; } }
  if (removed) { rebuildLbNameIndex(); persistLeaderboardNow(); }
  j.state = "done";
  persistAccountStoreNow(STORE_CLAIMS);
  log("account claim completed", uid, "rows=" + JSON.stringify(Object.keys(j.rows)));
  return { ok: true, moved: claimSummary(j.rows) };
}
// The individual reversal. Restores each source row from the journal (verbatim if that name is
// vacant, which is the normal case; ADDED if something has written to that name since, so a
// rollback never destroys newer data) and puts the account row back to its pre-claim values.
function undoAccountClaim(uid) {
  const j = claimJournal[uid];
  if (!j) return { ok: false, error: "no claim journal for that account" };
  for (const n of Object.keys(j.rows)) {
    const snap = j.rows[n];
    if (!globalBoard[n]) { globalBoard[n] = Object.assign({}, snap); continue; }
    const cur = globalBoard[n];
    for (const k of Object.keys(snap)) cur[k] = (Number(cur[k]) || 0) + snap[k];
  }
  rebuildLbNameIndex();
  persistLeaderboardNow();
  const pre = {};
  for (const k of Object.keys(j.pre)) { const v = j.pre[k]; if (typeof v === "number" && Number.isFinite(v) && v > 0) pre[k] = v; }
  if (Object.keys(pre).length) accountBoard[uid] = pre; else delete accountBoard[uid];
  persistAccountStoreNow(STORE_ACCT_BOARD);
  j.state = "undone";
  persistAccountStoreNow(STORE_CLAIMS);
  log("admin undid account claim", uid);
  return { ok: true, restored: Object.keys(j.rows) };
}

/* =======================================================================================
 * 2026-07-31 v0.68 § FREE MONTH TOMBSTONE - twin of server.ts's block of the same name (read
 * that one for the full design writeup; the reasoning is written once, there, and this copy
 * stays behaviorally identical).
 *
 * Blake, verbatim: "make sure you close the loophole of people deleting their account and just
 * creating a new one with the same Apple SSO to get another free month. While the old account
 * is deleted, we should still store an infinite record of 'this Apple account has already used
 * their free month' and let it be known when they create their new account." And on what may
 * be stored: "a one-way scrambled version of their Apple ID plus which month their free trial
 * covered... the stored value cannot be turned back into who they are."
 *
 * So: one record per sign-in identity, keyed SHA-256(salt + provider + sub), value
 * {freeThroughMonth, ts} and nothing else. Written if-absent at account creation, at identity
 * linking, and at deletion; read once at account creation, where a hit caps the new account's
 * derived free window via onlineFreeThrough. Node-specific bits: the salt lives in a
 * gitignored file (free-month-salt.txt, same pattern as admin-token.txt) with the
 * NASTY_FREEMONTH_SALT env override, and the hash is Node's synchronous crypto - so, unlike
 * the Deno twin, nothing here is async and resolveAccountForIdentity stays synchronous.
 * ===================================================================================== */
const FREEMONTH_SALT_FILE = accountsFilePath("NASTY_FREEMONTH_SALT_FILE", "free-month-salt.txt");
function loadOrCreateFreeMonthSalt() {
  const env = String(process.env.NASTY_FREEMONTH_SALT || "").trim();
  if (env) return env;
  try {
    const t = fs.readFileSync(FREEMONTH_SALT_FILE, "utf8").trim();
    if (t) return t;
  } catch (e) { /* first run - generate below */ }
  const t = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(FREEMONTH_SALT_FILE, t + "\n", { mode: 0o600 });
    fs.chmodSync(FREEMONTH_SALT_FILE, 0o600);
  } catch (e) { log("could not persist the free-month salt", e.message); }
  return t;
}
// The salt must NEVER change once tombstones exist - a new salt orphans every record (the
// hashes stop matching) and silently reopens the loophole. That is why it is persisted.
const FREEMONTH_SALT = loadOrCreateFreeMonthSalt();
function freeMonthIdentityHash(provider, sub) {
  return crypto.createHash("sha256").update(FREEMONTH_SALT + ":" + provider + ":" + sub).digest("hex");
}
function readFreeMonthTombstone(provider, sub) {
  if (!provider || !sub) return null;
  const t = freeMonthUsed[freeMonthIdentityHash(provider, sub)];
  return t && typeof t.freeThroughMonth === "string" ? t : null;
}
// If-absent on purpose: the FIRST record for an identity is the truth forever. Overwriting on a
// later delete would let a recreate-then-delete cycle push freeThroughMonth forward.
function writeFreeMonthTombstoneIfAbsent(provider, sub, freeThroughMonth) {
  if (!provider || !sub || !freeThroughMonth) return;
  const h = freeMonthIdentityHash(provider, sub);
  if (freeMonthUsed[h]) return;
  freeMonthUsed[h] = { freeThroughMonth, ts: Date.now() };
  persistAccountStoreNow(STORE_FREE_MONTHS);   // never debounced - see the store's own comment
}
/* Blake's decision on what the returning person is told, verbatim: "A clear line when the new
   account is created: their free online month was already used, so online play needs a token.
   No surprise later when they try to join a game." Worded for the honest majority - someone
   reinstalling after deleting - not as an accusation. Twin of server.ts's. */
const FREE_MONTH_USED_NOTICE =
  "Welcome back! A previous account on this sign-in already used its free month of online play, " +
  "so online games now take an Online Access token from the Shop. Everything else, including all " +
  "offline play, stays free.";

/* --- deletion (App Store guideline 5.1.1(v) - an app that creates accounts must delete them
   in-app). By default the leaderboard ROW SURVIVES, converted back into an ordinary unclaimed
   name row: the counters are the family's shared history and the display name is user-chosen
   and already public, while the actual personal data (Apple's identifier, the sessions) is
   genuinely destroyed. `eraseBoard:true` is the second, smaller option that removes the
   counters too. Apple token revocation needs the .p8 key Blake has not created yet; Apple's own
   guidance explicitly allows completing the deletion without it, so this is compliant from day
   one and the client tells the player they can also remove NASTY under
   Settings > their name > Sign in with Apple. --- */
function deleteAccountRecord(acct, eraseBoard) {
  const uid = acct.uid;
  // 2026-07-31 v0.68 § FREE MONTH TOMBSTONE: written FIRST, before anything is removed, so a
  // crash mid-delete can never lose the anti-abuse record. One per linked identity - deleting
  // an Apple+Google account tombstones BOTH doors back in. If-absent, so the record the
  // account got at creation (the normal case) is never overwritten; this write only matters
  // for accounts that predate the tombstone feature. Twin of server.ts's.
  {
    const through = accountFreeThroughMonth(acct);
    for (const id of accountIdentities(acct)) {
      try { writeFreeMonthTombstoneIfAbsent(id.provider, id.sub, through); }
      catch (e) { log("free-month tombstone write failed on delete", uid, id.provider, e.message); }
    }
  }
  const row = accountBoard[uid];
  let keptOnBoard = false;
  if (row && !eraseBoard && acct.gameName) {
    const bk = boardKeyFor(acct.gameName);
    const r = globalBoard[bk] = globalBoard[bk] || {};
    for (const k of Object.keys(row)) {
      if (!NUMERIC_STAT_KEY.test(k)) continue;
      const v = row[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) { r[k] = (r[k] || 0) + v; keptOnBoard = true; }
    }
    if (!Object.keys(r).length) delete globalBoard[bk];
    rebuildLbNameIndex();
    persistLeaderboardNow();
  }
  delete accountBoard[uid];
  persistAccountStoreNow(STORE_ACCT_BOARD);
  if (acct.nameFolded) delete accountIndex["name:" + acct.nameFolded];
  // Every linked sign-in method goes, not just the first one - a deletion that left Google
  // pointing at a dead uid would strand that person with an account they cannot get into.
  for (const id of accountIdentities(acct)) delete accountIndex[identityIndexKey(id.provider, id.sub)];
  if (acct.email) delete accountIndex[emailIndexKey(acct.email)];
  const killed = revokeAllSessionsFor(uid);
  delete accounts[uid];
  persistAccountStoreNow(STORE_ACCOUNTS);
  persistAccountStoreNow(STORE_ACCT_INDEX);
  // The claim journal is deliberately KEPT, so an already-run claim stays individually
  // reversible even after the account that ran it is gone.
  log("account deleted", uid, "sessions=" + killed, "boardRowKept=" + keptOnBoard);
  return { keptOnBoard };
}

/* =======================================================================================
 * THE ACCOUNT-ONLY LEADERBOARD (Blake's direction, gated OFF by default).
 *
 * Two kinds of row exist on the shared board once this is switched on:
 *
 *   ACCOUNT ROWS - keyed on uid, in their own namespace, displayed under that account's game
 *     name. These are the only rows that ever grow from here on.
 *   FROZEN HISTORICAL ROWS - the ordinary name rows that are already there. They keep being
 *     SERVED, exactly as they read today, so the family's real history from before accounts is
 *     never lost or hidden. They just stop being written to. If an account's game name folds to
 *     the same thing as a historical row, the account row is what shows (that is the shadowing
 *     rule) - so a person who claimed their old name during the migration window does not appear
 *     twice.
 *
 * /leaderboard's body shape does NOT change: it is still the flat {displayName: {stats}} every
 * already-shipped build knows how to render. /leaderboard/v2 is the additive route that also says
 * which rows are frozen, for a client that wants to label them.
 * ===================================================================================== */
function applyAccountLeaderboardEntry(uid, name, delta) {
  const s = sanitizeLeaderboardDelta(name, delta);
  if (!s) return;
  const r = accountBoard[uid] = accountBoard[uid] || {};
  for (const key of Object.keys(s.keys)) r[key] = (r[key] || 0) + s.keys[key];
  scheduleAccountStorePersist(STORE_ACCT_BOARD);
  recordMonthlyResult(s.clean, s.keys);   // 2026-07-28 § MONTHLY RANKING - additive, see that block
}
// The rows the board should show, in one place, used by both /leaderboard and /leaderboard/v2.
// With the switch OFF this returns globalBoard ITSELF (not a copy), so sendLeaderboard()
// serializes byte-for-byte what it always has.
function boardRowsForDisplay() {
  if (!accountsOnlyBoard()) return { flat: globalBoard, detail: null };
  const flat = {};
  const detail = [];
  // Every historical row, indexed by its folded name, so an account that owns that same name can
  // be shown as ONE row rather than colliding with it.
  const frozenByFold = new Map();
  for (const name of Object.keys(globalBoard)) {
    const row = globalBoard[name];
    if (!row || typeof row !== "object") continue;
    frozenByFold.set(leaderboardNameKey(name), { name, row });
  }
  const consumed = new Set();
  for (const uid of Object.keys(accounts)) {
    const a = accounts[uid];
    if (!a || !a.gameName || !a.nameFolded) continue;
    const own = accountBoard[uid] || {};
    // An account that owns a name whose history it has NOT yet claimed still displays that
    // history, so nothing ever appears to vanish between "I picked my name" and "yes, that
    // history is mine". If they explicitly said it was NOT theirs (claimDeclined), the old row
    // is left exactly where it is and is not folded in.
    const frozen = a.claimDeclined ? null : frozenByFold.get(a.nameFolded);
    const shown = {};
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

/* --- § POINTS WALLET (2026-07-28), continued from the SHOP_CATALOG block above.
   accountEarnedPoints() deliberately mirrors boardRowsForDisplay()'s own per-account shadowing
   rule (frozen name-matched row, if any and not declined, PLUS this account's own accountBoard
   row) instead of reading only one of the two - that is the exact sum already being SHOWN on
   /leaderboard for this account's name, so the wallet's idea of "earned" can never disagree with
   what the family board displays, in either state of the NASTY_LEADERBOARD_ACCOUNTS_ONLY switch.
   No epoch scoping anywhere in this feature, by design - see the file-level note below this
   block for why. */
function accountEarnedPoints(acct) {
  let hptsS = 0, hptsT = 0;
  if (acct && acct.nameFolded && !acct.claimDeclined) {
    for (const name of Object.keys(globalBoard)) {
      if (leaderboardNameKey(name) !== acct.nameFolded) continue;
      const r = globalBoard[name];
      if (!r || typeof r !== "object") continue;
      hptsS += Number(r.hptsS) || 0;
      hptsT += Number(r.hptsT) || 0;
    }
  }
  const own = (acct && accountBoard[acct.uid]) || {};
  hptsS += Number(own.hptsS) || 0;
  hptsT += Number(own.hptsT) || 0;
  return hptsS + hptsT;
}
// The wallet a client reads/spends against. Balance is NEVER stored - always earned-minus-spent,
// computed fresh, so it can never drift out of step with the leaderboard or with a hand-edited
// admin correction. Clamped at 0 defensively; in normal operation it can't go negative because
// earned only ever grows (see HANDOFF.md) and every purchase is checked against the balance at
// the moment it is made.
function walletView(acct) {
  const earned = accountEarnedPoints(acct);
  const spent = Math.max(0, Number(acct.walletSpent) || 0);
  // 2026-07-30 § REAL-MONEY CREDIT PACKS: credits bought with money join the spendable balance
  // here and NOWHERE ELSE - accountEarnedPoints() (and therefore the leaderboard) never sees
  // them. Old account records simply read 0, the same Array.isArray/|| 0 convention as every
  // other wallet field.
  const purchased = Math.max(0, Number(acct.walletPurchasedCredits) || 0);
  return {
    uid: acct.uid,
    lifetimeEarned: earned,
    spent,
    purchasedCredits: purchased,
    balance: Math.max(0, earned + purchased - spent),
    owned: Array.isArray(acct.walletOwned) ? acct.walletOwned.slice() : [],
    namechangeCredits: Math.max(0, Number(acct.walletNamechangeCredits) || 0),
  };
}

/* =======================================================================================
 * 2026-07-29 § ONLINE ACCESS - continued from the SHOP_CATALOG block above (ONLINE_ACCESS_COST/
 * ONLINE_ACCESS_ITEM_ID/ONLINE_FREE_EXTRA_MONTHS/ONLINE_ENTITLEMENT_ENFORCED live there).
 *
 * ENTITLEMENT STATE: which calendar months (chicagoMonthKey()-shaped "YYYY-MM" strings) an
 * account may play online. FREE months are DERIVED, never stored - onlineFreeMonths() reads
 * straight off acct.created, so there is nothing to keep in sync and nothing that can drift.
 * PURCHASED months ARE stored, on the account record, in acct.walletOnlineMonths (a plain array
 * of "YYYY-MM" strings, mirroring walletOwned's own storage convention) - defaults to [] and is
 * read with Array.isArray(...) everywhere, so an account record written before this feature
 * existed still parses correctly (same house convention as every other wallet field).
 *
 * THE ACCOUNT-CREATION-DATE QUESTION (this session was told to check, and did): every account
 * record has ALWAYS carried a real `created: Date.now()` timestamp - newAccountRecord() has
 * stamped it on every account since the very first commit that introduced accounts at all
 * (3fb8f18, "Accounts stage 1: Sign in with Apple server plumbing, dormant"), and an account is
 * ONLY EVER constructed by newAccountRecord() (checked directly - every accounts[uid]=... /
 * kv.set(accountKey,...) write in both servers assigns a record built there, never a
 * hand-rolled shape). So there is no "accounts predate this field" problem to solve, no
 * backfill needed, and no special-casing required for Blake's family's accounts - they were
 * created 2026-07-26/2026-07-27 and their real `created` timestamps already say so. This is
 * reported, not assumed: grep the git history yourself
 * (`git log --all -p -- server/server.js | grep 'created: now'`) before ever "fixing" this
 * again. The `|| Date.now()` fallbacks below are pure defensive belt-and-suspenders for a
 * hypothetically malformed record, not a real gap - they resolve to "treated as brand new
 * today" (i.e. free), never a crash.
 *
 * TIMEZONE: month boundaries are America/Chicago, exactly like § MONTHLY RANKING above -
 * chicagoMonthKey() (defined there) is reused verbatim, not reimplemented, per Blake's explicit
 * instruction. nextMonthKey()/chicagoMonthStartMs() below are the only NEW date math this
 * feature needed, and both operate purely on "YYYY-MM" keys or calendar y/m pairs - neither
 * reimplements the Chicago-local "what calendar month is it right now" question, which stays
 * chicagoMonthKey()'s job alone.
 *
 * THE SIGNUP-DAY BOUNDARY CASE, STATED EXPLICITLY: someone who signs up on the LAST calendar day
 * of a month still gets that (nearly-over) month free PLUS the whole next month, because
 * onlineFreeMonths() only ever looks at the CALENDAR MONTH chicagoMonthKey(acct.created)
 * resolves to - the day-of-month is never consulted. This is intended, per Blake, not an
 * oversight to "fix" by prorating.
 * ===================================================================================== */
function nextMonthKey(key) {
  const parts = String(key).split("-");
  const y = Number(parts[0]), m = Number(parts[1]);
  const y2 = m >= 12 ? y + 1 : y;
  const m2 = m >= 12 ? 1 : m + 1;
  return y2 + "-" + String(m2).padStart(2, "0");
}
// The exact UTC instant that reads as local midnight on the 1st of `month` (1-12) in `year`, in
// America/Chicago - used only to compute the precise "access lapses at" timestamp the status
// endpoint reports. Correct across any DST transition: instead of assuming a fixed UTC offset,
// it asks Intl what a guessed UTC instant actually READS AS in Chicago, then corrects the guess
// by the difference - the same "ask real tzdata, don't hand-roll DST" philosophy chicagoMonthKey
// already uses, just inverted (wall time -> UTC instant instead of UTC instant -> wall time).
// Converges in at most 2 passes (the offset is piecewise constant); 3 run defensively.
function chicagoMonthStartMs(year, month) {
  let guess = Date.UTC(year, month - 1, 1, 6, 0, 0); // seed assuming CST (UTC-6)
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const g = {}; for (const p of parts) g[p.type] = p.value;
    const wallMs = Date.UTC(Number(g.year), Number(g.month) - 1, Number(g.day), Number(g.hour), Number(g.minute), Number(g.second));
    const targetMs = Date.UTC(year, month - 1, 1, 0, 0, 0);
    const diff = targetMs - wallMs;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}
// Signup month + ONLINE_FREE_EXTRA_MONTHS following complete calendar months, always in that
// order (soonest first) - e.g. today's default (1 extra month) for a 2026-07-26 signup returns
// ["2026-07","2026-08"].
function onlineFreeMonths(acct) {
  const months = [];
  let m = chicagoMonthKey((acct && acct.created) || Date.now());
  months.push(m);
  for (let i = 0; i < ONLINE_FREE_EXTRA_MONTHS; i++) { m = nextMonthKey(m); months.push(m); }
  // 2026-07-31 v0.68 § FREE MONTH TOMBSTONE: an account that inherited a tombstone at creation
  // has its free window CAPPED at the original account's freeThroughMonth - the "YYYY-MM"
  // string compare is safe because the format is fixed-width and zero-padded. A returning
  // identity still inside its original window keeps the remainder; one past it gets an empty
  // free list. Accounts with no inherited history (cap null) are completely untouched. Twin of
  // server.ts's.
  const cap = acct && typeof acct.onlineFreeThrough === "string" && acct.onlineFreeThrough ? acct.onlineFreeThrough : null;
  return cap ? months.filter((mm) => mm <= cap) : months;
}
// 2026-07-31 v0.68 § FREE MONTH TOMBSTONE: the single answer to "which month does this
// account's free online play run through" - what tombstones are written with, and what the
// status view reports even when the capped free list has gone empty. Twin of server.ts's.
function accountFreeThroughMonth(acct) {
  const free = onlineFreeMonths(acct);
  if (free.length) return free[free.length - 1];
  return String((acct && acct.onlineFreeThrough) || chicagoMonthKey((acct && acct.created) || Date.now()));
}
function onlinePurchasedMonths(acct) {
  return Array.isArray(acct && acct.walletOnlineMonths) ? acct.walletOnlineMonths.slice() : [];
}
function onlineEntitledMonthSet(acct) {
  return new Set(onlineFreeMonths(acct).concat(onlinePurchasedMonths(acct)));
}
function isOnlineEntitledForMonth(acct, monthKey) { return onlineEntitledMonthSet(acct).has(monthKey); }
function onlineEntitledNow(acct) { return isOnlineEntitledForMonth(acct, chicagoMonthKey()); }
// The earliest month, starting at (and possibly equal to) fromMonthKey, this account is NOT
// already entitled to - i.e. exactly which month a purchase right now should grant. Scanning
// forward from the CURRENT month (never from the account's last-purchased month) is what makes
// repeat purchases stack into the future without ever wasting one on a month already covered.
function nextUnentitledOnlineMonth(acct, fromMonthKey) {
  const set = onlineEntitledMonthSet(acct);
  let cursor = fromMonthKey;
  while (set.has(cursor)) cursor = nextMonthKey(cursor);
  return cursor;
}
// What GET-shaped status a client renders a countdown from. See HANDOFF.md for the full shape
// contract; kept here as the single source of truth for both the dedicated status endpoint and
// the extra field folded into a successful /account/purchase response.
function onlineAccessView(acct) {
  const month = chicagoMonthKey();
  const set = onlineEntitledMonthSet(acct);
  const freeMonths = onlineFreeMonths(acct);
  let run = 0, cursor = month;
  while (set.has(cursor)) { run++; cursor = nextMonthKey(cursor); }
  const entitled = run > 0;
  const reason = !entitled ? "none" : (freeMonths.indexOf(month) >= 0 ? "free" : "purchased");
  const [cy, cm] = cursor.split("-").map(Number);
  return {
    uid: acct.uid,
    month,                                              // current Chicago calendar month, "YYYY-MM"
    entitled,                                            // may this account play online RIGHT NOW
    reason,                                              // "free" | "purchased" | "none"
    accessUntil: entitled ? chicagoMonthStartMs(cy, cm) : null,  // exact ms timestamp access lapses, or null if not entitled
    // v0.68: via accountFreeThroughMonth(), not freeMonths[last] - a tombstone-capped account
    // can have an EMPTY free list, and this still truthfully reports the original window's end.
    freeThroughMonth: accountFreeThroughMonth(acct),     // last month key covered by the free period
    monthsAheadCovered: entitled ? run - 1 : 0,          // how many FUTURE months beyond the current one are already banked
    tokenCost: ONLINE_ACCESS_COST,
    itemId: ONLINE_ACCESS_ITEM_ID,
  };
}
/* 2026-07-31 v0.68 (task 4): rewritten. The old line ("Sign in with your NASTY account to play
   online.") had two gaps a brand-new person hits at the worst moment - right after tapping a
   friend's invite link: it never said HOW to sign in (Apple is the only method there is), and it
   never said the reassuring part, that a new account's first month of online play is free, so
   they are not being marched into a paywall. Kept to two short sentences on purpose - this
   renders inside a toast/overlay on a phone. Twin of server.ts's. */
const ONLINE_SIGNIN_MESSAGE = "Playing online just needs a quick Sign in with Apple. New accounts get their first month of online play free.";
function onlineAccessDeniedMessage() {
  // 2026-07-31 v0.68 (task 3): "points" -> "credits". The currency was renamed app-wide in v0.59
  // (Blake: "the word is CREDITS everywhere money-like numbers are shown") but this string - the
  // one a blocked player actually reads - was missed. Leaderboard standing deliberately stays
  // "points"; this is spendable currency, so it is "credits". Twin of server.ts's.
  return "Your free online period has ended. Buy an Online Access token in the Shop (" + ONLINE_ACCESS_COST + " credits) to keep playing online this month.";
}
// The front-door gate - called from the "host" and "join" cases ONLY (never rejoin/reclaim; see
// HANDOFF.md's mid-game-rollover reasoning). Returns null when the connecting player may
// proceed; otherwise a plain object carrying a machine-readable `reason` AND a human sentence,
// both forwarded verbatim to the client via the SAME generic {type:'error'}/{type:'joinError'}
// messages this file already uses for every other host/join rejection - so an OLDER client that
// has never heard of any of this still shows the plain-language `message` exactly like it
// already does for "Too many rooms created from here" or "Pick a nicer name," never a silent
// hang or a cryptic failure.
function onlineAccessGate(accountId) {
  if (!ONLINE_ENTITLEMENT_ENFORCED) return null;
  const acct = accountId ? accounts[accountId] : null;
  if (!acct) return { reason: "signInRequired", message: ONLINE_SIGNIN_MESSAGE };
  if (!onlineEntitledNow(acct)) {
    return {
      reason: "onlineAccessRequired",
      message: onlineAccessDeniedMessage(),
      tokenCost: ONLINE_ACCESS_COST,
      itemId: ONLINE_ACCESS_ITEM_ID,
      onlineAccess: onlineAccessView(acct),
    };
  }
  return null;
}

/* Idempotency for a double-submitted/retried purchase - twin of the existing solo-result
   `soloSeen` gameId dedupe (see "§ SOLO RESULTS" below): a client-supplied `requestId` is
   remembered against the FULL response body it got the first time, so a retry (a double-tap, or
   a client that resent after a dropped reply) gets back the exact same answer instead of being
   charged twice. Ownership itself is also a natural double-spend guard for every NON-consumable
   category (a second buy of an already-owned palette/felt/title is rejected as "alreadyowned"
   regardless of requestId) - `requestId` exists specifically because the namechange credit is
   consumable/stackable, where ownership can't be the guard. */
const PURCHASE_IDS_FILE = process.env.NASTY_PURCHASE_IDS_FILE
  ? path.resolve(process.env.NASTY_PURCHASE_IDS_FILE)
  : path.join(__dirname, "purchase-ids.json");
const PURCHASE_ID_MAX_AGE_MS = 24 * 60 * 60 * 1000;
let purchaseSeen = {};   // "<uid>:<requestId>" -> {status, body, ts}
function loadPurchaseSeen() {
  try {
    const o = JSON.parse(fs.readFileSync(PURCHASE_IDS_FILE, "utf8"));
    if (o && typeof o === "object") purchaseSeen = o;
  } catch (e) { purchaseSeen = {}; }
}
let purchaseSeenTimer = null;
function schedulePurchaseSeenPersist() {
  if (purchaseSeenTimer) return;
  purchaseSeenTimer = setTimeout(() => { purchaseSeenTimer = null; persistPurchaseSeenNow(); }, PERSIST_DEBOUNCE_MS);
}
function persistPurchaseSeenNow() {
  if (purchaseSeenTimer) { clearTimeout(purchaseSeenTimer); purchaseSeenTimer = null; }
  try { fs.writeFileSync(PURCHASE_IDS_FILE, JSON.stringify(purchaseSeen)); }
  catch (e) { log("purchase-ids persist failed", e.message); }
}
function prunePurchaseSeen() {
  const now = Date.now();
  let pruned = false;
  for (const k of Object.keys(purchaseSeen)) {
    if (now - (purchaseSeen[k].ts || 0) > PURCHASE_ID_MAX_AGE_MS) { delete purchaseSeen[k]; pruned = true; }
  }
  if (pruned) schedulePurchaseSeenPersist();
}
function purchaseIdemKey(uid, requestId) { return uid + ":" + requestId; }

/* --- HTTP. Every route is POST with the session token in the JSON body as `auth`, except the
   nonce (a GET that carries nothing). /account/me and /account/name-available are POSTs
   specifically so a session token never lands in a URL, a server log, or a Referer header. --- */
/* --- the three token-based providers. One body of code, three front doors, because the only
   thing that differs between them is which key set and which audience list the token is checked
   against - and the Facebook access-token shape, which is checked WITH Facebook instead of by
   signature. This returns either a verified identity or a ready-made HTTP answer; nothing past
   it ever sees an unverified claim. --- */
const SIGNIN_ROUTES = { "/account/apple": "apple", "/account/google": "google", "/account/facebook": "facebook" };
async function verifyProviderCredential(provider, reqBody) {
  if (!providerConfigured(provider)) return { fail: { status: 503, body: ACCOUNTS_UNAVAILABLE_BODY } };
  // Nonce FIRST, before any crypto, and consumed whether or not it was still valid.
  const nonce = typeof reqBody.nonce === "string" ? reqBody.nonce : "";
  if (!consumeAuthNonce(nonce)) {
    return { fail: { status: 401, body: { error: "badnonce", message: "That sign-in took too long. Please try again." } } };
  }
  let v;
  try {
    if (provider === "facebook" && typeof reqBody.identityToken !== "string" && typeof reqBody.accessToken === "string") {
      // Facebook's classic web login. There is no signature to check, so the token is inspected
      // with Facebook itself. The server nonce above was still consumed, so a captured POST
      // cannot simply be resent - but unlike the OIDC providers the token itself is not
      // cryptographically bound to that nonce. That limit is stated plainly in the design doc
      // rather than papered over.
      v = await inspectFacebookAccessToken(reqBody.accessToken);
    } else {
      v = await verifyOidcToken(OIDC_PROVIDERS[provider], reqBody.identityToken, nonce);
    }
  } catch (e) {
    // The provider's key list (or Facebook's Graph API) was unreachable. Fail closed and tell the
    // client signing in is simply unavailable - never a partial verification.
    log(provider + " verification unavailable", e.message);
    return { fail: { status: 503, body: ACCOUNTS_UNAVAILABLE_BODY } };
  }
  if (!v.ok) {
    log(provider + " sign-in rejected", v.reason);
    return { fail: { status: 401, body: { error: "badtoken", reason: v.reason, message: "That sign-in couldn't be verified. Please try again." } } };
  }
  return { v };
}

const accountRateMap = new Map();
function underAccountRateLimit(ip) {
  const now = Date.now();
  const kept = (accountRateMap.get(ip) || []).filter((t) => now - t < ACCOUNT_RATE_WINDOW_MS);
  if (kept.length >= ACCOUNT_RATE_LIMIT) { accountRateMap.set(ip, kept); return false; }
  kept.push(now);
  accountRateMap.set(ip, kept);
  return true;
}
function accountPublicView(acct, exp) {
  return {
    uid: acct.uid,
    gameName: acct.gameName,
    needsName: !acct.gameName,
    claimDeclined: !!acct.claimDeclined,
    nameChangedAt: acct.nameChangedAt || 0,
    nameHistory: Array.isArray(acct.nameHistory) ? acct.nameHistory : [],
    // Which sign-in methods this one account answers to, so the account screen can show
    // "Apple, Google" and offer to add the missing ones. Provider ids are deliberately NOT
    // included - the client never needs them and the less they travel the better.
    identities: accountIdentities(acct).map((i) => i.provider),
    email: acct.email || null,
    emailPrivateRelay: !!acct.emailPrivateRelay,
    // So the client knows whether to offer the one-time "is this old history yours" step at all.
    claimWindow: claimWindowView(),
    providers: configuredProviders(),
    exp: exp || 0,
  };
}
/* ---------------------------------------------------------------------------------------
 * 2026-07-30 § LIVE RENAME PROPAGATION - Blake's ask, verbatim: nickname changes "take place
 * right away - even mid game". Before this, a successful /account/name rename updated the
 * ACCOUNT (and the renamer's own phone via the response), but a LIVE room never heard about it:
 * player names are copied into room/lobby/engine state at host/join and nothing ever wrote them
 * again, so the other players' boards kept the old name until the game ended. This helper runs
 * on every successful rename and pushes the new name into every live room this account is
 * sitting in - the room's own player record, the lobby seat (if still in the lobby), and the
 * running engine's seat (if the game already started) - then broadcasts an ADDITIVE
 * {type:"playerRenamed", playerId, seat, name} message plus a fresh lobby snapshot when in
 * lobby.
 *
 * OLD-CLIENT SAFETY, verified rather than assumed: index.html's handleNetMessage() ends in
 * `default: return;` (checked in the v0.58 source before this shipped), so every already-shipped
 * build silently ignores the new message type - worst case an old client keeps showing the old
 * name, exactly what happened before this feature existed. The state-integrity digest
 * (gDigestServer() above / the client's gDigest()) deliberately hashes NO names, so a client
 * that misses this message can never be pushed into a false resync by it. PROTOCOL_VERSION is
 * therefore NOT bumped.
 *
 * LEADERBOARD SAFETY: game-end attribution is keyed on accountId (accountIdForSeat(), see
 * finishGame()), never on the seat's display name - so a mid-game rename can never misfile a
 * result; this only changes what everyone SEES. Twin lives in server/cloud/server.ts.
 * ------------------------------------------------------------------------------------- */
function propagateAccountRename(uid, newName) {
  for (const room of rooms.values()) {
    let inLobby = false;
    for (const p of room.players.values()) {
      if (!p.accountId || p.accountId !== uid || p.name === newName) continue;
      p.name = newName;
      // The lobby seat, if this player is still sitting in a lobby.
      if (room.lobby) {
        const seat = room.lobby.seats.find((s) => s.claimedBy === p.id);
        if (seat) { seat.name = newName; inLobby = true; }
      }
      // The running game's seat, if the game already started - this is what the plaques on
      // every other phone render from (via snapshots), so it must move too or a reconnect
      // would resurrect the old name.
      let seatIndex = -1;
      if (room.started && room.engine && Array.isArray(room.seatOwners)) {
        seatIndex = room.seatOwners.indexOf(p.id);
        if (seatIndex >= 0) {
          const G = room.engine.getG();
          if (G && Array.isArray(G.seats) && G.seats[seatIndex]) G.seats[seatIndex].name = newName;
        }
      }
      broadcast(room, { type: "playerRenamed", playerId: p.id, seat: seatIndex >= 0 ? seatIndex : null, name: newName });
      touch(room);   // also schedules the room's disk persist, so a restart keeps the new name
      log("account rename propagated to live room", room.code, "player=" + p.id, "->", newName);
    }
    if (inLobby) broadcast(room, { type: "lobby", lobby: lobbySnapshot(room) });
  }
}

async function handleAccountRoute(req, res, url) {
  if (!underAccountRateLimit(remoteIp(req))) {
    sendJson(res, 429, { error: "slow down", message: "Too many sign-in tries. Wait a minute and try again." });
    return;
  }
  if (!accountsConfigured()) { sendJson(res, 503, ACCOUNTS_UNAVAILABLE_BODY); return; }
  const p = url.pathname;
  if (p === "/account/nonce") {
    if (req.method !== "GET") { sendJson(res, 405, { error: "method not allowed" }); return; }
    sendJson(res, 200, { nonce: issueAuthNonce() });
    return;
  }
  if (req.method !== "POST") { sendJson(res, 405, { error: "method not allowed" }); return; }
  const body = await readJsonBody(req);

  if (SIGNIN_ROUTES[p]) {
    const provider = SIGNIN_ROUTES[p];
    const r = await verifyProviderCredential(provider, body);
    if (r.fail) { sendJson(res, r.fail.status, r.fail.body); return; }
    const resolved = resolveAccountForIdentity(provider, r.v);
    const s = issueSession(resolved.account.uid);
    // 2026-07-31 v0.68 § FREE MONTH TOMBSTONE: told at creation, exactly as Blake chose ("A
    // clear line when the new account is created... No surprise later when they try to join a
    // game"). Additive fields - an older client simply ignores them. Twin of server.ts's.
    const usedExtra = resolved.created && resolved.freeMonthAlreadyUsed
      ? { freeMonthUsed: true, freeMonthNotice: FREE_MONTH_USED_NOTICE } : {};
    sendJson(res, 200, Object.assign(
      { sessionToken: s.token, provider, linkedToExisting: resolved.linked },
      usedExtra,
      accountPublicView(resolved.account, s.exp),
    ));
    return;
  }

  /* --- adding a SECOND sign-in method to the account you are already signed in to. This is the
     escape hatch for the one case email matching genuinely cannot solve: Apple's "Hide My Email"
     gives a per-app relay address that will never equal the same person's real Gmail, so their
     Apple and Google sign-ins can only ever be joined up by the person themselves saying "these
     are both me" while signed in. --- */
  if (p === "/account/link") {
    const me = resolveSession(body.auth);
    if (!me) { sendJson(res, 401, SIGNED_OUT_BODY); return; }
    const provider = String(body.provider || "");
    if (!SIGNIN_ROUTES["/account/" + provider]) { sendJson(res, 400, { error: "badprovider", message: "That sign-in method isn't one we use." }); return; }
    const r = await verifyProviderCredential(provider, body);
    if (r.fail) { sendJson(res, r.fail.status, r.fail.body); return; }
    const owner = accountForIdentity(provider, r.v.sub);
    if (owner && owner.uid !== me.uid) {
      sendJson(res, 409, { error: "linkedelsewhere", message: "That sign-in is already attached to a different NASTY account. Sign in with it instead, or remove it there first." });
      return;
    }
    attachIdentity(me.account, provider, r.v.sub);
    rememberAccountEmail(me.account, provider, r.v);
    sendJson(res, 200, Object.assign({ ok: true, provider }, accountPublicView(me.account, me.exp)));
    return;
  }

  if (p === "/account/unlink") {
    const me = resolveSession(body.auth);
    if (!me) { sendJson(res, 401, SIGNED_OUT_BODY); return; }
    const provider = String(body.provider || "");
    const list = accountIdentities(me.account);
    const keep = list.filter((i) => i.provider !== provider);
    if (keep.length === list.length) { sendJson(res, 404, { error: "notlinked", message: "That sign-in isn't attached to this account." }); return; }
    // Never remove the last one. An account with no way in is not a smaller account, it is a
    // lost one - and the family's leaderboard history is attached to it.
    if (!keep.length) { sendJson(res, 409, { error: "lastidentity", message: "That's the only way into this account, so it has to stay. Add another sign-in first." }); return; }
    for (const i of list) { if (i.provider === provider) delete accountIndex[identityIndexKey(i.provider, i.sub)]; }
    me.account.identities = keep;
    if (me.account.provider === provider) { me.account.provider = keep[0].provider; me.account.sub = keep[0].sub; }
    if (me.account.emailSource === provider && me.account.email) {
      delete accountIndex[emailIndexKey(me.account.email)];
      me.account.email = null; me.account.emailSource = null; me.account.emailPrivateRelay = false;
    }
    scheduleAccountStorePersist(STORE_ACCOUNTS);
    scheduleAccountStorePersist(STORE_ACCT_INDEX);
    sendJson(res, 200, Object.assign({ ok: true }, accountPublicView(me.account, me.exp)));
    return;
  }

  /* --- the passwordless email code, in two halves. No password is ever accepted, stored or
     asked for; the code is stored only as a hash, expires in ten minutes, and dies after five
     wrong guesses. --- */
  if (p === "/account/email/start") {
    if (!providerConfigured("email")) { sendJson(res, 503, ACCOUNTS_UNAVAILABLE_BODY); return; }
    const email = foldEmail(body.email);
    if (!isPlausibleEmail(email)) { sendJson(res, 400, { error: "bademail", message: "That doesn't look like an email address. Check it and try again." }); return; }
    pruneEmailCodes();
    const now = Date.now();
    const prev = emailCodes[email] || null;
    if (prev && prev.sentAt && now - prev.sentAt < EMAIL_CODE_RESEND_MS) {
      const waitS = Math.max(1, Math.ceil((EMAIL_CODE_RESEND_MS - (now - prev.sentAt)) / 1000));
      sendJson(res, 429, { error: "toosoon", waitSeconds: waitS, message: "We just sent one. Check your email, or try again in " + waitS + " seconds." });
      return;
    }
    const dayStart = prev && prev.dayStart && now - prev.dayStart < 24 * 60 * 60 * 1000 ? prev.dayStart : now;
    const sentToday = (dayStart === (prev && prev.dayStart) ? (prev.sentToday || 0) : 0) + 1;
    if (sentToday > EMAIL_CODE_MAX_PER_DAY) {
      sendJson(res, 429, { error: "toomany", message: "That's a lot of codes for one day. Try again tomorrow, or sign in with Apple, Google or Facebook." });
      return;
    }
    const code = newEmailCode();
    const sent = await sendAccountEmail(email, code);
    if (!sent.ok) {
      // Nothing is stored when nothing was sent, so a mail outage leaves no half-open challenge.
      sendJson(res, 503, { error: "emailunavailable", message: "We couldn't send that code right now. Try again in a minute, or sign in with Apple, Google or Facebook." });
      return;
    }
    emailCodes[email] = { hash: hashEmailCode(email, code), exp: now + EMAIL_CODE_TTL_MS, attempts: 0, sentAt: now, sentToday, dayStart };
    persistAccountStoreNow(STORE_EMAIL_CODES);
    sendJson(res, 200, { ok: true, sent: true, expiresInSeconds: Math.round(EMAIL_CODE_TTL_MS / 1000) });
    return;
  }

  if (p === "/account/email/verify") {
    if (!providerConfigured("email")) { sendJson(res, 503, ACCOUNTS_UNAVAILABLE_BODY); return; }
    const email = foldEmail(body.email);
    const code = String(body.code || "").trim();
    pruneEmailCodes();
    const ch = emailCodes[email];
    const badCode = { error: "badcode", message: "That code didn't match. Check it, or ask for a new one." };
    if (!isPlausibleEmail(email) || !ch || !(ch.exp > Date.now())) { sendJson(res, 401, badCode); return; }
    if ((ch.attempts || 0) >= EMAIL_CODE_MAX_ATTEMPTS) {
      burnEmailChallenge(email, ch);
      sendJson(res, 429, { error: "toomanytries", message: "Too many wrong tries. Ask for a new code." });
      return;
    }
    ch.attempts = (ch.attempts || 0) + 1;
    persistAccountStoreNow(STORE_EMAIL_CODES);
    if (!/^[0-9]{6}$/.test(code) || !timingSafeHexEqual(ch.hash, hashEmailCode(email, code))) { sendJson(res, 401, badCode); return; }
    burnEmailChallenge(email, ch);                    // single use, exactly like the sign-in nonce
    // The email method's "sub" IS the verified address, and it is verified by construction here,
    // so it is also the strongest possible linking key.
    const resolved = resolveAccountForIdentity("email", { sub: email, email, emailVerified: true, privateRelay: false });
    const s = issueSession(resolved.account.uid);
    // 2026-07-31 v0.68 § FREE MONTH TOMBSTONE: same additive creation-time notice as the token
    // sign-in routes above - the email door must not be the one that forgets to mention it.
    const usedExtra = resolved.created && resolved.freeMonthAlreadyUsed
      ? { freeMonthUsed: true, freeMonthNotice: FREE_MONTH_USED_NOTICE } : {};
    sendJson(res, 200, Object.assign(
      { sessionToken: s.token, provider: "email", linkedToExisting: resolved.linked },
      usedExtra,
      accountPublicView(resolved.account, s.exp),
    ));
    return;
  }

  if (p === "/account/me") {
    const me = resolveSession(body.auth);
    if (!me) { sendJson(res, 401, SIGNED_OUT_BODY); return; }
    sendJson(res, 200, accountPublicView(me.account, me.exp));
    return;
  }

  /* --- 2026-07-28 § POINTS WALLET. Same auth convention as every other /account/* route: the
     session token rides in the JSON body as `auth`, and a guest (no session, or an expired one)
     gets the same clean 401 SIGNED_OUT_BODY every other account route already answers with -
     never a crash, never a 500. A guest has no wallet; it is not an error, just nothing to show. */
  if (p === "/account/wallet") {
    const me = resolveSession(body.auth);
    if (!me) { sendJson(res, 401, SIGNED_OUT_BODY); return; }
    sendJson(res, 200, walletView(me.account));
    return;
  }

  // 2026-07-29 § ONLINE ACCESS - what the client renders a countdown from. Same auth convention
  // as /account/wallet; a guest has no online-access state, same clean 401.
  if (p === "/account/online-status") {
    const me = resolveSession(body.auth);
    if (!me) { sendJson(res, 401, SIGNED_OUT_BODY); return; }
    sendJson(res, 200, onlineAccessView(me.account));
    return;
  }

  if (p === "/account/purchase") {
    const me = resolveSession(body.auth);
    if (!me) { sendJson(res, 401, SIGNED_OUT_BODY); return; }
    const acct = me.account;
    const itemId = typeof body.itemId === "string" ? body.itemId : "";
    const requestId = typeof body.requestId === "string" && body.requestId ? body.requestId.slice(0, 128) : null;
    // Idempotency: a retried/double-submitted purchase carrying the SAME requestId gets back the
    // exact same answer it got the first time, without being charged again. See the block comment
    // above PURCHASE_IDS_FILE for why this exists alongside (not instead of) the ownership check.
    if (requestId) {
      prunePurchaseSeen();
      const seen = purchaseSeen[purchaseIdemKey(acct.uid, requestId)];
      if (seen) { sendJson(res, seen.status, Object.assign({}, seen.body, { duplicate: true })); return; }
    }
    const item = shopItemById(itemId);
    if (!item) { sendJson(res, 404, { error: "noitem", message: "That item doesn't exist." }); return; }
    const owned = Array.isArray(acct.walletOwned) ? acct.walletOwned : (acct.walletOwned = []);
    if (!item.consumable && owned.includes(item.id)) {
      const failBody = { error: "alreadyowned", message: "You already own that.", wallet: walletView(acct) };
      if (requestId) { purchaseSeen[purchaseIdemKey(acct.uid, requestId)] = { status: 409, body: failBody, ts: Date.now() }; schedulePurchaseSeenPersist(); }
      sendJson(res, 409, failBody);
      return;
    }
    const earned = accountEarnedPoints(acct);
    const spentSoFar = Math.max(0, Number(acct.walletSpent) || 0);
    // 2026-07-30 § REAL-MONEY CREDIT PACKS: bought credits are spendable through this exact
    // path - same formula as walletView(), deliberately not a second opinion.
    const purchased = Math.max(0, Number(acct.walletPurchasedCredits) || 0);
    const balance = Math.max(0, earned + purchased - spentSoFar);
    if (balance < item.cost) {
      // 2026-07-31 v0.68 (task 3): "points" -> "credits", the v0.59 rename this string missed.
      const failBody = { error: "cantafford", message: "Not enough credits for that yet.", cost: item.cost, balance, wallet: walletView(acct) };
      if (requestId) { purchaseSeen[purchaseIdemKey(acct.uid, requestId)] = { status: 409, body: failBody, ts: Date.now() }; schedulePurchaseSeenPersist(); }
      sendJson(res, 409, failBody);
      return;
    }
    // The whole check-then-mutate above is synchronous, single JS-thread, no `await` anywhere in
    // it - so two "simultaneous" purchases for the same account can never interleave here; Node
    // processes them one after the other, and the second one sees the first one's result.
    acct.walletSpent = spentSoFar + item.cost;
    // 2026-07-29 § ONLINE ACCESS: a distinct third branch, same shape as the namechange credit's
    // (consumable, stacks) but grants a MONTH rather than incrementing a flat counter - computed
    // BEFORE the mutation below touches walletOnlineMonths, from the pre-purchase entitlement set,
    // so it always lands on the earliest month not already covered (free or previously purchased).
    if (item.id === ONLINE_ACCESS_ITEM_ID) {
      if (!Array.isArray(acct.walletOnlineMonths)) acct.walletOnlineMonths = [];
      const grantMonth = nextUnentitledOnlineMonth(acct, chicagoMonthKey());
      acct.walletOnlineMonths.push(grantMonth);
      acct.walletOnlineMonths.sort();
    } else if (item.consumable) {
      acct.walletNamechangeCredits = Math.max(0, Number(acct.walletNamechangeCredits) || 0) + 1;
    } else {
      owned.push(item.id);
    }
    scheduleAccountStorePersist(STORE_ACCOUNTS);
    const okBody = {
      ok: true, purchased: item.id, wallet: walletView(acct),
      // Additive - lets the client refresh its online-access countdown after a purchase without
      // a second round trip. Ignored by any client that doesn't know about it.
      onlineAccess: onlineAccessView(acct),
    };
    if (requestId) { purchaseSeen[purchaseIdemKey(acct.uid, requestId)] = { status: 200, body: okBody, ts: Date.now() }; schedulePurchaseSeenPersist(); }
    sendJson(res, 200, okBody);
    return;
  }

  /* --- 2026-07-30 § REAL-MONEY CREDIT PACKS - the verification endpoint. The iPhone app buys a
     consumable credit pack through Apple (StoreKit 2), then POSTs the SIGNED TRANSACTION (the
     jwsRepresentation) here. Everything of consequence is decided from the verified payload -
     the client's word is never taken for what was bought, for how much, or for whom Apple
     thinks paid. Success is idempotent on the Apple transaction id: resubmitting an
     already-credited transaction answers 200 alreadyProcessed:true (with the current wallet) so
     the app can safely finish() a transaction whose first submission's reply got lost - the ONE
     wrong answer there would be an error, because the app would then never finish the
     transaction and would resubmit it forever.
     REPLAY SAFETY: see the § REPLAY LEDGER block above for the whole design (sync check-to-write
     on this single-threaded server, ledger-before-account crash ordering, never-pruned keys). */
  if (p === "/account/iap/verify") {
    if (!IAP_ENABLED) { sendJson(res, 503, { error: "iapoff", message: "Buying credits isn't available right now." }); return; }
    const me = resolveSession(body.auth);
    if (!me) { sendJson(res, 401, SIGNED_OUT_BODY); return; }
    const acct = me.account;
    const v = verifyAppleSignedJws(body.jws);
    if (!v.ok) {
      log("iap verify rejected", v.reason);
      sendJson(res, 400, { error: v.reason, message: "That purchase couldn't be verified with Apple." });
      return;
    }
    const t = v.payload;
    // Every claim below comes out of the VERIFIED payload. bundleId first: a validly-signed
    // transaction for someone else's app must be worthless here.
    if (t.bundleId !== IAP_BUNDLE_ID) { sendJson(res, 400, { error: "wrongapp", message: "That purchase belongs to a different app." }); return; }
    const environment = t.environment === "Production" ? "Production" : (t.environment === "Sandbox" ? "Sandbox" : null);
    if (!environment || !iapEnvironmentAllowed(environment)) { sendJson(res, 400, { error: "badenv", message: "That purchase couldn't be verified with Apple." }); return; }
    const pack = creditPackByProductId(t.productId);
    // Unknown product id = validly signed but not a credit pack (or a product this server has
    // never heard of). Refused outright - crediting ANYTHING from an unrecognized product would
    // let a future non-credit product mint credits.
    if (!pack) { sendJson(res, 400, { error: "unknownproduct", message: "That product isn't a credit pack.", productId: String(t.productId || "") }); return; }
    // A transaction Apple has already revoked/refunded must never credit, even on first sight.
    if (t.revocationDate || t.revocationReason !== undefined) { sendJson(res, 400, { error: "revoked", message: "Apple shows that purchase was refunded." }); return; }
    const transactionId = String(t.transactionId || "");
    if (!transactionId) { sendJson(res, 400, { error: "badpayload", message: "That purchase couldn't be verified with Apple." }); return; }
    // StoreKit lets a purchase carry quantity > 1; this client never sends one, but if Apple
    // says the player paid for N packs, crediting 1 would underpay them. Bounded defensively.
    const quantity = Math.min(10, Math.max(1, Number(t.quantity) || 1));
    const credits = pack.credits * quantity;
    const key = iapLedgerKey(environment, transactionId);
    // ---- replay guard. NOTHING between this lookup and the ledger write below may await. ----
    const seen = iapLedger[key];
    if (seen) {
      if (seen.uid === acct.uid) {
        // The idempotent-success case described above - same account, already credited.
        sendJson(res, 200, { ok: true, alreadyProcessed: true, creditsAdded: 0, transactionId, productId: pack.productId, wallet: walletView(acct) });
      } else {
        // Someone replaying another account's receipt (or one device signed into two accounts).
        // Refused - the credits stay where they landed first.
        sendJson(res, 409, { error: "alreadyused", message: "That purchase was already applied to a different account." });
      }
      return;
    }
    iapLedger[key] = { uid: acct.uid, productId: pack.productId, credits, environment, purchaseDate: Number(t.purchaseDate) || 0, ts: Date.now() };
    persistIapLedgerNow();   // ledger FIRST - see the crash-ordering note on the § REPLAY LEDGER block
    acct.walletPurchasedCredits = Math.max(0, Number(acct.walletPurchasedCredits) || 0) + credits;
    persistAccountStoreNow(STORE_ACCOUNTS);   // money moved - never the debounced persist
    log("iap credited", acct.uid, pack.productId, "credits=" + credits, environment, "txn=" + transactionId);
    sendJson(res, 200, { ok: true, creditsAdded: credits, transactionId, productId: pack.productId, wallet: walletView(acct) });
    return;
  }

  if (p === "/account/name-available") {
    const clean = cleanName(body.name, "");
    if (!clean) { sendJson(res, 200, { available: false, reason: "empty", message: "Type a name first." }); return; }
    if (isBadName(clean)) { sendJson(res, 200, { available: false, reason: "blocked", message: "That name is blocked. Please pick another one." }); return; }
    const folded = leaderboardNameKey(clean);
    const owner = accountOwningFoldedName(folded);
    const me = resolveSession(body.auth);
    if (owner && (!me || owner !== me.uid)) {
      sendJson(res, 200, { available: false, reason: "taken", message: "Somebody already has that name. Please pick another one." });
      return;
    }
    sendJson(res, 200, { available: true, name: clean });
    return;
  }

  if (p === "/account/name") {
    const me = resolveSession(body.auth);
    if (!me) { sendJson(res, 401, SIGNED_OUT_BODY); return; }
    const acct = me.account;
    const clean = cleanName(body.name, "");
    if (!clean) { sendJson(res, 400, { error: "empty", message: "Pick a name first." }); return; }
    if (isBadName(clean)) { sendJson(res, 400, { error: "blocked", message: "That name is blocked. Please pick another one." }); return; }
    const folded = leaderboardNameKey(clean);
    const owner = accountOwningFoldedName(folded);
    if (owner && owner !== acct.uid) {
      // First claim wins. There is no softer rule that actually stops squatting.
      sendJson(res, 409, { error: "taken", message: "Somebody already has that name. Please pick another one." });
      return;
    }
    const now = Date.now();
    // 2026-07-28 § POINTS WALLET: whether THIS call spent a purchased namechange credit to bypass
    // the cooldown below. Surfaced on the success response so the client can show "credit used"
    // and refresh its own wallet display; false on every path that isn't the cooldown-bypass one.
    let usedNamechangeCredit = false;
    if (acct.nameFolded === folded) {
      // Same name, possibly a different capitalization. Idempotent and always free - the fold is
      // what identity is enforced on, so this is a label edit, not a rename.
      // 2026-07-30 § LIVE RENAME PROPAGATION: even a capitalization edit is a visible change on
      // everyone else's board, so it propagates too.
      if (acct.gameName !== clean) {
        acct.gameName = clean;
        scheduleAccountStorePersist(STORE_ACCOUNTS);
        try { propagateAccountRename(acct.uid, clean); } catch (e) { log("rename propagation failed", e.message); }
      }
    } else if (!acct.nameFolded) {
      acct.gameName = clean;
      acct.nameFolded = folded;
      acct.nameChangedAt = 0;   // the FIRST rename after this is free; a day-one typo is not a 30-day sentence
      accountIndex["name:" + folded] = acct.uid;
      scheduleAccountStorePersist(STORE_ACCOUNTS);
      scheduleAccountStorePersist(STORE_ACCT_INDEX);
    } else {
      // A real rename. Allowed, with a 30-day cooldown: the leaderboard is a social object, and
      // a name that changes hourly makes the board unreadable and lets somebody cycle through
      // and squat names. History is NOT touched - the account row is keyed on uid, so this
      // rewrites one string and nothing else.
      // 2026-07-28 § POINTS WALLET: a purchased namechange credit bypasses the cooldown ONCE,
      // consuming it - but only when the client explicitly asks (`useNamechangeCredit:true`), so
      // a credit is never silently spent on an ordinary rename that would have gone through (or
      // failed) anyway. Same cooldown-reset behavior as a normal rename below - it is still a real
      // rename, just one that skipped the wait.
      if (acct.nameChangedAt && now - acct.nameChangedAt < NAME_COOLDOWN_MS) {
        const credits = Math.max(0, Number(acct.walletNamechangeCredits) || 0);
        if (body.useNamechangeCredit === true && credits > 0) {
          acct.walletNamechangeCredits = credits - 1;
          usedNamechangeCredit = true;
          scheduleAccountStorePersist(STORE_ACCOUNTS);
        } else {
          const daysLeft = Math.max(1, Math.ceil((NAME_COOLDOWN_MS - (now - acct.nameChangedAt)) / (24 * 60 * 60 * 1000)));
          sendJson(res, 429, { error: "cooldown", daysLeft, message: "You can change your name again in " + daysLeft + (daysLeft === 1 ? " day." : " days."), namechangeCredits: credits });
          return;
        }
      }
      delete accountIndex["name:" + acct.nameFolded];   // the old folded name goes back in the pool
      if (!Array.isArray(acct.nameHistory)) acct.nameHistory = [];
      acct.nameHistory.push({ name: acct.gameName, from: acct.nameChangedAt || acct.created, to: now });
      if (acct.nameHistory.length > 20) acct.nameHistory = acct.nameHistory.slice(-20);
      acct.gameName = clean;
      acct.nameFolded = folded;
      acct.nameChangedAt = now;
      accountIndex["name:" + folded] = acct.uid;
      scheduleAccountStorePersist(STORE_ACCOUNTS);
      scheduleAccountStorePersist(STORE_ACCT_INDEX);
      // 2026-07-30 § LIVE RENAME PROPAGATION (Blake: renames "take place right away - even mid
      // game") - see propagateAccountRename()'s own header comment right above this route.
      try { propagateAccountRename(acct.uid, clean); } catch (e) { log("rename propagation failed", e.message); }
    }
    // Is there existing history sitting on the board under this name? Report it; do NOT move
    // anything. An automatic merge on a name match would silently hand one relative another
    // relative's record - the confirm is the whole point.
    // Is there existing history sitting on the board under this name? Report it ONLY while the
    // one-time migration window is open; once it has sunset there is nothing to offer, so the
    // client never shows the "is this you" step again.
    let pendingClaim = null;
    const j = claimJournal[acct.uid];
    if (claimWindowOpen() && !acct.claimDeclined && (!j || j.state !== "done")) {
      const rows = unclaimedRowsForFolded(folded);
      if (Object.keys(rows).length) pendingClaim = claimSummary(rows);
    }
    sendJson(res, 200, {
      gameName: acct.gameName, pendingClaim, claimWindow: claimWindowView(),
      usedNamechangeCredit, namechangeCredits: Math.max(0, Number(acct.walletNamechangeCredits) || 0),
    });
    return;
  }

  if (p === "/account/claim") {
    const me = resolveSession(body.auth);
    if (!me) { sendJson(res, 401, SIGNED_OUT_BODY); return; }
    const acct = me.account;
    if (!acct.gameName) { sendJson(res, 400, { error: "noname", message: "Pick your game name first." }); return; }
    // THE SUNSET. After the one-time window, this path is gone. A journal already marked "done"
    // is still allowed through so a retry of an already-completed claim answers the same way it
    // did the first time instead of erroring - it moves nothing either way.
    if (!claimWindowOpen() && !(claimJournal[acct.uid] && claimJournal[acct.uid].state === "done")) {
      sendJson(res, 410, Object.assign({ claimWindow: claimWindowView() }, CLAIM_CLOSED_BODY));
      return;
    }
    if (body.decline === true) {
      acct.claimDeclined = true;
      scheduleAccountStorePersist(STORE_ACCOUNTS);
      sendJson(res, 200, { ok: true, declined: true });
      return;
    }
    try {
      const r = runAccountClaim(acct);
      sendJson(res, 200, { ok: true, alreadyDone: !!r.alreadyDone, moved: r.moved });
    } catch (e) {
      log("account claim failed", acct.uid, e.message);
      sendJson(res, 500, { error: "server error" });
    }
    return;
  }

  if (p === "/account/signout") {
    // Deletes the server session and nothing else. A signed-out player is exactly a guest: their
    // saved games, their device stats cache and every per-room rejoin credential are untouched.
    revokeSession(typeof body.auth === "string" ? body.auth : "");
    sendJson(res, 200, { ok: true });
    return;
  }

  if (p === "/account/delete") {
    const me = resolveSession(body.auth);
    if (!me) { sendJson(res, 401, SIGNED_OUT_BODY); return; }
    const r = deleteAccountRecord(me.account, body.eraseBoard === true);
    sendJson(res, 200, {
      ok: true,
      appleRevoked: false,   // needs the .p8 key Blake has not created yet - see the block comment
      keptOnBoard: r.keptOnBoard,
      message: "Your account is deleted. You can also remove NASTY under Settings, your name, Sign in with Apple.",
    });
    return;
  }

  sendJson(res, 404, { error: "no such account route" });
}

/* ---------------------------------------------------------------------------------------
 * v0.8: on-disk persistence. v0.15 adds the authoritative `G` snapshot + `tableSpeed` +
 * `recorded` (leaderboard idempotency flag) + `nextSeq` alongside the existing fields. The
 * action `log` is now just a short, capped tail (see LOG_TAIL_MAX) — reconnects hand back a
 * full `G` snapshot instead of replaying history, so the log no longer needs to hold a whole
 * game's worth of actions; it's kept short purely for live-debugging visibility, not replay.
 * ------------------------------------------------------------------------------------- */
try { fs.mkdirSync(ROOMS_DIR, { recursive: true }); } catch (e) { log("could not create rooms dir", e.message); }

const LOG_TAIL_MAX = 40;

function roomFile(code) { return path.join(ROOMS_DIR, code + ".json"); }
function roomToDisk(room) {
  return {
    code: room.code, createdAt: room.createdAt, lastActivity: room.lastActivity,
    hostPlayerId: room.hostPlayerId, nextPlayerId: room.nextPlayerId,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id, token: p.token, name: p.name, isHost: p.isHost, leftForGood: !!p.leftForGood,
      // v0.16 item 5: a registered APNs device token, tied to this player identity (the same
      // one rejoin tokens/reclaim-by-name already key off) - persisted so a server restart
      // doesn't lose it. See "registerPush" below.
      pushToken: p.pushToken || null, pushPlatform: p.pushPlatform || null,
      // 2026-07-25 § ACCOUNTS: persisted for the same reason the rejoin token is - a server
      // restart mid-game must not turn a signed-in player back into a guest and lose their
      // result. Null for every guest and for every client that has ever shipped.
      accountId: p.accountId || null,
    })),
    lobby: room.lobby, started: room.started, seatOwners: room.seatOwners, log: room.log,
    // v0.25 item 1: lobby-phase readiness (replaces the v0.16 post-Start readyCheck phase).
    // Sets aren't JSON-serializable directly - flatten to an array.
    readyPlayerIds: Array.from(room.ready || []),
    paused: !!room.paused,
    G: room.engine ? room.engine.getG() : null, tableSpeed: room.tableSpeed || 1,
    recorded: !!room.recorded, nextSeq: room.nextSeq || 0,
    // v0.27.1: sticky per-game-instance flag, see § SURRENDER's leaveSeatForGoodInternal()
    // comment below - persisted alongside `recorded` so a server restart mid-game doesn't lose
    // whether a no-fault exit is already in effect.
    anySurrenderOccurred: !!room.anySurrenderOccurred,
    // 2026-07-23 (item 2) § REUNION READY GATE - persisted (unlike `willSeat`/`seatGate`/`away`
    // above) on purpose: those are all fine to lose on a restart (worst case, a slightly less
    // polite first deal or a restarted away-ladder clock), but losing an OPEN reunion gate mid
    // ready-up would strand the table paused with no way to auto-resume and any already-tapped
    // "Ready up" taps silently forgotten - a real regression, not a harmless degrade. Persisting
    // it means a restart mid-reunion comes back exactly as it was.
    reunionActive: !!room.reunionActive, tableReadyIds: Array.from(room.tableReady || []),
    // 2026-07-25 (bug 2): the gate's own clock, persisted for the same reason the rest of the
    // gate is - REUNION_GATE_CAP_MS is enforced from this timestamp, and a restart that lost it
    // would leave exactly the stuck table the cap exists to rescue.
    reunionOpenedAt: room.reunionOpenedAt || 0,
  };
}
function roomFromDisk(obj) {
  const room = {
    code: obj.code, createdAt: obj.createdAt || Date.now(), lastActivity: obj.lastActivity || Date.now(),
    hostPlayerId: obj.hostPlayerId, nextPlayerId: obj.nextPlayerId || 1,
    players: new Map(), lobby: obj.lobby || null, started: !!obj.started,
    seatOwners: obj.seatOwners || null, log: Array.isArray(obj.log) ? obj.log : [],
    ready: new Set(obj.readyPlayerIds || []),   // v0.25 item 1: lobby-phase readiness
    paused: !!obj.paused, engine: null, tableSpeed: obj.tableSpeed || 1,
    recorded: !!obj.recorded, nextSeq: obj.nextSeq || 0,
    anySurrenderOccurred: !!obj.anySurrenderOccurred,   // v0.27.1
    away: null,   // v0.22: transient - a restart just restarts the ladder clock
    willSeat: new Set(), seatGate: null,   // v0.22 P0b: transient - see loadRoomsFromDisk's boot re-drive
    // 2026-07-23 (item 2): PERSISTED (see roomToDisk's matching comment) - restored exactly as
    // it was, not reset.
    reunionActive: !!obj.reunionActive, tableReady: new Set(obj.tableReadyIds || []),
    // 2026-07-25 (bug 2): a room persisted before this field existed simply has no timestamp -
    // sweepReunionGates() starts its clock on the first sweep instead of expiring it instantly.
    reunionOpenedAt: Number(obj.reunionOpenedAt) || 0,
  };
  for (const p of (obj.players || []))
    room.players.set(p.id, {
      id: p.id, token: p.token, name: p.name, ws: null, connected: false, isHost: !!p.isHost, leftForGood: !!p.leftForGood,
      pushToken: p.pushToken || null, pushPlatform: p.pushPlatform || null,
      accountId: p.accountId || null,
    });
  if (obj.G) {
    try {
      const engine = createEngine();
      engine.setLAY(engine.buildLayout(obj.G.n));
      engine.setG(obj.G);
      room.engine = engine;
    } catch (e) { log("failed to restore engine state for room", obj.code, e.message); }
  }
  return room;
}
const persistTimers = new Map();
function schedulePersist(room) {
  if (persistTimers.has(room.code)) return;
  persistTimers.set(room.code, setTimeout(() => {
    persistTimers.delete(room.code);
    if (rooms.get(room.code) !== room) return;
    persistRoomNow(room);
  }, PERSIST_DEBOUNCE_MS));
}
function persistRoomNow(room) {
  try { fs.writeFileSync(roomFile(room.code), JSON.stringify(roomToDisk(room))); }
  catch (e) { log("persist failed", room.code, e.message); }
}
function deleteRoomFile(code) {
  const t = persistTimers.get(code);
  if (t) { clearTimeout(t); persistTimers.delete(code); }
  try { fs.unlinkSync(roomFile(code)); } catch (e) { /* already gone, fine */ }
}
function loadRoomsFromDisk() {
  let files = [];
  try { files = fs.readdirSync(ROOMS_DIR); } catch (e) { return; }
  let n = 0;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(ROOMS_DIR, f), "utf8"));
      if (!obj || !obj.code) continue;
      rooms.set(obj.code, roomFromDisk(obj));
      n++;
    } catch (e) { log("failed to load room file", f, e.message); }
  }
  if (n) log(`loaded ${n} room(s) from disk (${ROOMS_DIR})`);
  // v0.22 P0b: a restart can catch a room mid-CPU-run, or lose a transient seat gate that was
  // holding the first deal - re-drive every live room once at boot. driveTurnLoop() is
  // idempotent: it advances whatever the server itself owes (CPU turns, a pending deal) and
  // stops at the current human turn; for a room already waiting on a human it's a no-op.
  for (const room of rooms.values()) {
    if (room.started && room.engine && !room.paused) {
      const G = room.engine.getG();
      if (G && !G.over) {
        try { driveTurnLoop(room); } catch (e) { log("boot re-drive failed", room.code, e.message); }
      }
    }
  }
}
function flushAllPersists() {
  for (const t of persistTimers.values()) clearTimeout(t);
  persistTimers.clear();
  for (const room of rooms.values()) persistRoomNow(room);
}

/* 2026-07-25 § ACCOUNTS: the account rides along ONCE, at the front door, as an OPTIONAL `acct`
   session token on `host`/`join`, and is then stored on the room's player record. Deliberate
   consequences: `rejoin` is not touched at all and never re-asserts identity, so an expired
   session mid-game cannot cost anyone their stats; a client that never sends `acct` (which is
   every client shipped to date) is a guest in that room, exactly as today; and an invalid token
   is silently ignored rather than being an error, because a sign-in problem must never stop
   somebody joining a family game. When `acct` is absent this function returns null without
   touching any storage, so the whole path stays byte-identical for existing clients. */
function resolveAcctField(msg) {
  if (!ACCOUNTS_ENABLED) return null;
  const t = msg && typeof msg.acct === "string" ? msg.acct : "";
  if (!t) return null;
  const me = resolveSession(t);
  return me ? me.uid : null;
}
function remoteIp(req) {
  const h = req.headers || {};
  const raw = h["cf-connecting-ip"] || h["x-forwarded-for"] || (req.socket && req.socket.remoteAddress) || "unknown";
  return String(raw).split(",")[0].trim();
}
const HOST_RATE_LIMIT = 5;
const HOST_RATE_WINDOW_MS = 60 * 1000;
const hostRateMap = new Map();
function underHostRateLimit(ip) {
  const now = Date.now();
  const kept = (hostRateMap.get(ip) || []).filter(t => now - t < HOST_RATE_WINDOW_MS);
  if (kept.length >= HOST_RATE_LIMIT) { hostRateMap.set(ip, kept); return false; }
  kept.push(now);
  hostRateMap.set(ip, kept);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hostRateMap) {
    const kept = arr.filter(t => now - t < HOST_RATE_WINDOW_MS);
    if (kept.length) hostRateMap.set(ip, kept); else hostRateMap.delete(ip);
  }
}, HOST_RATE_WINDOW_MS);

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");
  } while (rooms.has(code));
  return code;
}
function newToken() { return crypto.randomBytes(9).toString("hex"); }

function makeRoom(code) {
  const room = {
    code,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    hostPlayerId: null,
    nextPlayerId: 1,
    players: new Map(),
    lobby: null,
    started: false,
    seatOwners: null,
    // v0.25 item 1: lobby-phase readiness (REPLACES v0.16's post-Start readyCheck phase - the
    // separate "everyone ready?" page is gone). playerIds of guests who tapped "Ready up" on
    // the seat screen; the host never appears here (their Start tap IS their ready). Cleared
    // when the game actually starts. See "readyUp"/"start" below.
    ready: new Set(),
    log: [],
    paused: false,
    engine: null,        // v0.15: createEngine() instance, set at Start — the authoritative G
    tableSpeed: 1,        // v0.15: shared table pacing, host-controlled
    recorded: false,      // v0.15: leaderboard idempotency flag, see finishGame()
    nextSeq: 0,           // v0.15: ever-increasing action seq, independent of log trimming
    // v0.27.1: sticky for THIS game instance - true once ANY human has surrendered/conceded
    // this same still-unfinished game. See § SURRENDER's leaveSeatForGoodInternal() comment.
    // Reset to false in actuallyStartGame(), same lifecycle as `recorded` - a genuinely NEW
    // game/rematch at this table starts with a clean slate.
    anySurrenderOccurred: false,
    away: null,           // v0.22: transient away-ladder state, never persisted - see § AWAY LADDER
    willSeat: new Set(),  // v0.22 P0b: playerIds whose readyUp carried willSeat:true - see § SEAT GATE
    seatGate: null,       // v0.22 P0b: {waiting:Set, timer} while the first deal is being held
    // 2026-07-23 (Blake's item 2) § REUNION READY GATE - PERSISTED (unlike `away`/`willSeat`/
    // `seatGate` above - see roomToDisk()'s matching comment for why), so a restart mid-reunion
    // comes back exactly as it was instead of stranding a paused table.
    reunionActive: false, // true while a "getting the table back together" ready-up gate is open
    tableReady: new Set(),// playerIds who have tapped Ready up during the CURRENT reunion
    reunionOpenedAt: 0,   // 2026-07-25 (bug 2): when the CURRENT gate opened - see REUNION_GATE_CAP_MS
  };
  rooms.set(code, room);
  return room;
}
function touch(room) { room.lastActivity = Date.now(); schedulePersist(room); }

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
  }
}
function broadcast(room, obj, exceptPlayerId) {
  for (const p of room.players.values()) {
    if (p.id === exceptPlayerId) continue;
    send(p.ws, obj);
  }
}
function presenceSnapshot(room) {
  const out = {};
  for (const p of room.players.values()) out[p.id] = !!p.connected;
  return out;
}
function lobbySnapshot(room) {
  if (!room.lobby) return null;
  const snap = JSON.parse(JSON.stringify(room.lobby));
  snap.hostSeatIndex = snap.seats.findIndex(s => s.claimedBy === room.hostPlayerId);
  // v0.25 item 1: readiness rides every lobby snapshot so both the host's room screen and a
  // guest's seat screen can render per-seat "Ready" states live.
  snap.readyPlayerIds = Array.from(room.ready || []);
  return snap;
}
function roomIsFullyDisconnected(room) {
  for (const p of room.players.values()) if (p.connected) return false;
  return true;
}

/* ---------------------------------------------------------------------------------------
 * v0.15 § AUTHORITATIVE TURN LOOP — the heart of the rebuild. Runs entirely synchronously
 * (Node is single-threaded and every engine call here is sync — no awaits inside this
 * function), so there is no interleaving hazard between rooms or between two calls for the
 * SAME room. It deals, decides whose turn it is, resolves every CPU turn and every bow-out /
 * whole-table-stuck throw-in ITSELF (using the exact same pure decision helpers index.html's
 * offline path uses — see server/engine.js's dealDecision/passDecision/handOver/
 * seatsWithCards), and stops the moment it reaches a seat that needs a HUMAN'S move — at which
 * point it just returns; the next call is triggered by that human's validated `action` message
 * arriving (see the "action" case in handleMessage below).
 *
 * No pacing/delay logic lives here on purpose — the server's job is correctness, not UX pacing;
 * every phone at the table animates the resulting action stream at the shared table speed (see
 * "tableSpeed" below), so identical action queues + identical speed = the same view on every
 * screen, without the server needing to know or care about real-time animation timing.
 * ------------------------------------------------------------------------------------- */
const TURN_LOOP_GUARD = 200000; // sanity ceiling against a genuine infinite-loop bug — never hit in practice

function appendAction(room, action) {
  const seq = room.nextSeq++;
  room.log.push({ seq, action });
  if (room.log.length > LOG_TAIL_MAX) room.log.splice(0, room.log.length - LOG_TAIL_MAX);
  touch(room);
  if (process.env.NASTY_DEBUG_DIGEST) {
    const G = room.engine.getG();
    log('[DRIVE]', action.kind, 'seat=' + (action.seat != null ? action.seat : '-'), action.type ? action.type : (action.m ? action.m.type : ''), '-> turn=' + G.turn, 'over=' + G.over, 'bowedOut=' + JSON.stringify(G.bowedOut), 'handLens=' + JSON.stringify(G.hands.map(h => h.length)));
  }
  broadcast(room, { type: "gameAction", seq, action });
  return seq;
}

/* Cheap FNV-1a-style digest of the parts of G that must be identical everywhere — mirrors
 * index.html's client-side gDigest() (§ NET) byte-for-byte (same algorithm, same field order).
 * Used only for the self-heal integrity check, never for game logic — see maybeStateCheck().
 * Kept as an independent small copy rather than moved into the shared § ENGINE extract: this
 * is a testing/self-heal utility, not a game RULE, so the single-source-of-truth requirement
 * that applies to legalMoves()/applyMove()/etc doesn't apply here the same way — but if it's
 * ever changed, change BOTH copies (this one and index.html's gDigest()) together. */
function gDigestServer(G) {
  const parts = [G.turn, G.dealer, G.schedRound, G.over ? 1 : 0];
  for (let s = 0; s < G.n; s++) {
    parts.push(G.hands[s].length, G.bowedOut[s] ? 1 : 0);
    for (const p of G.pieces[s]) parts.push(p.state[0], p.steps);
  }
  parts.push(G.deck.length, G.discard.length);
  if (process.env.NASTY_DEBUG_DIGEST) console.log('[SRV-PARTS]', JSON.stringify(parts));
  const str = parts.join(",");
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
// v0.15 bug fix (found via instrumented reproduction): this used to tag the digest with
// G.actionSeq — but actionSeq only increments on a real MOVE (see applyMove(), § ENGINE);
// 'pass' and 'deal' actions leave it unchanged. A client could reach the SAME actionSeq value
// via an earlier move and immediately compare, before it had actually processed the later
// same-actionSeq 'pass'/'deal' actions still sitting in its own queue — a deterministic
// false-positive mismatch, not a rare race (this was the actual cause of most of the
// self-healing-but-frequent resyncs observed in testing, on top of the separate turn-tracking
// fix above). Fixed by tagging with `afterSeq` — the monotonic BROADCAST sequence number
// (room.nextSeq, already unique per action of any kind) of the specific action this digest was
// computed right after — and having the client compare once it's actually APPLIED that many
// broadcast actions (NET.appliedSeq, § NET), not once some unrelated field happens to match.
function maybeStateCheck(room, afterSeq) {
  const G = room.engine.getG();
  const digest = gDigestServer(G);
  if (process.env.NASTY_DEBUG_DIGEST) log('[SRV-FULLG]', afterSeq, JSON.stringify(G));
  broadcast(room, { type: "stateCheck", afterSeq, digest });
}

function sameMove(legal, submitted) {
  if (!legal || !submitted) return false;
  if (legal.ci !== submitted.ci || legal.type !== submitted.type || legal.owner !== submitted.owner) return false;
  // THE JACK BUG (found 2026-07-24, Blake's item 13): this used to skip the `pi` check for
  // swap moves entirely - only comparing `ts`/`tpi` (the TARGET tee). legalMoves() generates
  // one swap move per (owner's own track piece) x (every other track tee), so whenever the
  // owner has 2+ of their own tees on the track, several legal moves share the exact same
  // {ci,type,owner,ts,tpi} and differ ONLY in `pi` - which of the owner's OWN pieces is doing
  // the swapping. Array.prototype.find() below always returns the FIRST such match, and
  // legalMoves() builds its list with `pi` as the OUTER loop - so that first match is always
  // whichever of the owner's track pieces happens to have the lowest array index, regardless
  // of which one the player actually tapped. The server (authoritative for online games) would
  // then apply THAT wrong piece's swap instead of the submitted one - a completely different
  // tee, anywhere on the board, silently swapped instead of the one the player picked. Since
  // online moves are only applied locally after the server's echo (see index.html's
  // commitMove()), this corrupted the tapping player's OWN phone too, not just everyone else's -
  // matching Blake's report exactly ("switches the wrong piece, nowhere near the ones they
  // clicked", "even on the acting phone"). Fix: also require `pi` to match.
  if (legal.type === "swap") return legal.pi === submitted.pi && legal.ts === submitted.ts && legal.tpi === submitted.tpi;
  if (legal.pi !== submitted.pi || legal.to !== submitted.to) return false;
  const a = legal.kick, b = submitted.kick;
  if (!!a !== !!b) return false;
  if (a && (a.seat !== b.seat || a.pi !== b.pi)) return false;
  return true;
}

/* ---------------------------------------------------------------------------------------
 * v0.16 item 5 § PUSH — "It's your turn in NASTY." Fires exactly once per genuine turn-start
 * event: driveTurnLoop() is only ever CALLED (from the three call sites below) right after a
 * real mutation (a fresh game start, a validated human move, a "leaveForGood" conversion), so
 * the single "stop and wait for a human" return point inside it is reached fresh every call -
 * no extra dedupe bookkeeping needed to satisfy "one push per turn-start, not per loop tick."
 * A player who's still connected (their own phone is right there) never gets buzzed - this
 * only ever fires for a seat whose socket is dead AND who has a registered push token.
 * Fire-and-forget (never awaited by the caller) - a push failure/misconfiguration must never
 * slow down or affect anyone's turn. See server/apns.js for the no-op-until-key-exists design.
 * ------------------------------------------------------------------------------------- */
function maybeSendTurnPush(room, seat) {
  const G = room.engine.getG();
  if (!G || !G.seats[seat] || G.seats[seat].type !== "human") return; // defensive - driveTurnLoop only stops here for a human seat
  const ownerId = room.seatOwners ? room.seatOwners[seat] : null;
  if (ownerId == null) return;
  const player = room.players.get(ownerId);
  // v0.22: was `player.connected` alone - now the shared away test, so a SILENT zombie socket
  // (TCP alive, app frozen - reports connected but hasn't produced an app-level message in
  // AWAY_SILENT_MS) also counts as "not right there" and still gets its phone buzzed.
  if (!player || !playerLooksAway(player)) return;   // they're right there - no need to buzz their phone
  if (!player.pushToken) {
    // v0.25 item 3: this exact silent return was where the field failure hid (no device ever
    // registered a token, so every push attempt vanished without a trace in the logs) - log
    // it, so a future "no push arrived" report is diagnosable from the server log alone.
    log("turn push skipped - no token registered", room.code, "playerId=" + ownerId, "name=" + player.name);
    return;
  }
  sendTurnPush({
    token: player.pushToken, playerName: G.seats[seat].name,
    title: "NASTY", body: "It's your turn in NASTY",
  }).catch(e => log("push send threw", room.code, e.message));
}

/* ---------------------------------------------------------------------------------------
 * v0.22 § AWAY LADDER - the family-appropriate escalation ladder for "the on-turn HUMAN's
 * phone is gone" (disconnected, or app-level silent - see ws.lastAppMsgAt). Server-driven so
 * every phone at the table sees the same thing, wired with ADDITIVE protocol messages
 * ('awayStatus' broadcasts + the 'playTurnForAway' client request) that old builds 16-28
 * simply ignore. The ladder, timed from when the away-wait starts:
 *   0 .. AWAY_NUDGE_MS      nothing beyond the client's own passive grey plate (P0).
 *   AWAY_NUDGE_MS           fire the v0.16 turn push (graceful no-op until the APNs key
 *                           lands) + broadcast {awayStatus, stage:'nudged'} - clients show
 *                           "Waiting for X. We sent their phone a nudge." with a re-nudge
 *                           button (the existing 'nudge' message, extended below to re-fire
 *                           the push, rate-limited).
 *   AWAY_CPU_OFFER_MS       broadcast {awayStatus, stage:'cpuOffer'} - every OTHER player
 *                           gets a one-tap "Have the computer play this turn for X" button
 *                           ('playTurnForAway' - any player, no vote). The server plays that
 *                           SINGLE turn via chooseAI at Tricky; the seat STAYS human and its
 *                           owner can rejoin normally.
 * Deliberately NO automatic forfeits and NO automatic CPU conversion (v0.16's reasoning
 * stands - "Leave for good" remains the only permanent conversion, and remains the player's
 * own choice). Composes with pause (a paused room's ladder resets - see currentAwayTarget)
 * and with leaveForGood (a converted seat is type 'cpu', so it can never be an away target).
 * Thresholds are env-tunable so the permanent freeze-recovery test can run fast; room.away is
 * transient in-memory state on purpose (a restart just restarts the clock).
 * ------------------------------------------------------------------------------------- */
function envInt(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}
const AWAY_NUDGE_MS = envInt("NASTY_AWAY_NUDGE_MS", 30 * 1000);
const AWAY_CPU_OFFER_MS = envInt("NASTY_AWAY_CPU_MS", 150 * 1000);
const AWAY_SILENT_MS = envInt("NASTY_AWAY_SILENT_MS", 60 * 1000);
const AWAY_SWEEP_MS = envInt("NASTY_AWAY_SWEEP_MS", Math.min(5000, Math.max(500, Math.floor(AWAY_NUDGE_MS / 3))));
const AWAY_REPUSH_MIN_MS = 25 * 1000;   // re-nudge push rate limit per away stretch

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
   below the socket window, where it does the work. (Same on server.ts - this was already true
   over there, which is one of the drifts the parity pass closed.) */
function playerLooksAway(p) {
  if (!p) return true;
  if (!p.connected) return true;
  if (p.ws && p.ws.lastAppMsgAt && Date.now() - p.ws.lastAppMsgAt > AWAY_SILENT_MS) return true;
  return false;
}
function currentAwayTarget(room) {
  if (!room.started || !room.engine || room.paused || !room.seatOwners) return null;
  if (room.seatGate) return null;   // v0.22 P0b: pre-first-deal - nobody is "on turn" in any meaningful sense yet
  const G = room.engine.getG();
  if (!G || G.over) return null;
  const seat = G.turn;
  if (!G.seats[seat] || G.seats[seat].type !== "human") return null;
  const ownerId = room.seatOwners[seat];
  if (ownerId == null) return null;
  if (!playerLooksAway(room.players.get(ownerId))) return null;
  return { seat, name: G.seats[seat].name };
}
function broadcastAwayClear(room) {
  if (room.away && room.away.announced) broadcast(room, { type: "awayStatus", stage: "clear", seat: room.away.seat });
  room.away = null;
}
const awaySweepTimer = setInterval(() => {
  const now = Date.now();
  // 2026-07-25 (bug 2): the reunion gate's cap rides this same sweep - it is the one periodic
  // per-room pass this file has, and seconds-level cadence is far finer than a 75s cap needs.
  sweepReunionGates();
  for (const room of rooms.values()) {
    const t = currentAwayTarget(room);
    if (!t) { if (room.away) broadcastAwayClear(room); continue; }
    if (!room.away || room.away.seat !== t.seat) {
      room.away = { seat: t.seat, since: now, nudgeSent: false, offerSent: false, announced: false, lastPushAt: 0 };
    }
    const a = room.away;
    if (!a.nudgeSent && now - a.since >= AWAY_NUDGE_MS) {
      a.nudgeSent = true; a.announced = true; a.lastPushAt = now;
      maybeSendTurnPush(room, t.seat);   // graceful no-op until the APNs key lands
      broadcast(room, { type: "awayStatus", stage: "nudged", seat: t.seat, name: t.name });
      log("away ladder: nudged stage", room.code, "seat=" + t.seat);
    }
    if (!a.offerSent && now - a.since >= AWAY_CPU_OFFER_MS) {
      a.offerSent = true; a.announced = true;
      broadcast(room, { type: "awayStatus", stage: "cpuOffer", seat: t.seat, name: t.name });
      log("away ladder: cpuOffer stage", room.code, "seat=" + t.seat);
    }
  }
}, AWAY_SWEEP_MS);

function driveTurnLoop(room) {
  const E = room.engine;
  for (let guard = 0; guard < TURN_LOOP_GUARD; guard++) {
    const G = E.getG();
    if (!G || G.over) { if (G && G.over) finishGame(room); return; }
    if (E.handOver()) {
      // sweep dead cards from bowed-out seats' leftover hands (mirrors runTurnInner()'s sweep)
      for (let s = 0; s < G.n; s++) { if (G.hands[s].length) { G.discard.push(...G.hands[s]); G.hands[s].length = 0; } }
      let seed = {};
      if (E.needsReshuffle()) seed = { deck: E.freshDeck(), dealer: (G.dealer + 1) % G.n };
      const r = E.dealDecision(seed);
      const dealSeqNum = appendAction(room, { kind: "deal", dealer: r.dealer, reshuffled: r.reshuffled, k: r.k, hands: r.hands, deckCount: r.deckCount, turn: E.getG().turn });
      maybeStateCheck(room, dealSeqNum);
      continue;
    }
    const seat = G.turn;
    if (G.hands[seat].length === 0) {
      E.advanceTurn();
      appendAction(room, { kind: "pass", seat, newlyBowedOut: false, threwIn: false, passStreak: G.passStreak, emptyHand: true, turn: E.getG().turn });
      continue;
    }
    if (G.bowedOut[seat]) {
      const r = E.passDecision(seat, false);
      E.advanceTurn();
      appendAction(room, { kind: "pass", seat, newlyBowedOut: false, threwIn: r.threwIn, passStreak: r.passStreak, turn: E.getG().turn });
      continue;
    }
    const moves = E.legalMoves(seat);
    if (moves.length === 0) {
      const r = E.passDecision(seat, true);
      E.advanceTurn();
      appendAction(room, { kind: "pass", seat, newlyBowedOut: true, threwIn: r.threwIn, passStreak: r.passStreak, turn: E.getG().turn });
      continue;
    }
    const seatCfg = G.seats[seat];
    if (seatCfg.type === "cpu") {
      const m = E.chooseAI(seat, moves);
      E.applyMove(seat, m);
      tallyKnockout(E, m);   // 2026-07-24 item 9 - see that function's comment
      if (E.getG().over) { appendAction(room, { kind: "move", seat, m, turn: G.turn }); finishGame(room); return; }
      E.advanceTurn();
      // v0.15 bug fix: every action carries the RESULTING turn number explicitly (computed
      // AFTER advanceTurn(), here and at every other appendAction call site in this function
      // and in the "action" handler below) — found via instrumented reproduction: the client
      // mirrors turn advancement by calling its own advanceTurn()/advance() rather than
      // trusting a wire value, and a rare timing window (a stale in-flight animation call
      // finishing after a fresh reconnect snapshot landed) could call it one extra time,
      // silently drifting the turn number forward by one while every OTHER field (hands,
      // pieces, actionSeq) stayed perfectly in sync — invisible until the next digest
      // checkpoint caught it several actions later. Sending the authoritative number directly
      // and having the client just ASSIGN it (idempotent) removes the whole class of drift
      // instead of chasing the exact race. See index.html's applyServerAction()/
      // applyPassAction()/applyDealAction() for the client-side assignment.
      const cpuMoveSeqNum = appendAction(room, { kind: "move", seat, m, turn: E.getG().turn });
      // v0.15 second bug fix, found the SAME way: maybeStateCheck() used to run BEFORE
      // advanceTurn() - since G.actionSeq doesn't change when advanceTurn() runs, the digest
      // it broadcast was tagged with an actionSeq that, on the CLIENT side, only gets reached
      // once the WHOLE action (turn included) has finished applying - a guaranteed,
      // deterministic mismatch on every single kick/swap move, not a rare race. Moved to AFTER
      // advanceTurn() so the digest reflects the exact same fully-resolved checkpoint the
      // client will have once it's done applying this action.
      if (m.kick || m.type === "swap") maybeStateCheck(room, cpuMoveSeqNum);
      continue;
    }
    // Human seat with cards and at least one legal move: stop here and wait for their
    // validated `action` message (see the "action" case below) — this is the ONLY external
    // input the authoritative loop ever waits on.
    maybeSendTurnPush(room, seat);   // v0.16 item 5: "it's your turn" push if they're not connected
    return;
  }
  log("driveTurnLoop guard tripped (possible infinite loop) — room", room.code);
}

/* ---------------------------------------------------------------------------------------
 * v0.25 item 1 § LOBBY READINESS - readiness is collected ON THE SEAT SCREEN now (a guest's
 * "Ready up" button locks their seat choice in), not on a separate post-Start page. The host
 * never readies up: their Start tap IS their ready. Start only proceeds once every claimed
 * NON-HOST seat's player is ready - guestsAllReady() is the single source of that rule,
 * checked both client-side (Start button disabled) and here (the authoritative gate).
 * ------------------------------------------------------------------------------------- */
function guestsAllReady(room) {
  if (!room.lobby) return false;
  return room.lobby.seats.every(s => s.claimedBy == null || s.claimedBy === room.hostPlayerId || (room.ready && room.ready.has(s.claimedBy)));
}
/* ---------------------------------------------------------------------------------------
 * v0.22 P0b § SEAT GATE - hold the FIRST deal until every human is actually LOOKING at the
 * board. Blake's report: his group was still reading the pre-game popups when the server
 * dealt hand 1, auto-bowed-out every human whose turn arrived with no legal move, let the
 * CPUs play the whole hand out and dealt hand 2 - "we only had four cards in our initial
 * deal" (rules-correct 5-then-4 deal sizes; they just never saw hand 1).
 * Two layers: the CLIENT now shows its one-time popups during the READY CHECK (so they're
 * dismissed before "I'm ready" is even tappable), and THIS gate is the server-side
 * belt-and-suspenders: a new client's readyUp carries willSeat:true, promising an explicit
 * {type:'seated'} once its board is visible with no overlays - the start action still
 * broadcasts immediately (clients need it to render the board at all), but the first deal
 * waits for every promised 'seated'. Old clients (builds 16-28) never send willSeat and are
 * treated as seated immediately - their behavior is byte-identical to v0.21. A capped timer
 * guarantees one broken client can never hold the table hostage; a disconnect releases that
 * player's slot early. All transient in-memory state - a restart falls back to "deal now"
 * via loadRoomsFromDisk()'s boot re-drive, the same semantics as the cap expiring.
 * ------------------------------------------------------------------------------------- */
const SEAT_GATE_CAP_MS = envInt("NASTY_SEAT_GATE_CAP_MS", 25 * 1000);
function releaseSeatGateSlot(room, playerId, why) {
  if (!room.seatGate || !room.seatGate.waiting.has(playerId)) return;
  room.seatGate.waiting.delete(playerId);
  if (room.seatGate.waiting.size === 0) {
    clearTimeout(room.seatGate.timer);
    room.seatGate = null;
    log("seat gate cleared - dealing", room.code, "(" + why + ")");
    driveTurnLoop(room);
  }
}

// The actual game start - since v0.25 triggered directly from the host's "start" message
// (once guestsAllReady() holds); the v0.16-v0.24 readyCheck phase between the two is gone.
function actuallyStartGame(room) {
  room.ready = new Set();
  room.started = true;
  room.seatOwners = room.lobby.seats.map(s => s.claimedBy);
  const n = room.lobby.n === 6 ? 6 : 4;
  // v0.8 rule, carried forward from the old client-side transformation at Start time
  // ($('btnRoomStart').onclick used to compute this): any seat nobody claimed plays as
  // CPU, regardless of what `type` said during lobby setup (a family's offline setup
  // screen may have configured 2+ human seats for pass-and-play, but online, an
  // unclaimed seat has nobody to hand the phone to — it has to be a CPU). A seat's
  // `type` is normally already kept in sync with `claimedBy` by claimSeat/setSeat, EXCEPT
  // exactly this "configured human, never claimed" case, so re-derive from claimedBy
  // here rather than trusting the stored `type` blindly.
  const seatsCfg = room.lobby.seats.map(s => ({ name: s.name, diff: s.diff || "medium", type: s.claimedBy != null ? "human" : "cpu" }));
  const engine = createEngine();
  engine.setLAY(engine.buildLayout(n));
  engine.newGame({ n, teams: !!room.lobby.teams, seats: seatsCfg }, { deck: engine.freshDeck(), dealer: Math.floor(Math.random() * n) });
  room.engine = engine;
  room.recorded = false;
  room.anySurrenderOccurred = false;   // v0.27.1: a genuinely new game/rematch resets the no-fault-exit flag
  room.reunionActive = false; room.tableReady = new Set();   // 2026-07-23: defensive reset, same lifecycle as `recorded`
  const G = engine.getG();
  const startAction = { kind: "start", n: G.n, teams: G.teams, seats: seatsCfg, dealer: G.dealer, deck: [], tableSpeed: room.tableSpeed || 1 };
  room.log = [{ seq: 0, action: startAction }];
  room.nextSeq = 1;
  touch(room);
  broadcast(room, { type: "gameAction", seq: 0, action: startAction, seatOwners: room.seatOwners });
  log("room started", room.code, `n=${n}`, room.lobby.teams ? "teams" : "ffa");
  // v0.22 P0b § SEAT GATE: only players who PROMISED a 'seated' signal (new clients) are ever
  // waited for; a table of old clients (empty set) deals immediately, exactly as before. A
  // promiser who has ALREADY disconnected again (their close ran before this gate existed)
  // is skipped up front - their overlays are moot and their close can't release them anymore.
  const waiting = new Set(Array.from(room.willSeat || []).filter(id =>
    room.seatOwners.includes(id) && !!(room.players.get(id) || {}).connected));
  room.willSeat = new Set();
  if (waiting.size === 0) { driveTurnLoop(room); return; }
  room.seatGate = {
    waiting,
    timer: setTimeout(() => {
      if (rooms.get(room.code) !== room || !room.seatGate) return;
      log("seat gate cap expired - dealing anyway", room.code, "unseated=" + Array.from(room.seatGate.waiting).join(","));
      room.seatGate = null;
      driveTurnLoop(room);
    }, SEAT_GATE_CAP_MS),
  };
  log("holding the first deal until everyone is seated", room.code, "waiting=" + waiting.size);
}

/* ---------------------------------------------------------------------------------------
 * 2026-07-23 § REUNION READY GATE (Blake's items 1-4, "when we come back" batch)
 *
 * Item 2: "it didn't let me see that everyone was there when I came back - it just threw us
 * all in since we were all there. Can you still make there be a lobby that says we're all
 * there and we click 'ready up' to start when we come back?"
 *
 * Before this, tapping the saved-game tile SKIPPED the rejoin lobby entirely whenever every
 * other human already looked connected (see the old onSync() "missing.length===0" branch,
 * index.html - now removed) - "presence" (a socket is open) silently stood in for "actually at
 * the table, paying attention," which is exactly what Blake reported. Now: tapping the tile
 * ALWAYS opens a ready-up gate, reusing the SAME lobby-seat pattern v0.25 built for the very
 * first deal (readyPlayerIds/readyUp) rather than inventing a second mechanism - just applied
 * post-start instead of pre-start. EVERY currently-connected human seat (not just the one who
 * tapped the tile - anyone else still sitting at the table too) must tap "Ready up" before play
 * resumes; a seat that's still genuinely missing doesn't block it (send a rejoin link, or hand
 * it to a computer via the existing takeOverSeat - unchanged).
 *
 * Deliberately does NOT touch an ordinary pauseToggle (a plain Pause/Save tap, or its own
 * Cancel/"Return to Game") when no gate is open - that stays instant, exactly as it always has
 * (index.html's releaseSheetPause() depends on this: cancelling YOUR OWN sheet-initiated pause
 * must never require a ready-up dance). This gate is a SEPARATE, additive mechanism the client
 * opts into (requestReunion) only when deliberately coming back to a game, never applied
 * automatically to every pause.
 *
 * 2026-07-25 § TWO HOLES IN THE ABOVE, FOUND AND CLOSED
 *
 * (bug 1) "does not touch pauseToggle" was too literal: pauseToggle set room.paused
 * UNCONDITIONALLY and never looked at reunionActive. So an UNPAUSE arriving while the gate was
 * open resumed play with nobody having readied AND left reunionActive stuck true forever - after
 * which requestReunion's own "already open, no-op" guard made every LATER reunion a silent
 * no-op, killing the feature for the rest of that room's life. And it needed no old build to
 * reach: player A opens the Pause/Save sheet (PAUSED_BY_SHEET=true), player B returns via the
 * tile and opens the gate, player A taps Cancel -> releaseSheetPause() -> requestPause(false).
 * A build-38 client's tap-to-resume sends the same message (its PAUSE_TAP_ALLOWED has no
 * reunion awareness), which is what made this the real protocol-5 compatibility hole too.
 * The fix is in the pauseToggle case below: while a gate is open, an UNPAUSE is REFUSED and the
 * asker is told plainly why. Refusing rather than treating it as a gate cancel is deliberate -
 * cancelling a Pause/Save sheet is not "everyone is back and ready", and Blake asked for that
 * check-in lobby specifically; silently dissolving it on a stray Cancel tap would put us right
 * back at the presence-stands-in-for-attention behavior he reported. Pausing (paused:true)
 * while a gate is open stays allowed and is simply a no-op, since the gate already paused it.
 * Deliberately NOT treated as an implicit ready-up either: a Cancel tap is not "I'm ready".
 *
 * (bug 2) The gate had NO cap. maybeResolveReunion() required every currently-connected human
 * seat to ready up and would wait forever - so one person who put their phone down with the
 * app open, or one client whose ready-up button never rendered, froze the whole table with no
 * escape at all (the gate pauses the table, and currentAwayTarget() bails on room.paused, so
 * the away ladder AND its "have a computer take over" escape were both disabled for the whole
 * duration). The pre-start seat gate has had SEAT_GATE_CAP_MS since v0.22 for exactly this
 * reason - "a broken client can never hold the table hostage" - and this gate now has the same
 * thing. REUNION_GATE_CAP_MS is generous (a family really does take a moment to all tap a
 * button) but finite; when it expires the gate resolves itself exactly as if everyone had
 * readied, so play carries on and no stale state is left behind.
 *
 * The cap is enforced from a TIMESTAMP (room.reunionOpenedAt, persisted with the rest of the
 * gate) checked by the periodic sweep below, NOT from a setTimeout: a timer would be lost on a
 * restart, and losing it would strand exactly the table this cap exists to protect. The Deno
 * twin uses the same timestamp + sweep shape for the same reason.
 * ------------------------------------------------------------------------------------- */
const REUNION_GATE_CAP_MS = envInt("NASTY_REUNION_GATE_CAP_MS", 75 * 1000);
function closeReunionGate(room, why) {
  room.paused = false;
  room.reunionActive = false;
  room.tableReady = new Set();
  room.reunionOpenedAt = 0;
  touch(room);
  broadcast(room, { type: "paused", paused: false });
  broadcast(room, { type: "reunionStatus", active: false, readyPlayerIds: [] });
  log("reunion gate closed - table resuming", room.code, "(" + why + ")");
}
function maybeResolveReunion(room) {
  if (!room.reunionActive || !room.engine) return;
  const G = room.engine.getG();
  if (!G) return;
  const required = (room.seatOwners || []).filter((pid, seat) => {
    if (pid == null) return false;
    if (!G.seats[seat] || G.seats[seat].type !== "human") return false;   // converted to CPU since the gate opened
    const p = room.players.get(pid);
    return !!(p && p.connected);   // only players CURRENTLY at the table are required to ready up
  });
  // Never auto-resolve with nobody required (e.g. everyone momentarily disconnected at once) -
  // sit tight until someone's actually back to tap ready, rather than silently resuming an
  // unattended table. (The cap below is what bounds even THIS case - see sweepReunionGates().)
  if (required.length === 0) return;
  if (!required.every((pid) => room.tableReady.has(pid))) return;
  closeReunionGate(room, "everyone readied up");
}
// 2026-07-25 (bug 2): the cap's enforcement. Runs on the same interval as the away ladder's
// sweep - that is the one periodic per-room pass this file already has, and its cadence
// (seconds) is far finer than the cap needs.
function sweepReunionGates() {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.reunionActive) continue;
    if (!room.reunionOpenedAt) { room.reunionOpenedAt = now; continue; }   // pre-2026-07-25 persisted gate: start its clock now
    // A gate that has sat UNOBSERVED for far longer than the cap did not have anybody there to
    // tap Ready up, so expiring it the instant somebody finally shows up would flash the
    // check-in lobby for a second and then yank it away. Restart its clock instead, so whoever
    // just came back gets a full-length check-in. Reachable here after a long server outage with
    // a gate persisted open; the identical line in the Deno twin also covers ITS case (the sweep
    // there only sees rooms with a live socket, so a gate goes unwatched whenever everyone is
    // gone). Same rule in both files on purpose.
    if (now - room.reunionOpenedAt > REUNION_GATE_CAP_MS * 3) { room.reunionOpenedAt = now; continue; }
    if (now - room.reunionOpenedAt < REUNION_GATE_CAP_MS) continue;
    closeReunionGate(room, "waited " + Math.round((now - room.reunionOpenedAt) / 1000) + "s for everyone to tap Ready up");
    // A clean resume, not just an unpaused flag: if the gate happened to open while the very
    // first deal was still pending, nothing else would retrigger it. Guarded on nextSeq===1 so
    // this is a no-op unless that deal is genuinely still owed - the same condition the Deno
    // twin's releaseFirstDeal() checks for itself.
    if (room.engine && room.nextSeq === 1) driveTurnLoop(room);
  }
}

/* ---- tiny HTTP helpers (no framework, matches the rest of this file's style) ---- */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}
const CORS_HEADERS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS", "access-control-allow-headers": "content-type, x-admin-token", "access-control-expose-headers": "x-leaderboard-epoch" };
function sendJson(res, status, obj) {
  res.writeHead(status, Object.assign({ "content-type": "application/json" }, CORS_HEADERS));
  res.end(JSON.stringify(obj));
}
const TEAM_APP_ID = "YJU5U6VX8V.com.pangman.nasty";
const AASA_BODY = JSON.stringify({
  applinks: {
    apps: [],
    details: [{ appID: TEAM_APP_ID, appIDs: [TEAM_APP_ID], paths: ["/join/*"] }],
  },
});
const JOIN_CODE_RE = /^\/join\/([A-Za-z0-9]{1,8})\/?$/;
function joinRedirectHtml(code) {
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
async function handleAdminRoute(req, res, url) {
  if (!checkAdminToken(req, url)) { sendJson(res, 401, { error: "unauthorized" }); return true; }
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts.length === 2 && parts[1] === "rooms" && req.method === "GET") {
    const list = Array.from(rooms.values()).map(r => ({
      code: r.code, started: r.started,
      paused: !!r.paused,   // v0.22: lets the lifecycle test assert "never paused" server-side
      playerCount: r.players.size,
      // v0.25 item 3: `push` - does this player have a registered APNs token? Surfaced in the
      // god-mode panel so "why did nobody get a push" is debuggable at the table next time.
      players: Array.from(r.players.values()).map(p => ({ id: p.id, name: p.name, isHost: p.isHost, connected: p.connected, push: !!p.pushToken })),
    }));
    sendJson(res, 200, list);
    return true;
  }
  /* -------------------------------------------------------------------------------------
   * GET /admin/push - push health in one request (2026-07-26 push audit).
   *
   * WHY: /admin/rooms already reports `push: !!p.pushToken` per player, which answers "did a
   * phone ever register a token" - and that flag is exactly what proved the field failure
   * (every real player false, only a test probe true). What NOTHING reported was the other
   * half: whether an attempted send was actually ACCEPTED by Apple. That half was log-only,
   * on a Deno Deploy instance whose logs nobody reads, so a revoked key or a rejected token
   * would have looked identical to everything working. This endpoint closes that gap.
   *
   * Read-only, admin-token-gated, no secrets: the key ID is an identifier (already logged in
   * plaintext by apns.js), and lastReason is Apple's short reason word only, never a body.
   * ----------------------------------------------------------------------------------- */
  if (parts.length === 2 && parts[1] === "push" && req.method === "GET") {
    let playersWithToken = 0, playersTotal = 0;
    for (const r of rooms.values()) {
      for (const p of r.players.values()) { playersTotal++; if (p.pushToken) playersWithToken++; }
    }
    sendJson(res, 200, Object.assign({ rooms: rooms.size, playersTotal, playersWithToken }, getApnsStats()));
    return true;
  }
  if (parts.length === 3 && parts[1] === "rooms" && req.method === "DELETE") {
    const code = parts[2].toUpperCase();
    const room = rooms.get(code);
    if (room) {
      for (const p of room.players.values()) { if (p.ws) { try { p.ws.close(); } catch (e) {} } }
      rooms.delete(code);
      deleteRoomFile(code);
      log("admin deleted room", code);
    }
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (parts.length === 4 && parts[1] === "rooms" && parts[3] === "rename" && req.method === "POST") {
    const code = parts[2].toUpperCase();
    const room = rooms.get(code);
    if (!room) { sendJson(res, 404, { error: "no such room" }); return true; }
    const body = await readJsonBody(req);
    const p = room.players.get(Number(body.playerId));
    if (!p) { sendJson(res, 404, { error: "no such player" }); return true; }
    const name = cleanName(body.name, p.name);
    if (isBadName(name)) { sendJson(res, 400, { error: "that name is blocked" }); return true; }
    p.name = name;
    if (room.lobby) {
      const seat = room.lobby.seats.find(s => s.claimedBy === p.id);
      if (seat) seat.name = name;
      touch(room);
      broadcast(room, { type: "lobby", lobby: lobbySnapshot(room) });
    } else {
      touch(room);
    }
    log("admin renamed player", code, p.id, "->", name);
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (parts.length === 2 && parts[1] === "leaderboard" && req.method === "GET") {
    sendLeaderboard(res, 200);
    return true;
  }
  if (parts.length === 3 && parts[1] === "leaderboard" && parts[2] === "reset" && req.method === "POST") {
    globalBoard = {};
    rebuildLbNameIndex();   // 2026-07-25 (bug 6): a new season starts with an empty name index too
    // 2026-07-25 § ACCOUNTS: a new season wipes the account-keyed rows too - they are leaderboard
    // rows, just stored in their own namespace. Accounts, sessions and the name index are
    // deliberately LEFT ALONE: after a reset you are still signed in and still own your name.
    // In production today this namespace is empty, so this line does nothing observable.
    accountBoard = {};
    persistAccountStoreNow(STORE_ACCT_BOARD);
    leaderboardEpoch += 1;
    persistLeaderboardNow();
    persistLeaderboardEpoch();
    log("admin reset the leaderboard - new epoch", leaderboardEpoch);
    sendJson(res, 200, { ok: true, epoch: leaderboardEpoch });
    return true;
  }
  if (parts.length === 3 && parts[1] === "leaderboard" && req.method === "PATCH") {
    const name = decodeURIComponent(parts[2]);
    if (!globalBoard[name]) { sendJson(res, 404, { error: "no such entry" }); return true; }
    const body = await readJsonBody(req);
    for (const k of Object.keys(body || {})) {
      if (!NUMERIC_STAT_KEY.test(k)) continue;
      const v = Number(body[k]);
      if (Number.isFinite(v)) globalBoard[name][k] = v;
    }
    scheduleLeaderboardPersist();
    log("admin edited leaderboard entry", name);
    sendJson(res, 200, globalBoard[name]);
    return true;
  }
  if (parts.length === 3 && parts[1] === "leaderboard" && req.method === "DELETE") {
    const name = decodeURIComponent(parts[2]);
    delete globalBoard[name];
    rebuildLbNameIndex();   // 2026-07-25 (bug 6): keep the case-fold index in step with a deletion
    scheduleLeaderboardPersist();
    log("admin deleted leaderboard entry", name);
    sendJson(res, 200, { ok: true });
    return true;
  }
  /* 2026-07-25 § ACCOUNTS (Stage 1) - god-mode view + the one reversal.
     Both only exist while the accounts kill switch is ON; with it off they 404 like any other
     unknown admin route, so the switch really does restore today's exact surface. The listing
     deliberately does NOT include Apple's `sub` - Blake never needs it, and the less that
     identifier travels the better. */
  if (ACCOUNTS_ENABLED && parts.length === 2 && parts[1] === "accounts" && req.method === "GET") {
    const list = Object.keys(accounts).map((uid) => {
      const a = accounts[uid];
      const j = claimJournal[uid];
      return {
        uid, gameName: a.gameName, nameFolded: a.nameFolded, created: a.created, lastSeen: a.lastSeen,
        // Which sign-in methods answer to this one account, and the verified email it links on.
        // The provider ids themselves are still deliberately withheld.
        identities: accountIdentities(a).map((i) => i.provider),
        email: a.email || null, emailPrivateRelay: !!a.emailPrivateRelay,
        nameChangedAt: a.nameChangedAt || 0, nameHistory: a.nameHistory || [], claimDeclined: !!a.claimDeclined,
        sessions: Object.keys(sessions).filter((t) => sessions[t] && sessions[t].uid === uid).length,
        claim: j ? j.state : null,
        row: accountBoard[uid] || {},
        // 2026-07-28 § POINTS WALLET - purely informational for Blake's own god-mode view.
        wallet: walletView(a),
      };
    });
    sendJson(res, 200, list);
    return true;
  }
  if (ACCOUNTS_ENABLED && parts.length === 3 && parts[1] === "claim" && parts[2] === "undo" && req.method === "POST") {
    const body = await readJsonBody(req);
    const uid = typeof body.uid === "string" ? body.uid : "";
    const r = undoAccountClaim(uid);
    if (!r.ok) { sendJson(res, 404, { error: r.error }); return true; }
    sendJson(res, 200, r);
    return true;
  }
  /* -------------------------------------------------------------------------------------
   * 2026-07-28 § POINTS WALLET ADMIN GRANT - Blake's ask, verbatim: "give me (nickname on
   * account is Baker Sr.) unlocked access to all the shop items so I can test them." A real
   * account, real board row - this must NOT touch earned points (never inflate
   * accountEarnedPoints()'s inputs, i.e. never touch globalBoard/accountBoard) and must NOT
   * touch `spent` (a real purchase debits spent; this is a direct grant, not a purchase, so
   * spent stays exactly where it was). Only `walletOwned`/`walletNamechangeCredits` on the
   * account record move - the same two fields a real purchase would move, just without the
   * price ever being charged. Admin-token-gated (this endpoint can hand out the whole catalog
   * for free - it must never be reachable without the token), same auth pattern as every other
   * /admin/* route in this file.
   *
   * Body: { name?, uid?, namechangeCredits? (default 2), revoke?: true }. `name` is folded and
   * looked up the same way /account/name-available does (accountOwningFoldedName) so Blake can
   * just pass "Baker Sr."; `uid` is accepted directly too, for scripting. `revoke:true` is the
   * reverse of a normal call - it removes every non-consumable catalog item from `walletOwned`
   * and subtracts the SAME namechangeCredits amount back off (floored at 0) - the exact inverse
   * of what a normal call would have granted, so this is fully reversible without hand-editing
   * accounts.json.
   * ----------------------------------------------------------------------------------- */
  if (ACCOUNTS_ENABLED && parts.length === 3 && parts[1] === "wallet" && parts[2] === "grantall" && req.method === "POST") {
    const body = await readJsonBody(req);
    let uid = typeof body.uid === "string" ? body.uid : "";
    if (!uid && typeof body.name === "string" && body.name) {
      const folded = leaderboardNameKey(cleanName(body.name, ""));
      uid = accountOwningFoldedName(folded) || "";
    }
    if (!uid || !accounts[uid]) { sendJson(res, 404, { error: "no such account" }); return true; }
    const acct = accounts[uid];
    const owned = Array.isArray(acct.walletOwned) ? acct.walletOwned : (acct.walletOwned = []);
    const grantedTracked = Array.isArray(acct.walletGrantedItems) ? acct.walletGrantedItems : (acct.walletGrantedItems = []);
    const creditAmount = Number.isFinite(body.namechangeCredits) && body.namechangeCredits >= 0
      ? Math.round(body.namechangeCredits) : 2;
    if (body.revoke === true) {
      // Removes EXACTLY the ids this route previously granted (walletGrantedItems), never an
      // item that was genuinely purchased - see the field's own comment on newAccountRecord().
      const grantedSet = new Set(grantedTracked);
      const before = owned.length;
      acct.walletOwned = owned.filter((id) => !grantedSet.has(id));
      const removedItemIds = owned.filter((id) => grantedSet.has(id));
      const removedItems = before - acct.walletOwned.length;
      acct.walletGrantedItems = [];
      acct.walletNamechangeCredits = Math.max(0, (Number(acct.walletNamechangeCredits) || 0) - creditAmount);
      scheduleAccountStorePersist(STORE_ACCOUNTS);
      log("admin revoked granted wallet items", uid, "items=" + removedItems, "credits=" + creditAmount);
      sendJson(res, 200, { ok: true, uid, revokedItems: removedItems, revokedItemIds: removedItemIds, revokedCredits: creditAmount, wallet: walletView(acct) });
      return true;
    }
    let grantedItems = 0;
    const grantedItemIds = [];
    for (const item of SHOP_CATALOG) {
      if (item.consumable) continue;   // namechange credits are granted separately, below
      if (!owned.includes(item.id)) {
        owned.push(item.id);
        if (!grantedTracked.includes(item.id)) grantedTracked.push(item.id);
        grantedItems++;
        grantedItemIds.push(item.id);
      }
    }
    acct.walletNamechangeCredits = Math.max(0, Number(acct.walletNamechangeCredits) || 0) + creditAmount;
    scheduleAccountStorePersist(STORE_ACCOUNTS);
    log("admin granted every wallet item", uid, "items=" + grantedItems, "credits=" + creditAmount);
    sendJson(res, 200, { ok: true, uid, grantedItems, grantedItemIds, grantedCredits: creditAmount, wallet: walletView(acct) });
    return true;
  }
  /* =====================================================================================
   * 2026-07-31 v0.68 § LAUNCH RESET - twin of server.ts's block of the same name; read that
   * one for the full design (Blake's verbatim ask, why it is an explicit admin POST and NOT
   * anything automatic on a flag, exactly what survives and why). Node-specific shape:
   *   - the backup is ALSO written to a local file (launch-reset-backup-<runId>.json, next to
   *     server.js or NASTY_LAUNCH_BACKUP_DIR) before anything is deleted, on top of riding
   *     back in the response body;
   *   - the one-shot guard is a small file (launch-reset-done.json / NASTY_LAUNCH_RESET_DONE_FILE),
   *     written with the exclusive 'wx' flag so even two racing requests cannot both claim it,
   *     and checked on every attempt - it survives restarts, so this can never run twice;
   *   - what survives: iapLedger + iapEvents (the Apple replay ledger - keeping it is what
   *     stops an old receipt being replayed against a fresh post-launch account), soloSeen
   *     (same anti-replay reasoning), and the free-month SALT (identity-free).
   * =================================================================================== */
  if (parts.length >= 2 && parts[1] === "launch-reset") {
    const doneFile = process.env.NASTY_LAUNCH_RESET_DONE_FILE
      ? path.resolve(process.env.NASTY_LAUNCH_RESET_DONE_FILE)
      : path.join(__dirname, "launch-reset-done.json");
    const backupDir = process.env.NASTY_LAUNCH_BACKUP_DIR
      ? path.resolve(process.env.NASTY_LAUNCH_BACKUP_DIR)
      : __dirname;
    const readMarker = () => {
      try { return JSON.parse(fs.readFileSync(doneFile, "utf8")); } catch (e) { return null; }
    };
    const collectBackup = () => ({
      version: 1,
      server: "node",
      takenAt: Date.now(),
      epoch: leaderboardEpoch,
      counts: {
        accounts: Object.keys(accounts).length,
        accountIndex: Object.keys(accountIndex).length,
        sessions: Object.keys(sessions).length,
        accountBoard: Object.keys(accountBoard).length,
        leaderboard: Object.keys(globalBoard).length,
        monthly: Object.keys(monthlyBoard).length,
        claims: Object.keys(claimJournal).length,
        emailCodes: Object.keys(emailCodes).length,
        purchaseSeen: Object.keys(purchaseSeen).length,
        freeMonthTombstones: Object.keys(freeMonthUsed).length,
        rooms: rooms.size,
      },
      data: {
        accounts, accountIndex, sessions, authNonces, accountBoard,
        leaderboard: globalBoard, monthly: monthlyBoard, claims: claimJournal,
        emailCodes, purchaseSeen, freeMonthTombstones: freeMonthUsed,
        roomCodes: Array.from(rooms.keys()),
      },
    });
    if (parts.length === 2 && req.method === "GET") {
      const m = readMarker();
      sendJson(res, 200, m ? Object.assign({ done: true }, m) : { done: false });
      return true;
    }
    if (parts.length === 3 && parts[2] === "backup" && req.method === "GET") {
      // Read-only preview of exactly what the wipe would take - the runner script saves this
      // to a local file before it ever sends the POST below.
      sendJson(res, 200, collectBackup());
      return true;
    }
    if (parts.length === 2 && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body || body.confirm !== "WIPE EVERYTHING FOR LAUNCH") {
        sendJson(res, 400, { error: "confirmrequired", message: 'This wipes every account and leaderboard row. Send {"confirm":"WIPE EVERYTHING FOR LAUNCH"} to really run it.' });
        return true;
      }
      const prior = readMarker();
      if (prior) {
        sendJson(res, 409, Object.assign({ error: "alreadyran", message: "The launch reset already ran and refuses to run twice." }, prior));
        return true;
      }
      const backup = collectBackup();
      const runId = Date.now() + "-" + crypto.randomBytes(4).toString("hex");
      const backupFile = path.join(backupDir, "launch-reset-backup-" + runId + ".json");
      // Backup file FIRST - if this write fails, nothing has been touched yet.
      fs.writeFileSync(backupFile, JSON.stringify(backup));
      // THE GUARD, claimed before any deletion: 'wx' throws EEXIST if any other request (or a
      // previous run) got here first, so only one invocation can ever pass this line.
      try {
        fs.writeFileSync(doneFile, JSON.stringify({ ranAt: Date.now(), runId, state: "wiping", backupFile }), { flag: "wx" });
      } catch (e) {
        const again = readMarker();
        sendJson(res, 409, Object.assign({ error: "alreadyran", message: "The launch reset already ran and refuses to run twice." }, again || {}));
        return true;
      }
      // Rooms: close every live socket, then drop the room records and their files.
      const deleted = { rooms: rooms.size };
      for (const room of rooms.values()) {
        for (const p of room.players.values()) { if (p.ws) { try { p.ws.close(); } catch (e) {} } }
        deleteRoomFile(room.code);
      }
      rooms.clear();
      const wipeCount = (o) => Object.keys(o).length;
      deleted.accounts = wipeCount(accounts); accounts = {};
      deleted.accountIndex = wipeCount(accountIndex); accountIndex = {};
      deleted.sessions = wipeCount(sessions); sessions = {};
      deleted.authNonces = wipeCount(authNonces); authNonces = {};
      deleted.accountBoard = wipeCount(accountBoard); accountBoard = {};
      deleted.leaderboard = wipeCount(globalBoard); globalBoard = {};
      deleted.monthly = wipeCount(monthlyBoard); monthlyBoard = {};
      deleted.claims = wipeCount(claimJournal); claimJournal = {};
      deleted.emailCodes = wipeCount(emailCodes); emailCodes = {};
      deleted.purchaseSeen = wipeCount(purchaseSeen); purchaseSeen = {};
      deleted.freeMonthTombstones = wipeCount(freeMonthUsed); freeMonthUsed = {};
      rebuildLbNameIndex();
      // Persist every emptied store NOW - a crash after this response must not resurrect
      // anything from disk. The IAP ledger and events files are deliberately NOT touched.
      for (const s of accountStores) persistAccountStoreNow(s);
      persistLeaderboardNow();
      persistMonthlyHistoryNow();
      persistPurchaseSeenNow();
      leaderboardEpoch += 1;
      persistLeaderboardEpoch();
      const doneMarker = { ranAt: Date.now(), runId, state: "done", deleted, epoch: leaderboardEpoch, backupFile };
      fs.writeFileSync(doneFile, JSON.stringify(doneMarker));
      log("LAUNCH RESET completed", "runId=" + runId, JSON.stringify(deleted), "epoch=" + leaderboardEpoch);
      sendJson(res, 200, { ok: true, runId, epoch: leaderboardEpoch, deleted, backupFile, backup });
      return true;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }
  sendJson(res, 404, { error: "no such admin route" });
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  if (url.pathname === "/health") {
    res.writeHead(200, Object.assign({ "content-type": "application/json" }, CORS_HEADERS));
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: process.uptime(), epoch: leaderboardEpoch, protocolVersion: PROTOCOL_VERSION }));
    return;
  }
  if (url.pathname === "/.well-known/apple-app-site-association") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(AASA_BODY);
    return;
  }
  {
    const jm = url.pathname.match(JOIN_CODE_RE);
    if (jm) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(joinRedirectHtml(jm[1].toUpperCase()));
      return;
    }
  }
  if (url.pathname === "/leaderboard") {
    sendLeaderboard(res, 200);
    return;
  }
  // 2026-07-28 § MONTHLY RANKING - public, no auth, ungated by NASTY_ACCOUNTS_ENABLED (this is
  // not an accounts feature - it works off the same name-keyed rows /leaderboard always has).
  if (url.pathname === "/leaderboard/monthly") {
    sendMonthlyLeaderboard(res, 200, url.searchParams.get("month"));
    return;
  }
  if (url.pathname.startsWith("/admin/")) {
    handleAdminRoute(req, res, url).catch((e) => { log("admin route error", e); sendJson(res, 500, { error: "server error" }); });
    return;
  }
  if (url.pathname === "/solo-result" && req.method === "POST") {
    handleSoloResult(req, res).catch((e) => { log("solo-result route error", e); sendJson(res, 500, { error: "server error" }); });
    return;
  }
  // 2026-07-25 § ACCOUNTS (Stage 1): only routed when the kill switch is ON. With
  // NASTY_ACCOUNTS_ENABLED=0 these paths fall through to the same 404 they hit today, which is
  // exactly what makes the switch a true revert rather than a partial one.
  // 2026-07-25 § ACCOUNTS: the additive board route. /leaderboard's flat body deliberately never
  // changes shape (every already-shipped build renders it), so the extra "is this row attached to
  // an account, or is it frozen history" detail lives here instead. Routed only with the kill
  // switch on, exactly like /account/*.
  if (ACCOUNTS_ENABLED && url.pathname === "/leaderboard/v2") {
    const b = boardRowsForDisplay();
    const entries = b.detail || Object.keys(globalBoard).map((name) => ({ name, stats: globalBoard[name], account: false, frozen: false }));
    sendJson(res, 200, { epoch: leaderboardEpoch, accountsOnly: accountsOnlyBoard(), claimWindow: claimWindowView(), entries });
    return;
  }
  // 2026-07-28 § POINTS WALLET - the server-owned shop catalog. A plain, unauthenticated GET:
  // browsing prices needs no account, and the client must never be trusted for one anyway, so
  // there is nothing here that needs a session. Gated on the same kill switch as the rest of the
  // accounts feature it belongs to - with NASTY_ACCOUNTS_ENABLED=0 this 404s like everything else.
  if (ACCOUNTS_ENABLED && url.pathname === "/shop" && req.method === "GET") {
    // 2026-07-30 § REAL-MONEY CREDIT PACKS: creditPacks rides along additively (a client that
    // has never heard of it ignores it, same convention as every response-shape change in this
    // file). Absent entirely with the IAP kill switch off, so the client falls back to
    // credits-only presentation.
    sendJson(res, 200, IAP_ENABLED ? { items: SHOP_CATALOG, creditPacks: CREDIT_PACKS } : { items: SHOP_CATALOG });
    return;
  }
  /* 2026-07-30 § REAL-MONEY CREDIT PACKS - App Store Server Notifications V2. Apple POSTs
     {signedPayload} here for refunds, revocations, and its own connectivity TEST. Auth is the
     signature itself (same pinned-root verifier as purchases - there is no session, Apple is
     the caller), so a forged POST from anyone else dies in verifyAppleSignedJws(). Everything
     verified is RECORDED (recordIapEvent); the only types acted on are REFUND and REVOKE, which
     subtract the pack's credits back off walletPurchasedCredits so a refunded pack does not
     silently leave credits behind. What is NOT handled, stated plainly: credits already SPENT
     cannot be fully clawed back - the deduction floors at the credits the account still has
     (balance can reach 0 but never goes negative), the un-recovered remainder is written into
     the ledger entry as `shortfall`, and items already bought with the refunded credits stay
     owned. Apple expects a 200 on success and retries on 5xx; a bad signature answers 401. */
  if (ACCOUNTS_ENABLED && IAP_ENABLED && url.pathname === "/appstore/notifications" && req.method === "POST") {
    (async () => {
      const body = await readJsonBody(req);
      const v = verifyAppleSignedJws(body && body.signedPayload);
      if (!v.ok) { log("appstore notification rejected", v.reason); sendJson(res, 401, { error: v.reason }); return; }
      const note = v.payload;
      const type = String(note.notificationType || "");
      const subtype = String(note.subtype || "");
      const data = note.data && typeof note.data === "object" ? note.data : {};
      // The transaction inside the notification is its OWN signed JWS, verified independently -
      // the outer envelope being genuine does not vouch for an inner payload nobody checked.
      let txn = null;
      if (typeof data.signedTransactionInfo === "string") {
        const tv = verifyAppleSignedJws(data.signedTransactionInfo);
        if (tv.ok) txn = tv.payload;
      }
      recordIapEvent({
        type, subtype,
        environment: String((txn && txn.environment) || data.environment || ""),
        transactionId: txn ? String(txn.transactionId || "") : "",
        productId: txn ? String(txn.productId || "") : "",
      });
      if ((type === "REFUND" || type === "REVOKE") && txn && txn.bundleId === IAP_BUNDLE_ID) {
        const environment = txn.environment === "Production" ? "Production" : "Sandbox";
        const key = iapLedgerKey(environment, String(txn.transactionId || ""));
        const entry = iapLedger[key];
        // Only a transaction THIS server credited can be clawed back, and only once - a
        // replayed/duplicate refund notification is recorded above but deducts nothing again.
        if (entry && !entry.refunded) {
          const acct = accounts[entry.uid];
          const have = acct ? Math.max(0, Number(acct.walletPurchasedCredits) || 0) : 0;
          const clawedBack = Math.min(entry.credits, have);
          entry.refunded = true;
          entry.refundedAt = Date.now();
          entry.clawedBack = clawedBack;
          entry.shortfall = entry.credits - clawedBack;
          persistIapLedgerNow();
          if (acct) {
            acct.walletPurchasedCredits = have - clawedBack;
            persistAccountStoreNow(STORE_ACCOUNTS);
          }
          log("iap refund processed", entry.uid, key, "clawedBack=" + clawedBack, "shortfall=" + entry.shortfall);
        }
      }
      sendJson(res, 200, { ok: true });
    })().catch((e) => { log("appstore notification error", e); sendJson(res, 500, { error: "server error" }); });
    return;
  }
  if (ACCOUNTS_ENABLED && url.pathname.startsWith("/account/")) {
    handleAccountRoute(req, res, url).catch((e) => { log("account route error", e); sendJson(res, 500, { error: "server error" }); });
    return;
  }
  res.writeHead(404, Object.assign({ "content-type": "text/plain" }, CORS_HEADERS));
  res.end("nasty relay - see /health");
});

const wss = new WebSocketServer({ server });

// v0.15: a full authoritative snapshot for reconnect/rejoin/reclaim — replaces the old
// "send the whole action log, let the client replay it" shape. The client just SETS G
// directly (see index.html's bootGameFromSnapshot()) instead of replaying history, which is
// both simpler and avoids the reconnect cost ever growing with a long game's history.
function gameSnapshotFields(room, isHost) {
  return {
    G: room.engine ? room.engine.getG() : null,
    // v0.15: the broadcast seq of the most recent action already reflected in this snapshot -
    // the client sets NET.appliedSeq to this on install, so the NEXT integrity-digest
    // checkpoint (see maybeStateCheck()/checkStateDigest()) compares from a known-consistent
    // baseline instead of possibly-stale bookkeeping left over from before the snapshot.
    appliedSeq: (room.nextSeq || 1) - 1,
    isHost,
    hostConnected: !!(room.players.get(room.hostPlayerId) || {}).connected,
    paused: !!room.paused,
    presence: presenceSnapshot(room),
    tableSpeed: room.tableSpeed || 1,
    protocolVersion: PROTOCOL_VERSION,
    // v0.27.1: server-authoritative "has anyone conceded THIS game yet" - rides every sync so a
    // reconnect/rejoin/reclaim always lands with the right no-fault-exit state, even if a client
    // missed the live 'surrenderOccurred' broadcast (see the "surrender" case below). Additive -
    // old clients simply never read this field.
    anySurrenderOccurred: !!room.anySurrenderOccurred,
    // 2026-07-23 (Blake's item 2) § REUNION READY GATE - rides every sync so ANY reconnect
    // (not just the deliberate tile-tap that may have started it) lands already knowing whether
    // a ready-up gate is open and who's already readied. Additive - old clients never read these.
    reunionActive: !!room.reunionActive,
    tableReadyIds: Array.from(room.tableReady || []),
  };
}

wss.on("connection", (ws, req) => {
  const ip = remoteIp(req);
  // v0.22: app-level proof-of-life clock (twin of server.ts's socketLastSeen) - any inbound
  // APPLICATION message counts; protocol-frame pongs deliberately do NOT (a frozen WKWebView's
  // network stack can keep answering those with the page's JS fully suspended - the exact
  // "silent" shape the § AWAY LADDER needs to see through).
  // 2026-07-26: this is now the ONLY proof of life on this socket. The old ws.isAlive flag and
  // its 'pong' listener were removed with the heartbeat rewrite - they measured the protocol
  // frame, which is exactly the thing a sleeping phone keeps answering. See § HEARTBEAT.
  ws.lastAppMsgAt = Date.now();
  let ctx = null;

  ws.on("message", (raw) => {
    ws.lastAppMsgAt = Date.now();
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg.type !== "string") return;

    try {
      handleMessage(msg);
    } catch (e) {
      log("message handler error", e);
      send(ws, { type: "error", message: "server error" });
    }
  });

  ws.on("close", () => {
    if (!ctx) return;
    const { room, playerId } = ctx;
    const p = room.players.get(playerId);
    if (p && p.ws === ws) {
      p.connected = false;
      p.ws = null;
      touch(room);
      // v0.22 P0b: never hold the first deal for a phone that's gone - its overlays are moot.
      // (The cap would cover this anyway; this just resolves it sooner.)
      releaseSeatGateSlot(room, playerId, "unseated player disconnected");
      // 2026-07-23: a disconnect can complete an open reunion gate too - a player who was
      // "required but hasn't readied up yet" stops being required the instant they're gone
      // (mirrors the seat gate's own release-on-disconnect above, same reasoning).
      maybeResolveReunion(room);
      broadcast(room, { type: "presence", playerId, connected: false });
      if (playerId === room.hostPlayerId) broadcast(room, { type: "hostStatus", connected: false });
      // v0.16 item 5: covers the OTHER real trigger shape beyond driveTurnLoop's own turn-start
      // check (maybeSendTurnPush() above) - a player who was connected when their turn started
      // but then backgrounds/drops mid-turn (the common real case: they were already looking at
      // their phone when it became their turn, then put it down) never re-enters driveTurnLoop
      // on its own (nothing mutated the game), so without this the push would never fire for
      // that shape. Fires at most once for the SAME turn as the turn-start check (mutually
      // exclusive: that check only pushes if ALREADY disconnected at turn-start; this one only
      // pushes on a connect->close transition while already on-turn) - never a double push.
      if (room.started && room.engine) {
        const G = room.engine.getG();
        if (G && !G.over && room.seatOwners && room.seatOwners[G.turn] === playerId) {
          maybeSendTurnPush(room, G.turn);
        }
      }
    }
  });

  function identify(room, playerId) { ctx = { room, playerId }; }
  ws.identify = identify;

  function handleMessage(msg) {
    switch (msg.type) {
      case "ping":
        send(ws, { type: "pong", t: msg.t });
        return;

      case "host": {
        // v0.15: {type:'host', protocolVersion, name, n, teams, seats:[{name,type,diff}]}
        if (!protocolOk(msg)) { send(ws, { type: "protocolMismatch", message: PROTOCOL_MISMATCH_MESSAGE }); sendLegacyMismatch(ws, "host"); return; }
        if (!underHostRateLimit(ip)) {
          send(ws, { type: "error", message: "Too many rooms created from here - wait a minute and try again." });
          log("rate-limited host attempt", "ip="+ip);
          return;
        }
        if (isBadName(msg.name)) { send(ws, { type: "error", message: "Pick a nicer name and try hosting again." }); return; }
        // 2026-07-29 § ONLINE ACCESS - the front door. Resolved once, reused below (host's own
        // account, if any), and gated BEFORE any room is created - see onlineAccessGate() for the
        // full reasoning (guest vs unentitled messages, why rejoin/reclaim are never gated here).
        const hostAcctId = resolveAcctField(msg);
        const hostGate = onlineAccessGate(hostAcctId);
        if (hostGate) {
          send(ws, { type: "error", message: hostGate.message, reason: hostGate.reason, tokenCost: hostGate.tokenCost, itemId: hostGate.itemId, onlineAccess: hostGate.onlineAccess });
          log("online access denied at host", hostGate.reason, "ip="+ip);
          return;
        }
        const code = newCode();
        const room = makeRoom(code);
        const playerId = room.nextPlayerId++;
        const token = newToken();
        room.hostPlayerId = playerId;
        room.players.set(playerId, { id: playerId, token, name: cleanName(msg.name, "Host"), ws, connected: true, isHost: true, accountId: hostAcctId });
        const seats = Array.isArray(msg.seats) ? msg.seats.map(s => ({
          name: isBadName(s.name) ? cleanName("", "Player") : cleanName(s.name, ""),
          type: s.type === "cpu" ? "cpu" : "human", diff: s.diff || "medium", claimedBy: null,
        })) : [];
        const firstHuman = seats.findIndex(s => s.type === "human");
        if (firstHuman >= 0) { seats[firstHuman].claimedBy = playerId; seats[firstHuman].name = room.players.get(playerId).name; }
        room.lobby = { n: msg.n === 6 ? 6 : 4, teams: !!msg.teams, seats };
        // v0.25 item 2: the host's chosen table speed seeds room.tableSpeed at creation (the
        // v0.19-flagged gap - it used to always start at the 1.0 default until the host found
        // the in-game Speed button). Validated against the client's real SPEED_OPTS range;
        // anything missing/odd just keeps the old default.
        const hostSpeed = Number(msg.speed);
        if (Number.isFinite(hostSpeed) && hostSpeed > 0 && hostSpeed <= 4) room.tableSpeed = hostSpeed;
        identify(room, playerId);
        touch(room);
        send(ws, { type: "created", code, playerId, token, lobby: lobbySnapshot(room), protocolVersion: PROTOCOL_VERSION });
        log("room created", code, "ip="+ip);
        return;
      }

      case "join": {
        // v0.15: {type:'join', protocolVersion, code, name}
        if (!protocolOk(msg)) { send(ws, { type: "protocolMismatch", message: PROTOCOL_MISMATCH_MESSAGE }); sendLegacyMismatch(ws, "join"); return; }
        const code = String(msg.code || "").toUpperCase();
        const room = rooms.get(code);
        if (!room) { send(ws, { type: "joinError", message: "That room code doesn't exist. Double check it with the host." }); return; }
        if (room.started) { send(ws, { type: "joinError", message: "That game already started. Ask the host to send a new code, or reconnect if you were already playing.", reason: "started" }); return; }
        if (isBadName(msg.name)) { send(ws, { type: "joinError", message: "Pick a nicer name." }); return; }
        // 2026-07-29 § ONLINE ACCESS - same front-door gate as "host" above, for the JOINING
        // player's own account. A game already `started` was already turned away above (existing
        // check), so by construction this only ever gates a brand-new seat in a lobby that hasn't
        // started - never an in-progress game (that's rejoin/reclaim, neither of which is gated).
        const joinAcctId = resolveAcctField(msg);
        const joinGate = onlineAccessGate(joinAcctId);
        if (joinGate) {
          send(ws, { type: "joinError", message: joinGate.message, reason: joinGate.reason, tokenCost: joinGate.tokenCost, itemId: joinGate.itemId, onlineAccess: joinGate.onlineAccess });
          log("online access denied at join", joinGate.reason, "ip="+ip);
          return;
        }
        const playerId = room.nextPlayerId++;
        const token = newToken();
        room.players.set(playerId, { id: playerId, token, name: cleanName(msg.name, "Player"), ws, connected: true, isHost: false, accountId: joinAcctId });
        identify(room, playerId);
        touch(room);
        send(ws, { type: "joined", code, playerId, token, lobby: lobbySnapshot(room), protocolVersion: PROTOCOL_VERSION });
        broadcast(room, { type: "lobby", lobby: lobbySnapshot(room) }, playerId);
        log("player joined", code, playerId, "ip="+ip);
        return;
      }

      case "rejoin": {
        // v0.15: {type:'rejoin', protocolVersion, code, playerId, token}. Old clients (no/low
        // protocolVersion) get the plain-language mismatch message instead of a confusing
        // silent failure - this matters here specifically because `rejoin` is also the path a
        // long-lived tab that never explicitly re-hosted/joined takes after a server deploy.
        if (!protocolOk(msg)) { send(ws, { type: "protocolMismatch", message: PROTOCOL_MISMATCH_MESSAGE }); sendLegacyMismatch(ws, "rejoin"); return; }
        const code = String(msg.code || "").toUpperCase();
        const room = rooms.get(code);
        const playerId = msg.playerId;
        const p = room && room.players.get(playerId);
        // v0.15.1 hotfix 2/2: this room is verifiably gone (never existed, expired, or the
        // token no longer matches) - see sendDeadRoomFollowup() above for why the follow-up
        // 'kicked' message is always safe here, for every client build.
        if (!room || !p || p.token !== msg.token) {
          const deadRoomMsg = "Couldn't reconnect you to that room - it may have ended.";
          send(ws, { type: "rejoinError", message: deadRoomMsg });
          sendDeadRoomFollowup(ws, deadRoomMsg);
          return;
        }
        // v0.16 item 2: this player deliberately left their seat for good (see "leaveForGood"
        // below) - their token still technically matches, but the seat is permanently a CPU
        // now and must never be reclaimable by the original human again.
        if (p.leftForGood) {
          const leftMsg = "You left that game for good - a computer is playing your seat now.";
          send(ws, { type: "rejoinError", message: leftMsg });
          sendDeadRoomFollowup(ws, leftMsg);
          return;
        }
        if (isUnmigratableRoom(room)) {
          send(ws, { type: "rejoinError", message: OLD_ROOM_MESSAGE });
          sendDeadRoomFollowup(ws, OLD_ROOM_MESSAGE);
          pruneUnmigratableRoom(room);
          return;
        }
        p.connected = true; p.ws = ws;
        /* v0.40 (2026-07-26) § ACCOUNTS - UPGRADE ONLY, and the "only" is the whole design.
           `acct` was captured once at the front door, which left one real hole: somebody who
           joined as a guest, signed in DURING the game, and then reconnected still had a null
           accountId and lost their result under the account-only switch. A rejoin may therefore
           now FILL a missing accountId - and nothing else. It can never overwrite one that is
           already set and it can never clear one, so an expired or missing session on a
           reconnect still cannot cost anybody their stats, which was the original reason rejoin
           did not touch identity at all. Twin of server.ts's. */
        if (p.accountId == null) { const up = resolveAcctField(msg); if (up) p.accountId = up; }
        identify(room, playerId);
        touch(room);
        const isHost = playerId === room.hostPlayerId;
        if (room.started) {
          send(ws, Object.assign({ type: "sync", lobby: lobbySnapshot(room), seatOwners: room.seatOwners }, gameSnapshotFields(room, isHost)));
        } else {
          // v0.25 item 1: the lobby snapshot carries readyPlayerIds now, so a mid-lobby
          // reconnect lands back on the seat screen with everyone's ready state intact.
          send(ws, { type: "lobby", lobby: lobbySnapshot(room), isHost, protocolVersion: PROTOCOL_VERSION });
        }
        broadcast(room, { type: "presence", playerId, connected: true }, playerId);
        if (playerId === room.hostPlayerId) broadcast(room, { type: "hostStatus", connected: true }, playerId);
        log("player rejoined", code, playerId, "ip="+ip);
        return;
      }

      case "reclaim": {
        // v0.10.3, protocol-versioned in v0.15: {type:'reclaim', protocolVersion, code, name}
        if (!protocolOk(msg)) { send(ws, { type: "protocolMismatch", message: PROTOCOL_MISMATCH_MESSAGE }); sendLegacyMismatch(ws, "reclaim"); return; }
        const code = String(msg.code || "").toUpperCase();
        const room = rooms.get(code);
        // v0.15.1 hotfix 2/2: same "this room is verifiably gone" follow-up as the rejoin case
        // above - see sendDeadRoomFollowup().
        if (!room) {
          const deadRoomMsg = "That room code doesn't exist or has expired.";
          send(ws, { type: "reclaimError", message: deadRoomMsg });
          sendDeadRoomFollowup(ws, deadRoomMsg);
          return;
        }
        if (!room.started) { send(ws, { type: "reclaimError", message: "That game hasn't started yet - use Join a game instead.", reason: "notStarted" }); return; }
        if (isUnmigratableRoom(room)) {
          send(ws, { type: "reclaimError", message: OLD_ROOM_MESSAGE });
          sendDeadRoomFollowup(ws, OLD_ROOM_MESSAGE);
          pruneUnmigratableRoom(room);
          return;
        }
        if (isBadName(msg.name)) { send(ws, { type: "reclaimError", message: "Pick a nicer name." }); return; }
        const wantName = String(msg.name || "").trim().toLowerCase();
        const allNamed = Array.from(room.players.values()).filter(p => p.name.trim().toLowerCase() === wantName);
        // v0.16 item 2: a player who left for good can never be reclaimed back into their old
        // seat - filter them out, but give a clearer message than the generic "no one named X"
        // when that's the ONLY reason nothing matched.
        const candidates = allNamed.filter(p => !p.leftForGood);
        if (candidates.length === 0) {
          if (allNamed.some(p => p.leftForGood)) {
            send(ws, { type: "reclaimError", message: `${cleanName(msg.name,'That player')} left that game for good - a computer is playing their seat now.` });
          } else {
            send(ws, { type: "reclaimError", message: `No one named "${cleanName(msg.name,'that')}" is in that game.` });
          }
          return;
        }
        const target = candidates.find(p => !p.connected) || candidates[0];
        if (target.connected) {
          const hostP = room.players.get(room.hostPlayerId);
          if (!hostP || !hostP.connected || !hostP.ws) {
            send(ws, { type: "reclaimError", message: `${target.name} is already connected and the host isn't reachable to confirm a takeover - try again in a bit.` });
            return;
          }
          const reqId = newToken();
          // v0.40: the contested branch resolves the challenger's identity NOW, while their
        // `acct` field is in hand, and carries it to reclaimApprove below - the host's approval
        // message obviously cannot carry the challenger's session token.
        pendingReclaims.set(reqId, { code, targetPlayerId: target.id, ws, accountId: resolveAcctField(msg), expires: Date.now() + RECLAIM_TIMEOUT_MS });
          send(hostP.ws, { type: "reclaimRequest", reqId, name: target.name });
          send(ws, { type: "reclaimPending", message: `${target.name} looks like they're already connected - asking the host to confirm.` });
          log("reclaim contested, asked host", code, target.id, "ip="+ip);
          return;
        }
        target.token = newToken();
        target.ws = ws; target.connected = true;
        /* v0.40 (2026-07-26) § ACCOUNTS: reclaim is "a DIFFERENT device is taking this seat by
           name", so unlike rejoin it re-asserts identity OUTRIGHT, including to null. Leaving the
           previous occupant's accountId in place would credit their account for a game somebody
           else finished, which is worse than crediting nobody. Twin of server.ts's. */
        target.accountId = resolveAcctField(msg);
        identify(room, target.id);
        touch(room);
        const isHost = target.id === room.hostPlayerId;
        send(ws, Object.assign({ type: "reclaimed", code, playerId: target.id, token: target.token, lobby: lobbySnapshot(room), seatOwners: room.seatOwners }, gameSnapshotFields(room, isHost)));
        broadcast(room, { type: "presence", playerId: target.id, connected: true }, target.id);
        if (isHost) broadcast(room, { type: "hostStatus", connected: true }, target.id);
        log("player reclaimed seat by name", code, target.id, "ip="+ip);
        return;
      }

      case "reclaimApprove": {
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (playerId !== room.hostPlayerId) return;
        const pending = pendingReclaims.get(msg.reqId);
        if (!pending || pending.code !== room.code) return;
        pendingReclaims.delete(msg.reqId);
        const target = room.players.get(pending.targetPlayerId);
        if (!msg.approve || !target) { send(pending.ws, { type: "reclaimError", message: "The host didn't approve that." }); return; }
        const oldWs = target.ws;
        target.token = newToken();
        target.ws = pending.ws; target.connected = true;
        target.accountId = pending.accountId || null;   // v0.40: see the reclaim case above
        if (pending.ws.identify) pending.ws.identify(room, target.id);
        touch(room);
        if (oldWs && oldWs !== pending.ws) { try { send(oldWs, { type: "kicked", message: "Someone else took over your seat." }); oldWs.terminate(); } catch (e) {} }
        const isHost = target.id === room.hostPlayerId;
        send(pending.ws, Object.assign({ type: "reclaimed", code: room.code, playerId: target.id, token: target.token, lobby: lobbySnapshot(room), seatOwners: room.seatOwners }, gameSnapshotFields(room, isHost)));
        broadcast(room, { type: "presence", playerId: target.id, connected: true }, target.id);
        log("reclaim approved by host", room.code, target.id);
        return;
      }

      case "claimSeat": {
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (!room.lobby || room.started) return;
        // v0.25 item 1: "Ready up" locks the seat choice in - a ready player can't move seats.
        if (room.ready && room.ready.has(playerId)) return;
        const seat = room.lobby.seats[msg.seatIndex];
        if (!seat) return;
        if (seat.claimedBy === room.hostPlayerId) return;
        if (seat.claimedBy != null && seat.claimedBy !== playerId) return;
        room.lobby.seats.forEach(s => { if (s.claimedBy === playerId) s.claimedBy = null; });
        seat.claimedBy = playerId;
        seat.type = "human";
        if (msg.name && !isBadName(msg.name)) seat.name = cleanName(msg.name, seat.name);
        touch(room);
        broadcast(room, { type: "lobby", lobby: lobbySnapshot(room) });
        return;
      }

      case "setSeat": {
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (playerId !== room.hostPlayerId || !room.lobby || room.started) return;
        const seat = room.lobby.seats[msg.seatIndex];
        if (!seat) return;
        const patch = msg.patch || {};
        if (patch.type === "cpu" && seat.claimedBy != null) {
          const kicked = seat.claimedBy;
          seat.claimedBy = null;
          if (room.ready) room.ready.delete(kicked);   // v0.25 item 1: a kicked guest's ready mark goes with them
          const kp = room.players.get(kicked);
          if (kp) send(kp.ws, { type: "kicked", message: "The host turned your seat into a CPU." });
        }
        if (patch.type) seat.type = patch.type === "cpu" ? "cpu" : "human";
        // 2026-07-24 (Blake's follow-up: "let me set the cpu difficulty when playing an online
        // game") - host-only (guarded above, unchanged), CPU-seat difficulty patch. Validated
        // against the same three real tiers takeOverSeat already checks (easy/medium/hard -
        // Easy/Tricky/Nasty are just the display names, see index.html's DIFF_LABEL) rather than
        // trusting the wire value directly - an unrecognized string would otherwise sit on the
        // seat forever (harmless at play time, since chooseAI() already falls back to
        // AI_TIERS.medium for anything it doesn't recognize, but it would show as a broken/blank
        // label everywhere the lobby displays it, both to the host and to every guest).
        if (patch.diff && ["easy", "medium", "hard"].includes(patch.diff)) seat.diff = patch.diff;
        if (patch.name != null && !isBadName(patch.name)) seat.name = cleanName(patch.name, seat.name);
        touch(room);
        broadcast(room, { type: "lobby", lobby: lobbySnapshot(room) });
        return;
      }

      case "start": {
        // v0.25 item 1: {type:'start', willSeat} - host-only, and only once every claimed
        // NON-HOST seat's player has readied up on the seat screen (guestsAllReady() - the
        // client disables the Start button until then too; this is the authoritative gate).
        // The v0.16-v0.24 post-Start readyCheck phase is GONE: readiness already happened in
        // the lobby, so this deals (via the v0.22 seat gate) immediately. The host's own
        // willSeat rides this message - their Start tap is their ready-up.
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (playerId !== room.hostPlayerId || room.started || !room.lobby) return;
        if (!guestsAllReady(room)) {
          send(ws, { type: "error", message: "Waiting for everyone to tap Ready up first." });
          return;
        }
        if (msg.willSeat) room.willSeat.add(playerId);
        actuallyStartGame(room);
        return;
      }

      case "readyUp": {
        // v0.25 item 1: {type:'readyUp', willSeat} - a guest on the seat screen locks their
        // seat choice in. Valid any time in the lobby (there is no separate ready phase
        // anymore); requires an actually-claimed seat. willSeat carries the v0.22 seat-gate
        // promise exactly as before (a 'seated' will follow once their board is visible).
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (!room.lobby || room.started) return;
        if (!room.lobby.seats.some(s => s.claimedBy === playerId)) return;
        if (msg.willSeat) room.willSeat.add(playerId);
        room.ready.add(playerId);
        touch(room);
        broadcast(room, { type: "lobby", lobby: lobbySnapshot(room) });
        return;
      }

      case "action": {
        // v0.15: {type:'action', action:{kind:'move', seat, m}} — the ONLY action a client may
        // ever originate now. CPU moves and reshuffles are no longer client-generated at all
        // (see driveTurnLoop above) — any other kind is silently ignored (forward-compat safe
        // default, matches this file's existing "no such case, do nothing" convention).
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (!room.started || !room.engine) return;
        const action = msg.action;
        if (!action || action.kind !== "move") return;
        const E = room.engine, G = E.getG();
        if (!G || G.over) return;
        const owner = room.seatOwners[action.seat];
        if (owner == null || owner !== playerId) return; // not authorized for this seat
        if (action.seat !== G.turn) {
          // Stale/out-of-turn submission (a race against a very recent server-side action this
          // client hasn't seen yet) — don't crash the room, just resync this ONE client.
          send(ws, Object.assign({ type: "sync", lobby: lobbySnapshot(room), seatOwners: room.seatOwners }, gameSnapshotFields(room, playerId === room.hostPlayerId)));
          return;
        }
        const legal = E.legalMoves(action.seat);
        const match = legal.find(lm => sameMove(lm, action.m));
        if (!match) {
          log("rejected illegal/stale move", room.code, "playerId="+playerId, "seat="+action.seat);
          send(ws, Object.assign({ type: "sync", lobby: lobbySnapshot(room), seatOwners: room.seatOwners }, gameSnapshotFields(room, playerId === room.hostPlayerId)));
          return;
        }
        E.applyMove(action.seat, match);
        tallyKnockout(E, match);   // 2026-07-24 item 9 - see that function's comment
        if (E.getG().over) { appendAction(room, { kind: "move", seat: action.seat, m: match, turn: G.turn }); finishGame(room); return; }
        E.advanceTurn();
        // v0.15 bug fix: send the resulting turn number explicitly - see driveTurnLoop()'s
        // matching comment (CPU-move branch) for the full root-cause writeup. maybeStateCheck()
        // moved to AFTER advanceTurn() too - see driveTurnLoop()'s second matching comment.
        const humanMoveSeqNum = appendAction(room, { kind: "move", seat: action.seat, m: match, turn: E.getG().turn });
        if (match.kick || match.type === "swap") maybeStateCheck(room, humanMoveSeqNum);
        driveTurnLoop(room);
        return;
      }

      case "leaveForGood": {
        // v0.16 item 2: {type:'leaveForGood'} — a human seat permanently converts to a CPU for
        // the rest of THIS game. No "host is special" branch anywhere here on purpose - a host
        // leaving for good is handled identically to any other seat (see HANDOFF.md v0.16 for
        // the audit of host-lifecycle logic that confirmed nothing else depends on the host
        // staying human/connected past this point).
        if (!ctx) return;
        const { room, playerId } = ctx;
        const converted = leaveSeatForGoodInternal(ctx, ws);
        log("player left for good", room.code, playerId, converted ? "(seat converted to CPU)" : "(no active seat)");
        return;
      }

      case "surrender": {
        // v0.27: {type:'surrender'} — Blake's ask: the topbar Quit button, "Leave without
        // saving" and "Have a computer take over my seat" (both under Pause/Save's sheet), and
        // deleting a saved-game tile for a room you're in, ALL permanently abandon an unfinished
        // game now and count as a loss on the leaderboard (see index.html's
        // doSurrenderCurrentGame()/surrenderOnlineTile(), HANDOFF.md v0.27 for the full design
        // and why those sheet buttons converge on this same message). Records exactly one
        // hg<mode>+1 for THIS seat's stored name — no hw<mode>, no points, the same per-seat
        // loss shape buildResultEntriesServer() already writes for a real finish, just recorded
        // without G.over ever becoming true — then reuses the EXACT SAME conversion/lockout
        // machinery as "leaveForGood" via leaveSeatForGoodInternal() below (this seat becomes a
        // CPU for the rest of the game; every other player's table is completely untouched).
        // Additive-safe by construction: old clients simply never send this message type.
        //
        // v0.27.1 § NO-FAULT EXIT — Blake's follow-up: once ANY human has surrendered in this
        // still-unfinished game, the competitive game everyone else agreed to play was already
        // altered by someone else's choice, not their own — so every OTHER human's subsequent
        // departure from this SAME game (via any of these same surrender-flagged paths) is now
        // FREE: no loss recorded, a true stat-wise no-op. room.anySurrenderOccurred (see
        // makeRoom()/actuallyStartGame()) is the sticky per-game-instance flag: false at every
        // genuinely new game/rematch, flips true the moment the FIRST surrender writes its loss
        // below, and never un-sets again for the rest of THIS game — so a second, third, etc.
        // surrenderer all read it as already-true and all get the free exit (no extra logic
        // needed beyond "check it, don't re-check who else already left"). The seat still
        // converts to a CPU exactly as before either way — only the stat consequence changes.
        // Broadcasting 'surrenderOccurred' the instant it flips true lets every OTHER player
        // still sitting at the table see the no-fault state live (index.html's
        // openSurrenderConfirm()), before THEY decide to leave — not just after the fact.
        if (!ctx) return;
        const { room, playerId } = ctx;
        const converted = leaveSeatForGoodInternal(ctx, ws, (G, seat, room) => {
          if (G.over || G.seats[seat].type !== "human") return;   // already finished, or not actually a human seat — nothing to surrender
          const mode = (G.n === 4 ? "4" : "6") + (G.teams ? "t" : "s");
          if (room.anySurrenderOccurred) {
            // Someone else already surrendered this same game - free, no-fault exit: no
            // hg<mode>, no loss, no points. Not a disguised win/draw, a true competitive no-op.
            //
            // 2026-07-25 (bug 5): this branch used to `return` right here, before building any
            // delta at all - so this player's already-accrued hkoDealt/hkoTaken were lost
            // permanently (their seat becomes a CPU immediately after, so finishGame() skips it
            // too, and nothing else ever writes them). That contradicted this handler's own
            // comment a few lines down ("a knockout isn't gated on how the game eventually
            // ends") and diverged from the offline twin recordOfflineSurrenderLoss(), which
            // always records them. A knockout already happened at the table; it is a fun
            // lifetime stat, not a competitive one, and nobody else's concession should erase
            // it. So the free exit still writes a delta - just one containing ONLY the knockout
            // keys. Twin of server.ts's matching branch.
            const koDelta = {};
            if (G.koDealt && G.koDealt[seat]) koDelta.hkoDealt = G.koDealt[seat];
            if (G.koTaken && G.koTaken[seat]) koDelta.hkoTaken = G.koTaken[seat];
            if (Object.keys(koDelta).length) applyLeaderboardEntry(G.seats[seat].name, koDelta);
            log("no-fault exit (someone already surrendered this game)", room.code, "seat=" + seat, "name=" + G.seats[seat].name, "mode=" + mode, "knockouts kept=" + JSON.stringify(koDelta));
            return;
          }
          const delta = {}; delta["hg" + mode] = 1;
          // 2026-07-24 item 9: whatever knockouts already happened THIS game before the surrender
          // are real and should still count - a knockout isn't gated on who eventually wins/quits.
          if (G.koDealt && G.koDealt[seat]) delta.hkoDealt = G.koDealt[seat];
          if (G.koTaken && G.koTaken[seat]) delta.hkoTaken = G.koTaken[seat];
          applyLeaderboardEntry(G.seats[seat].name, delta);
          room.anySurrenderOccurred = true;
          broadcast(room, { type: "surrenderOccurred" });
          log("surrender recorded", room.code, "seat=" + seat, "name=" + G.seats[seat].name, "mode=" + mode);
        });
        log("player surrendered", room.code, playerId, converted ? "(seat converted to CPU)" : "(no active seat)");
        return;
      }

      case "takeOverSeat": {
        // v0.25 items 6+7 § REJOIN LOBBY: {type:'takeOverSeat', seat, diff} - any seated
        // player may hand an ABSENT human's seat to a real CPU (Easy/Tricky/Nasty) from the
        // rejoin lobby. Same conversion machinery and same permanence as "leaveForGood"
        // (seatToCpu broadcast; the original player is locked out of the seat) - the only
        // difference is who asks: the table, about a player who is not there. Guards: the
        // sender must own a seat here; the target must be a live human seat whose owner is
        // genuinely away (disconnected or app-silent) - never converted under a player who
        // is actually present.
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (!room.started || !room.engine || !room.seatOwners) return;
        const seat = Number(msg.seat);
        const diff = ["easy", "medium", "hard"].includes(msg.diff) ? msg.diff : "medium";
        const G = room.engine.getG();
        if (!G || G.over) return;
        if (!room.seatOwners.includes(playerId)) return;      // only a seated player may ask
        const seatCfg = G.seats[seat];
        if (!seatCfg || seatCfg.type !== "human") return;
        const ownerId = room.seatOwners[seat];
        if (ownerId == null || ownerId === playerId) return;  // your own seat has "leaveForGood"
        const owner = room.players.get(ownerId);
        if (!playerLooksAway(owner)) return;                  // they're right there - hands off
        if (owner) owner.leftForGood = true;                  // same permanent lockout as leaveForGood
        const takenName = seatCfg.name;
        seatCfg.type = "cpu";
        seatCfg.diff = diff;
        room.seatOwners[seat] = null;
        touch(room);
        appendAction(room, { kind: "seatToCpu", seat, diff, name: takenName });
        // The seat may be the on-turn seat everyone has been waiting on - drive forward now.
        driveTurnLoop(room);
        // 2026-07-23: converting the last missing seat can complete an open reunion gate on its
        // own (nobody left to ready up for) - re-check.
        maybeResolveReunion(room);
        log("rejoin lobby: seat handed to a computer", room.code, "seat=" + seat, "diff=" + diff, "by playerId=" + playerId);
        return;
      }

      case "requestStateCheck": {
        // v0.15: simplified — the server IS the authority now, so it can just answer directly
        // instead of relaying to the host (v0.14's design, back when only the host's phone
        // could compute a digest). Still the same wire shape/name for minimal client churn.
        // Tags with the most recent broadcast seq (room.nextSeq-1) - this is an ON-DEMAND
        // check (someone's phone just came back from the background), not tied to any
        // particular action, so "everything broadcast so far" is the right checkpoint.
        // v0.20: superseded as the CLIENT's own foreground-trigger (see index.html's
        // triggerRecalibration(), which sends "resync" instead — a direct fresh snapshot beats
        // a digest compare that can only ever get resolved by a LATER action, see HANDOFF.md
        // v0.20's root-cause writeup). Kept working here, unmodified, purely so a pre-v0.20
        // client (build 16-26) still gets its existing self-heal path — new clients never send
        // this message at all.
        if (!ctx) return;
        const { room } = ctx;
        if (!room.started || !room.engine) return;
        maybeStateCheck(room, room.nextSeq - 1);
        return;
      }

      case "seated": {
        // v0.22 P0b § SEAT GATE: this client's board is genuinely on screen with no pre-game
        // overlay in the way - release its slot; the last one out releases the first deal.
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (room.seatGate) { releaseSeatGateSlot(room, playerId, "all seated"); return; }
        // Belt-and-suspenders restart recovery: a restart loses the transient gate, and a
        // room can in principle sit at nextSeq===1 (start broadcast, first deal never dealt)
        // with nothing left to trigger the loop - any seated client is a safe re-drive
        // moment (the loop no-ops unless the server genuinely owes the table something).
        if (room.started && room.engine && !room.paused) {
          const G = room.engine.getG();
          if (G && !G.over && room.nextSeq === 1) driveTurnLoop(room);
        }
        return;
      }

      case "resync": {
        // v0.20: lightweight "give me a fresh full snapshot right now" for a client that
        // already has a live, identified connection (ctx set from an earlier host/join/rejoin/
        // reclaim on THIS SAME websocket) — see HANDOFF.md v0.20's "unconditional resync on
        // every foreground" design. Deliberately NOT the same code path as "rejoin": rejoin
        // assumes the connection itself needed re-establishing (touches p.connected, broadcasts
        // presence/hostStatus to the rest of the room) — none of that is warranted here, since
        // by construction this message can only arrive over a socket the server already thinks
        // is fine. Skipping those side effects means a client can call this on EVERY single
        // foreground without ever causing a spurious "X reconnected" ripple for anyone else at
        // the table. Old (pre-v0.20) clients never send this message — fully additive, no
        // protocolVersion gate needed. Same response shape as "rejoin"'s success reply
        // ('sync'), so the client's EXISTING onSync()/bootGameFromSnapshot() handles it with
        // zero new client-side message-type handling.
        if (!ctx) return;
        const { room, playerId } = ctx;
        const p = room.players.get(playerId);
        if (!p || !room.started || !room.engine) return;
        const isHost = playerId === room.hostPlayerId;
        send(ws, Object.assign({ type: "sync", lobby: lobbySnapshot(room), seatOwners: room.seatOwners }, gameSnapshotFields(room, isHost)));
        return;
      }

      case "pauseToggle": {
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (!room.started) return;
        const wantPaused = !!msg.paused;
        // 2026-07-25 (bug 1) § REUNION GATE GUARD - see the big comment above maybeResolveReunion()
        // for the full root cause. Short version: this case used to set room.paused
        // unconditionally, so an unpause arriving while the ready-up gate was open both BYPASSED
        // the gate (play resumed with nobody having readied) and WEDGED it (reunionActive stayed
        // true forever, which made every later reunion a silent no-op for that room's whole
        // life). Two entirely ordinary taps produce that message - cancelling the Pause/Save
        // sheet, and an older build's tap-to-resume - so this had to be closed server-side.
        // An unpause is refused while the gate is open and the player is told plainly why; the
        // gate itself is untouched (still open, still waiting, still capped). A PAUSE request is
        // still accepted, because it changes nothing: the gate has already paused the table.
        if (!wantPaused && room.reunionActive) {
          send(ws, { type: "error", message: "Everyone is checking in first. Tap Ready up when you are ready to keep playing." });
          // Re-state the truth to just this player, so a client that assumed its own tap worked
          // (or an older build with no idea this gate exists) lands back on the real state.
          send(ws, { type: "paused", paused: true });
          send(ws, { type: "reunionStatus", active: true, readyPlayerIds: Array.from(room.tableReady || []) });
          log("unpause refused - reunion gate open", room.code, "playerId=" + playerId);
          return;
        }
        room.paused = wantPaused;
        touch(room);
        broadcast(room, { type: "paused", paused: room.paused });
        return;
      }

      case "requestReunion": {
        // 2026-07-23 (Blake's item 2) § REUNION READY GATE - a client sends this the moment it
        // deliberately comes back to a game (index.html's onSync() enteringViaResume branch),
        // ALWAYS, regardless of whether anyone else looks missing - that's the whole point (see
        // the big comment above this section). Idempotent: if a reunion is already open (someone
        // else's return already started one, or the table just happened to already be paused),
        // this is a no-op - the caller just opens the SAME lobby via the reunionActive/
        // tableReadyIds fields already riding the 'sync' they got, not a second one.
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (!room.started || !room.engine) return;
        // 2026-07-25 (bug 7): the same seat check its sibling "tableReadyUp" below has always
        // had. Without it a guest who joined the lobby but never claimed a seat could pause the
        // whole table with this message - and then could NOT clear it, because tableReadyUp
        // does check seatOwners, so their own ready-up was rejected. Only somebody who is
        // actually playing can call the table back together.
        if (!room.seatOwners || !room.seatOwners.includes(playerId)) return;
        if (!room.reunionActive) {
          room.paused = true;
          room.reunionActive = true;
          room.tableReady = new Set();
          room.reunionOpenedAt = Date.now();   // 2026-07-25 (bug 2): starts REUNION_GATE_CAP_MS
          touch(room);
          broadcast(room, { type: "paused", paused: true });
          broadcast(room, { type: "reunionStatus", active: true, readyPlayerIds: [] });
          log("reunion opened", room.code, "by playerId=" + playerId);
        }
        return;
      }

      case "tableReadyUp": {
        // 2026-07-23 (Blake's item 2): {type:'tableReadyUp'} - a connected human seat owner
        // checking in during an open reunion gate. Requires an actually-seated human (mirrors
        // "readyUp"'s pre-start seat check) and an ACTIVE gate - harmless no-op otherwise (a
        // stale/late tap after the table already resumed on its own).
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (!room.started || !room.engine || !room.reunionActive) return;
        if (!room.seatOwners || !room.seatOwners.includes(playerId)) return;
        room.tableReady.add(playerId);
        touch(room);
        broadcast(room, { type: "reunionStatus", active: true, readyPlayerIds: Array.from(room.tableReady) });
        maybeResolveReunion(room);
        return;
      }

      case "setTableSpeed": {
        // v0.15: {type:'setTableSpeed', speed} — host-only (mirrors the CPU-move/reshuffle
        // authorization pattern this file has always used for "one player's phone is briefly
        // special"), replacing each phone's own local speed choice while a table is online. See
        // index.html § UTIL's applySpeed()/SPEED_OPTS for the offline-unchanged local version.
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (playerId !== room.hostPlayerId || !room.started) return;
        const speed = Number(msg.speed);
        if (!Number.isFinite(speed) || speed <= 0) return;
        room.tableSpeed = speed;
        touch(room);
        broadcast(room, { type: "tableSpeed", speed: room.tableSpeed });
        return;
      }

      case "nudge": {
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (!room.started) return;
        const target = room.players.get(msg.targetPlayerId);
        const sender = room.players.get(playerId);
        if (target && target.ws) send(target.ws, { type: "nudged", fromPlayerId: playerId, fromName: sender ? sender.name : "Someone" });
        // v0.22 § AWAY LADDER: a nudge aimed at the disconnected/silent ON-TURN player also
        // re-fires the turn push (rate-limited per away stretch) - this is the "Nudge again"
        // button's whole point once the live-toast route above can't reach them.
        if (room.engine && room.seatOwners) {
          const G = room.engine.getG();
          if (G && !G.over && room.seatOwners[G.turn] === msg.targetPlayerId && playerLooksAway(target)) {
            const a = room.away;
            const now = Date.now();
            if (!a || now - (a.lastPushAt || 0) > AWAY_REPUSH_MIN_MS) {
              if (a) a.lastPushAt = now;
              maybeSendTurnPush(room, G.turn);
            }
          }
        }
        return;
      }

      case "playTurnForAway": {
        // v0.22 § AWAY LADDER: {type:'playTurnForAway', seat} - ANY connected player may, once
        // the ladder's cpuOffer stage has been reached for that exact seat's current turn, have
        // the server play that ONE turn with the Tricky AI. One tap, no vote; the first tap
        // wins (the turn advances, so a second tap fails the seat===G.turn check and is
        // silently ignored). The seat STAYS human, its owner rejoins normally - this is help,
        // never a takeover. Old clients never send this message - fully additive.
        if (!ctx) return;
        const { room } = ctx;
        if (!room.started || !room.engine || room.paused) return;
        const E = room.engine, G = E.getG();
        if (!G || G.over) return;
        const seat = Number(msg.seat);
        if (seat !== G.turn) return;                       // stale tap - the turn already moved on
        if (!G.seats[seat] || G.seats[seat].type !== "human") return;
        const ownerId = room.seatOwners ? room.seatOwners[seat] : null;
        if (ownerId == null) return;
        if (!playerLooksAway(room.players.get(ownerId))) return;   // they're back - it's their turn again
        if (!room.away || room.away.seat !== seat || !room.away.offerSent) return;   // only after the offer stage
        const moves = E.legalMoves(seat);
        if (moves.length === 0) return;   // defensive - driveTurnLoop would have auto-passed this seat
        // chooseAI at Tricky ("medium" - this codebase's internal name for it) regardless of
        // anything stored on the seat - a one-turn assist, not a difficulty change; the seat's
        // own config is restored immediately after the pick.
        const savedDiff = G.seats[seat].diff;
        G.seats[seat].diff = "medium";
        const m = E.chooseAI(seat, moves);
        G.seats[seat].diff = savedDiff;
        E.applyMove(seat, m);
        tallyKnockout(E, m);   // 2026-07-24 item 9 - see that function's comment
        log("away ladder: computer played one turn for seat", seat, "room", room.code);
        broadcastAwayClear(room);
        if (E.getG().over) { appendAction(room, { kind: "move", seat, m, turn: G.turn }); finishGame(room); return; }
        E.advanceTurn();
        // Same explicit-turn + post-advance digest pattern as every other move site (v0.15
        // bugs #3/#4 - see driveTurnLoop's comments).
        const awaySeqNum = appendAction(room, { kind: "move", seat, m, turn: E.getG().turn });
        if (m.kick || m.type === "swap") maybeStateCheck(room, awaySeqNum);
        driveTurnLoop(room);
        return;
      }

      case "registerPush": {
        // v0.16 item 5: {type:'registerPush', token, platform} — the iOS app registers (or
        // RE-registers, after every reconnect - see index.html's onSync()/bootGameFromNetwork())
        // its APNs device token here. Tied to the SAME per-connection identity (this playerId's
        // player record) that a rejoin token/reclaim-by-name already key off - see
        // maybeSendTurnPush() above. Never logs the token value itself (not a secret, but no
        // reason to put a device identifier in plain logs either — same restraint as the rest
        // of this file's logging).
        if (!ctx) return;
        const { room, playerId } = ctx;
        const p = room.players.get(playerId);
        if (!p) return;
        const token = typeof msg.token === "string" ? msg.token.trim().slice(0, 512) : "";
        if (!token) return;
        p.pushToken = token;
        p.pushPlatform = "ios"; // only iOS ships right now - a real value once a second platform ever exists
        touch(room);
        log("push token registered", room.code, "playerId=" + playerId);
        return;
      }

      default:
        return;
    }
  }
});

/* § HEARTBEAT - twin of server.ts's block of the same name, keep the two in sync.
 * 2026-07-26: rewritten to match the cloud server exactly. What changed and why:
 *
 * OLD RULE: terminate a socket that missed two PROTOCOL-FRAME pongs (so 25-50s at the old 25s
 * interval). The flaw is not the timing, it is what was being measured. A backgrounded iOS
 * WKWebView's NETWORKING process keeps answering protocol-frame pings all by itself while the
 * page's JavaScript is completely suspended - that is the documented zombie shape this repo's
 * freeze harness exists to reproduce. So the old rule could look at a phone that has been
 * asleep in someone's pocket for five minutes and call it healthy.
 *
 * NEW RULE (server.ts's, since v0.16): measure the APP-LEVEL echo instead. ws.lastAppMsgAt is
 * refreshed by any inbound application message, including the {type:'pong'} every live client
 * sends back to the {type:'ping'} below. Protocol-frame pongs deliberately do NOT refresh it
 * (see the ws.on("message") handler). Nothing inbound for SOCKET_STALE_MS means the CLIENT is
 * gone, whatever the socket claims, so tear it down: ws.terminate() destroys the connection
 * locally and fires 'close' immediately, which runs the normal disconnect bookkeeping and gets
 * the 'presence' broadcast out to the rest of the table. (Node can do this in one step. The
 * cloud server cannot - its platform only offers a close HANDSHAKE, which a dead pipe never
 * completes - so server.ts has to call its disconnect path by hand. Same outcome, same timing,
 * different amount of work to get there. See § THE DISCONNECT PATH over there.)
 *
 * The protocol-frame ping is still sent. It costs nothing and it keeps cellular NAT mappings
 * warm; it just no longer decides whether anybody is alive. */
const hb = setInterval(() => {
  const now = Date.now();
  // Collect first, terminate second: terminate() fires 'close' synchronously, and that handler
  // can touch room state, so mutating anything mid-forEach is asking for trouble. (Twin of the
  // same two-pass shape in server.ts's sweep.)
  const stale = [];
  wss.clients.forEach(ws => {
    if (now - (ws.lastAppMsgAt || now) > SOCKET_STALE_MS) { stale.push(ws); return; }
    try { ws.ping(); } catch (e) {}
    // v0.22 P4: app-level ping - the client echoes {type:'pong'} (index.html's 'ping' case,
    // shipped v0.16/build 18), which refreshes ws.lastAppMsgAt and thereby BOTH the § AWAY
    // LADDER's "silent" clock and (since 2026-07-26) this loop's own staleness rule.
    send(ws, { type: "ping", t: now });
  });
  for (const ws of stale) { try { ws.terminate(); } catch (e) {} }
}, HEARTBEAT_MS);

const pruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!roomIsFullyDisconnected(room)) continue;
    const ttl = room.started ? STARTED_ROOM_TTL_MS : ROOM_TTL_MS;
    if (now - room.lastActivity > ttl) {
      rooms.delete(code);
      deleteRoomFile(code);
      log("pruned room", code, room.started ? "(started, idle "+Math.round((now-room.lastActivity)/60000)+"m)" : "(lobby)");
    }
  }
}, PRUNE_EVERY_MS);

const reclaimSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [reqId, pending] of pendingReclaims) {
    if (now > pending.expires) {
      pendingReclaims.delete(reqId);
      send(pending.ws, { type: "reclaimError", message: "The host didn't respond in time - try again." });
    }
  }
}, 5000);

if (process.env.NASTY_DEBUG_DIGEST) {
  setInterval(() => {
    for (const [code, room] of rooms) {
      if (!room.engine) continue;
      const G = room.engine.getG();
      log('[HEARTBEAT]', code, 'turn=' + G.turn, 'actionSeq=' + G.actionSeq, 'dealSeq=' + G.dealSeq, 'over=' + G.over, 'hands=' + JSON.stringify(G.hands.map(h => h.length)), 'bowedOut=' + JSON.stringify(G.bowedOut), 'seats=' + JSON.stringify(G.seats.map(s => s.type)));
    }
  }, 2000);
}
loadRoomsFromDisk();
loadLeaderboard();
loadMonthlyHistory();   // 2026-07-28 § MONTHLY RANKING
migrateLegacyLeaderboardPoints();
// 2026-07-25 (bug 6): ORDER IS LOAD-BEARING - the solo/teams split runs first so a legacy
// pre-split row's plain "hpts" is turned into hptsS/hptsT while that row still stands alone;
// merging first would fold that row into a sibling that already has hptsS/hptsT, and the split
// migration's own "already split, skip" guard would then leave the legacy points stranded.
migrateLeaderboardNameCase();
loadSoloSeen();
loadLeaderboardEpoch();
// 2026-07-25 § ACCOUNTS (Stage 1): reads six small JSON files if they happen to exist and
// creates none of them. On a machine that has never had an account (every machine today) this
// leaves all six stores empty and writes nothing at all.
loadAccountStores();
loadPurchaseSeen();   // 2026-07-28 § POINTS WALLET - purchase-request dedupe, twin of loadSoloSeen()
loadIapLedger();      // 2026-07-30 § REAL-MONEY CREDIT PACKS - the forever replay ledger
loadIapEvents();      // 2026-07-30 § REAL-MONEY CREDIT PACKS - the Apple notification audit log
log(`admin token file: ${ADMIN_TOKEN_FILE}`);
log(`protocol version: ${PROTOCOL_VERSION}`);
log(`accounts: ${!ACCOUNTS_ENABLED ? "OFF (NASTY_ACCOUNTS_ENABLED=0)" : (accountsConfigured() ? "on, Apple audiences configured" : "on but Apple is not configured yet - /account/* answers 503")}`);

server.listen(PORT, () => log(`nasty relay listening on :${PORT}`));

function shutdown() {
  clearInterval(hb); clearInterval(pruneTimer); clearInterval(reclaimSweepTimer); clearInterval(awaySweepTimer);
  flushAllPersists();
  if (lbPersistTimer) { clearTimeout(lbPersistTimer); lbPersistTimer = null; }
  persistLeaderboardNow();
  if (soloSeenPersistTimer) { clearTimeout(soloSeenPersistTimer); soloSeenPersistTimer = null; }
  persistSoloSeenNow();
  persistLeaderboardEpoch();
  if (monthlyPersistTimer) { clearTimeout(monthlyPersistTimer); monthlyPersistTimer = null; }
  persistMonthlyHistoryNow();   // 2026-07-28 § MONTHLY RANKING
  flushAccountStores();   // 2026-07-25 § ACCOUNTS: only writes stores with a pending debounce
  for (const ws of wss.clients) { try { ws.terminate(); } catch (e) {} }
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
