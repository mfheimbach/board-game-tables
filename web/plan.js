// Weekend planner: all rounds at once as one integer program (solved with HiGHS).
//
// Who plays what in which round, so that
//   1. the worst-off person does as well as possible (average rating per round they're there), then
//   2. the weekend has as many points as possible = as few 1s as possible (seats are fixed), then
//   3. as few guessed (blank) ratings as possible, then
//   4. as few different games as possible (what actually needs to be brought).
// Rules: everyone present sits once per round; one copy per game, so one table per game per round;
// nobody plays the same game twice; table sizes from the allowed player counts; at most maxTables
// tables per round; with the explainer rule, someone who can explain sits at the table.
//
// input = {
//   nPlayers, rounds: [[player idx present]...], maxTables, minPerTable, minRating, fair,
//   games: [{ counts: [k...], pts: [per player: 0/1/2], guess: [per player: 0/1], banned: Set,
//             explainers: [idx] | null (null = no explainer needed), off: Set(round idx) }]
// }

const v = (...a) => a.join('_');

export function buildLP(I, { fixMin } = {}) {
  const R = I.rounds.length, G = I.games;
  const present = I.rounds.map(r => new Set(r));
  const X = [];                 // [p, g, r]
  const Y = [];                 // [g, r, lo, hi]: game g is set up in round r with lo..hi players
  for (let r = 0; r < R; r++)
    G.forEach((g, gi) => {
      if (g.off?.has(r)) return;
      const n = present[r].size;
      const ks = [...new Set(g.counts)].filter(k => k >= I.minPerTable && k <= n).sort((a, b) => a - b);
      if (!ks.length) return;
      if (g.explainers && !g.explainers.some(p => present[r].has(p))) return;
      const ps = I.rounds[r].filter(p => g.pts[p] >= I.minRating && !g.banned?.has(p));
      if (ps.length < ks[0]) return;
      ps.forEach(p => X.push([p, gi, r]));
      // split the allowed counts into contiguous ranges (usually just one)
      let lo = ks[0];
      ks.forEach((k, i) => { if (ks[i + 1] !== k + 1) { if (lo <= ps.length) Y.push([gi, r, lo, Math.min(k, ps.length)]); lo = ks[i + 1]; } });
    });

  const rows = [];
  const sum = terms => terms.map(([c, n]) => `${c >= 0 ? '+' : '-'} ${Math.abs(c)} ${n}`).join(' ');
  const by = (arr, key) => arr.reduce((m, e) => { const k = key(e); (m[k] ??= []).push(e); return m; }, {});
  const xBySeat = by(X, ([p, , r]) => v(p, r));
  const xByTable = by(X, ([, g, r]) => v(g, r));
  const yByTable = by(Y, ([g, r]) => v(g, r));
  const xByPG = by(X, ([p, g]) => v(p, g));
  const xByP = by(X, ([p]) => p);
  const yByR = by(Y, ([, r]) => r);
  const xn = ([p, g, r]) => `x${v(p, g, r)}`, yn = ([g, r, lo]) => `y${v(g, r, lo)}`;

  const unseatable = [];
  I.rounds.forEach((ps, r) => ps.forEach(p => {
    const xs = xBySeat[v(p, r)];
    if (!xs) unseatable.push([p, r]);
    else rows.push(`seat${v(p, r)}: ${sum(xs.map(e => [1, xn(e)]))} = 1`);
  }));
  for (const [key, ys] of Object.entries(yByTable)) {
    const xs = xByTable[key] ?? [];
    rows.push(`smin${key}: ${sum([...xs.map(e => [1, xn(e)]), ...ys.map(e => [-e[2], yn(e)])])} >= 0`);
    rows.push(`smax${key}: ${sum([...xs.map(e => [1, xn(e)]), ...ys.map(e => [-e[3], yn(e)])])} <= 0`);
    if (ys.length > 1) rows.push(`copy${key}: ${sum(ys.map(e => [1, yn(e)]))} <= 1`);
    const ex = G[ys[0][0]].explainers;
    if (ex) {
      const xe = xs.filter(([p]) => ex.includes(p));
      rows.push(`expl${key}: ${sum([...xe.map(e => [1, xn(e)]), ...ys.map(e => [-1, yn(e)])])} >= 0`);
    }
  }
  for (const [key, xs] of Object.entries(xByPG)) if (xs.length > 1) rows.push(`once${key}: ${sum(xs.map(e => [1, xn(e)]))} <= 1`);
  for (const [r, ys] of Object.entries(yByR)) rows.push(`tables${r}: ${sum(ys.map(e => [1, yn(e)]))} <= ${I.maxTables}`);
  // Rounds with the same people are interchangeable; fix their order by the game one person plays
  // (strictly increasing, since nobody plays a game twice). Removes R! equivalent plans.
  for (let r = 0; r + 1 < R; r++) {
    const a = I.rounds[r], b = I.rounds[r + 1];
    if (a.length !== b.length || !a.every(p => present[r + 1].has(p)) || !a.length) continue;
    const p = a[0], A = (xBySeat[v(p, r)] ?? []), B = (xBySeat[v(p, r + 1)] ?? []);
    if (A.length && B.length) rows.push(`order${r}: ${sum([...B.map(e => [e[1] + 1, xn(e)]), ...A.map(e => [-(e[1] + 1), xn(e)])])} >= 1`);
  }
  // z_g = game g gets brought (used in any round)
  const yByG = by(Y, ([g]) => g), Z = Object.keys(yByG).map(Number);
  for (const g of Z) rows.push(`bring${g}: ${sum(yByG[g].map(e => [1, yn(e)]))} - ${R} z${g} <= 0`);

  // fairness: t <= average points per round for everyone; or, in phase 2, keep everyone at that level
  const rounds = Array.from({ length: I.nPlayers }, (_, p) => I.rounds.filter(r => r.includes(p)).length);
  const pts = ([p, g]) => G[g].pts[p];
  for (const [p, xs] of Object.entries(xByP)) {
    const t = xs.filter(e => pts(e) > 0).map(e => [pts(e), xn(e)]);
    if (fixMin == null) rows.push(`fair${p}: ${rounds[p]} t ${t.length ? sum(t.map(([c, n]) => [-c, n])) : ''} <= 0`);
    else { const need = Math.ceil(rounds[p] * fixMin - 1e-6); if (need > 0) rows.push(`fair${p}: ${t.length ? sum(t) : '0 t'} >= ${need}`); }
  }

  const seats = I.rounds.reduce((a, r) => a + r.length, 0), M = seats + 1, M2 = Z.length + 1;
  const obj = fixMin == null && I.fair
    ? '+ 1 t'
    : sum([...X.map(e => [M2 * (M * pts(e) - (G[e[1]].guess[e[0]] ? 1 : 0)), xn(e)]).filter(([c]) => c !== 0),
           ...Z.map(g => [-1, `z${g}`])]) || '0 t';
  const lp = [
    'Maximize', ` obj: ${obj}`,
    'Subject To', ...rows.map(r => ' ' + r),
    'Bounds', ' 0 <= t <= 2',
    'Binary', ...chunk([...X.map(xn), ...Y.map(yn), ...Z.map(g => `z${g}`)], 50).map(c => ' ' + c.join(' ')),
    'End',
  ].join('\n');
  return { lp, X, Y, unseatable, rounds };
}

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

