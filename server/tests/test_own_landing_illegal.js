// v0.23 unit check: landing on your OWN (or partner's) peg is ILLEGAL - never offered.
// Replaces the old expectation (own-landing kicks, forced when it is the only move).
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
// 7. TEAMS: landing exactly on your PARTNER's peg is illegal too (the v0.23 interpretation).
{
  const { E, G } = fresh(4, true);
  const L = E.getLAY().L;
  G.pieces[0][0] = { state: "track", steps: 10 };            // seat 0, abs 10
  G.pieces[2][0] = { state: "track", steps: (10 + 5 - 24 + L) % L }; // partner seat 2 at abs 15
  G.hands[0] = [card("5")];
  const ms = E.legalMoves(0);
  check(!ms.some(m => m.pi === 0 && m.type === "move" && m.to === 15), "teams: landing exactly on your PARTNER's peg is NOT offered");
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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
