"use strict";
/*
 * 2026-07-25 § ACCOUNTS - ONLINE GAMES AND THE OPTIONAL `acct` FIELD.
 *
 * The one wire-level addition in this whole batch is an OPTIONAL `acct` session token on `host`
 * and `join`. This suite plays REAL online games to completion against a real server and proves,
 * identically on BOTH servers:
 *
 *   Part AA - a signed-in host's finished online game is credited to their ACCOUNT (with the
 *     account-only board switched on), and shows on the shared board under their game name.
 *   Part AB - a GUEST's finished online game is not posted to the shared board at all. The game
 *     still plays, still finishes, still works exactly as before - it just does not appear.
 *     This is Blake's decision: accounts are optional to play, required to be on the board.
 *   Part AC - a junk/expired `acct` is silently ignored: the player joins and plays normally as
 *     a guest. A sign-in problem must never stop somebody joining a family game.
 *   Part AD - with the switch OFF (production today), a game hosted WITH an `acct` field records
 *     by name exactly as it always has, so sending the field can never change today's behavior.
 *
 * Harness note, learned the hard way and repeated here on purpose: this server sends an
 * app-level {type:'ping'} and force-closes a socket that never answers. Every connection below
 * replies {type:'pong'}, or a game stalls mid-play and presents as a mysterious timeout.
 *
 * Never touches production - private port, scratch rooms dir / KV / leaderboard, throwaway
 * admin token. Nothing here contacts Apple.
 *
 * Usage:
 *   node test_accounts_online.js node
 *   node test_accounts_online.js deno
 */
const K = require("./test_accounts_kit.js");
const WebSocket = require("/Users/jarvis/nasty-game/server/node_modules/ws");
const { createEngine } = require("../engine.js");

const KIND = process.argv[2] || "node";
const ADMIN_TOKEN = "accounts-online-admin-token";
const AUD = "com.pangman.nasty";
const ISSUER = "https://appleid.test.local";

let PASS = 0, FAIL = 0;
function log(...a) { console.log("[acct-online]", ...a); }
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
// Clear of every other test_accounts_* suite's port range - see test_accounts_linking.js's note.
function randPort() { return 30800 + Math.floor(Math.random() * 300); }

function wsConnect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

/* One human seat, three CPUs, played to a real finish. The server drives the CPU turns itself;
   this drives seat 0 from a shadow engine, exactly the technique test_knockout_leaderboard.js
   and test_jack_swap_index.js already use. `acct` is passed through to `host` untouched, which
   is the whole point of the suite. */
async function playSoloOnlineGame(port, hostName, acct) {
  const seats = [
    { name: hostName, type: "human", diff: "medium" },
    { name: "CPU1", type: "cpu", diff: "easy" },
    { name: "CPU2", type: "cpu", diff: "easy" },
    { name: "CPU3", type: "cpu", diff: "easy" },
  ];
  const ws = await wsConnect(port);
  const E = createEngine();
  return await new Promise((resolve, reject) => {
    let settled = false;
    let code = null;
    const budget = 180000;
    const hard = setTimeout(() => finish(new Error("online game did not finish within its budget")), budget);
    function finish(err, val) {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      try { ws.close(); } catch (e) {}
      if (err) reject(err); else resolve(val);
    }
    ws.on("message", (raw) => {
      if (settled) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      try {
        // HARNESS RULE: answer the server's app-level ping, or this socket gets force-closed
        // mid-game and the whole thing presents as an unexplained stall.
        if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong", t: msg.t })); return; }
        if (msg.type === "created") {
          code = msg.code;
          ws.send(JSON.stringify({ type: "start", protocolVersion: 5, willSeat: true }));
          ws.send(JSON.stringify({ type: "seated" }));
          return;
        }
        if (msg.type === "gameAction") {
          const a = msg.action;
          if (a.kind === "start") {
            E.setLAY(E.buildLayout(a.n));
            E.newGame({ n: a.n, teams: a.teams, seats: a.seats }, { deck: [], dealer: a.dealer });
          } else if (a.kind === "deal") {
            const G = E.getG();
            G.dealer = a.dealer; G.bowedOut = G.seats.map(() => false);
            for (let s = 0; s < G.n; s++) G.hands[s] = (a.hands[s] || []).slice();
            G.turn = a.turn;
          } else if (a.kind === "move") {
            E.applyMove(a.seat, a.m);
            E.getG().turn = a.turn;
          } else if (a.kind === "pass") {
            const G = E.getG();
            if (a.newlyBowedOut) G.bowedOut[a.seat] = true;
            if (a.threwIn) for (const h of G.hands) h.length = 0;
            G.turn = a.turn;
          }
          const G = E.getG();
          if (G.over) { finish(null, { code, winners: G.winners.slice() }); return; }
          if (G.turn === 0 && !G.bowedOut[0] && G.hands[0].length > 0) {
            const legal = E.legalMoves(0);
            if (legal.length) {
              const m = legal[Math.floor(Math.random() * legal.length)];
              const payload = JSON.stringify({ type: "action", action: { kind: "move", seat: 0, m } });
              setTimeout(() => { if (!settled) ws.send(payload); }, 15);
            }
          }
          return;
        }
        if (msg.type === "sync") { finish(new Error("got resynced - a submitted move was rejected")); return; }
        if (msg.type === "kicked" || msg.type === "error") { finish(new Error("server said: " + (msg.message || msg.type))); return; }
      } catch (e) { finish(e); }
    });
    const hostMsg = { type: "host", protocolVersion: 5, name: hostName, n: 4, teams: false, seats };
    if (acct !== undefined) hostMsg.acct = acct;   // ONLY present when the test means it to be
    ws.send(JSON.stringify(hostMsg));
  });
}