// Solve both phases. highs = loaded highs-js instance. Returns null if infeasible.
export function solvePlan(highs, I, { timeLimit = 20 } = {}) {
  const opts = { time_limit: timeLimit, mip_rel_gap: 0, output_flag: false };
  let minAvg = null, optimal = true;
  if (I.fair) {
    const a = buildLP(I);
    if (a.unseatable.length) return { unseatable: a.unseatable };
    const s1 = highs.solve(a.lp, opts);
    if (!s1.Columns?.t && s1.Status !== 'Optimal') return { status: s1.Status };
    if (s1.Status !== 'Optimal') optimal = false;
    minAvg = s1.Columns.t?.Primal ?? 0;
    // exact level: smallest per-person average that the solution reaches
  }
  const b = buildLP(I, { fixMin: minAvg ?? undefined });
  if (b.unseatable.length) return { unseatable: b.unseatable };
  const s2 = highs.solve(b.lp, opts);
  const cols = s2.Columns ?? {};
  if (!Object.keys(cols).length || /infeasible/i.test(s2.Status)) return { status: s2.Status };
  if (s2.Status !== 'Optimal') optimal = false;
  const on = n => (cols[n]?.Primal ?? 0) > 0.5;
  const plan = I.rounds.map(() => []);
  const tables = {};
  for (const e of b.X) if (on(`x${v(...e)}`)) {
    const [p, g, r] = e;
    (tables[v(g, r)] ??= { g, r, p: [] }).p.push(p);
  }
  for (const t of Object.values(tables)) plan[t.r].push(t);
  return { plan, ...score(I, plan, b.rounds), optimal };
}

export function score(I, plan, rounds) {
  const per = Array.from({ length: I.nPlayers }, () => ({ pts: 0, twos: 0, ones: 0, zeros: 0, guesses: 0 }));
  let total = 0, ones = 0, guesses = 0;
  const nGames = new Set(plan.flat().map(t => t.g)).size;
  plan.forEach(ts => ts.forEach(t => t.p.forEach(p => {
    const s = I.games[t.g].pts[p], q = I.games[t.g].guess[p];
    const o = per[p]; o.pts += s; total += s; guesses += q; o.guesses += q;
    if (s === 2) o.twos++; else if (s === 1) { o.ones++; ones++; } else o.zeros++;
  })));
  let minAvg = Infinity;
  per.forEach((o, p) => { o.rounds = rounds[p]; if (rounds[p]) { o.avg = o.pts / rounds[p]; minAvg = Math.min(minAvg, o.avg); } });
  return { per, total, ones, guesses, nGames, minAvg: Number.isFinite(minAvg) ? minAvg : 0 };
}

// How much each game in the plan matters: plan again without it and see what's lost.
export function importance(highs, I, base, { timeLimit = 8, onProgress } = {}) {
  const used = [...new Set(base.plan.flat().map(t => t.g))];
  const out = [];
  used.forEach((g, i) => {
    onProgress?.(i, used.length);
    const J = { ...I, games: I.games.map((x, gi) => gi === g ? { ...x, off: new Set(I.rounds.map((_, r) => r)) } : x) };
    const s = solvePlan(highs, J, { timeLimit });
    out.push({ g, rounds: base.plan.filter(ts => ts.some(t => t.g === g)).length,
      lostMin: s.plan ? base.minAvg - s.minAvg : Infinity,
      extraOnes: s.plan ? s.ones - base.ones : Infinity,
      lostPts: s.plan ? base.total - s.total : Infinity,
      extraGames: s.plan ? s.nGames - base.nGames : Infinity,
      exact: !!s.optimal });
  });
  return out.sort((a, b) => b.lostMin - a.lostMin || b.lostPts - a.lostPts || b.extraGames - a.extraGames || b.rounds - a.rounds);
}
