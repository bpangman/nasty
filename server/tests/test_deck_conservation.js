#!/usr/bin/env node
"use strict";
/*
 * Card conservation - a permanent regression check (fairness audit, 2026-07-18).
 * Independent of any other test: asserts that at EVERY checkpoint of a real simulated game -
 * right after newGame(), after every deal (dealDecision()), after every played move
 * (applyMove()), and after every pass/bow-out (passDecision(), which can also throw a stuck
 * hand's cards into discard) - the total card count across the whole table is exactly 52:
 *     G.deck.length + sum(G.hands[s].length) + G.discard.length === 52
 * always, no exceptions, regardless of player count, teams mode, dealer, or how many reshuffles
 * happen along the way. A violation here means a card got duplicated (drift upward) or lost
 * (drift downward) somewhere in the deal/play/discard bookkeeping - a real correctness bug, not
 * a style nit, since it would eventually hand someone an impossible hand or leave the deck short.
 *
 * Drives full CPU-vs-CPU games straight against server/engine.js's createEngine() - same
 * harness pattern as test-engine-headless.js / test_ai_difficulty.js (no browser, no server, no
 * network). Mixes all three AI tiers across seats so every code path chooseAI() can reach
 * (including the 'hard' tier's rollout, which itself runs whole simulated hands - including
 * simulated reshuffles - inside a cloned G; see cloneG()/rolloutValue() in index.html § AI) gets
 * exercised, not just the real game's own bookkeeping.
 *
 * Run: node server/tests/test_deck_conservation.js  (wired into `npm test`, see package.json)
 */
const { createEngine } = require("../engine.js");

let PASS = 0, FAIL = 0;
function log(...a) { console.log("[deck-conservation]", ...a); }
function check(cond, label) { if (cond) { PASS++; } else { FAIL++; log("FAIL", label); } }

function totalCards(G) {
  return G.deck.length + G.hands.reduce((a, h) => a + h.length, 0) + G.discard.length;
}

// Asserts conservation right now; throws with full context on any drift so a failure points
// straight at which checkpoint broke it, not just "somewhere in this game."
function assertConserved(E, ctx, checkpointCount) {
  const G = E.getG();
  const total = totalCards(G);
  checkpointCount.n++;
  if (total !== 52) {
    throw new Error(
      `card conservation violated at "${ctx}" (checkpoint #${checkpointCount.n}): total=${total} ` +
      `(deck=${G.deck.length}, hands=${JSON.stringify(G.hands.map(h => h.length))}, discard=${G.discard.length})`
    );
  }
}

function seatsFor(n) {
  // Mix all three tiers across seats so 'hard' (the rollout tier, the one under suspicion in
  // this audit) drives real decisions in every game, not just a subset of runs.
  const diffs = ["easy", "medium", "hard"];
  return Array.from({ length: n }, (_, i) => ({
    name: "P" + i, type: "cpu", diff: diffs[i % diffs.length],
  }));
}

function runOneGame(n, teams, dealerSeed, maxTurns, checkpointCount) {
  const E = createEngine();
  E.setLAY(E.buildLayout(n));
  E.newGame({ n, teams, seats: seatsFor(n) }, { deck: E.freshDeck(), dealer: dealerSeed % n });
  assertConserved(E, "post newGame", checkpointCount);
  let turns = 0, deals = 0;
  while (!E.getG().over) {
    if (turns++ > maxTurns) throw new Error(`game did not finish within ${maxTurns} turns (n=${n} teams=${teams})`);
    const G = E.getG();
    if (E.handOver()) {
      // sweep dead cards from bowed-out seats, mirroring runTurnInner()'s sweep - see RULES.md /
      // HANDOFF.md: leftover held cards at hand-over go to discard, they don't vanish.
      for (let s = 0; s < G.n; s++) { if (G.hands[s].length) { G.discard.push(...G.hands[s]); G.hands[s].length = 0; } }
      assertConserved(E, "post hand-over sweep", checkpointCount);
      if (E.needsReshuffle()) E.dealDecision({ deck: E.freshDeck(), dealer: (G.dealer + 1) % G.n });
      else E.dealDecision({});
      deals++;
      assertConserved(E, "post dealDecision", checkpointCount);
      continue;
    }
    const seat = G.turn;
    if (G.hands[seat].length === 0) { E.advanceTurn(); continue; }
    if (G.bowedOut[seat]) {
      E.passDecision(seat, false);
      assertConserved(E, "post passDecision (re-pass)", checkpointCount);
      E.advanceTurn();
      continue;
    }
    const moves = E.legalMoves(seat);
    if (moves.length === 0) {
      E.passDecision(seat, true);
      assertConserved(E, "post passDecision (fresh bow-out, possible throw-in)", checkpointCount);
      E.advanceTurn();
      continue;
    }
    const m = E.chooseAI(seat, moves);
    E.applyMove(seat, m);
    assertConserved(E, "post applyMove", checkpointCount);
    if (!E.getG().over) E.advanceTurn();
  }
  return { turns, deals };
}

function main() {
  // Several player counts, teams on/off, several dealer seeds each - "a few different game
  // lengths / random seeds, decent N" per the audit brief. freshDeck()'s own shuffle plus
  // chooseAI()'s jitter (easy/medium tiers) already gives each run a genuinely different game;
  // the dealer seed just also varies who deals/goes first first across runs.
  const cases = [
    { n: 4, teams: false, runs: 8, maxTurns: 20000 },
    { n: 4, teams: true, runs: 8, maxTurns: 20000 },
    { n: 6, teams: false, runs: 6, maxTurns: 40000 },
    { n: 6, teams: true, runs: 8, maxTurns: 40000 },
  ];
  const checkpointCount = { n: 0 };
  let ok = 0, fail = 0;
  for (const c of cases) {
    for (let i = 0; i < c.runs; i++) {
      const t0 = Date.now();
      try {
        const r = runOneGame(c.n, c.teams, i * 7 + 1, c.maxTurns, checkpointCount);
        const ms = Date.now() - t0;
        log(`OK  n=${c.n} teams=${c.teams} run=${i + 1}/${c.runs}  turns=${r.turns} deals=${r.deals} (${ms}ms)`);
        ok++;
      } catch (e) {
        log(`FAIL n=${c.n} teams=${c.teams} run=${i + 1}/${c.runs}:`, e.message);
        fail++;
      }
    }
  }
  check(fail === 0, `all ${ok + fail} games kept card conservation (52 total) at every checkpoint`);
  log(`${checkpointCount.n} total conservation checkpoints asserted across ${ok + fail} games`);
  log(`\n${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}
main();
