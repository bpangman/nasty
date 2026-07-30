"use strict";
/*
 * 2026-07-30 (v0.59) § LIVE RENAME PROPAGATION - Blake's ask, verbatim: nickname changes "take
 * place right away - even mid game". This suite proves the SERVER half against BOTH servers:
 * a successful POST /account/name rename reaches every live room the account is sitting in,
 * as an ADDITIVE {type:"playerRenamed"} broadcast plus (in lobby) a fresh lobby snapshot.
 *
 *   R1  LOBBY: the host renames mid-lobby - the guest receives playerRenamed for the host's
 *       playerId AND a lobby snapshot whose claimed seat already carries the new name
 *   R2  STARTED GAME: a player renames mid-game - everyone receives playerRenamed carrying the
 *       REAL SEAT INDEX, and a fresh rejoin snapshot's G.seats[seat].name is the new name (so a
 *       reconnect can never resurrect the old one)
 *   R3  a rename by an account sitting in NO room broadcasts nothing and breaks nothing
 *   R4  the message is genuinely additive: PROTOCOL_VERSION is still 5 (nothing about this
 *       feature may force an app-store update)
 *
 * Same no-Apple-contact machinery as every accounts suite (test_accounts_kit.js).
 *
 * Usage:
 *   node test_live_rename.js node
 *   node test_live_rename.js deno
 */
const K = require("./test_accounts_kit.js");
const WebSocket = require("/Users/jarvis/nasty-game/server/node_modules/ws");

const KIND = process.argv[2] || "node";
const ADMIN_TOKEN = "live-rename-admin-token";
const AUD = "com.pangman.nasty";
const ISSUER = "https://test.local";
const PV = 5;   // current PROTOCOL_VERSION - R4 asserts the server still reports exactly this

let PASS = 0, FAIL = 0;
function log(...a) { console.log("[live-rename]", ...a); }
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
function randPort() { return 29900 + Math.floor(Math.random() * 600); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wsConnect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
function nextMsg(ws, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { ws.removeListener("message", onMsg); reject(new Error("timeout waiting for message")); }, timeoutMs);
    function onMsg(raw) {
      const m = JSON.parse(raw.toString());
      if (!predicate || predicate(m)) { clearTimeout(to); ws.removeListener("message", onMsg); resolve(m); }
    }
    ws.on("message", onMsg);
  });
}
function collect(ws) {
  const seen = [];
  ws.on("message", (raw) => { try { seen.push(JSON.parse(raw.toString())); } catch (e) {} });
  return seen;
}

