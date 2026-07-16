// v0.17 AI difficulty overhaul: a small, fast, permanent regression check on the tier ladder.
// All three tiers share ONE strategic scoring core (index.html § AI: scoreMove + strategyBonus)
// and differ only in AI_TIERS parameters (jitter / strat weight / endgame denial). This test
// guards two things a future engine change could quietly break:
//   1. Nasty ('hard') still measurably beats Easy ('easy') - the ladder still has a gap.
//   2. Easy still beats a PURE-RANDOM baseline - Easy is still strategic, not a coin flip.
//      (The random policy lives only in this test - there is no random tier in shipped code.)
// Not a full statistical validation (the dev-time scratchpad harness ran 400+ games/matchup
// with tighter targets) - just a CI-reasonable guard. Runs straight against server/engine.js
// (createEngine()), same driver shape as ../test-engine-headless.js - no server process, no
// Playwright, no network.
// Usage: node test_ai_difficulty.js
const { createEngine } = require("../engine.js");

const GAMES = 30;        // hard-vs-easy matchup - CI-reasonable, not the 400+ game acceptance run
const GAMES_RANDOM = 40; // easy-vs-random gets a few more games: its true rate (~75%) sits closer
                         // to its threshold, so the extra games keep the flake risk negligible
const HARD_VS_EASY_MIN = 0.65;   // dev-time acceptance measured 91.5%; big margin for variance
const EASY_VS_RANDOM_MIN = 0.55; // dev-time acceptance measured 75.5%; margin for variance

function log(...a) { console.log("[ai-difficulty]", ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK ", label); } else { FAIL++; log("FAIL", label); } }

// Test-only pure-random policy: uniform over legalMoves(). Seats tagged diff:'random' are
// intercepted below before chooseAI ever sees them (chooseAI has no such tier; unknown keys
// fall back to medium, so the interception is what actually makes these seats random).
function pickRandom(moves) { return moves[Math.floor(Math.random() * moves.length)]; }

// 4P FFA, seats 0/2 = tierA, seats 1/3 = tierB - alternated per game (see runMatchup) so
// neither tier is structurally favored by turn order / dealer-left-goes-first.
function seatsFor(tierA, tierB) {
  return [
    { name: "A0", type: "cpu", diff: tierA },
    { name: "B0", type: "cpu", diff: tierB },
    { name: "A1", type: "cpu", diff: tierA },
    { name: "B1", type: "cpu", diff: tierB },
  ];
}

function runOneGame(seats, maxTurns) {
  const E = createEngine();
  E.setLAY(E.buildLayout(4));
  E.newGame({ n: 4, teams: false, seats }, { deck: E.freshDeck(), dealer: Math.floor(Math.random() * 4) });
  let turns = 0;
  while (!E.getG().over) {
    if (turns++ > maxTurns) throw new Error(`did not finish within ${maxTurns} turns`);
    const G = E.getG();
    if (E.handOver()) {
      for (let s = 0; s < G.n; s++) { if (G.hands[s].length) { G.discard.push(...G.hands[s]); G.hands[s].length = 0; } }
      if (E.needsReshuffle()) E.dealDecision({ deck: E.freshDeck(), dealer: (G.dealer + 1) % G.n });
      else E.dealDecision({});
      continue;
    }
    const seat = G.turn;
    if (G.hands[seat].length === 0) { E.advanceTurn(); continue; }
    if (G.bowedOut[seat]) { E.passDecision(seat, false); E.advanceTurn(); continue; }
    const moves = E.legalMoves(seat);
    if (moves.length === 0) { E.passDecision(seat, true); E.advanceTurn(); continue; }
    const m = seats[seat].diff === "random" ? pickRandom(moves) : E.chooseAI(seat, moves);
    E.applyMove(seat, m);
    if (!E.getG().over) E.advanceTurn();
  }
  return E.getG().winners[0];
}

function runMatchup(tierA, tierB, games) {
  let winsA = 0, winsB = 0;
  for (let i = 0; i < games; i++) {
    const swap = i % 2 === 1;
    const seats = swap ? seatsFor(tierB, tierA) : seatsFor(tierA, tierB);
    const winnerSeat = runOneGame(seats, 30000);
    const winnerTier = seats[winnerSeat].diff;
    if (winnerTier === tierA) winsA++; else if (winnerTier === tierB) winsB++;
  }
  return { winsA, winsB, total: winsA + winsB };
}

function main() {
  const he = runMatchup("hard", "easy", GAMES);
  const heRate = he.winsA / he.total;
  log(`Nasty (hard) vs Easy: ${he.winsA}/${he.total} = ${(100 * heRate).toFixed(1)}% over ${GAMES} games`);
  check(heRate >= HARD_VS_EASY_MIN, `Nasty beats Easy at >=${(100 * HARD_VS_EASY_MIN).toFixed(0)}% (got ${(100 * heRate).toFixed(1)}%)`);

  const er = runMatchup("easy", "random", GAMES_RANDOM);
  const erRate = er.winsA / er.total;
  log(`Easy vs pure-random: ${er.winsA}/${er.total} = ${(100 * erRate).toFixed(1)}% over ${GAMES_RANDOM} games`);
  check(erRate >= EASY_VS_RANDOM_MIN, `Easy beats pure-random at >=${(100 * EASY_VS_RANDOM_MIN).toFixed(0)}% (got ${(100 * erRate).toFixed(1)}%) - proves Easy is strategic`);

  log(`\n${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}
main();
