#!/usr/bin/env node
"use strict";
/*
 * v0.15 — headless sanity test for the extracted engine (server/engine.js), independent of any
 * server/network code. Runs full CPU-vs-CPU games straight against the engine module (newGame
 * -> loop legalMoves/chooseAI/applyMove -> G.over) for both board sizes, several runs each, and
 * asserts: no exceptions, a winner is reached, and no two pieces ever occupy the same ABSOLUTE
 * board position (converted via loopIdx() - comparing raw seat-relative `steps` across seats is
 * a documented false-positive trap, see HANDOFF.md's v0.11-era note on this exact mistake).
 *
 * Run: node server/test-engine-headless.js
 */
const { createEngine } = require("./engine.js");

function seatsFor(n, teams) {
  const diffs = ["easy", "medium", "hard"];
  return Array.from({ length: n }, (_, i) => ({
    name: "P" + i, type: "cpu", diff: diffs[i % diffs.length],
  }));
}

function checkNoDoubleOccupancy(E) {
  const G = E.getG();
  const seen = new Map();
  for (let s = 0; s < G.n; s++) {
    for (const p of G.pieces[s]) {
      if (p.state !== "track") continue;
      const abs = E.loopIdx(s, p.steps);
      if (seen.has(abs)) return { bad: true, abs, a: seen.get(abs), b: s };
      seen.set(abs, s);
    }
  }
  return { bad: false };
}

function runOneGame(n, teams, maxTurns) {
  const E = createEngine();
  E.setLAY(E.buildLayout(n));
  // This is a headless stand-in for the SERVER's authoritative view (server/server.js always
  // seeds a real deck - only the ONLINE CLIENT mirror ever passes an empty deck, since it
  // never deals for itself, see index.html's bootGameFromNetwork()). An empty seed.deck here
  // would make the very first (non-reshuffle) deal round pop from an empty array.
  E.newGame({ n, teams, seats: seatsFor(n, teams) }, { deck: E.freshDeck(), dealer: 0 });
  let turns = 0;
  let deals = 0;
  while (!E.getG().over) {
    if (turns++ > maxTurns) throw new Error(`game did not finish within ${maxTurns} turns (n=${n} teams=${teams})`);
    const G = E.getG();
    if (E.handOver()) {
      // sweep dead cards from bowed-out seats, mirroring runTurnInner()'s sweep
      for (let s = 0; s < G.n; s++) { if (G.hands[s].length) { G.discard.push(...G.hands[s]); G.hands[s].length = 0; } }
      if (E.needsReshuffle()) {
        E.dealDecision({ deck: E.freshDeck(), dealer: (G.dealer + 1) % G.n });
      } else {
        E.dealDecision({});
      }
      deals++;
      const chk = checkNoDoubleOccupancy(E);
      if (chk.bad) throw new Error(`double occupancy at abs=${chk.abs} seats ${chk.a}/${chk.b} after deal #${deals}`);
      continue;
    }
    const seat = G.turn;
    if (G.hands[seat].length === 0) { E.advanceTurn(); continue; }
    if (G.bowedOut[seat]) { E.passDecision(seat, false); E.advanceTurn(); continue; }
    const moves = E.legalMoves(seat);
    if (moves.length === 0) {
      E.passDecision(seat, true);
      E.advanceTurn();
      continue;
    }
    const m = E.chooseAI(seat, moves);
    E.applyMove(seat, m);
    const chk = checkNoDoubleOccupancy(E);
    if (chk.bad) throw new Error(`double occupancy at abs=${chk.abs} seats ${chk.a}/${chk.b} after a move`);
    if (!E.getG().over) E.advanceTurn();
  }
  return { turns, deals, winners: E.getG().winners.slice() };
}

function main() {
  const cases = [
    { n: 4, teams: false, runs: 3, maxTurns: 20000 },
    { n: 4, teams: true, runs: 2, maxTurns: 20000 },
    { n: 6, teams: false, runs: 2, maxTurns: 40000 },
    { n: 6, teams: true, runs: 2, maxTurns: 40000 },
  ];
  let ok = 0, fail = 0;
  for (const c of cases) {
    for (let i = 0; i < c.runs; i++) {
      const t0 = Date.now();
      try {
        const r = runOneGame(c.n, c.teams, c.maxTurns);
        const ms = Date.now() - t0;
        console.log(`OK  n=${c.n} teams=${c.teams} run=${i + 1}/${c.runs}  turns=${r.turns} deals=${r.deals} winners=${r.winners} (${ms}ms)`);
        ok++;
      } catch (e) {
        console.error(`FAIL n=${c.n} teams=${c.teams} run=${i + 1}/${c.runs}:`, e.message);
        fail++;
      }
    }
  }
  console.log(`\n${ok} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main();
