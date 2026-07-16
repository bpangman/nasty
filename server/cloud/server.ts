// NASTY relay server — Deno Deploy port of ../server.js (the Node/ws version, which stays
// intact for local dev/tests). SAME wire protocol, EXACTLY — every message type an old
// deployed client sends/expects (host/join/rejoin/claimSeat/setSeat/start/action/stateCheck/
// requestStateCheck/pauseToggle/recordResult/nudge, plus the /health, /leaderboard, /admin/*
// HTTP routes) is implemented identically here. See HANDOFF.md "Online multiplayer" +
// "Cloud hosting (Deno Deploy)" sections for the protocol reference and deploy instructions.
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
//    New-platform addition: a § HEARTBEAT interval (below) sends periodic 'pong' frames over
//    every open socket so the platform's idle-instance teardown (as short as 5s of total
//    silence, per its docs) never fires mid-game — old clients already silently ignore an
//    unsolicited 'pong', so this is not a wire-protocol change.
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

const PORT = Number(Deno.env.get("NASTY_PORT") ?? 8484);
const KV_PATH = Deno.env.get("NASTY_KV_PATH") || undefined; // undefined = Deploy's managed KV / local default

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
const NUMERIC_STAT_KEY = /^(hg[46][st]|hw[46][st]|hpts)$/;
async function applyLeaderboardEntry(name: unknown, delta: unknown) {
  const clean = cleanName(name, "");
  if (!clean || isBadName(clean) || !delta || typeof delta !== "object") return;
  for (const k of Object.keys(delta as Record<string, unknown>)) {
    if (!NUMERIC_STAT_KEY.test(k)) continue;
    const v = Number((delta as Record<string, unknown>)[k]);
    if (!Number.isFinite(v)) continue;
    await kv.atomic().sum(["leaderboard", clean, k], BigInt(Math.round(v))).commit();
  }
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
type Player = { id: number; token: string; name: string; isHost: boolean; connected: boolean };
type RoomMeta = {
  code: string; createdAt: number; lastActivity: number;
  hostPlayerId: number | null; nextPlayerId: number;
  players: Player[];
  lobby: { n: number; teams: boolean; seats: Seat[] } | null;
  started: boolean; seatOwners: (number | null)[] | null;
  paused: boolean; logCount: number;
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

async function getRoomLog(code: string, count: number): Promise<{ seq: number; action: unknown }[]> {
  const map = new Map<number, unknown>();
  for await (const e of kv.list({ prefix: ["roomlog", code] })) {
    map.set(Number(e.key[2]), e.value);
  }
  const out: { seq: number; action: unknown }[] = [];
  for (let i = 0; i < count; i++) out.push({ seq: i, action: map.get(i) });
  return out;
}

function lobbySnapshot(meta: RoomMeta) {
  if (!meta.lobby) return null;
  const snap = JSON.parse(JSON.stringify(meta.lobby));
  snap.hostSeatIndex = snap.seats.findIndex((s: Seat) => s.claimedBy === meta.hostPlayerId);
  return snap;
}
function presenceSnapshot(meta: RoomMeta) {
  const out: Record<number, boolean> = {};
  for (const p of meta.players) out[p.id] = !!p.connected;
  return out;
}

/* ---------------------------------------------------------------------------------------
 * § RELAY — cross-isolate fanout via BroadcastChannel, see file header point 3.
 * `localSockets`: code -> playerId -> WebSocket, only the sockets THIS isolate is holding.
 * `channels`: code -> BroadcastChannel, one per room this isolate currently cares about.
 * ------------------------------------------------------------------------------------- */
const localSockets = new Map<string, Map<number, WebSocket>>();
const channels = new Map<string, BroadcastChannel>();

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
 * § HEARTBEAT — new-platform adaptation, 2026-07-11. The new Deno Deploy platform tears an
 * instance down after "no new incoming requests ... or responses ... for a period of time"
 * as short as 5 SECONDS in the worst case (docs: "between 5 seconds and 10 minutes"), but
 * explicitly says WebSocket connections that actively transmit data — including ping/pong
 * frames — count as activity and keep the instance (and the socket) alive. Real games have
 * long idle gaps (someone's deciding a move, a phone's just sitting on the board), so without
 * this, a family member who steps away for a couple minutes could come back to a silently
 * dropped connection. This sends the SAME 'pong' message the protocol already uses (echoed
 * today only in response to a client 'ping', see the "ping" case above) to every socket this
 * isolate holds, often enough to stay comfortably under the platform's shortest possible idle
 * window. Old/unmodified clients already silently ignore an unsolicited 'pong' (no matching
 * switch case in handleNetMessage does anything with it) — zero wire-protocol change.
 * ------------------------------------------------------------------------------------- */
const HEARTBEAT_MS = 4000;
setInterval(() => {
  const now = Date.now();
  for (const socks of localSockets.values()) {
    for (const ws of socks.values()) send(ws, { type: "pong", t: now });
  }
  // v0.10.3: a contested reclaim (see PendingReclaim above) the host never answered — tell the
  // requester instead of leaving them hanging forever.
  for (const [reqId, pending] of pendingReclaims) {
    if (now > pending.expires) {
      pendingReclaims.delete(reqId);
      send(pending.socket, { type: "reclaimError", message: "The host didn't respond in time — try again." });
    }
  }
}, HEARTBEAT_MS);

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
        players: meta.players.map((p) => ({ id: p.id, name: p.name, isHost: p.isHost, connected: !!p.connected })),
      });
    }
    return json(200, out);
  }
  if (parts.length === 3 && parts[1] === "rooms" && req.method === "DELETE") {
    const code = parts[2].toUpperCase();
    const cur = await kv.get<RoomMeta>(roomKey(code));
    if (cur.value) {
      forceCloseRoomSockets(code);
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
        if (!underHostRateLimit(ip)) {
          send(socket, { type: "error", message: "Too many rooms created from here — wait a minute and try again." });
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
        const meta: RoomMeta = {
          code, createdAt: Date.now(), lastActivity: Date.now(),
          hostPlayerId: playerId, nextPlayerId: 2,
          players: [{ id: playerId, token, name: hostName, isHost: true, connected: true }],
          lobby: { n: msg.n === 6 ? 6 : 4, teams: !!msg.teams, seats },
          started: false, seatOwners: null, paused: false, logCount: 0,
        };
        await kv.set(roomKey(code), meta, { expireIn: ROOM_TTL_MS });
        identify(code, playerId);
        send(socket, { type: "created", code, playerId, token, lobby: lobbySnapshot(meta) });
        log("room created", code, "ip=" + ip);
        return;
      }

      case "join": {
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
        send(socket, { type: "joined", code, playerId, token, lobby: lobbySnapshot(r.meta) });
        broadcastRoom(code, { type: "lobby", lobby: lobbySnapshot(r.meta) }, playerId);
        log("player joined", code, playerId, "ip=" + ip);
        return;
      }

      case "rejoin": {
        const code = String(msg.code || "").toUpperCase();
        const pre = await kv.get<RoomMeta>(roomKey(code));
        const playerId = Number(msg.playerId);
        const preP = pre.value && pre.value.players.find((p) => p.id === playerId);
        if (!pre.value || !preP || preP.token !== msg.token) {
          send(socket, { type: "rejoinError", message: "Couldn't reconnect you to that room — it may have ended." });
          return;
        }
        const r = await touchRoom(code, (meta) => {
          const p = meta.players.find((pp) => pp.id === playerId);
          if (!p) return false;
          p.connected = true;
          return {};
        });
        if (!r.ok) { send(socket, { type: "rejoinError", message: "Couldn't reconnect you to that room — it may have ended." }); return; }
        identify(code, playerId);
        const isHost = playerId === r.meta.hostPlayerId;
        if (r.meta.started) {
          const gameLog = await getRoomLog(code, r.meta.logCount);
          const hostP = r.meta.players.find((p) => p.id === r.meta.hostPlayerId);
          send(socket, {
            type: "sync", lobby: lobbySnapshot(r.meta), seatOwners: r.meta.seatOwners, log: gameLog,
            isHost, hostConnected: !!(hostP && hostP.connected), paused: !!r.meta.paused,
            presence: presenceSnapshot(r.meta),
          });
        } else {
          send(socket, { type: "lobby", lobby: lobbySnapshot(r.meta), isHost });
        }
        broadcastRoom(code, { type: "presence", playerId, connected: true }, playerId);
        if (playerId === r.meta.hostPlayerId) broadcastRoom(code, { type: "hostStatus", connected: true }, playerId);
        log("player rejoined", code, playerId, "ip=" + ip);
        return;
      }

      case "reclaim": {
        // v0.10.3: {type:'reclaim', code, name} — token-less recovery, mirrors server.js's
        // "reclaim" case. See the PendingReclaim comment near the top of this file for the
        // known same-isolate caveat on the contested branch.
        const code = String(msg.code || "").toUpperCase();
        const pre = await kv.get<RoomMeta>(roomKey(code));
        if (!pre.value) { send(socket, { type: "reclaimError", message: "That room code doesn't exist or has expired." }); return; }
        if (!pre.value.started) { send(socket, { type: "reclaimError", message: "That game hasn't started yet — use Join a game instead.", reason: "notStarted" }); return; }
        if (isBadName(msg.name)) { send(socket, { type: "reclaimError", message: "Pick a nicer name." }); return; }
        const wantName = String(msg.name || "").trim().toLowerCase();
        const candidates = pre.value.players.filter((p) => p.name.trim().toLowerCase() === wantName);
        if (candidates.length === 0) { send(socket, { type: "reclaimError", message: `No one named "${cleanName(msg.name, "that")}" is in that game.` }); return; }
        const targetPre = candidates.find((p) => !p.connected) || candidates[0];
        if (targetPre.connected) {
          const hostP = pre.value.players.find((p) => p.id === pre.value!.hostPlayerId);
          if (!hostP || !hostP.connected) {
            send(socket, { type: "reclaimError", message: `${targetPre.name} is already connected and the host isn't reachable to confirm a takeover — try again in a bit.` });
            return;
          }
          const reqId = newToken();
          pendingReclaims.set(reqId, { code, targetPlayerId: targetPre.id, socket, expires: Date.now() + RECLAIM_TIMEOUT_MS });
          sendToPlayer(code, hostP.id, { type: "reclaimRequest", reqId, name: targetPre.name });
          send(socket, { type: "reclaimPending", message: `${targetPre.name} looks like they're already connected — asking the host to confirm.` });
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
        if (!r.ok) { send(socket, { type: "reclaimError", message: "Try again — that seat just changed state." }); return; }
        identify(code, r.extra.playerId as number);
        const isHost = (r.extra.playerId as number) === r.meta.hostPlayerId;
        const gameLog = await getRoomLog(code, r.meta.logCount);
        const hostP2 = r.meta.players.find((p) => p.id === r.meta.hostPlayerId);
        send(socket, {
          type: "reclaimed", code, playerId: r.extra.playerId, token: r.extra.token,
          lobby: lobbySnapshot(r.meta), seatOwners: r.meta.seatOwners, log: gameLog, isHost,
          hostConnected: !!(hostP2 && hostP2.connected), paused: !!r.meta.paused, presence: presenceSnapshot(r.meta),
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
        const gameLog = await getRoomLog(code, r.meta.logCount);
        send(pending.socket, {
          type: "reclaimed", code, playerId: targetPlayerId, token: r.extra.token,
          lobby: lobbySnapshot(r.meta), seatOwners: r.meta.seatOwners, log: gameLog, isHost,
          hostConnected: true, paused: !!r.meta.paused, presence: presenceSnapshot(r.meta),
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
          if (patch.type === "cpu" && seat.claimedBy != null) { kicked = seat.claimedBy; seat.claimedBy = null; }
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
        if (!ctx) return;
        const { code, playerId } = ctx;
        const r = await touchRoom(code, (meta) => {
          if (playerId !== meta.hostPlayerId || meta.started || !meta.lobby) return false;
          meta.started = true;
          meta.seatOwners = meta.lobby.seats.map((s) => s.claimedBy);
          meta.logCount = 1;
          return { logKey: logKey(code, 0), logValue: msg.action };
        });
        if (r.ok) {
          broadcastRoom(code, { type: "gameAction", seq: 0, action: msg.action, seatOwners: r.meta.seatOwners });
          log("room started", code);
        }
        return;
      }

      case "action": {
        if (!ctx) return;
        const { code, playerId } = ctx;
        const action = msg.action as Record<string, unknown>;
        if (!action || typeof action.kind !== "string") return;
        const r = await touchRoom(code, (meta) => {
          if (!meta.started || !meta.seatOwners) return false;
          if (action.kind === "move") {
            const owner = meta.seatOwners[action.seat as number];
            const authorized = owner == null ? playerId === meta.hostPlayerId : owner === playerId;
            if (!authorized) return false;
          } else if (action.kind === "reshuffle") {
            if (playerId !== meta.hostPlayerId) return false;
          } else {
            return false;
          }
          const seq = meta.logCount;
          meta.logCount = seq + 1;
          return { logKey: logKey(code, seq), logValue: action, seq };
        });
        if (r.ok) broadcastRoom(code, { type: "gameAction", seq: r.extra.seq, action });
        return;
      }

      case "stateCheck": {
        if (!ctx) return;
        const { code, playerId } = ctx;
        const cur = await kv.get<RoomMeta>(roomKey(code));
        if (!cur.value || !cur.value.started || playerId !== cur.value.hostPlayerId) return;
        broadcastRoom(code, { type: "stateCheck", seq: msg.seq, digest: msg.digest }, playerId);
        return;
      }

      case "requestStateCheck": {
        if (!ctx) return;
        const { code, playerId } = ctx;
        const cur = await kv.get<RoomMeta>(roomKey(code));
        if (!cur.value || !cur.value.started || cur.value.hostPlayerId == null) return;
        sendToPlayer(code, cur.value.hostPlayerId, { type: "requestStateCheck", from: playerId });
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

      case "recordResult": {
        if (!ctx) return;
        const { code, playerId } = ctx;
        const cur = await kv.get<RoomMeta>(roomKey(code));
        if (!cur.value || !cur.value.started || playerId !== cur.value.hostPlayerId) return;
        if (Array.isArray(msg.entries)) {
          for (const e of msg.entries as Record<string, unknown>[]) {
            if (e && e.name) await applyLeaderboardEntry(e.name, e.delta);
          }
        }
        return;
      }

      case "nudge": {
        if (!ctx) return;
        const { code, playerId } = ctx;
        const cur = await kv.get<RoomMeta>(roomKey(code));
        if (!cur.value || !cur.value.started) return;
        const target = cur.value.players.find((p) => p.id === msg.targetPlayerId);
        const sender = cur.value.players.find((p) => p.id === playerId);
        if (target) sendToPlayer(code, target.id, { type: "nudged", fromPlayerId: playerId, fromName: sender ? sender.name : "Someone" });
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
      const r = await touchRoom(code, (meta) => {
        const p = meta.players.find((pp) => pp.id === playerId);
        if (!p) return false;
        p.connected = false;
        return {};
      }).catch(() => ({ ok: false as const, reason: "error" }));
      if (r.ok) {
        broadcastRoom(code, { type: "presence", playerId, connected: false });
        if (playerId === r.meta.hostPlayerId) broadcastRoom(code, { type: "hostStatus", connected: false });
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
  const url = new URL(req.url);
  const ip = remoteIp(req, info);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return handleWsUpgrade(req, ip);
  }
  if (url.pathname === "/health") {
    let rooms = 0;
    for await (const _e of kv.list({ prefix: ["room"] })) rooms++;
    return json(200, { ok: true, rooms, uptime: Math.round(performance.now() / 1000), epoch: await getEpoch() });
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
  return new Response("nasty relay — see /health", { status: 404, headers: { "content-type": "text/plain", ...CORS_HEADERS } });
}

log(`admin token source: ${Deno.env.get("NASTY_ADMIN_TOKEN") ? "NASTY_ADMIN_TOKEN env" : "ephemeral (dev only)"}`);

if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
  // Running on Deno Deploy — it manages the port; don't specify one.
  Deno.serve(handler);
} else {
  Deno.serve({ port: PORT }, handler);
  log(`nasty relay (deno) listening on :${PORT}`);
}
