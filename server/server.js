"use strict";
/*
 * NASTY relay server — dumb room registry + message relay for online multiplayer.
 * NO game rules live here. It only:
 *   - creates rooms (4-letter codes), tracks who's in them and which seat they hold
 *   - relays every game action to all sockets in the room, in the order it received them
 *   - keeps a log of the room's actions so a (re)joining client can catch up
 *   - prunes rooms that have been fully abandoned for a while
 *
 * See /Users/jarvis/nasty-game/HANDOFF.md ("Online multiplayer" section) for the wire
 * protocol this implements, how to run it, and how the client talks to it.
 */
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.NASTY_PORT ? parseInt(process.env.NASTY_PORT, 10) : 8484;
const ROOM_TTL_MS = 30 * 60 * 1000; // prune a room 30 min after everyone's gone
const PRUNE_EVERY_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;

// no vowels/Y and no easily-confused characters -> codes never spell a word, never
// look like 0/O or 1/I/L
const CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXZ";

/** @type {Map<string, Room>} */
const rooms = new Map();

function log(...a) { console.log(new Date().toISOString(), ...a); }

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
  };
  rooms.set(code, room);
  return room;
}
function touch(room) { room.lastActivity = Date.now(); }

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
  return room.lobby ? JSON.parse(JSON.stringify(room.lobby)) : null;
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

wss.on("connection", (ws) => {
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
        log("room created", code);
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
        log("player joined", code, playerId);
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
          send(ws, { type: "sync", lobby: lobbySnapshot(room), seatOwners: room.seatOwners, log: room.log, isHost, hostConnected: !!(room.players.get(room.hostPlayerId) || {}).connected });
        } else {
          send(ws, { type: "lobby", lobby: lobbySnapshot(room), isHost });
        }
        broadcast(room, { type: "presence", playerId, connected: true }, playerId);
        if (playerId === room.hostPlayerId) broadcast(room, { type: "hostStatus", connected: true }, playerId);
        log("player rejoined", code, playerId);
        return;
      }

      case "claimSeat": {
        // {type:'claimSeat', seatIndex, name}
        if (!ctx) return;
        const { room, playerId } = ctx;
        if (!room.lobby || room.started) return;
        const seat = room.lobby.seats[msg.seatIndex];
        if (!seat || seat.type !== "human") return;
        if (seat.claimedBy != null && seat.claimedBy !== playerId) return; // already taken
        // free any seat this player previously held
        room.lobby.seats.forEach(s => { if (s.claimedBy === playerId) s.claimedBy = null; });
        seat.claimedBy = playerId;
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

// prune abandoned rooms
const pruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (roomIsFullyDisconnected(room) && now - room.lastActivity > ROOM_TTL_MS) {
      rooms.delete(code);
      log("pruned room", code);
    }
  }
}, PRUNE_EVERY_MS);

server.listen(PORT, () => log(`nasty relay listening on :${PORT}`));

process.on("SIGTERM", () => { clearInterval(hb); clearInterval(pruneTimer); server.close(() => process.exit(0)); });
process.on("SIGINT", () => { clearInterval(hb); clearInterval(pruneTimer); server.close(() => process.exit(0)); });