async function main() {
  const key = K.makeKeyPair("apple-key");
  const jwks = await K.startJwksServer([key]);
  const providerEnv = {
    NASTY_ACCOUNTS_ENABLED: "1",
    NASTY_APPLE_JWKS_URL: jwks.url, NASTY_APPLE_ISSUER: ISSUER, NASTY_APPLE_AUDIENCES: AUD,
    NASTY_ACCOUNT_RATE_LIMIT: "8000",
  };
  let seq = 0;
  async function boot(extra, tag) {
    const scratch = K.makeScratch(`acct-online-${tag}-${KIND}`);
    const port = randPort() + (seq++);
    const base = `http://localhost:${port}`;
    const child = K.startServer(KIND, K.serverEnv(KIND, scratch, port, ADMIN_TOKEN, Object.assign({}, providerEnv, extra)), "ACCOUNTS_VERBOSE");
    await K.waitHealthy(base);
    return {
      port, base, scratch, c: K.makeClient(base),
      async board() { return await (await fetch(base + "/leaderboard")).json(); },
      stop() { return K.stopServer(child); },
    };
  }

  /* ============ Parts AA + AB + AC: the account-only board, switched ON ============ */
  {
    const s = await boot({ NASTY_LEADERBOARD_ACCOUNTS_ONLY: "1" }, "on");
    const acct = (await s.c.signIn(key, { iss: ISSUER, aud: AUD, sub: "001111.online" })).body;
    const named = await s.c.post("/account/name", { auth: acct.sessionToken, name: "Blake" });
    check(named.status === 200, "AA0 signed in and holding the game name Blake");

    log("playing a signed-in online game (this is a real game to a real finish, give it a minute)...");
    const g1 = await playSoloOnlineGame(s.port, "Blake", acct.sessionToken);
    check(!!g1.code, "AA1 a signed-in player's online game plays and finishes normally");
    await K.sleep(1500);
    const b1 = await s.board();
    check(b1.Blake && b1.Blake.hg4s === 1,
      "AA2 and it is credited to their ACCOUNT and shows on the shared board under their game name");
    if (g1.winners.includes(0)) check(b1.Blake.hw4s === 1, "AA2b (they won it, and the win is recorded too)");
    else check(b1.Blake.hw4s === undefined, "AA2b (they lost it, so no win is recorded - correct either way)");

    log("playing a GUEST online game...");
    const g2 = await playSoloOnlineGame(s.port, "Charlie", undefined);
    check(!!g2.code, "AB1 a guest's online game plays and finishes exactly the same way - play is never gated");
    await K.sleep(1500);
    const b2 = await s.board();
    check(!b2.Charlie,
      "AB2 but it does NOT post to the shared board. Optional to play, required to appear - Blake's decision.");

    log("playing an online game with a junk acct token...");
    const g3 = await playSoloOnlineGame(s.port, "Junky", "not-a-real-session-token-0000");
    check(!!g3.code, "AC1 a junk acct token does NOT stop anyone joining or playing - it is silently ignored");
    await K.sleep(1500);
    const b3 = await s.board();
    check(!b3.Junky, "AC2 they simply played as a guest, so nothing posted");

    await s.stop();
  }

  /* ============ Part AD: switch OFF - sending `acct` cannot change today's behavior ============ */
  {
    const s = await boot({}, "off");
    const acct = (await s.c.signIn(key, { iss: ISSUER, aud: AUD, sub: "001111.offline" })).body;
    await s.c.post("/account/name", { auth: acct.sessionToken, name: "Ginny" });
    log("playing an online game with acct present but the board switch OFF...");
    const g = await playSoloOnlineGame(s.port, "Ginny", acct.sessionToken);
    check(!!g.code, "AD1 the game plays normally");
    await K.sleep(1500);
    const b = await s.board();
    check(b.Ginny && b.Ginny.hg4s === 1,
      "AD2 and records by NAME exactly as it always has - sending the new field changes nothing until the switch is flipped");
    await s.stop();
  }

  jwks.close();
  console.log(`\n[acct-online/${KIND}] ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