async function main() {
  const key = K.makeKeyPair("rename-key");
  const scratch = K.makeScratch(`live-rename-${KIND}`);
  const port = randPort();
  const base = `http://localhost:${port}`;
  const envExtra = {
    NASTY_APPLE_ISSUER: ISSUER,
    NASTY_APPLE_AUDIENCES: AUD,
    NASTY_ACCOUNT_RATE_LIMIT: "4000",
  };
  const jwks = await K.startJwksServer([key]);
  envExtra.NASTY_APPLE_JWKS_URL = jwks.url;
  const env = K.serverEnv(KIND, scratch, port, ADMIN_TOKEN, envExtra);
  const srv = K.startServer(KIND, env, "ACCOUNTS_VERBOSE");
  await K.waitHealthy(base);
  const c = K.makeClient(base);

  async function makeAccount(sub, name) {
    const r = await c.signIn(key, { sub });
    if (r.status !== 200) throw new Error("sign-in failed: " + JSON.stringify(r.body));
    const n = await c.post("/account/name", { auth: r.body.sessionToken, name });
    if (n.status !== 200) throw new Error("name set failed: " + JSON.stringify(n.body));
    return r.body.sessionToken;
  }
  async function rename(auth, name) { return await c.post("/account/name", { auth, name }); }

  try {
    /* ===================== R1: mid-LOBBY rename reaches the guest ===================== */
    {
      const hostTok = await makeAccount("001444.hosty.0001", "Hosty");
      const guestTok = await makeAccount("001444.guesty.0002", "Guesty");
      const host = await wsConnect(port);
      const seats = [{ name: "Hosty", type: "human", diff: "medium" },
        { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" }];
      host.send(JSON.stringify({ type: "host", protocolVersion: PV, name: "Hosty", n: 4, teams: false, seats, acct: hostTok }));
      const created = await nextMsg(host, (m) => m.type === "created");
      check(created.protocolVersion === PV, "R4 the server still reports protocolVersion " + PV + " - playerRenamed is additive, no bump");
      const guest = await wsConnect(port);
      guest.send(JSON.stringify({ type: "join", protocolVersion: PV, code: created.code, name: "Guesty", acct: guestTok }));
      await nextMsg(guest, (m) => m.type === "joined");

      const renamedP = nextMsg(guest, (m) => m.type === "playerRenamed");
      const lobbyP = nextMsg(guest, (m) => m.type === "lobby" && m.lobby && m.lobby.seats.some((s) => s.name === "HostyTwo"));
      const r = await rename(hostTok, "HostyTwo");
      check(r.status === 200 && r.body.gameName === "HostyTwo", "R1 the rename itself succeeds (first rename after the initial set is free)");
      const pr = await renamedP;
      check(pr.playerId === created.playerId && pr.name === "HostyTwo",
        "R1b the GUEST receives playerRenamed for the host's playerId with the new name: " + JSON.stringify(pr));
      const lb = await lobbyP;
      const seat0 = lb.lobby.seats.find((s) => s.claimedBy === created.playerId);
      check(!!seat0 && seat0.name === "HostyTwo", "R1c and a fresh lobby snapshot already carries the new name on the host's claimed seat");
      host.close(); guest.close();
    }

    /* ===================== R2: mid-GAME rename carries the real seat index ===================== */
    {
      const startyTok = await makeAccount("001444.starty.0003", "Starty");
      const watchTok = await makeAccount("001444.watchy.0004", "Watchy");
      const host = await wsConnect(port);
      const seats = [{ name: "Starty", type: "human", diff: "medium" },
        { name: "C1", type: "cpu", diff: "easy" }, { name: "C2", type: "cpu", diff: "easy" }, { name: "C3", type: "cpu", diff: "easy" }];
      host.send(JSON.stringify({ type: "host", protocolVersion: PV, name: "Starty", n: 4, teams: false, seats, acct: startyTok }));
      const created = await nextMsg(host, (m) => m.type === "created");
      const watcher = await wsConnect(port);
      watcher.send(JSON.stringify({ type: "join", protocolVersion: PV, code: created.code, name: "Watchy", acct: watchTok }));
      await nextMsg(watcher, (m) => m.type === "joined");

      host.send(JSON.stringify({ type: "start", protocolVersion: PV, willSeat: true }));
      await nextMsg(host, (m) => m.type === "gameAction" && m.action && m.action.kind === "start");
      host.send(JSON.stringify({ type: "seated" }));
      await sleep(600);   // let the opening deal settle

      const renamedP = nextMsg(watcher, (m) => m.type === "playerRenamed");
      const r = await rename(startyTok, "StartyTwo");
      check(r.status === 200, "R2 mid-game rename succeeds");
      const pr = await renamedP;
      check(pr.playerId === created.playerId && pr.seat === 0 && pr.name === "StartyTwo",
        "R2b everyone in the STARTED game receives playerRenamed with the REAL seat index (0): " + JSON.stringify(pr));

      // A fresh rejoin snapshot must serve the NEW name - a reconnect can never resurrect the old.
      const back = await wsConnect(port);
      back.send(JSON.stringify({ type: "rejoin", protocolVersion: PV, code: created.code, playerId: created.playerId, token: created.token }));
      const sync = await nextMsg(back, (m) => m.type === "sync" && m.G);
      check(sync.G.seats && sync.G.seats[0] && sync.G.seats[0].name === "StartyTwo",
        "R2c a fresh rejoin snapshot's G.seats[0].name is the new name: " + (sync.G.seats && sync.G.seats[0] && sync.G.seats[0].name));
      host.close(); watcher.close(); back.close();
    }

    /* ===================== R3: a rename with no live room is quiet and safe ===================== */
    {
      const lonerTok = await makeAccount("001444.loner.0005", "Loner");
      const r = await rename(lonerTok, "LonerTwo");
      check(r.status === 200 && r.body.gameName === "LonerTwo", "R3 a rename with no live room simply succeeds - nothing to propagate, nothing breaks");
      const h = await fetch(base + "/health");
      check(h.ok, "R3b and the server is still healthy afterwards");
    }
  } catch (e) {
    FAIL++;
    log("FAIL", "unexpected exception: " + (e && e.stack || e));
  } finally {
    await K.stopServer(srv);
    jwks.close();
  }

  log(`${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main();
