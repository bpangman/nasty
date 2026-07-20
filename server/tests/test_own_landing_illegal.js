// v0.23 unit check: landing on your OWN peg is ILLEGAL - never offered, never forced.
// v0.23.1 (Blake's confirmed ruling, 2026-07-20): landing on a PARTNER's peg is a LAST
// RESORT - excluded whenever ANY other legal move exists anywhere in the hand, offered (and
// thus effectively forced) when it is the only possible play, and then it kicks the partner
// peg back to base instead of the player bowing out. This file asserts the whole matrix.
const { createEngine } = require("../engine.js");

let pass = 0, fail = 0;
function check(cond, label) { if (cond) { pass++; console.log("OK ", label); } else { fail++; console.log("FAIL", label); } }

function fresh(n, teams) {
  const E = createEngine();
  E.setLAY(E.buildLayout(n));
  E.newGame({ n, teams, seats: Array.from({ length: n }, (_, i) => ({ name: "P" + i, type: "cpu", diff: "medium" })) }, { deck: E.freshDeck(), dealer: 0 });
  const G = E.getG();
  // clear all hands so we fully control the cards
  for (let s = 0; s < n; s++) G.hands[s] = [];
  return { E, G };
}
const card = r => ({ r, s: "S" });

// 1. Forward move landing exactly on OWN peg: illegal (4P FFA).
{
  const { E, G } = fresh(4, false);
  G.pieces[0][0] = { state: "track", steps: 10 };
  G.pieces[0][1] = { state: "track", steps: 15 };  // 5 ahead of piece 0
  G.hands[0] = [card("5")];
  const ms = E.legalMoves(0);
  check(!ms.some(m => m.pi === 0 && m.to === 15), "5 landing exactly on own peg is NOT offered");
  // piece 1 can still use the 5 (15 -> 20), so the hand is not dead
  check(ms.some(m => m.pi === 1 && m.to === 20), "the same card still moves the un-blocked piece");
}
// 2. It was the ONLY candidate: no moves at all (old rule forced the own-kick here).
{
  const { E, G } = fresh(4, false);
  G.pieces[0][0] = { state: "track", steps: 10 };
  G.pieces[0][1] = { state: "home", steps: E.getLAY().L };     // parked home
  G.pieces[0][2] = { state: "home", steps: E.getLAY().L + 1 };
  G.pieces[0][3] = { state: "home", steps: E.getLAY().L + 2 };
  G.pieces[0][4] = { state: "track", steps: 15 };
  // snug up the home three? they are not snug (L..L+2 with L+3/L+4 empty) - a 5 overshoots anyway.
  G.hands[0] = [card("5")];
  const ms = E.legalMoves(0);
  // piece 0 with a 5 lands on own piece 4 (illegal); piece 4 with a 5 -> steps 20 (legal, empty)
  check(!ms.some(m => m.pi === 0), "blocked piece has no move");
  check(ms.every(m => m.pi === 4 || m.pi === 1 || m.pi === 2 || m.pi === 3), "only legal candidates remain");
}
// 3. ONLY move would be own-landing -> zero legal moves -> bow-out path (passDecision) works.
{
  const { E, G } = fresh(4, false);
  const L = E.getLAY().L;
  // A at L-6: a 5 lands exactly on B (own peg, illegal - under the OLD rule this was the
  // forced own-kick). B on the porch: its 5 would enter home but C occupies the path's end.
  // C snug at the last home hole: no moves ever. D/E stay in base; hand has no K/A.
  G.pieces[0][0] = { state: "track", steps: L - 6 };
  G.pieces[0][1] = { state: "track", steps: L - 1 };
  G.pieces[0][2] = { state: "home", steps: L + 4 };
  G.hands[0] = [card("5")];
  const ms = E.legalMoves(0);
  check(ms.length === 0, "only own-landing candidates -> ZERO legal moves (old rule would have forced the kick)");
  const r = E.passDecision(0, true);
  check(E.getG().bowedOut[0] === true, "bow-out still records cleanly when the shrunken move list is empty");
  check(typeof r.threwIn === "boolean", "passDecision returns its normal shape");
}
// 4. K/A enter with OWN peg on the start hole: enter is illegal (old rule kicked it, even forced).
{
  const { E, G } = fresh(4, false);
  G.pieces[0][0] = { state: "track", steps: 0 };  // own tee parked on own start
  G.hands[0] = [card("K")];
  const ms = E.legalMoves(0);
  check(ms.length === 0, "King cannot come out onto your own tee (illegal, not a forced kick)");
  G.hands[0] = [card("A")];
  const ms2 = E.legalMoves(0);
  check(!ms2.some(m => m.type === "enter"), "Ace enter blocked too");
  check(ms2.some(m => m.type === "move" && m.pi === 0 && m.to === 1), "Ace still moves the parked tee 1 instead");
}
// 5. K/A enter with an OPPONENT on the start hole: still a kick (unchanged).
{
  const { E, G } = fresh(4, false);
  const L = E.getLAY().L;
  // seat 1's steps s.t. absolute position == seat 0's start (abs 0): seat 1's entry is 12, so steps = L-12
  G.pieces[1][0] = { state: "track", steps: L - 12 };
  G.hands[0] = [card("K")];
  const ms = E.legalMoves(0);
  const enter = ms.find(m => m.type === "enter");
  check(!!enter && enter.kick && enter.kick.seat === 1, "opponent on your start still gets kicked by a King");
}
// 6. 3 backwards landing on OWN peg: illegal.
{
  const { E, G } = fresh(4, false);
  G.pieces[0][0] = { state: "track", steps: 10 };
  G.pieces[0][1] = { state: "track", steps: 13 };
  G.hands[0] = [card("3")];
  const ms = E.legalMoves(0);
  check(!ms.some(m => m.type === "back" && m.pi === 1 && m.to === 10), "3 backwards onto your own peg is NOT offered");
  check(ms.some(m => m.type === "back" && m.pi === 0 && m.to === 7), "3 backwards into open space still fine");
}
// 7. TEAMS (v0.23.1): partner-landing is EXCLUDED when any alternative exists - one check
// per alternative type (other piece, other card, 3-backward, Jack).
{
  // 7a. Alternative = the SAME card moving another piece.
  const { E, G } = fresh(4, true);
  const L = E.getLAY().L;
  G.pieces[0][0] = { state: "track", steps: 10 };            // seat 0, abs 10
  G.pieces[0][1] = { state: "track", steps: 30 };            // free runner, abs 30
  G.pieces[2][0] = { state: "track", steps: (10 + 5 - 24 + L) % L }; // partner seat 2 at abs 15
  G.hands[0] = [card("5")];
  const ms = E.legalMoves(0);
  check(!ms.some(m => m.pi === 0 && m.type === "move" && m.to === 15), "teams: partner-landing NOT offered while the same card can move another piece");
  check(ms.some(m => m.pi === 1 && m.to === 35), "teams: the alternative piece move IS offered");
}
{
  // 7b. Alternative = a DIFFERENT card.
  const { E, G } = fresh(4, true);
  const L = E.getLAY().L;
  G.pieces[0][0] = { state: "track", steps: 10 };
  G.pieces[2][0] = { state: "track", steps: (10 + 5 - 24 + L) % L }; // partner at abs 15
  G.hands[0] = [card("5"), card("2")];
  const ms = E.legalMoves(0);
  check(!ms.some(m => m.type === "move" && m.to === 15), "teams: partner-landing NOT offered while another card has a legal move");
  check(ms.length === 1 && ms[0].to === 12, "teams: only the other card's move remains");
}
{
  // 7c. Alternative = a 3 played BACKWARD.
  const { E, G } = fresh(4, true);
  const L = E.getLAY().L;
  G.pieces[0][0] = { state: "track", steps: 10 };
  G.pieces[2][0] = { state: "track", steps: (10 + 5 - 24 + L) % L }; // partner at abs 15
  G.hands[0] = [card("5"), card("3")];
  const ms = E.legalMoves(0);
  check(!ms.some(m => m.type === "move" && m.to === 15), "teams: partner-landing NOT offered while a 3-backward is legal");
  check(ms.some(m => m.type === "back" && m.to === 7), "teams: the 3-backward alternative IS offered");
}
{
  // 7d. Alternative = a Jack swap.
  const { E, G } = fresh(4, true);
  const L = E.getLAY().L;
  G.pieces[0][0] = { state: "track", steps: 10 };
  G.pieces[2][0] = { state: "track", steps: (10 + 5 - 24 + L) % L }; // partner at abs 15
  G.pieces[1][0] = { state: "track", steps: 2 };                     // opponent on track = swap target
  G.hands[0] = [card("5"), card("J")];
  const ms = E.legalMoves(0);
  check(!ms.some(m => m.type === "move" && m.to === 15), "teams: partner-landing NOT offered while a Jack swap is legal");
  check(ms.some(m => m.type === "swap"), "teams: the Jack swap alternative IS offered");
}
// 8. TEAMS: opponent at the same spot IS kickable (sanity).
{
  const { E, G } = fresh(4, true);
  const L = E.getLAY().L;
  G.pieces[0][0] = { state: "track", steps: 10 };
  G.pieces[1][0] = { state: "track", steps: (10 + 5 - 12 + L) % L }; // opponent seat 1 at abs 15
  G.hands[0] = [card("5")];
  const ms = E.legalMoves(0);
  const mv = ms.find(m => m.pi === 0 && m.type === "move" && m.to === 15);
  check(!!mv && mv.kick && mv.kick.seat === 1, "teams: opponent on the landing hole still gets kicked");
}
// 9. Never-pass rule unchanged: own peg strictly between start and landing still blocks.
{
  const { E, G } = fresh(4, false);
  G.pieces[0][0] = { state: "track", steps: 10 };
  G.pieces[0][1] = { state: "track", steps: 12 };
  G.hands[0] = [card("5")];
  const ms = E.legalMoves(0);
  check(!ms.some(m => m.pi === 0), "never-pass unchanged: cannot jump over your own peg");
}
// 10. TEAMS (v0.23.1): partner-landing IS offered when it is the ONLY possible play - and
// applying it kicks the partner peg back to base (no bow-out).
{
  const { E, G } = fresh(4, true);
  const L = E.getLAY().L;
  G.pieces[0][0] = { state: "track", steps: 10 };
  G.pieces[2][0] = { state: "track", steps: (10 + 5 - 24 + L) % L }; // partner at abs 15
  G.hands[0] = [card("5")];
  const ms = E.legalMoves(0);
  check(ms.length === 1 && ms[0].type === "move" && ms[0].to === 15, "teams: sole-move partner-landing IS offered (forced fallback)");
  check(!!ms[0].kick && ms[0].kick.seat === 2 && ms[0].pk === true, "teams: the fallback move carries the partner kick, tagged pk");
  E.applyMove(0, ms[0]);
  const vic = G.pieces[2][0];
  check(vic.state === "base" && vic.steps === -1, "teams: applying it sends the partner peg back to its base");
  check(G.pieces[0][0].steps === 15 && G.pieces[0][0].state === "track", "teams: the mover lands on the freed hole");
}
// 11. TEAMS: 3-backward partner-landing as the sole play - offered + kicks.
{
  const { E, G } = fresh(4, true);
  const L = E.getLAY().L;
  // Own peg at 13; a snugness-free hand of just a 3. Forward isn't possible (no forward card),
  // back 3 lands exactly on the partner peg at abs 10.
  G.pieces[0][0] = { state: "track", steps: 13 };
  G.pieces[2][0] = { state: "track", steps: (10 - 24 + L) % L };     // partner at abs 10
  G.hands[0] = [card("3")];
  const ms = E.legalMoves(0);
  check(ms.length === 1 && ms[0].type === "back" && ms[0].to === 10 && !!ms[0].kick && ms[0].kick.seat === 2, "teams: sole 3-backward partner-landing offered with the kick");
}
// 12. TEAMS: King come-out onto your start hole occupied by a PARTNER tee - last resort too.
{
  const { E, G } = fresh(4, true);
  const L = E.getLAY().L;
  G.pieces[2][0] = { state: "track", steps: (0 - 24 + L) % L };      // partner parked on seat 0's start (abs 0)
  G.hands[0] = [card("K")];
  const ms = E.legalMoves(0);
  check(ms.length === 1 && ms[0].type === "enter" && !!ms[0].kick && ms[0].kick.seat === 2 && ms[0].pk === true, "teams: sole King come-out onto a partner tee IS offered (kicks it)");
  E.applyMove(0, ms[0]);
  check(G.pieces[2][0].state === "base", "teams: the come-out kick sends the partner tee home to base");
  // ... but with ANY alternative, the come-out onto the partner is excluded again.
  const f2 = fresh(4, true); const L2 = f2.E.getLAY().L;
  f2.G.pieces[2][0] = { state: "track", steps: (0 - 24 + L2) % L2 }; // partner on seat 0's start
  f2.G.pieces[0][0] = { state: "track", steps: 20 };                 // free runner
  f2.G.hands[0] = [card("A")];                                        // Ace: enter (pk) OR move 1 (legal)
  const ms2 = f2.E.legalMoves(0);
  check(!ms2.some(m => m.type === "enter"), "teams: come-out onto a partner tee NOT offered when the Ace can move 1 instead");
  check(ms2.some(m => m.type === "move" && m.to === 21), "teams: the Ace's move-1 alternative is what remains");
}
// 13. TEAMS: King come-out blocked by your OWN tee stays illegal even as the only candidate.
{
  const { E, G } = fresh(4, true);
  G.pieces[0][0] = { state: "track", steps: 0 };                     // own tee on own start
  G.hands[0] = [card("K")];
  const ms = E.legalMoves(0);
  check(ms.length === 0, "teams: own tee on your start still blocks the come-out outright (no fallback)");
}
// 14. TEAMS: own-landing is NEVER offered even as the sole candidate (no own fallback).
// Same dead-hand shape as check 3, but in teams mode: piece 0's 5 lands on own piece 1
// (illegal), piece 1's 5 overshoots into a home hole own piece 2 occupies (illegal).
{
  const { E, G } = fresh(4, true);
  const L = E.getLAY().L;
  G.pieces[0][0] = { state: "track", steps: L - 6 };
  G.pieces[0][1] = { state: "track", steps: L - 1 };
  G.pieces[0][2] = { state: "home", steps: L + 4 };
  G.hands[0] = [card("5")];
  const ms = E.legalMoves(0);
  check(ms.length === 0, "teams: sole own-landing candidate -> zero legal moves, never a fallback");
}
// 15. TEAMS: bow-out only when even the fallback set is empty; partner-landing sole play
// does NOT bow the player out (the kick happens instead).
{
  const { E, G } = fresh(4, true);
  const L = E.getLAY().L;
  G.pieces[0][0] = { state: "track", steps: 10 };
  G.pieces[2][0] = { state: "track", steps: (10 + 5 - 24 + L) % L };
  G.hands[0] = [card("5")];
  check(E.legalMoves(0).length > 0, "teams: the forced partner-landing means legalMoves is NON-empty -> the turn loop never bows this seat out");
  // Truly nothing: check 14's dead-hand shape (own-landing plus a home-overshoot block).
  const f2 = fresh(4, true);
  const L2 = f2.E.getLAY().L;
  f2.G.pieces[0][0] = { state: "track", steps: L2 - 6 };
  f2.G.pieces[0][1] = { state: "track", steps: L2 - 1 };
  f2.G.pieces[0][2] = { state: "home", steps: L2 + 4 };
  f2.G.hands[0] = [card("5")];
  check(f2.E.legalMoves(0).length === 0, "teams: truly nothing (own-landing only) -> empty move list");
  f2.E.passDecision(0, true);
  check(f2.E.getG().bowedOut[0] === true, "teams: and THAT is the only case that bows the player out");
}
// 16. TEAMS: multiple partner-landing candidates and nothing else -> the whole fallback set
// is offered (player/AI chooses which partner peg to send back).
{
  const { E, G } = fresh(4, true);
  const L = E.getLAY().L;
  G.pieces[0][0] = { state: "track", steps: 10 };
  G.pieces[0][1] = { state: "track", steps: 30 };
  G.pieces[2][0] = { state: "track", steps: (15 - 24 + L) % L };     // partner at abs 15 (in front of piece 0)
  G.pieces[2][1] = { state: "track", steps: (35 - 24 + L) % L };     // partner at abs 35 (in front of piece 1)
  G.hands[0] = [card("5")];
  const ms = E.legalMoves(0);
  check(ms.length === 2 && ms.every(m => m.pk === true && m.kick && m.kick.seat === 2), "teams: an all-fallback hand offers EVERY partner-landing candidate");
  // The hard-tier AI must pick one without crashing (exercises the rollout across a forced
  // partner kick) - and any pick is a pk move by construction.
  G.seats[0].diff = "hard";
  const m = E.chooseAI(0, ms);
  check(!!m && m.pk === true, "teams: hard AI picks a fallback move cleanly (rollout handles the forced partner kick)");
}
// 17. 6P TEAMS: same exclusion + fallback semantics with 3 teams of 2 (partnerOf(0)=3).
{
  const { E, G } = fresh(6, true);
  const L = E.getLAY().L;                                            // 72
  G.pieces[0][0] = { state: "track", steps: 10 };
  G.pieces[3][0] = { state: "track", steps: (10 + 5 - 36 + L) % L }; // partner seat 3 at abs 15
  G.hands[0] = [card("5")];
  const ms = E.legalMoves(0);
  check(ms.length === 1 && ms[0].pk === true && ms[0].kick && ms[0].kick.seat === 3, "6P teams: sole partner-landing offered as the forced fallback");
  E.applyMove(0, ms[0]);
  check(G.pieces[3][0].state === "base", "6P teams: the partner peg goes back to base");
  const f2 = fresh(6, true); const L2 = f2.E.getLAY().L;
  f2.G.pieces[0][0] = { state: "track", steps: 10 };
  f2.G.pieces[0][1] = { state: "track", steps: 40 };                 // free runner
  f2.G.pieces[3][0] = { state: "track", steps: (10 + 5 - 36 + L2) % L2 };
  f2.G.hands[0] = [card("5")];
  const ms2 = f2.E.legalMoves(0);
  check(!ms2.some(m => m.pk) && ms2.some(m => m.pi === 1 && m.to === 45), "6P teams: partner-landing excluded when the same card can move another piece");
  // 6P: an OPPONENT peg (seat 1, different team) on the landing hole still just kicks, normal set.
  const f3 = fresh(6, true); const L3 = f3.E.getLAY().L;
  f3.G.pieces[0][0] = { state: "track", steps: 10 };
  f3.G.pieces[1][0] = { state: "track", steps: (15 - 12 + L3) % L3 }; // opponent at abs 15
  f3.G.hands[0] = [card("5")];
  const ms3 = f3.E.legalMoves(0);
  check(ms3.length === 1 && !ms3[0].pk && ms3[0].kick && ms3[0].kick.seat === 1, "6P teams: opponent on the landing hole is a normal kick, not a fallback");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
