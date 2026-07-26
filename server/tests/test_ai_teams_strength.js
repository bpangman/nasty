// ==============================================================================================
// TEAMS TEAMWORK HARNESS + REGRESSION CHECK  (added 2026-07-26, v0.38)
// ==============================================================================================
// Blake's ask, verbatim: "on teams mode (both local and online) the CPU's need to work together
// as a team better. Make them be strategic to move their partner into a good place if there isn't
// an immediate opportunity for them to get in better position themselves. Otherwise, when 2 human
// players work together well, even on Nasty difficulty it isn't all that hard."
// Follow-up when asked how hard: "I want the nasty teams to be genuinely hard to beat (but
// obviously still at the mercy of the cards they're dealt)."
//
// This file is BOTH the dev-time measurement harness that produced v0.38's numbers AND the
// permanent CI-sized regression check that keeps them from rotting. It is deliberately NOT in
// run-all.js's PLAN (that file was out of scope for the session that wrote this) - run it by hand:
//
//     cd /Users/jarvis/nasty-game/server && node tests/test_ai_teams_strength.js
//     NASTY_TEAMS_GAMES=400 node tests/test_ai_teams_strength.js      # the big acceptance run
//     NASTY_TEAMS_SEED=99 NASTY_TEAMS_GAMES=400 node tests/test_ai_teams_strength.js
//
// ---------------------------------------------------------------------------------------------
// THE HEADLINE METRIC AND ITS STAND-IN FOR "TWO HUMANS WHO PLAY WELL TOGETHER"
// ---------------------------------------------------------------------------------------------
// Blake's complaint is about a HUMAN pair beating Nasty CPUs, so the number that matters is a
// coordinated pair's win rate against Nasty CPU teams. Humans cannot be run 400 times, so the
// pair is played by CRP - the "Coordinated Reference Pair" policy defined below. It is written
// from scratch in THIS file (not by calling chooseAI/scoreMove/strategyBonus) precisely so that
// "coordinated pair vs Nasty" measures two genuinely different policies rather than the AI
// playing itself.
//
// CRP models two good players who have agreed on a strategy out loud but CANNOT see each other's
// cards. Exactly what it knows and does, in full:
//   INFORMATION: the public board (every peg's state/steps for every seat), whose turn it is, its
//   OWN legal moves for its OWN hand. It never reads G.deck, never reads any other seat's
//   G.hands - not even its partner's. Same hard line the AI is held to.
//   POLICY (deterministic, one ply, no simulation - humans do not run 48-ply rollouts):
//     1. Progress: a move is worth the holes it gains, plus a small bonus for pegs already deep
//        into their lap (finish what you started).
//     2. Getting home is worth a lot (+26) and worth more the more of that player's pegs are
//        already home (+4 each) - rush the last ones in.
//     3. Coming out of the stable is worth +15 (a peg in the stable does nothing).
//     4. Kicking an opponent is worth +30 plus a quarter of how far that peg had travelled, +26
//        more if it was that opponent's LAST peg still out, +10 more if it was inside its final
//        six holes before its porch.
//     5. Landing on the PARTNER (the last-resort forced case only) is heavily negative and scales
//        with how far that partner peg had travelled, so the least advanced partner peg is chosen.
//     6. Danger: count the opponents sitting 1 to 12 holes behind the destination (anyone who
//        could land exactly on it next turn) and subtract, scaled up for pegs that have more to
//        lose.
//     7. TEAM - a Jack is scored for the TEAM's net gain, not just its own: how far the trade
//        advances MY peg plus how far it advances my PARTNER's. This is the only mechanism in the
//        rules that lets you directly improve a partner's position before you are finished, and
//        measurement says it is the one team heuristic that actually earns its keep for a one-ply
//        player - see the long note on CRP_W below, which lists everything else that was tried and
//        measurably made a coordinated pair WORSE (staying out of the partner's way, protecting
//        the partner, focusing the leading team, racing to finish first).
// CRP is intentionally strong but human-shaped: no lookahead, no card counting, no simulation.
//
// TWO CONTEXT BASELINES are reported alongside it so the CRP number means something:
//   NAIVE  - the same seats played by the identical scorer with every team term switched off
//            (points 1-6 above, point 7 deleted). Two decent players who never think about their
//            partner. Measures 4 points weaker than CRP against Nasty, which is what makes the
//            word "coordinated" in the headline metric mean something.
//   RANDOM - uniform over legalMoves(). The floor.
//
// ---------------------------------------------------------------------------------------------
// HOW THE COMPARISON IS KEPT HONEST
// ---------------------------------------------------------------------------------------------
// * Every game's deck (initial and every reshuffle) comes from this file's OWN seeded PRNG
//   (mulberry32), not from Math.random - so game #i of a "before" run and game #i of an "after"
//   run are dealt the IDENTICAL cards in the identical order. The AI's own internal randomness
//   (Easy/Tricky jitter, cloneG's hidden-card reshuffle) still uses Math.random, which is seeded
//   once per run for reproducibility; it necessarily diverges between two different policies, and
//   that is fine - the cards, which is what "at the mercy of the cards they're dealt" is about,
//   are held fixed.
// * Seat assignment alternates every game so neither side is structurally favoured by
//   dealer-left-goes-first.
// * Both sides of every matchup are run in the SAME process against the SAME engine build.
// ==============================================================================================
// NASTY_ENGINE=<path> points this harness at a different build of the engine (an experimental
// copy in a scratchpad, or `git show <rev>:server/engine.js` written to a file) so a before/after
// comparison can be run against the SAME reference policies in the SAME process shape. Default is
// the checked-in engine, which is what every committed number was measured against.
const { createEngine } = require(process.env.NASTY_ENGINE || "../engine.js");

