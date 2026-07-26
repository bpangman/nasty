// ==============================================================================================
// AI BLINDNESS PROOF - the permanent guard on v0.21's fairness fix, extended for v0.38's teamwork
// (added 2026-07-26)
// ==============================================================================================
// WHY THIS FILE EXISTS
// The v0.21 audit (2026-07-18) found the Nasty AI PEEKING: its lookahead rollout cloned the REAL
// game state, so it simulated the future using every opponent's ACTUAL hand, its partner's ACTUAL
// hand, and the REAL remaining deck in its REAL order. That was fixed (cloneG(seat) now pools and
// reshuffles all hidden cards) and re-audited later, but the guard was a CODE READ, not a test -
// see test_cpu_kick_fairness_audit.js part A, which says so in as many words.
//
// v0.38 added a teamwork layer (teamworkBonus(), index.html § AI) so two CPU partners cooperate.
// Cooperation is exactly the kind of feature that tempts a future session to "just look at the
// partner's hand" - RULES.md is explicit that partners' cards stay hidden from each other, and
// two coordinating CPUs must look like two good players who cannot see each other's cards, not
// like one player holding both hands. So the guard becomes a real test now.
//
// THE INVARIANT BEING PROVED
//   A seat's chosen move must be a function of ONLY:
//     - the public board (every peg's state/steps for every seat),
//     - the face-up discard pile,
//     - whose turn it is and the public bookkeeping (dealer, schedule, bow-outs, hand SIZES),
//     - that seat's OWN hand,
//     - and the multiset of cards that are unaccounted for (52 minus my hand minus the discard) -
//       which is legitimate: any player at the table can work that out by counting cards.
//   It must NOT depend on HOW those unaccounted-for cards are distributed between the other
//   players' hands and the undealt deck. That distribution is the hidden information.
//
// HOW IT IS TESTED (part B): take a real mid-game position, collect every hidden card into one
// pool, then deal that SAME pool back out many different ways - each other seat always keeping its
// exact hand size and the deck its exact length, so every public fact is byte-identical - and
// assert chooseAI() returns the IDENTICAL move every single time. Math.random is reseeded to the
// same value before every call, so the AI's own legitimate internal randomness (Easy/Tricky
// jitter, cloneG's reshuffle of the pool) is held constant and cannot mask a difference.
//
// This is only a valid test because cloneG() sorts the hidden pool into a canonical order (by
// card id) BEFORE shuffling it - see the comment on that line in index.html. Without the sort,
// Fisher-Yates over a differently-ORDERED array of the same cards yields a different imagined
// deal even with the same RNG stream, and a blind AI would still (harmlessly) reach different
// conclusions - which would make this invariant untestable. The sort makes blindness observable.
//
// PART C is a positive control: a deliberately PEEKING policy is run through the same harness and
// must FAIL the invariant. Without that, a test that passes proves nothing about its own power.
// ==============================================================================================
const path = require("path");
const fs = require("fs");
const { createEngine } = require("../engine.js");

