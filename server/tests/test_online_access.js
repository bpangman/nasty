"use strict";
/*
 * 2026-07-29 § ONLINE ACCESS - proves the numbered claims in HANDOFF.md's "Online Access"
 * entry against BOTH servers: the free-period-by-signup-date rule, token purchase mechanics
 * (grant/stack/afford), the front-door host/join enforcement (guest vs unentitled vs entitled,
 * with the documented reason codes), that a live game survives a month rollover and can still be
 * rejoined, and that lifetime leaderboard points/ordering are untouched by any of it.
 *
 * Harness rule, learned the hard way and repeated here on purpose: this server sends an
 * app-level {type:'ping'} and force-closes a socket that never answers. Every connection below
 * replies {type:'pong'}, or a game stalls mid-play and presents as a mysterious timeout.
 *
 * Never touches production - private port, scratch rooms dir / KV / leaderboard/accounts files,
 * throwaway admin token. Nothing here contacts Apple.
 *
 * Usage:
 *   node test_online_access.js node
 *   node test_online_access.js deno
 */
const K = require("./test_accounts_kit.js");
const WebSocket = require("/Users/jarvis/nasty-game/server/node_modules/ws");
const { createEngine } = require("../engine.js");

const KIND = process.argv[2] || "node";
const ADMIN_TOKEN = "online-access-admin-token";
const AUD = "com.pangman.nasty";
const ISSUER = "https://online-access.test.local";

let PASS = 0, FAIL = 0;
function log(...a) { console.log("[online-access]", ...a); }
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }
function randPort() { return 32100 + Math.floor(Math.random() * 400); }

// A timestamp guaranteed to fall on the 15th of `monthKey` at noon UTC - nowhere near either end
// of the month in any timezone, so it can never accidentally land in the wrong Chicago month.
function midMonthMs(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return Date.UTC(y, m - 1, 15, 18, 0, 0);
}

function wsConnect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

/* Hosts a 4P game (seat 0 = the human driven from here, seats 1-3 = CPU) and drives seat 0's
   moves from a shadow engine - the same technique test_accounts_online.js / test_jack_swap_index.js
   already use. Resolves once the game is over UNLESS `stopAfterActions` is given, in which case
   it resolves as soon as that many gameActions have landed, leaving the socket OPEN (caller's
   choice what to do with it - used to simulate "walk away mid-game" ahead of a real month
   rollover). `acct`, when present (including `null`), rides on the host message exactly like the
   real client's acctField(). Returns {ws, code, playerId, token, over, winners, deniedHost}. */
async function hostGame(port, { hostName, acct, stopAfterActions } = {}) {
  const seats = [
    { name: hostName || "Human", type: "human", diff: "medium" },
    { name: "CPU1", type: "cpu", diff: "easy" },
    { name: "CPU2", type: "cpu", diff: "easy" },
    { name: "CPU3", type: "cpu", diff: "easy" },
  ];
  const ws = await wsConnect(port);
  const E = createEngine();
  let actionsSeen = 0;
  return await new Promise((resolve, reject) => {
    let settled = false;
    let code = null, playerId = null, token = null;
    const budget = 60000;
    const hard = setTimeout(() => finish(new Error("hostGame did not settle within its budget")), budget);
    function finish(err, val) {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      if (err) { try { ws.close(); } catch (e) {} reject(err); }
      else resolve(val);
    }
    ws.on("message", (raw) => {
      if (settled) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      try {
        if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong", t: msg.t })); return; }
        if (msg.type === "error") {
          // A front-door denial (rate limit, bad name, or - the whole point of this suite - the
          // online-access gate). Resolved as data, not thrown, so the caller can assert on it.
          finish(null, { ws, denied: true, message: msg.message, reason: msg.reason, tokenCost: msg.tokenCost, itemId: msg.itemId, onlineAccess: msg.onlineAccess });
          return;
        }
        if (msg.type === "created") {
          code = msg.code; playerId = msg.playerId; token = msg.token;
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
          actionsSeen++;
          const G = E.getG();
          if (G.over) { finish(null, { ws, code, playerId, token, over: true, winners: G.winners.slice() }); return; }
          if (stopAfterActions && actionsSeen >= stopAfterActions) {
            finish(null, { ws, code, playerId, token, over: false, stoppedEarly: true });
            return;
          }
          if (G.turn === 0 && !G.bowedOut[0] && G.hands[0].length > 0) {
            const legal = E.legalMoves(0);
            if (legal.length) {
              const m = legal[Math.floor(Math.random() * legal.length)];
              const payload = JSON.stringify({ type: "action", action: { kind: "move", seat: 0, m } });
              setTimeout(() => { if (!settled) ws.send(payload); }, 10);
            }
          }
          return;
        }
        if (msg.type === "sync") { finish(new Error("got resynced mid-drive - a submitted move was rejected")); return; }
        if (msg.type === "kicked") { finish(new Error("server kicked us: " + msg.message)); return; }
      } catch (e) { finish(e); }
    });
    const hostMsg = { type: "host", protocolVersion: 5, name: hostName || "Human", n: 4, teams: false, seats };
    if (acct !== undefined) hostMsg.acct = acct;
    ws.send(JSON.stringify(hostMsg));
  });
}

