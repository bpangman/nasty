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
const { sendTurnPush } = require("./apns.js");

const PORT = process.env.NASTY_PORT ? parseInt(process.env.NASTY_PORT, 10) : 8484;
// v0.8: two different prune windows. A lobby that never started is cheap to lose (nothing
// to come back to) so it keeps the original short fuse; a game that's actually IN PROGRESS
// needs to survive "come back tomorrow" — see PLANNING.md v0.8.
const ROOM_TTL_MS = 30 * 60 * 1000;              // never-started lobby, fully disconnected
const STARTED_ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // started-but-unfinished game, fully disconnected
const PRUNE_EVERY_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;
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
const PROTOCOL_VERSION = 2;
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
function loadLeaderboard() {
  try { globalBoard = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, "utf8")) || {}; }
  catch (e) { globalBoard = {}; }
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
const NUMERIC_STAT_KEY = /^(hg[46][st]|hw[46][st]|hpts)$/;
function applyLeaderboardEntry(name, delta) {
  const clean = cleanName(name, "");
  if (!clean || isBadName(clean) || !delta || typeof delta !== "object") return;
  const r = globalBoard[clean] = globalBoard[clean] || {};
  for (const k of Object.keys(delta)) {
    if (!NUMERIC_STAT_KEY.test(k)) continue;
    const v = Number(delta[k]);
    if (!Number.isFinite(v)) continue;
    r[k] = (r[k] || 0) + v;
  }
  scheduleLeaderboardPersist();
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
  res.end(JSON.stringify(globalBoard));
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
function buildResultEntriesServer(G, mode, winSet) {
  const entries = [];
  G.seats.forEach((seat, i) => {
    if (seat.type !== "human") return;
    const delta = {}; delta["hg" + mode] = 1;
    if (winSet.has(i)) { delta["hw" + mode] = 1; delta.hpts = pointsForWinServer(G, winSet); }
    entries.push({ name: seat.name, delta });
  });
  return entries;
}
function finishGame(room) {
  if (room.recorded) return; // idempotent — see comment block above
  room.recorded = true;
  touch(room);
  const G = room.engine.getG();
  const mode = (G.n === 4 ? "4" : "6") + (G.teams ? "t" : "s");
  const winSet = new Set(G.winners);
  const entries = buildResultEntriesServer(G, mode, winSet);
  for (const e of entries) applyLeaderboardEntry(e.name, e.delta);
  log("online game finished, recorded to global leaderboard", room.code,
    entries.map(e => e.name).join(",") || "(no human seats)");
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
  for (const e of entries) { if (e && e.name) applyLeaderboardEntry(e.name, e.delta); }
  soloSeen.set(gameId, Date.now());
  scheduleSoloSeenPersist();
  log("solo result recorded", gameId, entries.map(e => e && e.name).filter(Boolean).join(","));
  sendJson(res, 200, { ok: true, epoch: leaderboardEpoch });
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
    })),
    lobby: room.lobby, started: room.started, seatOwners: room.seatOwners, log: room.log,
    // v0.16 item 4: Sets aren't JSON-serializable directly - flatten readyPlayerIds to an array.
    readyCheck: room.readyCheck ? { requiredPlayerIds: room.readyCheck.requiredPlayerIds, readyPlayerIds: Array.from(room.readyCheck.ready) } : null,
    paused: !!room.paused,
    G: room.engine ? room.engine.getG() : null, tableSpeed: room.tableSpeed || 1,
    recorded: !!room.recorded, nextSeq: room.nextSeq || 0,
  };
}
function roomFromDisk(obj) {
  const room = {
    code: obj.code, createdAt: obj.createdAt || Date.now(), lastActivity: obj.lastActivity || Date.now(),
    hostPlayerId: obj.hostPlayerId, nextPlayerId: obj.nextPlayerId || 1,
    players: new Map(), lobby: obj.lobby || null, started: !!obj.started,
    seatOwners: obj.seatOwners || null, log: Array.isArray(obj.log) ? obj.log : [],
    readyCheck: obj.readyCheck ? { requiredPlayerIds: obj.readyCheck.requiredPlayerIds || [], ready: new Set(obj.readyCheck.readyPlayerIds || []) } : null,
    paused: !!obj.paused, engine: null, tableSpeed: obj.tableSpeed || 1,
    recorded: !!obj.recorded, nextSeq: obj.nextSeq || 0,
  };
  for (const p of (obj.players || []))
    room.players.set(p.id, {
      id: p.id, token: p.token, name: p.name, ws: null, connected: false, isHost: !!p.isHost, leftForGood: !!p.leftForGood,
      pushToken: p.pushToken || null, pushPlatform: p.pushPlatform || null,
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
}
function flushAllPersists() {
  for (const t of persistTimers.values()) clearTimeout(t);
  persistTimers.clear();
  for (const room of rooms.values()) persistRoomNow(room);
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
    // v0.16 item 4: {requiredPlayerIds:[...], readyPlayerIds:[...]} while the host has tapped
    // Start but the table hasn't all confirmed ready yet - null the rest of the time (plain
    // lobby, or already started). See "start"/"readyUp"/"cancelReadyCheck" below.
    readyCheck: null,
    log: [],
    paused: false,
    engine: null,        // v0.15: createEngine() instance, set at Start — the authoritative G
    tableSpeed: 1,        // v0.15: shared table pacing, host-controlled
    recorded: false,      // v0.15: leaderboard idempotency flag, see finishGame()
    nextSeq: 0,           // v0.15: ever-increasing action seq, independent of log trimming
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
  if (legal.type === "swap") return legal.ts === submitted.ts && legal.tpi === submitted.tpi;
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
  if (!player || player.connected) return;   // they're right there - no need to buzz their phone
  if (!player.pushToken) return;             // never registered (web player, or app player before granting permission)
  sendTurnPush({
    token: player.pushToken, playerName: G.seats[seat].name,
    title: "NASTY", body: "It's your turn in NASTY",
  }).catch(e => log("push send threw", room.code, e.message));
}

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
 * v0.16 item 4 § READY CHECK — host taps Start -> every HUMAN seat must confirm ready before
 * the server actually deals. CPU seats never block this (they have no one to ready up).
 * ------------------------------------------------------------------------------------- */
function startReadyCheck(room) {
  const requiredPlayerIds = Array.from(new Set(room.lobby.seats.filter(s => s.claimedBy != null).map(s => s.claimedBy)));
  room.readyCheck = { requiredPlayerIds, ready: new Set() };
  touch(room);
  broadcast(room, { type: "readyCheck", requiredPlayerIds, readyPlayerIds: [], lobby: lobbySnapshot(room) });
  log("room entered ready check", room.code, "required=" + requiredPlayerIds.length);
  maybeAdvanceReadyCheck(room);   // covers the zero-humans case (an all-CPU table) - proceeds immediately
}
function maybeAdvanceReadyCheck(room) {
  if (!room.readyCheck) return;
  const { requiredPlayerIds, ready } = room.readyCheck;
  if (!requiredPlayerIds.every(id => ready.has(id))) return;
  actuallyStartGame(room);
}
// The old "start" case's body, unchanged in substance - now triggered once the ready check
// clears instead of directly from the host's "start" message. See that case's comment.
function actuallyStartGame(room) {
  room.readyCheck = null;
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
  const G = engine.getG();
  const startAction = { kind: "start", n: G.n, teams: G.teams, seats: seatsCfg, dealer: G.dealer, deck: [], tableSpeed: room.tableSpeed || 1 };
  room.log = [{ seq: 0, action: startAction }];
  room.nextSeq = 1;
  touch(room);
  broadcast(room, { type: "gameAction", seq: 0, action: startAction, seatOwners: room.seatOwners });
  log("room started", room.code, `n=${n}`, room.lobby.teams ? "teams" : "ffa");
  driveTurnLoop(room);
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
      playerCount: r.players.size,
      players: Array.from(r.players.values()).map(p => ({ id: p.id, name: p.name, isHost: p.isHost, connected: p.connected })),
    }));
    sendJson(res, 200, list);
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
    scheduleLeaderboardPersist();
    log("admin deleted leaderboard entry", name);
    sendJson(res, 200, { ok: true });
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
  if (url.pathname.startsWith("/admin/")) {
    handleAdminRoute(req, res, url).catch((e) => { log("admin route error", e); sendJson(res, 500, { error: "server error" }); });
    return;
  }
  if (url.pathname === "/solo-result" && req.method === "POST") {
    handleSoloResult(req, res).catch((e) => { log("solo-result route error", e); sendJson(res, 500, { error: "server error" }); });
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
  };
}