function log(...a) { console.log("[ai-teams-fairness]", ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];
function seededDeck(rng) {
  const d = []; let id = 0;
  for (const s of SUITS) for (const r of RANKS) d.push({ r, s, id: id++ });
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

// ==============================================================================================
// PART A - static scan: nothing in § AI may read hidden state except cloneG()
// ==============================================================================================
function partA() {
  log("--- PART A: static scan of index.html's § AI block ---");
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "index.html"), "utf8");
  const aiStart = html.indexOf("§ AI ====");
  const aiEnd = html.indexOf("NASTY ENGINE EXTRACT: END");
  check(aiStart > 0 && aiEnd > aiStart, "found the § AI block inside the engine extract");
  let ai = html.slice(aiStart, aiEnd);

  // cloneG() is the ONE function allowed to touch hidden state - it exists precisely to
  // anonymise it. Cut it out (from its declaration to the line that closes it at column 0) and
  // everything left must be hidden-state-free.
  const cgStart = ai.indexOf("function cloneG(");
  check(cgStart > 0, "found cloneG()");
  const cgEnd = ai.indexOf("\n}\n", cgStart);
  check(cgEnd > cgStart, "found cloneG()'s closing brace");
  const cloneGBody = ai.slice(cgStart, cgEnd + 3);
  const rest = ai.slice(0, cgStart) + ai.slice(cgEnd + 3);

  // Strip comments before scanning - the explanatory prose in § AI legitimately talks ABOUT
  // G.deck / G.hands, and a comment cannot read anything.
  let code = rest.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // ONE documented allowance: rolloutValue()'s whole-table throw-in
  // (`G.discard.push(...G.hands[s])`). By the time that line runs, G has already been REPLACED by
  // cloneG()'s anonymised clone - those are imagined cards, not anybody's real hand - and the
  // line is pure bookkeeping copied from the real turn loop, not a scoring input (nothing in § AI
  // ever reads a card out of G.discard either). Blanked here so the scan below can stay a blunt
  // "no hidden card identity anywhere" rule for every other line.
  const throwIns = (code.match(/G\.discard\.push\(\.\.\.G\.hands\[\w+\]\)/g) || []).length;
  check(throwIns === 1, `exactly one whitelisted clone throw-in idiom in § AI (found ${throwIns})`);
  code = code.replace(/G\.discard\.push\(\.\.\.G\.hands\[\w+\]\)/g, "CLONE_THROW_IN");
  const deckHits = (code.match(/G\.deck/g) || []).length;
  const handHits = (code.match(/G\.hands/g) || []).length;
  const badHands = [];
  // G.hands[seat].length (how many cards a seat HOLDS) is public at a real table and the turn
  // bookkeeping in rolloutValue() needs it; reading the CARDS is what is forbidden. Allow only
  // the .length form.
  const handRefs = code.match(/G\.hands\[[^\]]*\](\.\w+)?/g) || [];
  for (const r of handRefs) if (!/\.length$/.test(r)) badHands.push(r);

  check(deckHits === 0, `no G.deck read anywhere in § AI outside cloneG() (found ${deckHits})`);
  check(badHands.length === 0,
    `no G.hands CARD access anywhere in § AI outside cloneG() - only hand SIZES (found ${badHands.length}: ${badHands.slice(0, 5).join(", ")})`);
  log(`  (${handRefs.length} G.hands[...] references outside cloneG(), all of them .length: ${JSON.stringify(handRefs)})`);
  check(/pool\.sort\(/.test(cloneGBody),
    "cloneG() canonicalises the hidden pool with a sort before shuffling it - the property PART B relies on");
  check(/for\(let i=pool\.length-1;i>0;i--\)/.test(cloneGBody),
    "cloneG() still reshuffles the hidden pool (the v0.21 fairness fix is intact)");
}

// ==============================================================================================
// PART B / C - partition invariance
// ==============================================================================================
// Play a seeded teams game forward `stopAt` turns and snapshot the position.
function positionAfter(n, diff, seed, stopAt) {
  const rng = mulberry32(seed);
  Math.random = mulberry32(seed ^ 0x1234abcd);
  const E = createEngine();
  E.setLAY(E.buildLayout(n));
  const seats = Array.from({ length: n }, (_, i) => ({ name: "S" + i, type: "cpu", diff }));
  E.newGame({ n, teams: true, seats }, { deck: seededDeck(rng), dealer: Math.floor(rng() * n) });
  let turns = 0;
  while (!E.getG().over && turns < stopAt) {
    const G = E.getG();
    if (E.handOver()) {
      for (let s = 0; s < G.n; s++) { if (G.hands[s].length) { G.discard.push(...G.hands[s]); G.hands[s].length = 0; } }
      if (E.needsReshuffle()) E.dealDecision({ deck: seededDeck(rng), dealer: (G.dealer + 1) % G.n });
      else E.dealDecision({});
      continue;
    }
    const seat = G.turn;
    if (G.hands[seat].length === 0) { E.advanceTurn(); continue; }
    if (G.bowedOut[seat]) { E.passDecision(seat, false); E.advanceTurn(); continue; }
    const moves = E.legalMoves(seat);
    if (moves.length === 0) { E.passDecision(seat, true); E.advanceTurn(); continue; }
    E.applyMove(seat, E.chooseAI(seat, moves));
    if (!E.getG().over) E.advanceTurn();
    turns++;
  }
  const G = E.getG();
  if (G.over) return null;
  return JSON.parse(JSON.stringify(G));
}