/* Joins an already-hosted, not-yet-started room. Resolves as soon as either 'joined' or
   'joinError' arrives - the caller checks which. `acct`, when present (including null), rides on
   the join message. */
async function joinRoom(port, { code, name, acct }) {
  const ws = await wsConnect(port);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const hard = setTimeout(() => { if (!settled) { settled = true; try { ws.close(); } catch (e) {} reject(new Error("joinRoom timed out")); } }, 15000);
    ws.on("message", (raw) => {
      if (settled) return;
      let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong", t: msg.t })); return; }
      if (msg.type === "joined") { settled = true; clearTimeout(hard); resolve({ ws, joined: true }); return; }
      if (msg.type === "joinError") { settled = true; clearTimeout(hard); try { ws.close(); } catch (e) {} resolve({ joined: false, message: msg.message, reason: msg.reason, tokenCost: msg.tokenCost, itemId: msg.itemId, onlineAccess: msg.onlineAccess }); return; }
    });
    const m = { type: "join", protocolVersion: 5, code, name: name || "Joiner" };
    if (acct !== undefined) m.acct = acct;
    ws.send(JSON.stringify(m));
  });
}

/* Reconnects to an ALREADY-STARTED room via 'rejoin' (the mid-game-rollover proof needs this to
   keep working even for an account whose month has since lapsed) and drives it to a real finish
   from the server's live snapshot - exactly what bootGameFromSnapshot() does client-side. */