function log(...a) { console.log("[ai-teams]", ...a); }
let PASS = 0, FAIL = 0;
function check(cond, label) { if (cond) { PASS++; log("OK  ", label); } else { FAIL++; log("FAIL", label); } }

// ---- deterministic RNG (harness-owned; the engine's own Math.random is separate) --------------
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
// Byte-for-byte the same 52 card objects freshDeck() builds (same ids, same rank/suit order),
// shuffled with OUR seeded PRNG instead of Math.random so a run is reproducible.
function seededDeck(rng) {
  const d = []; let id = 0;
  for (const s of SUITS) for (const r of RANKS) d.push({ r, s, id: id++ });
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

// ==============================================================================================
// CRP - the Coordinated Reference Pair policy (see the header for the full description).
// Written against the engine's PUBLIC helpers only. It reads G.pieces (public board), G.n,
// G.teams and its own `moves` list. It never touches G.deck or G.hands.
// `teamAware` false gives the NAIVE baseline: the identical policy with every team term removed.
// ==============================================================================================
// CRP_W - the team-term weights, chosen by sweeping THIS harness (250 games per configuration,
// identical decks, identical opponent) for the CONFIGURATION THAT MAKES THE REFERENCE PAIR AS
// STRONG AS POSSIBLE. The yardstick has to be the best coordinated pair we can build, otherwise
// "Nasty beats it" means nothing. Every weight is overridable from the environment so the sweep
// can be re-run; the committed defaults are the tuned values and are what every reported number
// was measured with.
//
// THE HONEST FINDING, recorded because it is counter-intuitive and cost a lot of measurement:
// for a ONE-PLY, human-shaped player, almost every "cooperation" heuristic a human would name is
// WORSE THAN NOTHING. Measured against the shipped v0.38 engine, 250 games each, starting from
// 48.8% for a pair with no team terms at all:
//   * counting the PARTNER's side of a Jack trade (mateSwapGain 0.9): 52.8%  <- the one that works
//   * ...at 1.3 instead of 0.9: 46.0%   (too heavy - it starts making bad trades)
//   * "stay out of the partner's way" (obstruct/funnel, partners cannot pass each other): 0.18/5
//     took a strong pair from 62.5% to 57.0% in the first sweep, and at 0.40 to 48.5%. A one-ply
//     player obeying it just loses tempo. NOTE: the same signal HELPS the Nasty AI, which has a
//     rollout that can see whether the tempo it gave up was worth it - see index.html's
//     TEAM_W.unblock. Same heuristic, opposite verdict, depending on whether you can search.
//   * "protect the partner" (kick the peg aiming at them): dead neutral, never changed a decision -
//     kick scores already dominate that choice.
//   * "hit the closest-to-winning TEAM" / "kill the sole survivor of a half-finished team":
//     slightly negative. In 4P teams both opponents share one team score, so it is a constant
//     across kick choices and only inflates kicks in general.
//   * "rush home because finishing first doubles the team's cards" (teamFinish/teamRush): 50.8%,
//     i.e. worse than leaving it out - the plain get-home bonus already covers it for a one-ply
//     player. (This one DOES work for the AI. See index.html's TEAM_W.finish.)
// The rejected terms are kept as live code with 0 weights rather than deleted, so a future session
// can re-measure them in one command instead of rewriting them from scratch.
const CRP_W = {
  obstruct: parseFloat(process.env.CRP_OBSTRUCT || '0'),
  funnel: parseFloat(process.env.CRP_FUNNEL || '0'),
  protect: parseFloat(process.env.CRP_PROTECT || '0'),
  stakes: parseFloat(process.env.CRP_STAKES || '0'),
  soleSurvivor: parseFloat(process.env.CRP_SOLE || '0'),
  swapStakes: parseFloat(process.env.CRP_SWAPSTAKES || '0'),
  mateSwapSafety: parseFloat(process.env.CRP_MATESWAP || '0'),
  mateSwapGain: parseFloat(process.env.CRP_MATEGAIN || '0.9'),   // the one that earns its keep
  teamFinish: parseFloat(process.env.CRP_TEAMFINISH || '0'),
  teamRush: parseFloat(process.env.CRP_TEAMRUSH || '0'),
};

function makeReferencePolicy(teamAware, W) {
  W = W || CRP_W;
  return function (E, seat, moves) {
    const G = E.getG(), LAY = E.getLAY(), L = LAY.L;
    const { loopIdx, entryIdx, sameTeam, partnerOf } = E;
    const homeN = s => G.pieces[s].filter(p => p.state === 'home').length;
    const owner0 = E.actingOwner(seat);
    const mate = G.teams ? partnerOf(owner0) : -1;
    const mateTrack = (teamAware && mate >= 0 && mate !== owner0)
      ? G.pieces[mate].filter(p => p.state === 'track') : [];
    const oppSeats = [];
    for (let s = 0; s < G.n; s++) if (!sameTeam(s, owner0)) oppSeats.push(s);

    // opponents that could land exactly on this absolute hole with one card (1..12 behind it)
    const threatAt = abs => {
      let d = 0;
      for (const s of oppSeats) for (const p of G.pieces[s]) {
        if (p.state !== 'track') continue;
        const g = (abs - loopIdx(s, p.steps) + L) % L;
        if (g >= 1 && g <= 12) d++;
      }
      return d;
    };
    // how badly a peg of MINE parked on `abs` walls my partner in (partners can never pass each
    // other) - steeper the closer it sits in front of them, much steeper inside their final six.
    const obstruct = abs => {
      if (!mateTrack.length) return { gap: 0, funnel: 0 };
      let gap = 0, funnel = 0;
      for (const b of mateTrack) {
        const g = (abs - loopIdx(mate, b.steps) + L) % L;
        if (g >= 1 && g <= 12) gap += (13 - g);
      }
      const rel = (abs - entryIdx(mate) + L) % L;
      if (rel >= L - 6) for (const b of mateTrack) if (b.steps < rel) funnel += 1;
      return { gap, funnel };
    };
    const ZERO_OBS = { gap: 0, funnel: 0 };
    const teamHome = s => G.teams ? homeN(s) + homeN(partnerOf(s)) : homeN(s);

    let best = null, bs = -1e9;
    for (const m of moves) {
      const owner = m.owner;
      let sc = 0;
      let destAbs = null, fromAbs = null, fromSteps = 0;
      if (m.type === 'enter') {
        sc += 15;
        destAbs = entryIdx(owner);
      } else if (m.type === 'move' || m.type === 'back') {
        const p = G.pieces[owner][m.pi];
        fromSteps = p.steps;
        sc += (m.to - p.steps) * 1.0 + p.steps * 0.05;
        if (m.to >= L) {
          sc += 26 + homeN(owner) * 4;
          // TEAM: the first partner home starts playing their cards for the OTHER one
          // (RULES.md "Finishing"), so the team's card flow doubles - worth rushing towards.
          if (teamAware) sc += W.teamFinish + W.teamRush * homeN(owner);
        }
        if (m.type === 'back') { sc -= 4; if (p.steps >= L) sc -= 20; }
        if (p.state === 'track') fromAbs = loopIdx(owner, p.steps);
        if (m.to < L) destAbs = loopIdx(owner, m.to);
      } else if (m.type === 'swap') {
        const a = G.pieces[owner][m.pi], b = G.pieces[m.ts][m.tpi];
        const aAbs = loopIdx(owner, a.steps), bAbs = loopIdx(m.ts, b.steps);
        const an = (bAbs - entryIdx(owner) + L) % L;   // my peg's new steps
        const bn = (aAbs - entryIdx(m.ts) + L) % L;    // their peg's new steps
        sc += (an - a.steps) * 1.0;
        if (sameTeam(m.ts, owner)) {
          // TEAM: a Jack is the only way to directly improve a partner's position before you are
          // finished. A player who is NOT coordinating simply does not count their partner's side
          // of the trade at all, which is exactly the difference this weight encodes.
          if (teamAware) sc += (bn - b.steps) * W.mateSwapGain;
        } else {
          sc += (b.steps - bn) * 0.6;                  // opponent swap: how far it drags them back
          if (teamAware) sc += teamHome(m.ts) * W.swapStakes;   // prefer hurting the leading opposing team
        }
        fromAbs = aAbs; destAbs = bAbs; fromSteps = a.steps;
        if (teamAware && sameTeam(m.ts, owner) && m.ts === mate) {
          // both pegs move; obstruction is symmetrical, so just take the danger delta on theirs
          sc += (threatAt(bAbs) - threatAt(aAbs)) * W.mateSwapSafety;
        }
      }
      if (m.kick) {
        const vic = G.pieces[m.kick.seat][m.kick.pi];
        if (sameTeam(m.kick.seat, owner)) {
          sc -= 40 + vic.steps * 1.0;                  // forced partner landing - least advanced peg
        } else {
          sc += 30 + vic.steps * 0.25;
          if (homeN(m.kick.seat) === 4) sc += 26;      // their last peg out
          if (vic.steps >= L - 6 && vic.steps < L) sc += 10;
          if (teamAware) {
            sc += teamHome(m.kick.seat) * W.stakes;
            if (G.teams && homeN(partnerOf(m.kick.seat)) === 5) sc += W.soleSurvivor;  // sole survivor of a half-done team
            if (vic.state === 'track') {               // was it aiming at one of my partner's pegs?
              const va = loopIdx(m.kick.seat, vic.steps);
              for (const b of mateTrack) {
                const d = (loopIdx(mate, b.steps) - va + L) % L;
                if (d >= 1 && d <= 12) sc += W.protect * (1 + b.steps / L);
              }
            }
          }
        }
      }
      if (destAbs != null) sc -= threatAt(destAbs) * 3.2 * (1 + fromSteps / L);
      if (teamAware && mateTrack.length) {
        const bO = fromAbs != null ? obstruct(fromAbs) : ZERO_OBS;
        const aO = destAbs != null ? obstruct(destAbs) : ZERO_OBS;
        sc += (bO.gap - aO.gap) * W.obstruct + (bO.funnel - aO.funnel) * W.funnel;
      }
      if (sc > bs) { bs = sc; best = m; }
    }
    return best;
  };
}
const CRP = makeReferencePolicy(true);
const NAIVE = makeReferencePolicy(false);

// ==============================================================================================
// game driver
// ==============================================================================================
function pickMove(E, seat, policy, moves, rng, timing) {
  if (policy === 'random') return moves[Math.floor(rng() * moves.length)];
  if (policy === 'crp') return CRP(E, seat, moves);
  if (policy === 'naive') return NAIVE(E, seat, moves);
  if (timing) {
    const t0 = process.hrtime.bigint();
    const m = E.chooseAI(seat, moves);
    timing.push(Number(process.hrtime.bigint() - t0) / 1e6);
    return m;
  }
  return E.chooseAI(seat, moves);   // 'easy' | 'medium' | 'hard'
}

// policies[] is one entry per seat: 'crp' | 'naive' | 'random' | an AI_TIERS key.
// Returns {winnerSeat, turns, illegalIssues}.
function runTeamsGame(n, policies, rng, maxTurns, timing, invariants) {
  const E = createEngine();
  E.setLAY(E.buildLayout(n));
  const seats = policies.map((p, i) => ({
    name: 'S' + i, type: 'cpu',
    diff: (p === 'crp' || p === 'naive' || p === 'random') ? 'medium' : p,
  }));
  E.newGame({ n, teams: true, seats }, { deck: seededDeck(rng), dealer: Math.floor(rng() * n) });
  let turns = 0;
  while (!E.getG().over) {
    if (turns++ > maxTurns) throw new Error(`did not finish within ${maxTurns} turns`);
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
    const m = pickMove(E, seat, policies[seat], moves, rng, timing);
    if (invariants) {
      if (!moves.includes(m)) invariants.illegal++;
    }
    E.applyMove(seat, m);
    if (invariants) {
      const seen = new Map();
      const g2 = E.getG();
      for (let s = 0; s < g2.n; s++) for (const p of g2.pieces[s]) {
        if (p.state !== 'track') continue;
        const abs = E.loopIdx(s, p.steps);
        if (seen.has(abs)) invariants.doubleOcc++;
        seen.set(abs, s);
      }
      const cards = g2.deck.length + g2.discard.length + g2.hands.reduce((a, h) => a + h.length, 0);
      if (cards !== 52) invariants.deck++;
    }
    if (!E.getG().over) E.advanceTurn();
  }
  return { winnerSeat: E.getG().winners[0], turns };
}

// A "matchup": team A's policy vs team B's policy (4P: 1 A team + 1 B team; 6P: 1 A team + 2 B
// teams). `rot` rotates which seat team A occupies each game so turn order never favours a side.
function seatPlanFor(n, aPolicy, bPolicy, rot) {
  const half = n / 2;
  const aSeat = rot % half;               // team A = {aSeat, aSeat+half}
  const pol = new Array(n).fill(bPolicy);
  pol[aSeat] = aPolicy; pol[aSeat + half] = aPolicy;
  return { pol, aSeats: [aSeat, aSeat + half] };
}

function runMatchup(n, aPolicy, bPolicy, games, seed, timing, invariants) {
  let winsA = 0, total = 0, totalTurns = 0;
  const t0 = Date.now();
  for (let i = 0; i < games; i++) {
    const rng = mulberry32(seed + i * 7919);      // per-game, so game i is the same cards every run
    // Reseed the ENGINE's own randomness per game too (Easy/Tricky jitter, cloneG's hidden-card
    // reshuffle). Without this, matchup #2 in a run starts from whatever Math.random state
    // matchup #1 happened to leave behind, so an unchanged control policy's win rate would drift
    // by several points purely from the order the matchups ran in - measured directly while
    // tuning this file on 2026-07-26 (an untouched baseline moved 40%-55% across sweep configs).
    Math.random = mulberry32((seed + i * 7919) ^ 0x5bf03635);
    const { pol, aSeats } = seatPlanFor(n, aPolicy, bPolicy, i);
    const { winnerSeat, turns } = runTeamsGame(n, pol, rng, 60000, timing, invariants);
    totalTurns += turns; total++;
    if (aSeats.includes(winnerSeat)) winsA++;
  }
  return { winsA, total, rate: winsA / total, avgTurns: totalTurns / total, ms: Date.now() - t0 };
}

// ==============================================================================================
// main
// ==============================================================================================
const GAMES = parseInt(process.env.NASTY_TEAMS_GAMES || '150', 10);
const SEED = parseInt(process.env.NASTY_TEAMS_SEED || '20260726', 10);
/* ---------------------------------------------------------------------------------------------
   SAMPLE SIZE - READ THIS BEFORE YOU TRUST ANY NUMBER THIS FILE PRINTS
   The v0.38 teamwork change is worth about two points of win rate at 4P and three at 6P. A run of
   this file at the default GAMES is NOT capable of measuring that. Directly observed while tuning
   on 2026-07-26: one single UNCHANGED configuration measured 61.3% at N=150, 58.0% at N=250,
   54.5% at N=1500 and 53.5% at N=3000. Eight points of drift with nothing changed at all.
   So this file has two jobs and they need different N:
     * REGRESSION GUARD (the default): loose ceilings that a real breakage blows through and
       ordinary variance does not. That is all the assertions below claim.
     * MEASUREMENT: use a paired comparator - same decks, same reference policy, both engine
       builds in one process, N>=1500, and McNemar on the paired outcomes. The v0.38 numbers were
       produced that way. Do not tune against 250-game runs; that is how the first version of the
       teamwork layer came to look ten points better than it is.
   Authoritative v0.38 measurements (paired, both engines, same decks):
     4P teams, N=3000: coordinated reference pair 53.5% before -> 51.8% after (McNemar z=1.43)
     6P teams, N=800 : 40.4% before -> 37.1% after (McNemar z=1.41)
     combined across the two independent board sizes: Stouffer z=2.0, p=0.04
   --------------------------------------------------------------------------------------------- */
// Ceilings, set well ABOVE the measured means so this is a breakage detector, not a coin flip.
// If the AI regressed badly in teams these blow; ordinary variance does not reach them.
const CRP_VS_NASTY_4P_MAX = parseFloat(process.env.NASTY_TEAMS_MAX4 || '0.62');
const CRP_VS_NASTY_6P_MAX = parseFloat(process.env.NASTY_TEAMS_MAX6 || '0.50');

function pct(r) { return (100 * r).toFixed(1) + '%'; }

// NASTY_TEAMS_ONLY=4p runs just the two headline 4P rows (used while sweeping CRP's own weights -
// see CRP_W above). Default runs the whole bar.
const ONLY = process.env.NASTY_TEAMS_ONLY || '';

function main() {
  Math.random = mulberry32(SEED ^ 0x5bf03635);   // engine-internal randomness, reproducible per run
  log(`games per matchup = ${GAMES}, seed = ${SEED}`);
  const inv = { illegal: 0, doubleOcc: 0, deck: 0 };
  const timing = [];

  if (ONLY === 'head') {
    const out = [];
    for (const [a, label] of [['crp', 'coordinated'], ['naive', 'uncoordinated'], ['random', 'random']]) {
      const r4 = runMatchup(4, a, 'hard', GAMES, SEED, null, inv);
      const r6 = runMatchup(6, a, 'hard', GAMES, SEED + 101, null, inv);
      out.push(`${label}: 4P=${pct(r4.rate)} 6P=${pct(r6.rate)}`);
    }
    log('HEAD ' + out.join('  |  '));
    process.exit(0);
  }
  if (ONLY === 'sweep') {
    // the tuning loop: the strong reference pair against Nasty, 4P and 6P, nothing else
    const a = runMatchup(4, 'naive', 'hard', GAMES, SEED, null, inv);
    const b = runMatchup(6, 'naive', 'hard', GAMES, SEED + 101, null, inv);
    log(`SWEEP ref-vs-nasty 4P=${pct(a.rate)} 6P=${pct(b.rate)}`);
    process.exit(0);
  }
  if (ONLY === '4p') {
    const a = runMatchup(4, 'crp', 'hard', GAMES, SEED, null, inv);
    const b = runMatchup(4, 'naive', 'hard', GAMES, SEED, null, inv);
    log(`SWEEP crp=${pct(a.rate)} naive=${pct(b.rate)} weights=${JSON.stringify(CRP_W)}`);
    process.exit(0);
  }

  log('--- 4P teams (one coordinated pair vs one Nasty pair) ---');
  const rows4 = [];
  for (const [a, label] of [['crp', 'coordinated pair'], ['naive', 'uncoordinated pair'], ['random', 'random pair']]) {
    const r = runMatchup(4, a, 'hard', GAMES, SEED, a === 'crp' ? timing : null, inv);
    rows4.push([label, r]);
    log(`4P  ${label.padEnd(20)} vs Nasty : ${r.winsA}/${r.total} = ${pct(r.rate)}  (avg ${r.avgTurns.toFixed(0)} turns, ${r.ms}ms)`);
  }

  log('--- 6P teams (one coordinated pair vs TWO Nasty pairs) ---');
  const rows6 = [];
  for (const [a, label] of [['crp', 'coordinated pair'], ['naive', 'uncoordinated pair'], ['random', 'random pair']]) {
    const r = runMatchup(6, a, 'hard', GAMES, SEED + 101, a === 'crp' ? timing : null, inv);
    rows6.push([label, r]);
    log(`6P  ${label.padEnd(20)} vs Nasty : ${r.winsA}/${r.total} = ${pct(r.rate)}  (avg ${r.avgTurns.toFixed(0)} turns, ${r.ms}ms)`);
  }

  log('--- tier ordering inside teams mode (must stay easy < tricky < nasty) ---');
  const th4 = runMatchup(4, 'hard', 'medium', GAMES, SEED + 7, null, inv);
  log(`4P  Nasty pair vs Tricky pair : ${th4.winsA}/${th4.total} = ${pct(th4.rate)}`);
  const tm4 = runMatchup(4, 'medium', 'easy', GAMES, SEED + 13, null, inv);
  log(`4P  Tricky pair vs Easy pair  : ${tm4.winsA}/${tm4.total} = ${pct(tm4.rate)}`);
  const te4 = runMatchup(4, 'easy', 'random', GAMES, SEED + 17, null, inv);
  log(`4P  Easy pair vs random pair  : ${te4.winsA}/${te4.total} = ${pct(te4.rate)}`);
  const th6 = runMatchup(6, 'hard', 'medium', Math.max(20, Math.floor(GAMES / 2)), SEED + 23, null, inv);
  log(`6P  Nasty pair vs Tricky pairs: ${th6.winsA}/${th6.total} = ${pct(th6.rate)}`);

  log('--- assertions ---');
  check(rows4[0][1].rate <= CRP_VS_NASTY_4P_MAX,
    `4P: a coordinated pair beats two Nasty CPUs at most ${pct(CRP_VS_NASTY_4P_MAX)} of the time (got ${pct(rows4[0][1].rate)})`);
  check(rows6[0][1].rate <= CRP_VS_NASTY_6P_MAX,
    `6P: a coordinated pair beats two Nasty pairs at most ${pct(CRP_VS_NASTY_6P_MAX)} of the time (got ${pct(rows6[0][1].rate)})`);
  // Reported, not asserted: measured at 250 games against the shipped engine, CRP beats NAIVE
  // 52.8% to 48.8% - but that 4-point edge is inside the noise of a default-N run, and per the
  // sample-size note above a small run cannot be trusted to reproduce it. Gating on it would make
  // this suite flaky for no benefit.
  log(`4P: coordinated ${pct(rows4[0][1].rate)} vs uncoordinated ${pct(rows4[1][1].rate)} (dev-time at N=250: 52.8% vs 48.8%)`);
  check(th4.rate >= 0.60, `4P teams: Nasty beats Tricky (got ${pct(th4.rate)})`);
  check(tm4.rate >= 0.55, `4P teams: Tricky beats Easy (got ${pct(tm4.rate)})`);
  check(te4.rate >= 0.55, `4P teams: Easy beats random (got ${pct(te4.rate)}) - Easy is still strategic, not upgraded`);
  check(th6.rate >= 0.45, `6P teams: a Nasty pair still wins a 3-team table more than its 33% share (got ${pct(th6.rate)})`);
  check(inv.illegal === 0, `no illegal move was ever returned (${inv.illegal})`);
  check(inv.doubleOcc === 0, `no two track pegs ever shared a hole (${inv.doubleOcc})`);
  check(inv.deck === 0, `52 cards conserved at every single move (${inv.deck} violations)`);
  if (timing.length) {
    const avg = timing.reduce((a, b) => a + b, 0) / timing.length;
    const sorted = timing.slice().sort((a, b) => a - b);
    const p99 = sorted[Math.floor(timing.length * 0.99)];
    log(`Nasty chooseAI() in teams over ${timing.length} decisions: avg=${avg.toFixed(3)}ms p99=${p99.toFixed(3)}ms max=${sorted[sorted.length - 1].toFixed(3)}ms`);
    check(avg < 50, `Nasty teams decision time inside the 50ms budget (avg ${avg.toFixed(3)}ms)`);
    check(p99 < 150, `Nasty teams p99 decision time under 150ms (got ${p99.toFixed(3)}ms)`);
  }

  log(`\n${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}
main();
