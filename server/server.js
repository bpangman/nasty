"use strict";
/*
 * NASTY relay server — dumb room registry + message relay for online multiplayer.
 * NO game rules live here. It only:
 *   - creates rooms (4-letter codes), tracks who's in them and which seat they hold
 *   - relays every game action to all sockets in the room, in the order it received them
 *   - keeps a log of the room's actions so a (re)joining client can catch up
 *   - persists rooms to disk (server/rooms/<CODE>.json) so a game survives a server
 *     restart or Mac reboot, and prunes rooms that have been fully abandoned for a while
 *
 * See /Users/jarvis/nasty-game/HANDOFF.md ("Online multiplayer" section) for the wire
 * protocol this implements, how to run it, and how the client talks to it.
 */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

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

/** @type {Map<string, Room>} */
const rooms = new Map();

function log(...a) { console.log(new Date().toISOString(), ...a); }

/* ---------------------------------------------------------------------------------------
 * v0.8: on-disk persistence. Only the essentials survive a restart — room code, lobby
 * config, the action log (so a rejoining client can replay/catch up exactly like it
 * already does after a live reconnect), and each player's stable id+token (so an old
 * rejoin link/localStorage token still authenticates after the process restarts). Live
 * sockets and `connected` flags are NOT persisted — everyone comes back as "disconnected"
 * on load and has to actually reconnect, same as any other reconnect.
 * ------------------------------------------------------------------------------------- */
try { fs.mkdirSync(ROOMS_DIR, { recursive: true }); } catch (e) { log("could not create rooms dir", e.message); }

