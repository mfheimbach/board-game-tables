// "What to bring": simulates many weekends with the C++ core and counts how often each game
// gets played. Classic worker (importScripts).
//
// One simulated weekend:
//  - all games are there (except ⊘)
//  - rounds from the schedule: per day 2 long slots (morning dropped most often), a short
//    party/filler round between them ~60% of the time; a 2-hour slot is a short round; 5-7 rounds
//  - attendance: a 1 stays with 95%, a 0 turns up with 5%, blank is 50/50
//  - each round: the core's top-K (default 10) game combinations for whoever is there; the group picks one at
//    random, weighted by rank: weight 1/rank^strict (strict = Infinity: always #1, 0: any of them).
//    Games played earlier this weekend are gone.
//  - a seat is worth rating × (hours / 3)^alpha; short rounds count at most 1½ h, long day slots
//    at most 5 h, evenings without limit; short rounds only allow games up to 2 h, day slots up to 6 h
importScripts('tables.js');
const ready = createTables();
let stop = false;

const SHORT = 0, DAY = 1, EVE = 2;
const CAP = [90, 300, Infinity], MAXDUR = [120, 360, 0];

onmessage = async ({ data }) => {
  if (data.type === 'stop') { stop = true; return; }
  if (data.type !== 'run') return;
  stop = false;
  const M = await ready;
  run(M, data.input);
};

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function run(M, I) {
  const rand = rng(I.seed ?? Date.now());
  const G = I.games, nG = G.length, nP = I.nPlayers;
  let n = 0, fails = 0, rounds = 0;
  const cnt = new Float64Array(nG);           // weekends in which each game got played
  const pick = k => {                         // index into the top-k combinations, weighted by rank
    if (k <= 1 || I.strict === Infinity) return 0;
    let tot = 0; const w = [];
    for (let i = 0; i < k; i++) { w.push(Math.pow(i + 1, -I.strict)); tot += w[i]; }
    let u = rand() * tot;
    for (let i = 0; i < k; i++) { u -= w[i]; if (u <= 0) return i; }
    return k - 1;
  };
  const h = (min, type) => Math.pow(Math.min(min > 0 ? min : 90, CAP[type]) / 180, I.alpha);
  // ranking values per round type (core wants int16 per player and game, 64 = one rating step at 3 h)
  const valueFor = type => G.map(g => g.eff.map(e => Math.round(64 * e * h(g.typDur, type))));
  const VAL = [valueFor(SHORT), valueFor(DAY), valueFor(EVE)];
  // the per-game part of the solver input only depends on the round type: build it once
  const BLOCK = VAL.map(val => Int32Array.from(G.flatMap((g, gi) => [g.mask, g.explainers.length, ...g.explainers,
    g.banned.length, ...g.banned, 0, g.dur.length, ...g.dur, ...g.dur, ...g.rating, ...val[gi]])));
  const t0 = Date.now();

  const step = () => {
    const until = Date.now() + 150;
    while (Date.now() < until && !stop && n < I.maxWeekends) {
      const seq = weekend(rand, I);
      const played = new Uint8Array(nG);
      for (const r of seq) {
        const att = r.present;
        if (att.length < 2) continue;
        const attSet = new Set(att);
        const excl = [];
        G.forEach((g, gi) => {
          if (G[gi].out || played[gi] || (I.ownerRule && g.owners.length && !g.owners.some(p => attSet.has(p)))) excl.push(gi);
        });
        const head = [nP, nG, I.maxTables, I.minRating, I.blankAsZero, I.needExplainer, I.minPerTable, I.strict === Infinity ? 1 : I.topK, 1, 0, 20, 0, 250, 0, MAXDUR[r.type], att.length, ...att];
        const block = BLOCK[r.type], len = head.length + nP + block.length + 2 + excl.length;
        const buf = new Int32Array(len);
        buf.set(head, 0); buf.set(block, head.length + nP);
        let o = head.length + nP + block.length; buf[o++] = excl.length; buf.set(excl, o); o += excl.length; buf[o] = 0;
        const res = JSON.parse(M.ccall('solve_buf', 'string', ['array', 'number'], [new Uint8Array(buf.buffer), len]));
        rounds++;
        const combos = res.combos ?? [];
        if (!combos.length) { fails++; continue; }
        const st = combos[pick(combos.length)].seatings[0];
        for (const t of st.tables) played[t.g] = 1;
      }
      played.forEach((v, gi) => { if (v) cnt[gi]++; });
      n++;
    }
    postMessage({ type: 'progress', n, fails, rounds, cnt: Array.from(cnt), ms: Date.now() - t0 });
    if (!stop && n < I.maxWeekends) setTimeout(step, 0);
    else postMessage({ type: 'done', n });
  };
  step();
}

// Rounds of one simulated weekend: [{ type, present: [player idx] }]
function weekend(rand, I) {
  for (let tries = 0; tries < 50; tries++) {
    const seq = [];
    const pres = slot => I.players.filter(p => {
      const v = slot.present[p];
      return v === 1 ? rand() < 0.95 : v === 0 ? rand() < 0.05 : rand() < 0.5;
    });
    for (const day of I.days) {
      const longs = day.filter(s => s.to - s.from > 150), shorts = day.filter(s => s.to - s.from <= 150);
      let pick = longs;
      if (longs.length > 2) {
        // drop one long slot: morning 60 %, afternoon 20 %, evening 20 %
        const u = rand(), drop = u < 0.6 ? 0 : u < 0.8 ? 1 : 2;
        pick = longs.filter((_, i) => i !== Math.min(drop, longs.length - 1));
      }
      for (const s of shorts) if (rand() < 0.5) seq.push({ type: SHORT, present: pres(s) });
      pick.forEach((s, i) => {
        seq.push({ type: s.from >= 17 * 60 ? EVE : DAY, present: pres(s) });
        if (i < pick.length - 1 && rand() < 0.6) seq.push({ type: SHORT, present: pres(pick[i + 1]) });
      });
    }
    if (seq.length >= 5 && seq.length <= 7) return seq;
    if (tries === 49) return seq;
  }
}