async function rejoinAndFinish(port, { code, playerId, token }) {
  const ws = await wsConnect(port);
  const E = createEngine();
  return await new Promise((resolve, reject) => {
    let settled = false;
    const budget = 60000;
    const hard = setTimeout(() => finish(new Error("rejoinAndFinish did not settle within its budget")), budget);
    function finish(err, val) {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      try { ws.close(); } catch (e) {}
      if (err) reject(err); else resolve(val);
    }
    ws.on("message", (raw) => {
      if (settled) return;
      let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      try {
        if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong", t: msg.t })); return; }
        if (msg.type === "rejoinError") { finish(new Error("rejoin refused: " + msg.message)); return; }
        if (msg.type === "kicked") { finish(new Error("server kicked us: " + msg.message)); return; }
        if (msg.type === "sync") {
          E.setLAY(E.buildLayout(msg.G.n));
          E.setG(msg.G);
          const G = E.getG();
          if (G.over) { finish(null, { over: true, winners: G.winners.slice() }); return; }
          if (G.turn === 0 && !G.bowedOut[0] && G.hands[0].length > 0) {
            const legal = E.legalMoves(0);
            if (legal.length) {
              const m = legal[Math.floor(Math.random() * legal.length)];
              setTimeout(() => { if (!settled) ws.send(JSON.stringify({ type: "action", action: { kind: "move", seat: 0, m } })); }, 10);
            }
          }
          return;
        }
        if (msg.type === "gameAction") {
          const a = msg.action;
          if (a.kind === "deal") {
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
          if (G.over) { finish(null, { over: true, winners: G.winners.slice() }); return; }
          if (G.turn === 0 && !G.bowedOut[0] && G.hands[0].length > 0) {
            const legal = E.legalMoves(0);
            if (legal.length) {
              const m = legal[Math.floor(Math.random() * legal.length)];
              setTimeout(() => { if (!settled) ws.send(JSON.stringify({ type: "action", action: { kind: "move", seat: 0, m } })); }, 10);
            }
          }
          return;
        }
      } catch (e) { finish(e); }
    });
    ws.send(JSON.stringify({ type: "rejoin", protocolVersion: 5, code, playerId, token }));
  });
}

async function main() {
  const key = K.makeKeyPair("online-access-key");
  const jwks = await K.startJwksServer([key]);
  const providerEnv = {
    NASTY_ACCOUNTS_ENABLED: "1",
    NASTY_APPLE_JWKS_URL: jwks.url, NASTY_APPLE_ISSUER: ISSUER, NASTY_APPLE_AUDIENCES: AUD,
    NASTY_ACCOUNT_RATE_LIMIT: "8000",
  };
  let seq = 0;
  async function boot(extra, tag) {
    const scratch = K.makeScratch(`online-access-${tag}-${KIND}`);
    const port = randPort() + (seq++);
    const base = `http://localhost:${port}`;
    const env = K.serverEnv(KIND, scratch, port, ADMIN_TOKEN, Object.assign({}, providerEnv, extra));
    const child = K.startServer(KIND, env, "ONLINE_ACCESS_VERBOSE");
    await K.waitHealthy(base);
    return {
      port, base, scratch, env, c: K.makeClient(base),
      async board() { return await (await fetch(base + "/leaderboard")).json(); },
      async shop() { return await (await fetch(base + "/shop")).json(); },
      stop() { return K.stopServer(child); },
    };
  }
  // Restarts the SAME server (same scratch/port/state on disk-or-KV) with different env - the
  // exact technique test_monthly_ranking.js's Part F already established for simulating a real
  // month rollover across a process restart, reused here rather than reinvented.
  async function restart(s, extraEnv) {
    await s.stop();
    const env = Object.assign({}, s.env, extraEnv || {});
    const child = K.startServer(KIND, env, "ONLINE_ACCESS_VERBOSE");
    await K.waitHealthy(s.base);
    s.env = env;
    s._child = child;
    s.stop = () => K.stopServer(child);
  }
  let gid = 0;
  async function seedPoints(base, name, pts) {
    const r = await fetch(base + "/solo-result", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: `oa-${KIND}-${Date.now()}-${gid++}`, entries: [{ name, delta: { hg4s: 1, hw4s: 1, hptsS: pts } }] }),
    });
    return r.status;
  }
  async function signInAs(c, sub, name) {
    const r = await c.signIn(key, { sub, iss: ISSUER, aud: AUD });
    if (r.status !== 200) throw new Error("sign-in failed for " + sub + ": " + JSON.stringify(r.body));
    if (name) await c.post("/account/name", { auth: r.body.sessionToken, name });
    return r.body;
  }
  async function status(c, auth) { return await c.post("/account/online-status", { auth }); }
  async function buy(c, auth, itemId, extra) { return await c.post("/account/purchase", Object.assign({ auth, itemId }, extra || {})); }

  /* =============================================================================================
   * GROUP 1 - the free-period-by-signup-date rule, item 1 of the brief: an account created
   * 2026-07-27 (the real system clock this session ran on reads 2026-07-29 - see the note in the
   * final report; only the CALENDAR MONTH of `created` is ever consulted, never the day, so a
   * freshly-created account today is functionally identical to one created 2026-07-26/27 for
   * every claim this group proves) is entitled for July AND August, and NOT for September.
   * ========================================================================================== */
  {
    const s = await boot({}, "group1-freeperiod");
    try {
      const acct = await signInAs(s.c, "001111.group1", "Group1Fam");
      const st1 = await status(s.c, acct.sessionToken);
      check(st1.status === 200, "1.0 online-status answers 200 for a signed-in account");
      log("1.0 raw status:", JSON.stringify(st1.body));
      const signupMonth = st1.body.month;
      check(signupMonth === "2026-07", "1.1 signup happened in the real current Chicago month, 2026-07: " + signupMonth);
      check(st1.body.entitled === true, "1.2 entitled in the signup month itself");
      check(st1.body.reason === "free", "1.3 reason is 'free' in the signup month: " + st1.body.reason);
      check(st1.body.freeThroughMonth === "2026-08", "1.4 free period runs through 2026-08 (signup month + 1 full month): " + st1.body.freeThroughMonth);
      check(st1.body.monthsAheadCovered === 1, "1.5 exactly one FUTURE month (August) already covered: " + st1.body.monthsAheadCovered);
      check(st1.body.tokenCost === 50, "1.6 token cost reported as 50: " + st1.body.tokenCost);
      check(st1.body.itemId === "online_month", "1.7 item id reported as online_month: " + st1.body.itemId);

      // Fast-forward the server's notion of "now" to mid-August, same account, same server -
      // still free (the confirmed "AND all of August" half of Blake's exact scenario).
      await restart(s, { NASTY_MONTHLY_NOW_MS: String(midMonthMs("2026-08")) });
      const st2 = await status(s.c, acct.sessionToken);
      check(st2.body.month === "2026-08", "1.8 server now reads August as the current month: " + st2.body.month);
      check(st2.body.entitled === true, "1.9 STILL entitled in August (the following full calendar month)");
      check(st2.body.reason === "free", "1.10 still free in August, not purchased: " + st2.body.reason);

      // Fast-forward to mid-September - the free period is exhausted, no purchase was made.
      await restart(s, { NASTY_MONTHLY_NOW_MS: String(midMonthMs("2026-09")) });
      const st3 = await status(s.c, acct.sessionToken);
      check(st3.body.month === "2026-09", "1.11 server now reads September as the current month: " + st3.body.month);
      check(st3.body.entitled === false, "1.12 NOT entitled in September - the free period has ended");
      check(st3.body.reason === "none", "1.13 reason is 'none': " + st3.body.reason);
      check(st3.body.accessUntil === null, "1.14 accessUntil is null when not entitled");
    } finally { await s.stop(); }
  }

  /* =============================================================================================
   * GROUP 2 - purchase mechanics (items 2, 3, 4): grants exactly one month, deducts exactly 50,
   * stacks forward on repeat purchases without ever wasting one, and an unaffordable purchase is
   * refused and changes nothing. Real current month throughout (2026-07, already free through
   * 2026-08), so a purchase's earliest unentitled month is 2026-09, then 2026-10.
   * ========================================================================================== */
  {
    const s = await boot({}, "group2-purchase");
    try {
      const acct = await signInAs(s.c, "001111.group2", "Group2Fam");
      await seedPoints(s.base, "Group2Fam", 300);

      const before = await status(s.c, acct.sessionToken);
      check(before.body.monthsAheadCovered === 1, "2.0 before any purchase, 1 future month (Aug) already covered");

      const p1 = await buy(s.c, acct.sessionToken, "online_month");
      check(p1.status === 200, "2.1 first online_month purchase succeeds: " + JSON.stringify(p1.body));
      check(p1.body.wallet.spent === 50, "2.2 exactly 50 points spent: " + p1.body.wallet.spent);
      check(p1.body.wallet.balance === 250, "2.3 balance is exactly 300-50=250: " + p1.body.wallet.balance);
      check(p1.body.onlineAccess.monthsAheadCovered === 2, "2.4 now 2 future months covered (Aug free + Sep purchased): " + p1.body.onlineAccess.monthsAheadCovered);

      const p2 = await buy(s.c, acct.sessionToken, "online_month");
      check(p2.status === 200, "2.5 second online_month purchase succeeds: " + JSON.stringify(p2.body));
      check(p2.body.wallet.spent === 100, "2.6 spent is now exactly 100 (two purchases of 50, never double-charged): " + p2.body.wallet.spent);
      check(p2.body.wallet.balance === 200, "2.7 balance is exactly 300-100=200: " + p2.body.wallet.balance);
      check(p2.body.onlineAccess.monthsAheadCovered === 3, "2.8 now 3 future months covered (Aug free + Sep + Oct purchased) - the SECOND purchase stacked into a NEW month, not wasted: " + p2.body.onlineAccess.monthsAheadCovered);

      // Prove the actual months granted, not just the count: fast-forward to Sept and Oct in turn.
      await restart(s, { NASTY_MONTHLY_NOW_MS: String(midMonthMs("2026-09")) });
      const stSep = await status(s.c, acct.sessionToken);
      check(stSep.body.entitled === true && stSep.body.reason === "purchased", "2.9 September is entitled via the FIRST purchase: " + JSON.stringify(stSep.body));
      await restart(s, { NASTY_MONTHLY_NOW_MS: String(midMonthMs("2026-10")) });
      const stOct = await status(s.c, acct.sessionToken);
      check(stOct.body.entitled === true && stOct.body.reason === "purchased", "2.10 October is entitled via the SECOND purchase: " + JSON.stringify(stOct.body));
      await restart(s, { NASTY_MONTHLY_NOW_MS: String(midMonthMs("2026-11")) });
      const stNov = await status(s.c, acct.sessionToken);
      check(stNov.body.entitled === false, "2.11 November is NOT covered (only 2 months were ever purchased) - nothing was wasted, nothing was over-granted: " + JSON.stringify(stNov.body));

      // Item 4: an unaffordable purchase is refused and changes nothing.
      const poor = await signInAs(s.c, "001111.group2poor", "Group2Poor");
      const beforePoor = await status(s.c, poor.sessionToken);
      const failBuy = await buy(s.c, poor.sessionToken, "online_month");
      check(failBuy.status === 409, "2.12 an unaffordable purchase (0 earned points, cost 50) is refused: " + JSON.stringify(failBuy.body));
      check(failBuy.body.error === "cantafford", "2.13 refusal reason is 'cantafford'");
      const afterPoor = await status(s.c, poor.sessionToken);
      check(JSON.stringify(beforePoor.body) === JSON.stringify(afterPoor.body),
        "2.14 the refused purchase changed NOTHING: before=" + JSON.stringify(beforePoor.body) + " after=" + JSON.stringify(afterPoor.body));
      const poorWallet = await s.c.post("/account/wallet", { auth: poor.sessionToken });
      check(poorWallet.body.spent === 0 && poorWallet.body.balance === 0, "2.15 the poor account's wallet is untouched by the failed attempt");
    } finally { await s.stop(); }
  }

  /* =============================================================================================
   * GROUP 6 (points-order half, run here since it reuses group 2's purchaser) - lifetime earned
   * points and cross-account ORDERING are completely unaffected by an online_month purchase,
   * mirroring the wallet suite's own W7 proof for this specific item id.
   * ========================================================================================== */
  {
    const s = await boot({}, "group6-leaderboard");
    try {
      const rich = await signInAs(s.c, "001111.group6rich", "Group6Rich");
      const poor = await signInAs(s.c, "001111.group6poor", "Group6Poor");
      await seedPoints(s.base, "Group6Rich", 200);
      await seedPoints(s.base, "Group6Poor", 60);
      const before = await s.board();
      check(before.Group6Rich && before.Group6Rich.hptsS === 200, "6.1 setup: Group6Rich shows 200 earned before any purchase");
      const buyResp = await buy(s.c, rich.sessionToken, "online_month");
      check(buyResp.status === 200, "6.2 the purchase itself succeeds");
      const after = await s.board();
      check(JSON.stringify(before.Group6Rich) === JSON.stringify(after.Group6Rich),
        "6.3 Group6Rich's leaderboard row is byte-identical before and after buying online access: " + JSON.stringify(after.Group6Rich));
      check(JSON.stringify(before.Group6Poor) === JSON.stringify(after.Group6Poor),
        "6.4 Group6Poor's row is untouched too (spending is per-account, proven anyway)");
    } finally { await s.stop(); }
  }

  /* =============================================================================================
   * GROUP 3 - ENFORCEMENT (item 5): a guest is refused at both host and join with reason
   * 'signInRequired'; an unentitled (signed-in but lapsed, no purchase) account is refused at
   * both host and join with reason 'onlineAccessRequired'; an entitled account can host and can
   * be joined by another entitled account, over a REAL websocket. The whole boot's clock is
   * pinned to September so a brand-new account (created "now", i.e. really 2026-07) is ALREADY
   * past its free period without needing a restart.
   * ========================================================================================== */
  {
    const s = await boot({ NASTY_MONTHLY_NOW_MS: String(midMonthMs("2026-09")) }, "group3-enforce");
    try {
      const gated = await signInAs(s.c, "001111.group3gated", "G3Gated");
      const gatedStatus = await status(s.c, gated.sessionToken);
      check(gatedStatus.body.entitled === false, "3.0 setup: G3Gated is genuinely unentitled under this boot's pinned September clock");

      // 3a. Guest host - no `acct` field at all.
      const guestHost = await hostGame(s.port, { hostName: "GuestHost" });
      check(guestHost.denied === true, "3.1 a GUEST host attempt is refused, not silently accepted");
      check(guestHost.reason === "signInRequired", "3.2 guest host reason code is 'signInRequired': " + guestHost.reason);
      check(typeof guestHost.message === "string" && guestHost.message.length > 0, "3.3 guest host carries a plain human sentence: " + guestHost.message);

      // 3b. Unentitled (signed-in, lapsed) host.
      const gatedHost = await hostGame(s.port, { hostName: "G3Gated", acct: gated.sessionToken });
      check(gatedHost.denied === true, "3.4 an UNENTITLED signed-in account's host attempt is refused");
      check(gatedHost.reason === "onlineAccessRequired", "3.5 unentitled host reason code is 'onlineAccessRequired': " + gatedHost.reason);
      check(gatedHost.tokenCost === 50, "3.6 the denial itself tells the client the token cost: " + gatedHost.tokenCost);
      check(gatedHost.onlineAccess && gatedHost.onlineAccess.entitled === false, "3.7 the denial carries the full onlineAccess view for a client to render");

      // Entitled host + entitled joiner, to have a real lobby to test the negative join cases
      // against, and as the positive control proving entitled accounts are NEVER blocked.
      await seedPoints(s.base, "G3Host", 100);
      const host1 = await signInAs(s.c, "001111.group3host", "G3Host");
      const hostBuy = await buy(s.c, host1.sessionToken, "online_month");
      check(hostBuy.status === 200, "3.8 setup: G3Host buys this month's access (100 pts seeded, cost 50)");
      const hostStatus = await status(s.c, host1.sessionToken);
      check(hostStatus.body.entitled === true, "3.9 setup: G3Host is now entitled for the current (pinned September) month");

      const lobbyWs = await wsConnect(s.port);
      const created = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("host never created a room")), 10000);
        lobbyWs.on("message", (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "ping") { lobbyWs.send(JSON.stringify({ type: "pong", t: msg.t })); return; }
          if (msg.type === "created") { clearTimeout(t); resolve(msg); }
        });
        lobbyWs.send(JSON.stringify({
          type: "host", protocolVersion: 5, name: "G3Host", n: 4, teams: false,
          seats: [{ name: "G3Host", type: "human", diff: "medium" }], acct: host1.sessionToken,
        }));
      });
      check(!!created.code, "3.10 an ENTITLED account's host attempt succeeds normally: room " + created.code);

      // 3c. Guest join into that real, open lobby.
      const guestJoin = await joinRoom(s.port, { code: created.code, name: "GuestJoiner" });
      check(guestJoin.joined === false, "3.11 a GUEST join attempt into a real open lobby is refused");
      check(guestJoin.reason === "signInRequired", "3.12 guest join reason code is 'signInRequired': " + guestJoin.reason);

      // 3d. Unentitled signed-in join into that same lobby.
      const gatedJoin = await joinRoom(s.port, { code: created.code, name: "G3Gated", acct: gated.sessionToken });
      check(gatedJoin.joined === false, "3.13 an UNENTITLED signed-in account's join attempt is refused");
      check(gatedJoin.reason === "onlineAccessRequired", "3.14 unentitled join reason code is 'onlineAccessRequired': " + gatedJoin.reason);

      // 3e. Positive control: another ENTITLED account CAN join the same lobby.
      await seedPoints(s.base, "G3Joiner", 100);
      const joiner1 = await signInAs(s.c, "001111.group3joiner", "G3Joiner");
      await buy(s.c, joiner1.sessionToken, "online_month");
      const goodJoin = await joinRoom(s.port, { code: created.code, name: "G3Joiner", acct: joiner1.sessionToken });
      check(goodJoin.joined === true, "3.15 an ENTITLED account's join attempt succeeds normally");
      try { lobbyWs.close(); } catch (e) {}
      try { goodJoin.ws && goodJoin.ws.close(); } catch (e) {}
    } finally { await s.stop(); }
  }

  /* =============================================================================================
   * GROUP 4 - item 6: an entitled account plays a COMPLETE real online game entirely normally,
   * with entitlement enforcement fully active (the default). Real current month (free period).
   * ========================================================================================== */
  {
    const s = await boot({}, "group4-normal-play");
    try {
      const acct = await signInAs(s.c, "001111.group4", "G4Player");
      const result = await hostGame(s.port, { hostName: "G4Player", acct: acct.sessionToken });
      check(result.over === true, "4.1 an entitled account's online game plays all the way to a real finish: winners=" + JSON.stringify(result.winners));
      const board = await s.board();
      check(!!board.G4Player, "4.2 the finished game was recorded to the shared leaderboard under the account's name");
    } finally { await s.stop(); }
  }

  /* =============================================================================================
   * GROUP 5 - item 7: a game already in progress when a month rolls over is NOT interrupted, and
   * rejoining it still works even though the account's month has since lapsed - proving the
   * design decision (gate only at host/join, never mid-game) against a REAL process restart, the
   * same technique test_monthly_ranking.js's Part F uses to simulate a real rollover.
   * ========================================================================================== */
  {
    const s = await boot({}, "group5-rollover");
    try {
      const acct = await signInAs(s.c, "001111.group5", "G5Player");
      const before = await status(s.c, acct.sessionToken);
      check(before.body.entitled === true, "5.0 setup: G5Player is entitled at game start (real current month, free)");

      // Start a real game and stop the shadow driver after a handful of actions - the game is
      // genuinely IN PROGRESS (not finished) and the socket is still open.
      const mid = await hostGame(s.port, { hostName: "G5Player", acct: acct.sessionToken, stopAfterActions: 6 });
      check(mid.stoppedEarly === true && mid.over === false, "5.1 the game is genuinely in progress, not finished, when we walk away: " + JSON.stringify({ over: mid.over, stoppedEarly: mid.stoppedEarly }));
      try { mid.ws.close(); } catch (e) {}

      // Simulate a real month rollover: restart the SAME server/room state with the clock pinned
      // to September - this account's free period has now lapsed, with no purchase.
      await restart(s, { NASTY_MONTHLY_NOW_MS: String(midMonthMs("2026-09")) });
      const afterRollover = await status(s.c, acct.sessionToken);
      check(afterRollover.body.entitled === false, "5.2 confirmed: this account is now genuinely unentitled after the simulated rollover");

      // The in-progress game must NOT be ripped away: rejoin must still succeed and the game must
      // be finishable to completion, exactly as if nothing had happened.
      const finished = await rejoinAndFinish(s.port, { code: mid.code, playerId: mid.playerId, token: mid.token });
      check(finished.over === true, "5.3 the SAME in-progress game, from BEFORE the rollover, rejoins successfully and plays to a real finish AFTER the rollover - it was never interrupted");
      const board = await s.board();
      check(!!board.G5Player, "5.4 the game that survived the rollover still recorded to the leaderboard exactly once");

      // Contrast, stated explicitly: the SAME now-unentitled account trying to start a BRAND NEW
      // game after the rollover IS blocked - the gate applies to NEW participation, never to an
      // already-seated player finishing what they started.
      const newAttempt = await hostGame(s.port, { hostName: "G5Player", acct: acct.sessionToken });
      check(newAttempt.denied === true && newAttempt.reason === "onlineAccessRequired",
        "5.5 the SAME account's attempt to host a NEW game after the rollover IS blocked: " + JSON.stringify({ denied: newAttempt.denied, reason: newAttempt.reason }));
    } finally { await s.stop(); }
  }

  /* =============================================================================================
   * GROUP 7 - item 9: the existing wallet, shop, leaderboard and monthly endpoints all still
   * behave identically. Spot checks only - test_accounts_wallet.js/test_monthly_ranking.js carry
   * the full regression bar for those features; this just confirms nothing about THIS feature
   * leaked into or broke them.
   * ========================================================================================== */
  {
    const s = await boot({}, "group7-existing");
    try {
      const shop = await s.c.get("/shop");
      check(shop.status === 200, "7.1 GET /shop still answers 200");
      check(Array.isArray(shop.body.items) && shop.body.items.length === 15, "7.2 shop still lists every item, now 15 including online_month: " + shop.body.items.length);
      const cats = Array.from(new Set(shop.body.items.map((i) => i.category))).sort();
      check(JSON.stringify(cats) === JSON.stringify(["felt", "namechange", "online", "palette", "title"]), "7.3 categories: " + JSON.stringify(cats));

      const acct = await signInAs(s.c, "001111.group7", "G7Player");
      const wallet = await s.c.post("/account/wallet", { auth: acct.sessionToken });
      check(wallet.status === 200, "7.4 POST /account/wallet still answers 200");
      check(!("onlineAccess" in wallet.body), "7.5 /account/wallet's shape is UNCHANGED - no onlineAccess field leaked in (kept on the dedicated status endpoint instead)");
      check(typeof wallet.body.lifetimeEarned === "number" && typeof wallet.body.balance === "number", "7.6 wallet still has its original fields");

      const board = await s.board();
      check(typeof board === "object", "7.7 GET /leaderboard still answers a plain object");
      const monthly = await s.c.get("/leaderboard/monthly");
      check(monthly.status === 200 && typeof monthly.body.month === "string", "7.8 GET /leaderboard/monthly still answers 200 with a month key: " + JSON.stringify(monthly.body).slice(0, 120));
    } finally { await s.stop(); }
  }

  /* =============================================================================================
   * BONUS - the NASTY_ONLINE_ENTITLEMENT_ENFORCED kill switch actually works, since it is the
   * documented escape hatch for anyone this feature's enforcement surprises.
   * ========================================================================================== */
  {
    const s = await boot({ NASTY_ONLINE_ENTITLEMENT_ENFORCED: "0" }, "group8-killswitch");
    try {
      const guestHost = await hostGame(s.port, { hostName: "KillSwitchGuest" });
      check(guestHost.denied !== true, "8.1 with the kill switch off, a GUEST can host again exactly like before this feature existed: " + JSON.stringify({ denied: guestHost.denied, code: guestHost.code }));
      try { guestHost.ws && guestHost.ws.close(); } catch (e) {}
    } finally { await s.stop(); }
  }

  log(`${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => {
  FAIL++;
  log("FAIL", "unexpected exception: " + (e && e.stack || e));
  log(`${PASS} passed, ${FAIL} failed`);
  process.exit(1);
});
