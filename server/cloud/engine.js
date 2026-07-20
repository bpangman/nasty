/*
 * GENERATED FILE — do not hand-edit. Produced by server/build-engine.js from the text between
 * index.html's "NASTY ENGINE EXTRACT: BEGIN"/"END" markers (§ LAYOUT, § STATE, § ENGINE,
 * § TURN DECISIONS, § AI). Edit the rules in index.html, then run:
 *   cd server && npm run build-engine
 * server/test-engine-sync.js fails if this file is stale relative to index.html — run it (or
 * `npm test`) after any engine change, before deploying/testing server changes.
 */
const rand=a=>a[Math.floor(Math.random()*a.length)];

function createEngine(){
  /* ============================= § LAYOUT ============================= */
  const COLORS4=[
    {name:'Green', c:'#2f8f5b',dark:'#1b5637'},
    {name:'Navy',  c:'#41598f',dark:'#273757'},
    {name:'Pink',  c:'#e56aa5',dark:'#a53a72'},
    {name:'Yellow',c:'#f0c419',dark:'#a37c0a'},
  ];
  // v0.9.1 (Blake): seat 5 ("Silver", #aeb6be) read as too close to Navy blue at a glance on the
  // 6P board - a light blue-gray sitting next to a saturated blue. Replaced with Purple, a hue
  // that doesn't sit near ANY of the other five (Green/Navy/Red/White/Yellow) or the card
  // preview's red landing/kill fill (§ UTIL's showPaths CSS) - verified in a browser/sim
  // screenshot of a real 6P game, see PLANNING.md.
  const COLORS6=[
    {name:'Green', c:'#2f8f5b',dark:'#1b5637'},
    {name:'Navy',  c:'#41598f',dark:'#273757'},
    {name:'Red',   c:'#c6444a',dark:'#7e2429'},
    {name:'White', c:'#efe6d2',dark:'#b7a98a'},
    {name:'Purple',c:'#8859c9',dark:'#4f3070'},
    {name:'Yellow',c:'#f0c419',dark:'#a37c0a'},
  ];
  const SCHEDULES={4:[5,4,4],6:[4,4]};   // deal-round sizes; deck reshuffles after the last round
  const HOME_N=5;
  let LAY=null;

  /* X/plus board. Each arm: safe row on the axis, track flanks on both sides.
     Blake's exact walk-through (v0.4-final): from your start, 5 holes up your exit flank -
     the 5th is a CORNER HOLE shared with the next leg (each of those two rows is 6 holes
     counting the start / counting the shared corner) -> turn left, 5 more out the next
     arm's entry flank, ending at tip level -> turn right, 2 holes: the porch (tip-row
     center) then that player's start. The tip row has 3 holes: flank end, porch, start.
     Starts are exactly 12 steps apart. The shared corners + innermost safe holes form the
     little ring of holes around the board center (like the real board). Your own porch
     (steps L-1) is your last shared hole; from it you branch inward to the safe row
     (steps L..L+4). */
  // v0.13.3: ray-cast the wood octagon (SAME point list as drawBoard()'s `oct` polygon, § RENDER -
  // this is the single source of truth so the two can never drift apart) from the board center
  // (500,500) outward at angle thRad, returning the exact distance to the real rim in that
  // direction. See buildLayout()'s 6P plaqueAnchor branch below for why this exists: the octagon's
  // true edge distance varies by angle (a flat-edge value straight up/down vs a farther, near-
  // corner value on the 4 oblique axes) and a single flat radius can't sit flush against both.
  function octRimR(thRad){
    const c=150;  // MUST match drawBoard()'s `oct` polygon chamfer constant, § RENDER
    const pts=[[c,8],[1000-c,8],[992,c],[992,1000-c],[1000-c,992],[c,992],[8,1000-c],[8,c]];
    const dx=Math.cos(thRad), dy=Math.sin(thRad);
    let best=Infinity;
    for(let i=0;i<pts.length;i++){
      const p1=pts[i], p2=pts[(i+1)%pts.length];
      const ex=p2[0]-p1[0], ey=p2[1]-p1[1];
      const denom=dx*ey-dy*ex;
      if(Math.abs(denom)<1e-9)continue;             // ray parallel to this edge - skip
      const t=((p1[0]-500)*ey-(p1[1]-500)*ex)/denom; // distance along the ray
      const u=((p1[0]-500)*dy-(p1[1]-500)*dx)/denom; // position along the edge segment, 0..1
      if(t>1e-6 && u>=-1e-6 && u<=1+1e-6 && t<best)best=t;
    }
    return best;
  }
  function buildLayout(n,viewSeat){
    // v0.12 (per-viewer board rotation - see HANDOFF.md "Per-viewer board rotation"): `viewSeat`
    // is whichever seat this SCREEN should treat as "home," always drawn at the bottom, like
    // sitting at a real table. Defaults to n/2 - the seat that ALREADY sat at the bottom under
    // the pre-v0.12 fixed formula below (see the th= line's comment) - so calling buildLayout(n)
    // with no second argument (old call sites, test scripts) reproduces the exact pre-v0.12
    // board with zero behavior change.
    if(viewSeat==null)viewSeat=Math.floor(n/2);
    const cfg=n===4
      ?{r0:430,holeR:13,baseR:470,spread:34}
      :{r0:400,holeR:10.5,baseR:440,spread:26};
    /* Even spacing everywhere: solve g so that flank spacing == tip-row spacing == g.
       tc = g/tan(pi/n) is where adjacent flank lines cross (the shared corner), and
       (r0 - tc)/5 = g  =>  g = r0 / (5 + 1/tan(pi/n)). Every consecutive pair of loop
       holes - flanks, corners, tip rows, porch->start - is then exactly g apart. */
    const g=cfg.r0/(5+1/Math.tan(Math.PI/n));
    const tc=g/Math.tan(Math.PI/n), hs=g;
    const arms=[];
    for(let s=0;s<n;s++){
      // Pre-v0.12 this was simply -90+s*(360/n) (seat 0 at top, clockwise, n/2 lands at the
      // bottom/90deg - screen y grows downward, so 90deg IS "down"). v0.12 adds a `viewSeat`
      // offset so THAT seat's arm lands on 90deg instead: th=90+(s-viewSeat)*(360/n) reduces to
      // the exact old formula when viewSeat=n/2 (algebraically identical - see HANDOFF.md's
      // derivation). Because n is always even and viewSeat is always an integer seat index, the
      // rotation is always an exact multiple of the seats' own angular spacing (360/n) - it only
      // PERMUTES which seat occupies which of the n evenly-spaced slots, it never invents a new
      // angle. That's why nothing downstream (the fixed wood-octagon polygon in drawBoard(), the
      // corner-anchor angles below, the uniform-spacing invariant) needs to change: the same set
      // of slot angles is reused, just relabeled - see the plaqueAnchor comment below for why the
      // corner selection stays correct too.
      const th=(90+(s-viewSeat)*(360/n))*Math.PI/180;
      const d={x:Math.cos(th),y:Math.sin(th)};
      arms.push({th,d,p:{x:-d.y,y:d.x}});                 // p = clockwise-side perpendicular
    }
    const P=(a,r,off)=>({x:500+a.d.x*r+a.p.x*off,y:500+a.d.y*r+a.p.y*off});
    const loop=[],home=[],base=[],plaque=[],plaqueDir=[];
    for(let s=0;s<n;s++){
      const a=arms[s],b=arms[(s+1)%n];
      loop.push({...P(a,cfg.r0,g),start:s});              // your start (tip row, exit side)
      for(let k=1;k<=4;k++)loop.push(P(a,cfg.r0-k*hs,g)); // 4 up the exit flank...
      loop.push(P(a,tc,g));                               // ...5th = the shared corner hole
      for(let k=4;k>=0;k--)loop.push(P(b,cfg.r0-k*hs,-g));// 5 out the entry flank (last = tip level)
      loop.push(P(b,cfg.r0,0));                           // porch: tip-row center, last before b's start
    }
    const deckPockets=[],discardPockets=[];
    const cardW=n===4?76:60, cardH=n===4?106:84;
    // v0.9.1 (Blake): 6P's deck used to sit at pocketR=225 - close enough to the center ring to
    // cover some of the board's own holes ("make the deck of cards be on the outer rim of the
    // dealer not the inside"). Moved out to 330 - right beside the 6P placard (radius 340, see
    // below) and just inside the base cluster (baseR=440), i.e. genuinely "near that player's
    // base/placard area" as asked. This was hand-verified against an exhaustive overlap search
    // (radius AND angle swept) once the placard doubled in size (v0.9.1 item 3): no position
    // exists on this board that clears the enlarged placard's full padded bounding box AND every
    // hole AND stays on the wood at any angle - 330 is the radius that clears every actual HOLE
    // (base/track/safe, the literal complaint) with only a small cosmetic corner-nick against the
    // placard's padding, confirmed by a direct screenshot (nowhere near as bad as the box-overlap
    // math alone suggested - the placard's real visible pill is smaller than its full hit-box).
    // 4P's pocketR=310 was re-checked against the now-bigger 4P placards too and is still clean -
    // untouched.
    const pocketR=n===4?310:330;
    const discOff=n===4?92:66;                            // sideways nudge - keeps a played card clear of the deck
    // v0.10.2 (Blake: "have the name plates run along that short cut off corner on every side
    // of the board"): the octagon's wood polygon (see drawBoard()'s `oct`, § RENDER) always has
    // its 4 diagonal chamfers at exactly ±45°/±135° from center, regardless of n - that's a
    // property of the physical board shape, not the seat layout. 4P's 4 bisectors land EXACTLY
    // on those 4 corners (a happy coincidence of 90° spacing), so every 4P seat gets its own. 6P's
    // 6 bisectors (60° apart) can't all get a private corner - every seat still finds whichever of
    // the 4 corners is angularly closest (an exact tie, for the 2 seats pointing at the board's
    // plain left/right edges, breaks toward the first corner checked - see CORNER_ANGLES' order),
    // landing 2 corners with 2 seats and 2 with 1. A corner with 2 seats offsets them along its own
    // tangent (perpendicular to its radial direction) so they sit side by side ALONG that corner,
    // not stacked - CORNER_TANGENT_GAP is that offset, tuned (see HANDOFF.md) against real
    // getBoundingClientRect() measurements the same way v0.10's PLAQUE_SLIDE was. rot alternates
    // -45/45 per corner (checkerboard, same sign rule the original 4P-only code used: u.x*u.y>0 ?
    // -45 : 45) so every plate lies flush and readable against its corner's actual diagonal cut.
    const CORNER_ANGLES=[-3*Math.PI/4,-Math.PI/4,Math.PI/4,3*Math.PI/4];   // NW, NE, SE, SW
    const CORNER_R=n===4?630:596;   // radius to just past the chamfer's midpoint (drawBoard's oct,
                                     // c=150, puts the chamfer itself at ~radius 595) - 4P pushes a
                                     // touch further since nothing shares its corners; both found
                                     // empirically against real hole/pocket/viewport measurements.
    const CORNER_TANGENT_GAP=120;   // board-space offset between two plates sharing one corner (6P only)
    const cornerGroups=CORNER_ANGLES.map(()=>[]);
    const seatBt=[];
    for(let s=0;s<n;s++){
      const bt=arms[s].th-Math.PI/n;                      // this seat's own bisector (still used for base/deck below)
      seatBt.push(bt);
      let best=0,bestDiff=Infinity;
      for(let c=0;c<4;c++){
        let diff=Math.abs(bt-CORNER_ANGLES[c])%(2*Math.PI);
        if(diff>Math.PI)diff=2*Math.PI-diff;
        if(diff<bestDiff){bestDiff=diff;best=c;}
      }
      cornerGroups[best].push(s);
    }
    const plaqueAnchor=new Array(n);
    if(n===4){
      for(let c=0;c<4;c++){
        const ang=CORNER_ANGLES[c];
        const cu={x:Math.cos(ang),y:Math.sin(ang)};
        const tangent={x:-cu.y,y:cu.x};
        const rot=cu.x*cu.y>0?-45:45;
        const seats=cornerGroups[c];
        seats.forEach((s,i)=>{
          // 1 seat at this corner: dead center on it. 2 seats: offset apart along the tangent,
          // symmetric around the corner's own anchor point (more than 2 never happens - 4 corners,
          // at most 6 seats, pigeonhole caps any one corner at 2 in this layout).
          const off=seats.length===1?0:(i===0?-1:1)*CORNER_TANGENT_GAP/2;
          plaqueAnchor[s]={x:500+cu.x*CORNER_R+tangent.x*off,y:500+cu.y*CORNER_R+tangent.y*off,rot};
        });
      }
    }else{
      /* v0.13 (Blake, 6P ONLY - 4P's corner design above is untouched, he only asked about 6P):
         "each name plate at the edge of the board behind where their 5 safe spots align... on the
         edge of the board near each of those pillars." The shared-corner design above forces 2 of
         6P's seats to split one corner (CORNER_TANGENT_GAP) - Blake's new ask replaces that with
         each seat getting its OWN plate, on its OWN safe-row axis (arms[s].d, offset 0 - the exact
         line the 5 home holes AND the porch hole already sit on, see home[] below and the porch
         loop-push above), pushed out past the porch hole to PLAQUE6_R - at/overlapping the board's
         outer wood edge on purpose (Blake: "you can have the plates overlap into the board...
         overlapping is explicitly fine now", a reversal of the old "never touch the wood" rule -
         just never covering an actual hole/tee/base spot/deck pocket, which PLAQUE6_R was picked
         to guarantee, same real-getBoundingClientRect()-sweep methodology as every other plaque
         constant in this file, not eyeballed - see HANDOFF.md "v0.13 six-player name plates").
         Rotation: readable at every one of the 6 fixed slot angles this board ever uses (30/90/
         150/210/270/330 - always the same SET regardless of viewSeat, only which seat occupies
         which slot changes, per v0.12) - tilts to follow the local radial direction like the 4P
         corner plates do, but clamped to +-90 deg so text is never upside-down at any position
         (unlike the fixed +-45 checkerboard the corner design uses, this needs a continuous
         formula since there are 6 distinct angles, not 4 shared corners). */
      /* v0.13.3 (Blake: "on 6 person make the name plates on the top and bottom actually semi
         touch the board like you did with the others"). Root cause: PLAQUE6_R below was a single
         FLAT radius applied to all 6 axes, but the wood's actual edge distance from center isn't
         uniform - it's the chamfered-square octagon drawBoard() renders (`oct`, § RENDER, chamfer
         constant c=150), which sits at exactly 492 board-units straight up/down (a flat edge) but
         ~568 on the other 4 (oblique) axes (near a corner chamfer, farther from center). A flat
         555 anchor landed OUTSIDE the wood at the 2 vertical axes (492 rim - a ~63-unit floating
         gap, confirmed both by direct measurement and by a screenshot of live v0.13.2) while
         sitting correctly INSIDE it at the other four (568 rim - a ~13-unit overlap, the exact
         "semi-touch" look Blake approved). Fix: octRimR() (just above buildLayout, § LAYOUT) ray-
         casts the SAME polygon drawBoard() renders to get the TRUE rim distance for any angle -
         one source of truth, so this can never silently drift out of sync with the physical board
         shape again - and every seat now anchors that same ~13-unit depth past ITS OWN true rim,
         instead of a single shared number. This reproduces the 4 oblique anchors byte-for-byte
         (568.1-13.1=555, today's PLAQUE6_R - zero change there) while pulling the 2 vertical ones
         in from 555 to ~479. Verified (HANDOFF.md "v0.13.3"): real getBoundingClientRect() sweeps
         (worst-case 10-char name) confirm ~479 makes the vertical plates straddle the rim exactly
         like the other four (2 of the plate's 4 corners land inside the wood, 2 outside - the same
         signature the approved look already has), and stays comfortably clear of every hole (the
         empirical hole-safe crossover there is ~440; PLAQUE6_HOLE_FLOOR below is a padded,
         never-expected-to-bind defensive floor, not the load-bearing constant PLAQUE6_R used to
         be). */
      const PLAQUE6_R=555;   // v0.13's original flat anchor radius - kept ONLY as the calibration
                              // reference the per-angle formula below reproduces exactly at the 4
                              // oblique axes (30/150/210/330deg); no longer applied directly.
      const PLAQUE6_OVERLAP=octRimR(Math.PI/6)-PLAQUE6_R; // ~13.1 - the semi-touch overlap depth
                              // already established/approved at the oblique axes (30deg is one),
                              // now applied to every axis via ITS OWN true rim distance below.
      const PLAQUE6_HOLE_FLOOR=460;  // defensive floor only - real sweeps (HANDOFF.md) found the
                              // vertical axes' true hole-safe crossover at ~440; the formula below
                              // lands them at ~479, comfortably above both.
      for(let s=0;s<n;s++){
        const a=arms[s];
        const thDeg=a.th*180/Math.PI;
        let rot=((thDeg-90)%360+360)%360;         // 0..360, 0 = upright (this seat's arm points straight down)
        if(rot>180)rot-=360;                       // -180..180
        if(rot>90)rot-=180; else if(rot<-90)rot+=180; // clamp to -90..90 - never upside-down
        const r=Math.max(PLAQUE6_HOLE_FLOOR, octRimR(a.th)-PLAQUE6_OVERLAP);
        plaqueAnchor[s]={x:500+a.d.x*r,y:500+a.d.y*r,rot};
      }
    }
    for(let s=0;s<n;s++){
      const a=arms[s];
      home.push([1,2,3,4,5].map(k=>P(a,cfg.r0-k*hs,0)));
      const bt=seatBt[s];                                 // bisector toward the player's right
      const u={x:Math.cos(bt),y:Math.sin(bt)};
      const bc={x:500+u.x*cfg.baseR,y:500+u.y*cfg.baseR},sp2=cfg.spread;
      base.push([{x:bc.x,y:bc.y},{x:bc.x-sp2,y:bc.y-sp2},{x:bc.x+sp2,y:bc.y-sp2},
                 {x:bc.x-sp2,y:bc.y+sp2},{x:bc.x+sp2,y:bc.y+sp2}]);
      plaque.push(plaqueAnchor[s]);
      // v0.10: outward unit vector for this seat's plaque - positionPlaques() (§ RENDER) can
      // still nudge the plaque a little further out along this line (now the CORNER's own radial
      // direction, not necessarily this seat's bisector - see plaqueAnchor above) if a screen has
      // room to spare; the anchor above is already the primary, corner-safe position.
      const anchorAng=Math.atan2(plaqueAnchor[s].y-500,plaqueAnchor[s].x-500);
      plaqueDir.push({x:Math.cos(anchorAng),y:Math.sin(anchorAng)});
      // the deck sits in the DEALER's quarter and slides over when the deal passes - unrelated
      // to the plaque redesign above, still keyed off this seat's OWN bisector as always.
      const dx=500+u.x*pocketR,dy=500+u.y*pocketR;
      deckPockets.push({x:dx,y:dy,w:cardW,h:cardH});
      // each seat's played cards land just beside their OWN deck pocket, offset so it
      // never sits on top of the deck (even when this seat is the current dealer)
      const perp={x:-u.y,y:u.x};
      discardPockets.push({x:dx+perp.x*discOff,y:dy+perp.y*discOff,w:cardW,h:cardH});
    }
    const discard={x:500,y:500,w:cardW,h:cardH};          // unused visually now - kept for shape stability
    return {n,L:12*n,loop,home,base,plaque,plaqueDir,holeR:cfg.holeR,deckPockets,discardPockets,discard,viewSeat};
  }
  // v0.12: which seat should this SCREEN treat as "home" (bottom of the board)? Online: always
  // YOUR OWN seat (NET.mySeat) - the core promise, every phone shows itself at the bottom.
  // Offline solo (exactly one human seat, e.g. vs-CPU): that human's seat, so a vs-CPU game
  // always seats you at the bottom no matter which color you picked. Offline pass-and-play (2+
  // human seats sharing one device) and autotest/all-CPU (0 human seats): explicitly NO rotation
  // - a real table doesn't spin when the phone gets handed to the next player, so this returns
  // the same seat (n/2) that always rendered at the bottom before this feature existed. `seats`
  // is a plain array of {type,...} seat descriptors - callers pass whatever they already have on
  // hand (CFG's local `seats`, `action.seats`, or a loaded G.seats) since this can run BEFORE `G`
  // exists (game start / boot from network).
  function computeViewSeat(n,seats){
    if(NET.online)return NET.mySeat;
    const humanIdx=seats.reduce((acc,s,i)=>{if(s.type==='human')acc.push(i);return acc;},[]);
    return humanIdx.length===1?humanIdx[0]:Math.floor(n/2);
  }
  const entryIdx=s=>s*12;
  const loopIdx=(s,steps)=>(entryIdx(s)+steps)%LAY.L;
  /* v0.11.1: HANDOFF.md's soak-testing recipe has long said loopIdx()/entryIdx() are "exposed on
     window alongside G/LAY for exactly this kind of check" (converting a seat-relative `steps` to
     a shared absolute board position before comparing pieces across seats) - that claim was
     actually false (only G/LAY were ever assigned to window), caught for real this session when a
     soak-test script following that exact recipe hit `window.loopIdx is not a function`. Actually
     exposing them now so the documented recipe is true. */

  function stepPos(s,steps){
    return steps<LAY.L ? LAY.loop[loopIdx(s,steps)] : LAY.home[s][steps-LAY.L];
  }

  /* ============================= § STATE ============================= */
  let G=null;
  function freshDeck(){
    const d=[]; let id=0;
    for(const s of ['♠','♥','♦','♣'])
      for(const r of ['A','2','3','4','5','6','7','8','9','10','J','Q','K'])
        d.push({r,s,id:id++});
    for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]];}
    return d;
  }
  function newGame(cfg,seed){
    // seed (online multiplayer): {deck,dealer} generated once by the host and broadcast, so
    // every client builds the identical starting state instead of shuffling independently.
    G={n:cfg.n,teams:cfg.teams,seats:cfg.seats,
       pieces:cfg.seats.map(()=>Array.from({length:5},()=>({state:'base',steps:-1}))),
       hands:cfg.seats.map(()=>[]),
       deck:(seed&&seed.deck)?seed.deck.slice():freshDeck(),discard:[],
       schedule:SCHEDULES[cfg.n],schedRound:0,
       dealer:(seed&&seed.dealer!=null)?seed.dealer:Math.floor(Math.random()*cfg.n),
       turn:0,passStreak:0,over:false,winners:[],
       bowedOut:cfg.seats.map(()=>false),   // per-seat "done for this hand" flag - see RULES.md 2026-07-08
       dealSeq:0,   // counts doDeal() calls - lets the stateCheck integrity guard match up a
                    // digest to the SAME logical checkpoint on every client, not just whoever's
                    // rendering fastest right now (see doDeal/gDigest)
       actionSeq:0, // v0.10.2: counts applyMove() calls (every real move/swap, game-lifetime) -
                    // a FINER-grained checkpoint than dealSeq for the integrity guard, so a
                    // silent drift gets caught within a few moves instead of up to a whole hand
                    // later (see the kick/swap stateCheck trigger in performMove(), § TURNS).
       paused:false,     // v0.8: pause/resume - see setPaused()/pauseGate() in § TURNS
       // v0.13: one random id per logical game, rides along inside the saved G object (survives
       // save/resume/reload) - the idempotency key for offline solo-result submission (see
       // submitOrQueueSoloResult below). ONLY generated for a genuine offline start (no `seed` -
       // see the two call sites: startGame() passes none, bootGameFromNetwork()'s 'start' handler
       // always passes {deck,dealer}). Deliberately left undefined for an online game: G is
       // deterministic-lockstep state that every phone must build byte-identically (see the
       // per-deal integrity digest, gDigest() below, and this project's own online-testing
       // convention of asserting JSON-stringify(G) equality across contexts) - a client-generated
       // random value here would make every phone's G differ from every other phone's for no
       // reason (harmless for the app itself, since gDigest() and recordWin()'s online branch
       // never read gameId - but a real footgun for exactly that byte-equality testing
       // convention, caught by this session's own online e2e regression test).
       gameId:seed?undefined:genGameId()};
    G.turn=(G.dealer+1)%G.n;
    G.humanCount=cfg.seats.filter(s=>s.type==='human').length;
  }
  const partnerOf=s=>G.teams?(s+G.n/2)%G.n:-1;
  const sameTeam=(a,b)=>a===b||(G.teams&&partnerOf(a)===b);
  const allHome=s=>G.pieces[s].every(p=>p.state==='home');
  function trackOccupant(idx){
    for(let s=0;s<G.n;s++)for(let pi=0;pi<5;pi++){
      const p=G.pieces[s][pi];
      if(p.state==='track'&&loopIdx(s,p.steps)===idx)return{seat:s,pi};
    } return null;
  }
  const homeOcc=(s,q)=>G.pieces[s].some(p=>p.state==='home'&&p.steps===q);
  function isSnug(s,pi){
    const p=G.pieces[s][pi]; if(p.state!=='home')return false;
    for(let q=p.steps+1;q<=LAY.L+HOME_N-1;q++)if(!homeOcc(s,q))return false;
    return true;
  }

  /* ============================= § ENGINE ============================= */
  /* Rules assumptions & sources: see RULES.md. steps: 0=own start hole; loop is L=12n
     holes so starts sit exactly 12 apart. Steps L-1 = your porch (the shared tip-center
     hole right before your start - you CAN be kicked there). From the porch you branch
     inward: steps L..L+4 = your safe row, which nobody else can touch. */
  /* You can NEVER pass your own peg (or your partner's, in teams) - and, as of v0.23
     (Blake, 2026-07-20), you can never LAND on your own peg either: a move that would land
     exactly on your own peg (or your partner's, in teams - same grouping as the never-pass
     rule) is simply ILLEGAL. It is never offered and can never be forced. Landing exactly
     on an OPPONENT's peg still takes it out. */
  function pathForward(owner,p,n){
    const t=p+n; if(t>LAY.L+HOME_N-1)return null;
    let kick=null;
    for(let q=p+1;q<=t;q++){
      if(q>=LAY.L){ if(homeOcc(owner,q))return null; }
      else{
        const occ=trackOccupant(loopIdx(owner,q));
        if(!occ)continue;
        // v0.23: your own peg (or your partner's) ANYWHERE on the path - passed over OR landed
        // on - makes the whole move illegal. sameTeam() covers "own" even in free-for-all.
        if(sameTeam(occ.seat,owner))return null;
        if(q===t)kick=occ;
      }
    }
    return{kick};
  }
  function pathBack(owner,p,n){
    const t=p-n; if(t<0)return null;
    let kick=null;
    for(let q=p-1;q>=t;q--){
      if(q>=LAY.L){ if(homeOcc(owner,q))return null; }
      else{
        const occ=trackOccupant(loopIdx(owner,q));
        if(!occ)continue;
        // v0.23: same rule backwards - own/partner peg on the path or the landing hole = illegal.
        if(sameTeam(occ.seat,owner))return null;
        if(q===t)kick=occ;
      }
    }
    return{kick};
  }
  function actingOwner(seat){
    if(G.teams&&allHome(seat)&&!allHome(partnerOf(seat)))return partnerOf(seat);
    return seat;
  }
  function legalMoves(seat){
    const owner=actingOwner(seat), ms=[];
    G.hands[seat].forEach((card,ci)=>{
      const r=card.r;
      if(r==='K'||r==='A'){
        const bi=G.pieces[owner].findIndex(p=>p.state==='base');
        if(bi>=0){
          const occ=trackOccupant(loopIdx(owner,0));
          // v0.23: an OPPONENT on your start gets kicked; your own (or partner's) tee sitting
          // there makes coming out illegal - never offered, never forced (Blake, 2026-07-20).
          if(!occ||!sameTeam(occ.seat,owner))ms.push({ci,type:'enter',owner,pi:bi,to:0,kick:occ||null});
        }
      }
      if(r==='J'){
        G.pieces[owner].forEach((p,pi)=>{ if(p.state!=='track')return;
          for(let ts=0;ts<G.n;ts++){ if(ts===owner)continue;
            G.pieces[ts].forEach((tp,tpi)=>{ if(tp.state==='track')ms.push({ci,type:'swap',owner,pi,ts,tpi}); });
          }
        });
      }
      let fwd=null;
      if(r==='A')fwd=1; else if(r==='Q')fwd=12;
      else if(/^(2|4|5|6|7|8|9|10)$/.test(r))fwd=parseInt(r,10);
      if(fwd!=null){
        G.pieces[owner].forEach((p,pi)=>{
          if(p.state==='base')return;
          if(p.state==='home'&&isSnug(owner,pi))return;
          const res=pathForward(owner,p.steps,fwd);
          if(res)ms.push({ci,type:'move',owner,pi,to:p.steps+fwd,kick:res.kick});
        });
      }
      if(r==='3'){
        G.pieces[owner].forEach((p,pi)=>{
          if(p.state==='base')return;
          if(p.state==='home'&&isSnug(owner,pi))return;
          const res=pathBack(owner,p.steps,3);
          if(res)ms.push({ci,type:'back',owner,pi,to:p.steps-3,kick:res.kick});
        });
      }
    });
    return ms;
  }
  // v0.10.2: thrown by applyMove() when it's asked to do something the current G genuinely
  // can't support (see the swap guard below) - a signal to the turn loop to resync instead of
  // silently corrupting state or crashing uncaught. See handleTurnLoopError(), § TURNS.
  class ImpossibleStateError extends Error{}
  function applyMove(seat,m){
    const card=G.hands[seat].splice(m.ci,1)[0];
    G.discard.push(card); G.passStreak=0; G.actionSeq++;
    if(m.type==='swap'){
      const a=G.pieces[m.owner][m.pi], b=G.pieces[m.ts][m.tpi];
      // Integrity guard (fix, v0.10.2 - the save/quit/reload/resume desync Blake hit
      // 2026-07-12): a swap is only ever legal between two pieces that are BOTH still on the
      // track (legalMoves() never offers one otherwise - see RULES.md, a Jack can never target
      // a safe-row/home piece). If this client's own copy of either piece has already drifted to
      // 'home' or 'base' - i.e. the action was computed against a DIFFERENT, no-longer-matching
      // G on whichever client sent it - blindly feeding a home/base `steps` value into
      // loopIdx() (which assumes a valid 0..L-1 loop position) produces a garbage, off-board
      // position instead of an error: exactly how a piece ended up "one spot up but to the
      // right, outside the safe zone" in Blake's report. Detect it and let the caller resync
      // instead of corrupting G further.
      if(a.state!=='track'||b.state!=='track'){
        throw new ImpossibleStateError(`swap target off-track: owner=${m.owner}/${m.pi} state=${a.state}, ts=${m.ts}/${m.tpi} state=${b.state}`);
      }
      const ia=loopIdx(m.owner,a.steps), ib=loopIdx(m.ts,b.steps);
      a.steps=(ib-entryIdx(m.owner)+LAY.L)%LAY.L;
      b.steps=(ia-entryIdx(m.ts)+LAY.L)%LAY.L;
    }else{
      if(m.kick){const v=G.pieces[m.kick.seat][m.kick.pi];v.state='base';v.steps=-1;}
      const p=G.pieces[m.owner][m.pi];
      p.steps=m.to; p.state=m.to>=LAY.L?'home':'track';
    }
    if(!G.teams&&allHome(m.owner)){G.over=true;G.winners=[m.owner];}
    if(G.teams&&allHome(m.owner)&&allHome(partnerOf(m.owner))){G.over=true;G.winners=[m.owner,partnerOf(m.owner)];}
    return card;
  }

  /* ============================= § TURN DECISIONS =============================
     v0.15: pure, deterministic turn-flow decision helpers - the dealing schedule, bow-out, and
     whole-table-stuck throw-in are RULES (see RULES.md) exactly like legalMoves()/applyMove(),
     so they get the same single-source-of-truth treatment, living in this same extracted block.
     These are DECISION-ONLY: no toast()/wait()/animation/DOM - a caller (the server's headless
     authoritative loop, or index.html's own doDeal()/runTurn()/passTurn() inside their
     NET.online branches) drives the actual UI/pacing around them.
     seatsWithCards()/handOver() were moved here VERBATIM from § TURNS (byte-identical, zero
     behavior change for the offline path, which still calls the same global function - it's
     just defined earlier in the file now) - see HANDOFF.md "v0.15" for why. */
  function seatsWithCards(){return G.hands.filter(h=>h.length>0).length;}
  // A hand is over once every seat has either played out (empty hand) or bowed out (2026-07-08
  // rule) - NOT just "all hands empty," since a bowed-out seat can still hold leftover cards
  // it's no longer allowed to play this hand.
  function handOver(){ return G.hands.every((h,s)=>h.length===0||G.bowedOut[s]); }
  // True exactly when the next doDeal()-equivalent needs a FRESH shuffle (the deal schedule for
  // this hand has run out) - the caller (only ever the server; the offline/local-shuffle path is
  // untouched, see doDeal()) uses this to decide whether it needs to generate a new deck+dealer
  // before calling dealDecision() below.
  function needsReshuffle(){ return G.schedRound>=G.schedule.length; }
  /* dealDecision(seed): mutates G exactly like doDeal() does, MINUS every toast()/animateDeal()/
     wait()/syncAll() call (those are the caller's job - see doServerDeal() in server.js and the
     NET.online branch of doDeal() below). `seed` is only consulted when needsReshuffle() is true
     at call time: {deck (a real shuffled 52-card array - only the SERVER ever has one to hand
     in), dealer}. Returns {reshuffled, dealer, k, hands} - `hands` is exactly which cards each
     seat received THIS round (seat index -> array of card objects), popped from the real deck -
     the caller (server) broadcasts this so every client can apply the identical cards without
     ever holding a real deck of its own (see "§ v0.15 wire protocol" in HANDOFF.md - hand
     privacy was never a security boundary in this app, so this is fine). */
  function dealDecision(seed){
    G.dealSeq++;
    G.bowedOut=G.seats.map(()=>false);   // fresh hand - everyone's back in (RULES.md 2026-07-08)
    let reshuffled=false;
    if(needsReshuffle()){
      reshuffled=true;
      G.deck=seed.deck.slice(); G.discard=[]; G.schedRound=0;
      G.dealer=seed.dealer; G.turn=(G.dealer+1)%G.n;
    }
    const k=G.schedule[G.schedRound]; G.schedRound++;
    const hands={};
    for(let s=0;s<G.n;s++)hands[s]=[];
    for(let i=0;i<k;i++)for(let j=0;j<G.n;j++){
      const seat=(G.dealer+1+j)%G.n, card=G.deck.pop();
      G.hands[seat].push(card); hands[seat].push(card);
    }
    // RULE (Blake, 2026-07-10): "the first person to go is always left of the dealer" - after
    // EVERY deal, not just a fresh reshuffle (RULES.md, resolved 2026-07-10).
    G.turn=(G.dealer+1)%G.n;
    return {reshuffled,dealer:G.dealer,k,hands,deckCount:G.deck.length};
  }
  /* passDecision(seat,newlyBowedOut): mutates G exactly like the "no legal move" branches of
     runTurn()/passTurn() do, minus toast()/wait(). `newlyBowedOut` is true exactly when THIS
     call is what bows the seat out for the hand (the caller already knows - it just ran
     legalMoves() and got nothing back); false for a seat that was already bowed out (an
     automatic re-pass) or one with a merely-empty hand this round (never flagged bowed-out,
     RULES.md doesn't call that a bow-out). Returns {threwIn} - whole-table-stuck throw-in
     (RULES.md, resolved 2026-07-10). */
  function passDecision(seat,newlyBowedOut){
    if(newlyBowedOut)G.bowedOut[seat]=true;
    G.passStreak++;
    let threwIn=false;
    if(G.passStreak>=seatsWithCards()&&seatsWithCards()>0){
      for(const h of G.hands){G.discard.push(...h);h.length=0;}
      G.passStreak=0;
      threwIn=true;
    }
    return {threwIn,passStreak:G.passStreak};
  }
  function advanceTurn(){ G.turn=(G.turn+1)%G.n; return G.turn; }

  /* ============================= § AI ============================= */
  function dangerAt(owner,steps){
    if(steps>=LAY.L)return 0;
    const my=loopIdx(owner,steps); let d=0;
    for(let s=0;s<G.n;s++){ if(sameTeam(s,owner))continue;
      for(const p of G.pieces[s]){ if(p.state!=='track')continue;
        const dist=(my-loopIdx(s,p.steps)+LAY.L)%LAY.L;
        if(dist>=1&&dist<=12)d++;
      }}
    return d;
  }
  function kickVal(owner,k){
    // v0.23: a kick can only ever hit an OPPONENT now (landing on your own or partner's peg is
    // illegal, so legalMoves() never produces such a kick) - the old own/partner penalty
    // branches were dead code and are gone. `owner` kept in the signature: exported name,
    // called with two args by the frozen-policy AI harness (server/tests/test_ai_difficulty.js).
    const vic=G.pieces[k.seat][k.pi];
    return 22+vic.steps*0.25;
  }
  function scoreMove(seat,m){
    let sc=0;
    if(m.type==='enter'){ sc+=16; if(m.kick)sc+=kickVal(m.owner,m.kick); }
    else if(m.type==='move'){
      const p=G.pieces[m.owner][m.pi];
      sc+=(m.to-p.steps)*0.4+p.steps*0.06;
      if(m.to>=LAY.L)sc+=20;
      if(m.kick)sc+=kickVal(m.owner,m.kick); else sc-=dangerAt(m.owner,m.to)*3.5;
    }
    else if(m.type==='back'){
      const p=G.pieces[m.owner][m.pi];
      sc-=6; if(p.steps>=LAY.L)sc-=22;
      if(m.kick)sc+=kickVal(m.owner,m.kick);
      sc-=dangerAt(m.owner,m.to)*2;
    }
    else if(m.type==='swap'){
      const a=G.pieces[m.owner][m.pi],b=G.pieces[m.ts][m.tpi];
      const an=(loopIdx(m.ts,b.steps)-entryIdx(m.owner)+LAY.L)%LAY.L;
      const bn=(loopIdx(m.owner,a.steps)-entryIdx(m.ts)+LAY.L)%LAY.L;
      sc+=(an-a.steps)*0.5;
      if(sameTeam(m.ts,m.owner))sc+=(bn-b.steps)*0.45; else sc+=(b.steps-bn)*0.3;
    }
    return sc;
  }
  // v0.17: how many of `s`'s tees are already home - the shared stakes proxy used by the
  // strategic core below for both "rush my last few tees in" and "deny them, they're about to win."
  const piecesHome=s=>G.pieces[s].filter(p=>p.state==='home').length;
  /* v0.17 (AI difficulty overhaul): ONE shared strategic scoring core for every tier. Every CPU
     seat scores every legal move (always a move legalMoves() already produced - no extra rules
     knowledge) as
         scoreMove(m) + P.strat*strategyBonus(m,P) + uniform(-P.jitter,+P.jitter)
     and plays the max. The three tiers differ ONLY in the AI_TIERS parameters below, never in
     policy code:
       - jitter: decision noise. Easy is noisy enough to frequently override its own judgment
         (clearly the most beatable tier, but never senseless - the same strategic core still
         steers it, so it enters, advances, kicks, and blocks like a real if unfocused player).
         Tricky is the scored-with-moderate-noise middle. Nasty is deterministic: it EXECUTES
         the strategy's top choice every single turn, which is empirically a big share of the
         tier gap all on its own.
       - strat: how strongly the strategic layer weighs in on top of scoreMove's tactical base.
       - deny: endgame denial aggressiveness - specifically scales the "they're about to win,
         take them out NOW" terms, so Nasty guards the finish line hardest.
     strategyBonus is deliberately SMALL relative to scoreMove's own scale (kicks ~22-40, home
     entry +20, a card of progress ~1-5): it tie-breaks among moves scoreMove already considers
     close rather than overriding a clearly better play - large versions of these bonuses were
     tried and measurably LOWERED win rate in harness testing. What it scores:
       - defensive Jacks: a swap's bonus scales with how far back it yanks an OPPONENT tee that
         was deep into ITS OWN lap (close to ITS OWN home entry).
       - blocking awareness: a bonus for ending a move on a physical hole that sits on an
         opponent's start hole, or in their final home stretch (their own last 6 steps before
         their porch) - a standing threat against whatever they need to pass through to finish.
       - stakes-aware: the get-home bonus grows with how many of the owner's tees are already
         home (rush the last few in); a kick against a tee close to, or already in, an opponent's
         home row is worth more - deny the opponent who's about to win (scaled by P.deny).
       - kick-hungry: extra weight on top of the kick value scoreMove already counts.
       - `closing`: once the owner has 4 tees home, the purely positional/defensive terms
         (blocking, defensive swaps) get discounted - "must still win itself," defense never
         outweighs finishing the game. */
  function strategyBonus(m,P){
    let v=0;
    const owner=m.owner, closing=piecesHome(owner)>=4?0.3:1;
    if(m.type==='move'||m.type==='enter'||m.type==='back'){
      if(m.to>=LAY.L)v+=2.5+piecesHome(owner)*1.5;                 // rush the last tees home
      if(m.to<LAY.L){
        const phys=loopIdx(owner,m.to);
        for(let o=0;o<G.n;o++){ if(sameTeam(o,owner))continue;
          let block=0;
          if(phys===entryIdx(o))block+=0.3;                       // camped on their start hole
          const rel=(phys-entryIdx(o)+LAY.L)%LAY.L;
          if(rel>=LAY.L-6)block+=0.6+piecesHome(o)*0.3*P.deny;     // sitting in their final home stretch
          v+=block*closing;
        }
      }
    }
    if(m.kick){                                                    // v0.23: every kick is an opponent kick now (own/partner landings are illegal)
      const vic=G.pieces[m.kick.seat][m.kick.pi];                 // pre-kick steps - still intact here
      v+=kickVal(m.owner,m.kick)*0.55;                             // kick-hungry: extra weight on top of kickVal
      v+=piecesHome(m.kick.seat)*3*P.deny;                         // they're close to winning - deny it
      if(vic.steps>=LAY.L-6&&vic.steps<LAY.L)v+=5*P.deny;          // stripped right before their porch
      if(vic.steps>=LAY.L)v+=4*P.deny;                             // forced a non-snug home tee back out
      // v0.18: their LAST tee still out - Nasty-only (P.ruthless is 0/undefined for every other
      // tier, so this is a pure no-op there). "Ruthless denial" per Blake's brief: a kick against
      // someone with all 4 other tees already home is worth taking almost no matter what else is
      // on offer, since it's the single biggest swing available on the board.
      if(piecesHome(m.kick.seat)===4)v+=(P.ruthless||0);
    }
    if(m.type==='swap'&&!sameTeam(m.ts,m.owner)){
      const a=G.pieces[m.owner][m.pi],b=G.pieces[m.ts][m.tpi];
      const bn=(loopIdx(m.owner,a.steps)-entryIdx(m.ts)+LAY.L)%LAY.L;
      const pulledBack=b.steps-bn;                                 // positive = yanked them backward
      if(pulledBack>0)v+=(pulledBack*0.3+(b.steps>=LAY.L-12?3:0)+piecesHome(m.ts)*0.8*P.deny)*closing;
    }
    return v;
  }
  /* Tier ladder, tuned via a headless many-game harness against server/engine.js:
     Easy/Tricky numbers are the original v0.17 measurements, UNCHANGED this session (Blake only
     asked to sharpen Nasty): Tricky 76.4% vs Easy; Easy 76.2% vs a harness-only pure-random
     baseline; N=500, 4P FFA 2-and-2 seating. Nasty's own numbers are the v0.18 ones - see the
     "v0.18" section of HANDOFF.md for the full harness writeup and exact win rates/decision
     timing. The jitter values look large next to scoreMove's scale on purpose - that is the knob
     that separates the rungs (for Easy/Tricky; Nasty separates itself with ply2 + ruthless
     instead, see below). */
  const AI_TIERS={
    easy:  {strat:0.15,jitter:95, deny:0.5, ply2:false, ruthless:0},    // UNCHANGED from v0.17
    medium:{strat:0.5, jitter:35, deny:1,   ply2:false, ruthless:0},    // "Tricky" - UNCHANGED from v0.17
    hard:  {strat:1,   jitter:0,  deny:2.4, ply2:true,  ruthless:150},   // "Nasty" - v0.18 overhaul, see below
  };
  /* v0.18 (2026-07-16, difficulty overhaul): Blake's ask was blunt - "make nasty difficulty damn
     near impossible." The v0.17 Nasty was still only a ONE-PLY scored move choice (the shared
     strategyBonus core, executed with zero noise). This session adds real lookahead to the hard
     tier ONLY (Easy/Tricky's policy code and AI_TIERS numbers are byte-for-byte what v0.17
     shipped - `ply2`/`ruthless` are 0/false for both, so every new code path below is a no-op for
     them). Two single-ply "probe the very next turn" designs were tried and measurably FAILED to
     clear the acceptance bar in harness testing before landing on the rollout below - worth
     recording so nobody re-tries them expecting a different result:
       1. Score the opponent's overall best next move (their own progress, kicks, everything) and
          subtract it from our candidate. Nearly a no-op: the opponent's OTHER 4 tees keep making
          progress no matter which of our moves we pick, so that term was almost CONSTANT across
          candidates and just added noise on top of the already-good 1-ply signal.
       2. Narrow that to ONLY "does the opponent have a card that kicks one of MY pieces next
          turn" (exact, unlike scoreMove's coarse loop-distance dangerAt() heuristic). Better -
          genuinely zero-noise on safe moves - but still just a single-turn probe, and it plateaued
          at best around 55-60% against the frozen v0.17 policy across a wide parameter sweep (see
          HANDOFF.md's v0.18 section for the numbers) - not enough separation from a policy that's
          already 90% the same scoring core.
     What ships is a heuristic-guided ROLLOUT instead (see rolloutValue() below): play EACH
     candidate move out to a bounded depth using a cheap, fast, deterministic 1-ply policy for
     every seat (including my own future turns), then score the resulting position - actually
     watching several turns of consequences unfold instead of guessing from one static probe. This
     is what finally cleared both acceptance numbers (see AI_TIERS/HANDOFF.md for the measured
     rates). Supporting pieces:
     - cloneG()/rolloutValue()'s applyMove() calls: the ONLY way to try "what if I play move m,
       then keep playing" without touching the real game is to run the REAL applyMove()/
       handOver()/needsReshuffle()/dealDecision()/passDecision()/advanceTurn() (single source of
       truth for how a move and a whole hand's lifecycle mutate state - no duplicated logic)
       against a throwaway clone. Since G is a plain `let` module binding and every engine
       function reads the CURRENT value of G at call time (not a captured reference), temporarily
       reassigning G to the clone and restoring it right after is safe as long as it all happens
       synchronously with no await in between - true here, chooseAI is a plain sync function.
     - Depth-2+ search (`P.ply2`): score every legal move 1-ply first (same as every tier always
       has), then for EVERY one of those candidates (no top-K cutoff - an earlier capped version
       was a real bug, not just an optimization: candidates outside the cutoff kept their
       unpenalized 1-ply score, so a legitimately strong move could win purely from being exempt
       from scrutiny, not from being better - fixed by scoring every candidate the same way),
       simulate playing it and roll the clone forward (rolloutValue()). A move that outright WINS
       in the simulation skips the rollout entirely and is forced to the top (LOOKAHEAD_WIN_BONUS)
       - "exact counting for the last tee home" per the brief, no amount of position-value math
       should ever out-vote an actual win-now move.
     - Ruthless endgame denial (`P.ruthless`, see strategyBonus above): a flat, large, Nasty-only
       bonus on any kick against an opponent who has all 4 OTHER tees home already - their very
       last tee. Already covered a little by the existing deny-scaled terms, but those are small
       relative to scoreMove's own scale; this makes the "kill shot" close to un-ignorable, which
       is exactly the "ruthless when someone's a couple of moves from winning" behavior Blake asked
       for, without touching Easy/Tricky's math at all (P.ruthless is 0 there). */
  const LOOKAHEAD_W=0.05, LOOKAHEAD_WIN_BONUS=1e6;   // tuned via harness sweep, see HANDOFF.md's v0.18 section
  function cloneG(seat){                               // throwaway sim state - shares static fields, deep-copies mutable ones
    // deck MUST be a real copy (never the same array reference): rolloutValue() below can call
    // dealDecision() inside the simulation, which does G.deck.pop() - sharing the real deck array
    // here would let a throwaway rollout silently eat cards out of the ACTUAL game's deck. Caught
    // via a real crash in testing (a later real deal came up with undefined cards) before this
    // ever shipped - worth keeping this comment so nobody "simplifies" it back to a reference.
    //
    // v0.21 fairness fix (audit, 2026-07-18): the rollout must only see information a real player
    // sitting in `seat` would legitimately know. `seat`'s own hand is legitimate (it's their own
    // cards) and G.discard is legitimate (face-up, public) - both copied straight across, same as
    // before. Every OTHER seat's hand - INCLUDING a partner's in teams mode, RULES.md is explicit
    // partners' cards stay hidden from each other - and the undealt deck's card identities/order
    // are hidden information nobody at the table (let alone the AI) is supposed to see. The old
    // code copied those real, so the rollout was replaying the REAL hidden future (every
    // opponent's actual cards, the actual next cards off the deck) instead of a plausible guess -
    // genuine peeking, not a bug in the simulation's mechanics. Fix: pool every card from every
    // OTHER seat's hand plus the whole remaining deck, shuffle that pool, then hand it back out -
    // each other seat gets a hand of the SAME SIZE it currently holds (so hand-size-dependent
    // logic like handOver()/seatsWithCards() still behaves identically) and whatever's left over
    // becomes the new deck (same LENGTH, so needsReshuffle()/schedule bookkeeping is unaffected).
    // Board/pieces state needs no change - it's always public, never hidden info. Total card count
    // is exactly preserved by construction (the pool's size never changes, only its order and how
    // it's sliced back out) - see server/tests/test_deck_conservation.js for the automated check.
    const pool=[];
    for(let s=0;s<G.n;s++)if(s!==seat)for(const c of G.hands[s])pool.push(c);
    for(const c of G.deck)pool.push(c);
    for(let i=pool.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
    let pi=0;
    // fresh arrays every time (pool.slice()/h.slice()) - never a reference into `pool` itself or
    // into the real G.hands/G.deck arrays, so a rollout's dealDecision()/applyMove() mutating the
    // clone can never reach back and corrupt real state.
    const hands=G.hands.map((h,s)=>s===seat?h.slice():pool.slice(pi,pi+=h.length));
    const deck=pool.slice(pi);
    return {
      n:G.n,teams:G.teams,seats:G.seats,
      pieces:G.pieces.map(arr=>arr.map(p=>({state:p.state,steps:p.steps}))),
      hands,deck,discard:G.discard.slice(),
      schedule:G.schedule,schedRound:G.schedRound,dealer:G.dealer,turn:G.turn,
      passStreak:G.passStreak,over:G.over,winners:G.winners.slice(),
      bowedOut:G.bowedOut.slice(),dealSeq:G.dealSeq,actionSeq:G.actionSeq,paused:G.paused,gameId:G.gameId
    };
  }
  const ROLLOUT_PLY=48;             // ~12 rounds for 4 players - enough for a kick's fallout (and the
                                     // fallout of avoiding one) to actually show up in the position
  function evalForSeat(s){          // static position value, own-team relative, ~0..300 scale
    let v=0;
    G.pieces[s].forEach((p,pi)=>{ if(p.state==='home')v+=50+(isSnug(s,pi)?8:0);
      else if(p.state==='track')v+=p.steps*0.6; });
    return v;
  }
  function rolloutPolicy(s,mv){     // cheap, deterministic, 1-ply-only - NEVER recurses into ply2/rollout
    let best=null,bs=-1e9;
    for(const m of mv){ const sc=scoreMove(s,m)+strategyBonus(m,AI_TIERS.medium); if(sc>bs){bs=sc;best=m;} }
    return best;
  }
  function rolloutValue(seat){      // call with G already pointed at the hypothetical post-move state
    let ply=0;
    while(ply<ROLLOUT_PLY&&!G.over){
      if(handOver()){
        for(let s=0;s<G.n;s++){ if(G.hands[s].length){ G.discard.push(...G.hands[s]); G.hands[s].length=0; } }
        if(needsReshuffle())dealDecision({deck:freshDeck(),dealer:(G.dealer+1)%G.n}); else dealDecision({});
        continue;
      }
      const s=G.turn;
      if(G.hands[s].length===0){ advanceTurn(); continue; }
      if(G.bowedOut[s]){ passDecision(s,false); advanceTurn(); continue; }
      const mv=legalMoves(s);
      if(mv.length===0){ passDecision(s,true); advanceTurn(); continue; }
      applyMove(s,rolloutPolicy(s,mv));
      if(!G.over)advanceTurn();
      ply++;
    }
    if(G.over)return sameTeam(G.winners[0],seat)?400:-400;   // an outright win/loss inside the rollout dominates everything
    let theirs=0,cnt=0;
    for(let s=0;s<G.n;s++){ if(sameTeam(s,seat))continue; theirs+=evalForSeat(s); cnt++; }
    const mine=evalForSeat(seat)+(G.teams?evalForSeat(partnerOf(seat)):0);
    return mine-(cnt?theirs/cnt:0);
  }
  function chooseAI(seat,moves){
    const P=AI_TIERS[G.seats[seat].diff]||AI_TIERS.medium;
    // v0.23: the old "never kick your own/partner tee unless forced" safe-filter is gone -
    // landing on your own or partner's peg is now ILLEGAL (RULES.md, changed 2026-07-20), so
    // legalMoves() never offers such a move and there is nothing left to filter.
    const pool=moves;
    const scored=pool.map(m=>({m,s:scoreMove(seat,m)+P.strat*strategyBonus(m,P)
      +(P.jitter?(Math.random()*2-1)*P.jitter:0)}));
    // v0.18 bug found via harness (a 200-game run came back a coin-flip against the frozen v0.17
    // policy): an earlier version of this only ran the depth-2 probe on the top LOOKAHEAD_TOPK
    // candidates by 1-ply score, leaving every move outside that cutoff with its ORIGINAL,
    // unpenalized 1-ply score. That's a biased comparison, not a real search - a legitimately
    // strong move that happened to rank 11th got compared unpenalized against penalized top-10
    // moves, and could win purely from being exempt, not from being better. legalMoves() output is
    // small enough (a handful of cards, at most a few dozen swap candidates on a Jack) that a
    // performance cap was never actually needed - every legal move gets the same rollout treatment
    // now, no cutoff, no bias.
    if(P.ply2&&pool.length>1){
      const realG=G;
      for(const entry of scored){
        G=cloneG(seat);
        applyMove(seat,entry.m);   // real engine mutation, on the throwaway clone only
        entry.s2=G.over?entry.s+LOOKAHEAD_WIN_BONUS:entry.s+LOOKAHEAD_W*rolloutValue(seat);
        G=realG;
      }
    }
    let best=null,bs=-1e9;
    for(const entry of scored){
      const val=entry.s2!=null?entry.s2:entry.s;
      if(val>bs){bs=val;best=entry.m;}
    }
    return best;
  }

  return {
    newGame,
    freshDeck,
    buildLayout,
    computeViewSeat,
    entryIdx,
    loopIdx,
    stepPos,
    partnerOf,
    sameTeam,
    allHome,
    trackOccupant,
    homeOcc,
    isSnug,
    pathForward,
    pathBack,
    actingOwner,
    legalMoves,
    applyMove,
    ImpossibleStateError,
    dangerAt,
    kickVal,
    scoreMove,
    chooseAI,
    seatsWithCards,
    handOver,
    needsReshuffle,
    dealDecision,
    passDecision,
    advanceTurn,
    COLORS4,
    COLORS6,
    SCHEDULES,
    HOME_N,
    getG:()=>G, setG:(g)=>{G=g;}, getLAY:()=>LAY, setLAY:(l)=>{LAY=l;},
  };
}

export { createEngine, rand };