function roomFile(code) { return path.join(ROOMS_DIR, code + ".json"); }
function roomToDisk(room) {
  return {
    code: room.code, createdAt: room.createdAt, lastActivity: room.lastActivity,
    hostPlayerId: room.hostPlayerId, nextPlayerId: room.nextPlayerId,
    players: Array.from(room.players.values()).map(p => ({ id: p.id, token: p.token, name: p.name, isHost: p.isHost })),
    lobby: room.lobby, started: room.started, seatOwners: room.seatOwners, log: room.log,
    paused: !!room.paused,
  };
}
function roomFromDisk(obj) {
  const room = {
    code: obj.code, createdAt: obj.createdAt || Date.now(), lastActivity: obj.lastActivity || Date.now(),
    hostPlayerId: obj.hostPlayerId, nextPlayerId: obj.nextPlayerId || 1,
    players: new Map(), lobby: obj.lobby || null, started: !!obj.started,
    seatOwners: obj.seatOwners || null, log: Array.isArray(obj.log) ? obj.log : [],
    paused: !!obj.paused,
  };
  for (const p of (obj.players || []))
    room.players.set(p.id, { id: p.id, token: p.token, name: p.name, ws: null, connected: false, isHost: !!p.isHost });
  return room;
}
const persistTimers = new Map(); // code -> Timeout
function schedulePersist(room) {
  if (persistTimers.has(room.code)) return;
  persistTimers.set(room.code, setTimeout(() => {
    persistTimers.delete(room.code);
    persistRoomNow(room);
  }, PERSIST_DEBOUNCE_MS));
}
function persistRoomNow(room) {
  try { fs.writeFileSync(roomFile(room.code), JSON.stringify(roomToDisk(room))); }
  catch (e) { log("persist failed", room.code, e.message); }
}
function deleteRoomFile(code) {
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

/* v0.8: remote-address logging + a light rate limit on room creation. This is still "no
 * game rules" — just an abuse guard. See HANDOFF.md "synthetic rooms" note for why this
 * was added: bursts of sub-second create->join->start plus periodic rejoins, source
 * previously unlogged. `x-forwarded-for`/`cf-connecting-ip` come from the cloudflared
 * tunnel; a direct localhost connection (dev/testing) has neither and falls back to the
 * raw socket address. */
function remoteIp(req) {
  const h = req.headers || {};
  const raw = h["cf-connecting-ip"] || h["x-forwarded-for"] || (req.socket && req.socket.remoteAddress) || "unknown";
  return String(raw).split(",")[0].trim();
}
const HOST_RATE_LIMIT = 5;          // max room creates...
const HOST_RATE_WINDOW_MS = 60 * 1000; // ...per IP, per rolling minute — generous for real humans
const hostRateMap = new Map();      // ip -> [timestamps]
function underHostRateLimit(ip) {
  const now = Date.now();
  const kept = (hostRateMap.get(ip) || []).filter(t => now - t < HOST_RATE_WINDOW_MS);
  if (kept.length >= HOST_RATE_LIMIT) { hostRateMap.set(ip, kept); return false; }
  kept.push(now);
  hostRateMap.set(ip, kept);
  return true;
}
setInterval(() => { // periodic cleanup so hostRateMap never grows unbounded
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
    players: new Map(), // playerId -> {id,token,name,ws,connected,isHost}
    lobby: null,        // {n,teams,seats:[{name,type,diff,claimedBy}]}
    started: false,
    seatOwners: null,   // frozen at start: seatIndex -> playerId|null
    log: [],            // [{seq, action}]
    paused: false,       // v0.8: pause/resume (see "pauseToggle" below) — not part of the
                         // action log, just current state, included directly in sync/lobby
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
function lobbySnapshot(room) {
  if (!room.lobby) return null;
  const snap = JSON.parse(JSON.stringify(room.lobby));
  // v0.8: tell clients which seat is the host's so they can show/protect it in the UI —
  // still just a display hint, not a rule (claimSeat below enforces the actual protection).
  snap.hostSeatIndex = snap.seats.findIndex(s => s.claimedBy === room.hostPlayerId);
  return snap;
}
function roomIsFullyDisconnected(room) {
  for (const p of room.players.values()) if (p.connected) return false;
  return true;
}

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/health/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: process.uptime() }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("nasty relay — see /health");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const ip = remoteIp(req); // v0.8: logged on room create/join, see "synthetic rooms" note above
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  // which room/player this socket represents, once it identifies itself
  let ctx = null; // {room, playerId}

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
    if (p) {
      p.connected = false;
      p.ws = null;
      touch(room);
      broadcast(room, { type: "presence", playerId, connected: false });
      if (playerId === room.hostPlayerId) broadcast(room, { type: "hostStatus", connected: false });
    }
  });

  function identify(room, playerId) { ctx = { room, playerId }; }

  function handleMessage(msg) {
    switch (msg.type) {
      case "ping":
        send(ws, { type: "pong", t: msg.t });
        return;

      case "host": {
        // {type:'host', name, n, teams, seats:[{name,type,diff}]}
        if (!underHostRateLimit(ip)) {
          send(ws, { type: "error", message: "Too many rooms created from here — wait a minute and try again." });
          log("rate-limited host attempt", "ip="+ip);
          return;
        }
        const code = newCode();
        const room = makeRoom(code);
        const playerId = room.nextPlayerId++;
        const token = newToken();
        room.hostPlayerId = playerId;
        room.players.set(playerId, { id: playerId, token, name: String(msg.name || "Host").slice(0, 20), ws, connected: true, isHost: true });
        const seats = Array.isArray(msg.seats) ? msg.seats.map(s => ({
          name: String(s.name || "").slice(0, 20), type: s.type === "cpu" ? "cpu" : "human", diff: s.diff || "medium", claimedBy: null,
        })) : [];
        const firstHuman = seats.findIndex(s => s.type === "human");
        if (firstHuman >= 0) { seats[firstHuman].claimedBy = playerId; seats[firstHuman].name = room.players.get(playerId).name; }
        room.lobby = { n: msg.n === 6 ? 6 : 4, teams: !!msg.teams, seats };
        identify(room, playerId);
        touch(room);
        send(ws, { type: "created", code, playerId, token, lobby: lobbySnapshot(room) });
        log("room created", code, "ip="+ip);
        return;
      }

      case "join": {
        // {type:'join', code, name}
        const code = String(msg.code || "").toUpperCase();
        const room = rooms.get(code);
        if (!room) { send(ws, { type: "joinError", message: "That room code doesn't exist. Double check it with the host." }); return; }
        if (room.started) { send(ws, { type: "joinError", message: "That game already started. Ask the host to send a new code, or reconnect if you were already playing." }); return; }
        const playerId = room.nextPlayerId++;
        const token = newToken();
        room.players.set(playerId, { id: playerId, token, name: String(msg.name || "Player").slice(0, 20), ws, connected: true, isHost: false });
        identify(room, playerId);
        touch(room);
        send(ws, { type: "joined", code, playerId, token, lobby: lobbySnapshot(room) });
        broadcast(room, { type: "lobby", lobby: lobbySnapshot(room) }, playerId);
        log("player joined", code, playerId, "ip="+ip);
        return;
      }

      case "rejoin": {
        // {type:'rejoin', code, playerId, token}
        const code = String(msg.code || "").toUpperCase();
        const room = rooms.get(code);
        const playerId = msg.playerId;
        const p = room && room.players.get(playerId);
        if (!room || !p || p.token !== msg.token) { send(ws, { type: "rejoinError", message: "Couldn't reconnect you to that room — it may have ended." }); return; }
        p.connected = true; p.ws = ws;
        identify(room, playerId);
        touch(room);
        const isHost = playerId === room.hostPlayerId;
        if (room.started) {
          send(ws, { type: "sync", lobby: lobbySnapshot(room), seatOwners: room.seatOwners, log: room.log, isHost, hostConnected: !!(room.players.get(room.hostPlayerId) || {}).connected, paused: !!room.paused });
        } else {
          send(ws, { type: "lobby", lobby: lobbySnapshot(room), isHost });
        }
        broadcast(room, { type: "presence", playerId, connected: true }, playerId);
        if (playerId === room.hostPlayerId) broadcast(room, { type: "hostStatus", connected: true }, playerId);
        log("player rejoined", code, playerId, "ip="+ip);
        return;
      }

      case "claimSeat": {
        // {type:'claimSeat', seatIndex, name}
        // v0.8: a guest may now claim ANY open seat, including one still marked CPU —
        // claiming converts it to human (Blake got tripped up needing to pre-flip a CPU
        // seat before texting an invite). The host's own seat is always protected.
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (!room.lobby || room.started) return;
        const seat = room.lobby.seats[msg.seatIndex];
        if (!seat) return;
        if (seat.claimedBy === room.hostPlayerId) return;                 // host seat protected
        if (seat.claimedBy != null && seat.claimedBy !== playerId) return; // already taken by someone else
        // free any seat this player previously held (can't be the host's — see check above)
        room.lobby.seats.forEach(s => { if (s.claimedBy === playerId) s.claimedBy = null; });
        seat.claimedBy = playerId;
        seat.type = "human";   // claiming a CPU seat converts it to human
        if (msg.name) seat.name = String(msg.name).slice(0, 20);
        touch(room);
        broadcast(room, { type: "lobby", lobby: lobbySnapshot(room) });
        return;
      }

      case "setSeat": {
        // host only: {type:'setSeat', seatIndex, patch:{type,diff,name}}
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (playerId !== room.hostPlayerId || !room.lobby || room.started) return;
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
        if (patch.name != null) seat.name = String(patch.name).slice(0, 20);
        touch(room);
        broadcast(room, { type: "lobby", lobby: lobbySnapshot(room) });
        return;
      }

      case "start": {
        // host only: {type:'start', action:{kind:'start', n, teams, seats, dealer, deck}}
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (playerId !== room.hostPlayerId || room.started) return;
        room.started = true;
        room.seatOwners = room.lobby.seats.map(s => s.claimedBy);
        room.log.push({ seq: 0, action: msg.action });
        touch(room);
        broadcast(room, { type: "gameAction", seq: 0, action: msg.action, seatOwners: room.seatOwners });
        log("room started", room.code);
        return;
      }

      case "action": {
        // {type:'action', action:{kind:'move'|'reshuffle', ...}}
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (!room.started) return;
        const action = msg.action;
        if (!action || typeof action.kind !== "string") return;
        if (action.kind === "move") {
          const owner = room.seatOwners[action.seat];
          const authorized = owner == null ? playerId === room.hostPlayerId : owner === playerId;
          if (!authorized) return;
        } else if (action.kind === "reshuffle") {
          if (playerId !== room.hostPlayerId) return;
        } else {
          return;
        }
        const seq = room.log.length;
        room.log.push({ seq, action });
        touch(room);
        broadcast(room, { type: "gameAction", seq, action });
        return;
      }

      case "stateCheck": {
        // {type:'stateCheck', seq, digest} — the host's periodic per-deal integrity digest
        // (see index.html gDigest/doDeal). Not part of the action log and not authoritative
        // here: this is still "no game rules on the server" — just a relay, like everything
        // else. Clients compare digests themselves and silently rejoin on a mismatch.
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (!room.started || playerId !== room.hostPlayerId) return;
        broadcast(room, { type: "stateCheck", seq: msg.seq, digest: msg.digest }, playerId);
        return;
      }

      case "requestStateCheck": {
        // v0.8: any non-host client can ask the host to run its per-deal integrity check
        // RIGHT NOW instead of waiting for the next deal boundary — used when a phone comes
        // back from the background (visibilitychange/pageshow) so a drift is caught within
        // moments of returning, not whenever the next hand happens to be dealt. Still just a
        // relay: the host decides how/whether to respond (see index.html "requestStateCheck").
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (!room.started) return;
        const hostP = room.players.get(room.hostPlayerId);
        if (hostP) send(hostP.ws, { type: "requestStateCheck", from: playerId });
        return;
      }

      case "pauseToggle": {
        // v0.8: pause/resume. {type:'pauseToggle', paused:true|false} — ANY seated player
        // can request it (family-friendly: whoever needs a break can call it, whoever's
        // ready can un-pause), not just the host. Deliberately NOT part of the action log —
        // it's current state, not a move — so it's broadcast immediately and also handed to
        // anyone who (re)joins via sync/lobby above, instead of being replayed.
        if (!ctx) return;
        const { room } = ctx;
        if (!room.started) return;
        room.paused = !!msg.paused;
        touch(room);
        broadcast(room, { type: "paused", paused: room.paused });
        return;
      }

      default:
        return;
    }
  }
});