wss.on("connection", (ws, req) => {
  const ip = remoteIp(req);
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  let ctx = null;

  ws.on("message", (raw) => {
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
        const code = newCode();
        const room = makeRoom(code);
        const playerId = room.nextPlayerId++;
        const token = newToken();
        room.hostPlayerId = playerId;
        room.players.set(playerId, { id: playerId, token, name: cleanName(msg.name, "Host"), ws, connected: true, isHost: true });
        const seats = Array.isArray(msg.seats) ? msg.seats.map(s => ({
          name: isBadName(s.name) ? cleanName("", "Player") : cleanName(s.name, ""),
          type: s.type === "cpu" ? "cpu" : "human", diff: s.diff || "medium", claimedBy: null,
        })) : [];
        const firstHuman = seats.findIndex(s => s.type === "human");
        if (firstHuman >= 0) { seats[firstHuman].claimedBy = playerId; seats[firstHuman].name = room.players.get(playerId).name; }
        room.lobby = { n: msg.n === 6 ? 6 : 4, teams: !!msg.teams, seats };
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
        // v0.16 item 4: mid ready-check, the seat list is locked in - a brand new guest joining
        // right now would land on a stale seat-picker with no idea a ready check is happening.
        if (room.readyCheck) { send(ws, { type: "joinError", message: "The host is starting the game - try again in a moment." }); return; }
        if (isBadName(msg.name)) { send(ws, { type: "joinError", message: "Pick a nicer name." }); return; }
        const playerId = room.nextPlayerId++;
        const token = newToken();
        room.players.set(playerId, { id: playerId, token, name: cleanName(msg.name, "Player"), ws, connected: true, isHost: false });
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
        identify(room, playerId);
        touch(room);
        const isHost = playerId === room.hostPlayerId;
        if (room.started) {
          send(ws, Object.assign({ type: "sync", lobby: lobbySnapshot(room), seatOwners: room.seatOwners }, gameSnapshotFields(room, isHost)));
        } else if (room.readyCheck) {
          // v0.16 item 4: reconnecting mid ready-check should land back on the ready-check
          // screen, not a stale plain-lobby seat picker.
          send(ws, { type: "lobby", lobby: lobbySnapshot(room), isHost, protocolVersion: PROTOCOL_VERSION });
          send(ws, { type: "readyCheck", requiredPlayerIds: room.readyCheck.requiredPlayerIds, readyPlayerIds: Array.from(room.readyCheck.ready), lobby: lobbySnapshot(room) });
        } else {
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
          pendingReclaims.set(reqId, { code, targetPlayerId: target.id, ws, expires: Date.now() + RECLAIM_TIMEOUT_MS });
          send(hostP.ws, { type: "reclaimRequest", reqId, name: target.name });
          send(ws, { type: "reclaimPending", message: `${target.name} looks like they're already connected - asking the host to confirm.` });
          log("reclaim contested, asked host", code, target.id, "ip="+ip);
          return;
        }
        target.token = newToken();
        target.ws = ws; target.connected = true;
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
        // v0.16 item 4: the seat list is locked in for the duration of a ready check - the
        // host must cancel back to the plain lobby (cancelReadyCheck) before anyone can move.
        if (!room.lobby || room.started || room.readyCheck) return;
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
        // v0.16 item 4: same lock as claimSeat above.
        if (playerId !== room.hostPlayerId || !room.lobby || room.started || room.readyCheck) return;
        const seat = room.lobby.seats[msg.seatIndex];
        if (!seat) return;
        const patch = msg.patch || {};
        if (patch.type === "cpu" && seat.claimedBy != null) {
          const kicked = seat.claimedBy;
          seat.claimedBy = null;
          const kp = room.players.get(kicked);
          if (kp) send(kp.ws, { type: "kicked", message: "The host turned your seat into a CPU." });
        }
        if (patch.type) seat.type = patch.type === "cpu" ? "cpu" : "human";
        if (patch.diff) seat.diff = patch.diff;
        if (patch.name != null && !isBadName(patch.name)) seat.name = cleanName(patch.name, seat.name);
        touch(room);
        broadcast(room, { type: "lobby", lobby: lobbySnapshot(room) });
        return;
      }

      case "start": {
        // v0.16 item 4: {type:'start'} used to deal immediately; it now only opens the READY
        // CHECK gate (see startReadyCheck()/maybeAdvanceReadyCheck() below) - the actual deal
        // happens once every human seat has confirmed ready (or immediately if there are none,
        // e.g. an all-CPU table). See HANDOFF.md v0.16 for the full design.
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (playerId !== room.hostPlayerId || room.started || !room.lobby || room.readyCheck) return;
        startReadyCheck(room);
        return;
      }

      case "readyUp": {
        // v0.16 item 4: {type:'readyUp'} - a human at the table confirms ready. CPU seats never
        // need this (only human `claimedBy` playerIds are ever in requiredPlayerIds).
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (!room.readyCheck || room.started) return;
        if (!room.readyCheck.requiredPlayerIds.includes(playerId)) return;
        room.readyCheck.ready.add(playerId);
        touch(room);
        broadcast(room, { type: "readyCheck", requiredPlayerIds: room.readyCheck.requiredPlayerIds, readyPlayerIds: Array.from(room.readyCheck.ready), lobby: lobbySnapshot(room) });
        maybeAdvanceReadyCheck(room);
        return;
      }

      case "cancelReadyCheck": {
        // v0.16 item 4: {type:'cancelReadyCheck'} - host-only, backs out to the plain lobby so
        // seats can be edited again.
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (playerId !== room.hostPlayerId || !room.readyCheck || room.started) return;
        room.readyCheck = null;
        touch(room);
        broadcast(room, { type: "readyCheckCancelled", lobby: lobbySnapshot(room) });
        log("room ready check cancelled", room.code);
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
        const p = room.players.get(playerId);
        // Invalidate this player's session for THIS room permanently, regardless of whether the
        // game has even started yet (covers the edge case of leaving mid-lobby too) - a token
        // match alone must never let them back into a seat they deliberately gave up.
        if (p) p.leftForGood = true;
        let converted = false;
        if (room.started && room.engine && room.seatOwners) {
          const seat = room.seatOwners.indexOf(playerId);
          if (seat >= 0) {
            const G = room.engine.getG();
            const seatCfg = G && G.seats[seat];
            if (seatCfg && seatCfg.type === "human") {
              const leaverName = seatCfg.name;
              seatCfg.type = "cpu";
              seatCfg.diff = "medium";   // "Tricky" - see engine.js chooseAI()'s diff naming
              room.seatOwners[seat] = null;
              converted = true;
              touch(room);
              appendAction(room, { kind: "seatToCpu", seat, diff: "medium", name: leaverName });
              // The seat may be sitting mid-turn waiting on exactly this human's move right
              // now - drive it forward immediately instead of stalling the table until
              // someone else's action happens to re-enter driveTurnLoop().
              driveTurnLoop(room);
            }
          }
        }
        if (!converted) touch(room);
        send(ws, { type: "leftForGood" });
        log("player left for good", room.code, playerId, converted ? "(seat converted to CPU)" : "(no active seat)");
        return;
      }

      case "requestStateCheck": {
        // v0.15: simplified — the server IS the authority now, so it can just answer directly
        // instead of relaying to the host (v0.14's design, back when only the host's phone
        // could compute a digest). Still the same wire shape/name for minimal client churn.
        // Tags with the most recent broadcast seq (room.nextSeq-1) - this is an ON-DEMAND
        // check (someone's phone just came back from the background), not tied to any
        // particular action, so "everything broadcast so far" is the right checkpoint.
        if (!ctx) return;
        const { room } = ctx;
        if (!room.started || !room.engine) return;
        maybeStateCheck(room, room.nextSeq - 1);
        return;
      }

      case "pauseToggle": {
        if (!ctx) return;
        const { room } = ctx;
        if (!room.started) return;
        room.paused = !!msg.paused;
        touch(room);
        broadcast(room, { type: "paused", paused: room.paused });
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

const hb = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
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
loadSoloSeen();
loadLeaderboardEpoch();
log(`admin token file: ${ADMIN_TOKEN_FILE}`);
log(`protocol version: ${PROTOCOL_VERSION}`);

server.listen(PORT, () => log(`nasty relay listening on :${PORT}`));

function shutdown() {
  clearInterval(hb); clearInterval(pruneTimer); clearInterval(reclaimSweepTimer);
  flushAllPersists();
  if (lbPersistTimer) { clearTimeout(lbPersistTimer); lbPersistTimer = null; }
  persistLeaderboardNow();
  if (soloSeenPersistTimer) { clearTimeout(soloSeenPersistTimer); soloSeenPersistTimer = null; }
  persistSoloSeenNow();
  persistLeaderboardEpoch();
  for (const ws of wss.clients) { try { ws.terminate(); } catch (e) {} }
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