// Re-deal the hidden pool a different way, keeping every public fact identical.
function repartition(snap, seat, shuffleRng) {
  const G = JSON.parse(JSON.stringify(snap));
  const pool = [];
  for (let s = 0; s < G.n; s++) if (s !== seat) for (const c of G.hands[s]) pool.push(c);
  for (const c of G.deck) pool.push(c);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(shuffleRng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  let pi = 0;
  for (let s = 0; s < G.n; s++) {
    if (s === seat) continue;
    const k = G.hands[s].length;
    G.hands[s] = pool.slice(pi, pi + k); pi += k;
  }
  G.deck = pool.slice(pi);
  return G;
}

// A deliberately PEEKING policy for PART C's positive control: it scores each move exactly like
// the honest one-ply core does, then adds a term that could only be computed by looking at
// another player's actual cards. This must FAIL the invariant, proving the harness has teeth.
function peekingPolicy(E, seat, moves) {
  const G = E.getG();
  let peek = 0;
  for (let s = 0; s < G.n; s++) {
    if (s === seat) continue;
    for (const c of G.hands[s]) if (c.r === "Q" || c.r === "K") peek++;   // <- cheating
  }
  for (const c of G.deck) if (c.r === "A") peek++;                        // <- cheating
  let best = null, bs = -1e9;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    const s = E.scoreMove(seat, m) + (i === peek % moves.length ? 1000 : 0);
    if (s > bs) { bs = s; best = m; }
  }
  return best;
}

const PARTITIONS = 24;
function invarianceRun(n, diff, seed, stopAt, policy) {
  const snap = positionAfter(n, diff, seed, stopAt);
  if (!snap) return null;
  const E = createEngine();
  E.setLAY(E.buildLayout(n));
  const seat = snap.turn;
  // The seat must actually have a decision to make, and more than one way to make it.
  E.setG(JSON.parse(JSON.stringify(snap)));
  if (snap.hands[seat].length === 0 || snap.bowedOut[seat]) return null;
  const baseMoves = E.legalMoves(seat);
  if (baseMoves.length < 2) return null;

  const sigs = new Set();
  const moveCounts = new Set();
  for (let k = 0; k < PARTITIONS; k++) {
    const G = repartition(snap, seat, mulberry32(seed * 31 + k * 7919 + 5));
    E.setG(G);
    const moves = E.legalMoves(seat);
    moveCounts.add(moves.length);
    Math.random = mulberry32(0xC0FFEE);            // identical internal randomness every time
    const m = policy ? policy(E, seat, moves) : E.chooseAI(seat, moves);
    sigs.add(JSON.stringify(m));
  }
  return { seat, nMoves: baseMoves.length, distinctDecisions: sigs.size, distinctMoveCounts: moveCounts.size };
}

function partBC() {
  log("--- PART B: the AI's decision cannot depend on how the hidden cards are dealt ---");
  let cases = 0, bad = 0, badMoveLists = 0;
  const tiers = ["hard", "medium", "easy"];
  for (const n of [4, 6]) {
    for (const diff of tiers) {
      let tierCases = 0, tierBad = 0;
      for (let seed = 1; seed <= 14; seed++) {
        for (const stopAt of [6, 15, 30, 60]) {
          const r = invarianceRun(n, diff, seed * 977 + n * 13, stopAt);
          if (!r) continue;
          cases++; tierCases++;
          if (r.distinctMoveCounts !== 1) badMoveLists++;
          if (r.distinctDecisions !== 1) { bad++; tierBad++; }
        }
      }
      check(tierBad === 0,
        `${n}P teams / ${diff}: ${tierCases} positions x ${PARTITIONS} hidden-card deals each - one identical decision every time (${tierBad} positions differed)`);
    }
  }
  check(cases >= 100, `enough positions exercised (${cases})`);
  check(badMoveLists === 0, `the legal-move list itself never changed with the hidden deal (${badMoveLists} anomalies) - a sanity check that only hidden state was varied`);
  log(`  total: ${cases} positions x ${PARTITIONS} partitions = ${cases * PARTITIONS} decisions`);

  log("--- PART C: positive control - a peeking policy MUST fail the same test ---");
  let peekCases = 0, peekVaried = 0;
  for (let seed = 1; seed <= 14; seed++) {
    for (const stopAt of [15, 30, 60]) {
      const r = invarianceRun(4, "hard", seed * 977 + 52, stopAt, peekingPolicy);
      if (!r) continue;
      peekCases++;
      if (r.distinctDecisions > 1) peekVaried++;
    }
  }
  check(peekCases > 0, `positive control ran (${peekCases} positions)`);
  check(peekVaried > 0,
    `the peeking policy DID change its mind when the hidden cards moved (${peekVaried}/${peekCases} positions) - so PART B's "always identical" result is meaningful, not vacuous`);
}

function main() {
  partA();
  partBC();
  log(`\n${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}
main();