// heartbeat: ping every socket, drop ones that didn't pong last round
const hb = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, HEARTBEAT_MS);

// prune abandoned rooms — started-but-unfinished games get a much longer runway (a week)
// than lobbies that never even started (30 min is plenty — nothing to come back to).
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

loadRoomsFromDisk(); // v0.8: bring back rooms that existed before this process started

server.listen(PORT, () => log(`nasty relay listening on :${PORT}`));

function shutdown() {
  clearInterval(hb); clearInterval(pruneTimer);
  flushAllPersists(); // make sure every debounced write actually lands before we exit
  // v0.8 fix: `server.close()` only stops ACCEPTING new connections — it does NOT touch
  // sockets that are already open, and its callback doesn't fire until every existing
  // connection closes on its own. If any phone is still connected at restart time (the
  // whole point of this restart-survives feature), this process would sit as a live
  // zombie — still fully serving its already-open sockets against its now-stale in-memory
  // room state — for as long as those sockets stay open, while a FRESH process binds the
  // now-available port and starts from the last DISK snapshot. A phone that reconnects
  // fresh (a real close+reopen, new socket) lands on the NEW process and gets the current
  // disk snapshot; phones that never actually dropped stay on the OLD zombie and keep
  // seeing/making progress that the new process never learns about — exactly the kind of
  // split-brain that produces two different "truths" for the same room. Terminating every
  // open socket here forces a real, clean handoff: every client sees an actual disconnect
  // and reconnects fresh to whichever process is listening after this one is fully gone.
  for (const ws of wss.clients) { try { ws.terminate(); } catch (e) {} }
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
