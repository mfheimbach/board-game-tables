// "What to bring": ranks every game by how much bringing it adds to a simulated weekend.
// Simulation in simworker.js; here: inputs, regression, and the list.
// ctx from app.js: { model, bgg, state, status, bansOf, gName, esc, hasExplainers, timeData, estimate, sheetId }
const $ = s => document.querySelector(s);
let ctx, workers = [], parts = [], running = false, snap = null, schedule, input = null, tables = 3;

const MAX_WEEKENDS = 4000;
const P_BRING = 0.5, ALPHA = 0.5;

export async function openBring(c) {
  ctx = c;
  if (schedule === undefined) {
    try { schedule = c.sheetId ? await (await fetch('data/schedule.json', { cache: 'no-cache' })).json() : null; } catch { schedule = null; }
  }
  snap = null; tables = c.state.maxTables;
  render();
  start();
}
export function closeBring() { stopRun(); }

function days() {
  const P = ctx.model.players;
  const idx = new Map(P.map((n, i) => [n.trim().toLowerCase(), i]));
  if (schedule?.slots?.length) {
    const by = [];
    for (const s of schedule.slots) {
      const present = P.map(() => null);
      for (const [n, v] of Object.entries(s.present)) { const i = idx.get(n.trim().toLowerCase()); if (i !== undefined) present[i] = v; }
      if (!by.length || by.at(-1).day !== s.day) by.push({ day: s.day, slots: [] });
      by.at(-1).slots.push({ from: s.from, to: s.to, present });
    }
    return by.map(d => d.slots);
  }
  // no schedule: everyone, Friday evening + two full days
  const all = P.map(() => 1), sl = (f, t) => ({ from: f * 60, to: t * 60, present: all });
  return [[sl(18, 22)], [sl(10, 14), sl(14, 18), sl(18, 22)], [sl(10, 14), sl(14, 18), sl(18, 22)]];
}

function buildInput() {
  const { model, state, status, bansOf, hasExplainers, timeData, estimate } = ctx, s = state.set;
  const P = model.players, pm = new Map(P.map((n, i) => [n, i]));
  const nd = Math.min(32, P.length + 1);
  return {
    seed: (Math.random() * 2 ** 31) | 0,
    nPlayers: P.length, players: P.map((_, i) => i), days: days(),
    maxTables: tables, minRating: +s.minRating, blankAsZero: s.blanks === 'zero' ? 1 : 0,
    needExplainer: s.explainer && hasExplainers() ? 1 : 0, minPerTable: +s.minPerTable, ownerRule: !!s.owner,
    pBring: P_BRING, alpha: ALPHA, maxWeekends: MAX_WEEKENDS,
    games: model.games.map(g => {
      const counts = status(g, new Set(P.map((_, i) => i))).counts;
      const d = timeData(g);
      const dur = Array.from({ length: nd }, (_, k) => k ? Math.round(estimate(d, k, false)?.total ?? 0) : 0);
      const typ = counts[Math.floor((counts.length - 1) / 2)] ?? 4;
      return {
        mask: counts.reduce((m, k) => m | (1 << k), 0),
        explainers: g.explainers, banned: bansOf(g.id).map(n => pm.get(n)).filter(i => i !== undefined),
        owners: g.bringers, rating: g.ratings,
        eff: g.ratings.map(r => r < 0 ? (s.blanks === 'zero' ? 0 : 1) : r),
        dur, typDur: dur[Math.min(typ, nd - 1)] || 0,
        out: state.excluded.includes(g.id),
      };
    }),
  };
}

// several workers in parallel, each with its own seed; their sums are simply added up
const NW = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
function start() {
  stopRun();
  input = buildInput();
  running = true; parts = []; snap = null;
  let done = 0;
  for (let k = 0; k < NW; k++) {
    const w = new Worker('simworker.js');
    w.onmessage = ({ data }) => {
      if (data.type === 'progress') { parts[k] = data; snap = merge(parts); render(); }
      if (data.type === 'done' && ++done === NW) { running = false; render(); }
    };
    w.onerror = e => { running = false; render(`The simulation stopped: ${e.message ?? 'unknown error'}`); };
    w.postMessage({ type: 'run', input: { ...input, seed: input.seed + 7919 * k, maxWeekends: Math.ceil(MAX_WEEKENDS / NW) } });
    workers.push(w);
  }
  render();
}
function stopRun() { workers.forEach(w => w.terminate()); workers = []; running = false; }
function merge(ps) {
  ps = ps.filter(Boolean);
  const D = ps[0].D, s = { D, n: 0, XtX: new Float64Array(D * D), Xty: new Float64Array(D), yy: 0, fails: 0, rounds: 0,
    used: new Array(ps[0].used.length).fill(0), brought: new Array(ps[0].used.length).fill(0) };
  for (const p of ps) {
    s.n += p.n; s.yy += p.yy; s.fails += p.fails; s.rounds += p.rounds;
    for (let i = 0; i < D * D; i++) s.XtX[i] += p.XtX[i];
    for (let i = 0; i < D; i++) s.Xty[i] += p.Xty[i];
    p.used.forEach((v, i) => { s.used[i] += v; s.brought[i] += p.brought[i]; });
  }
  return s;
}

// OLS from accumulated X'X, X'y. Columns that never vary (left-out games) are dropped.
function ols(S) {
  const D = S.D, n = S.n;
  const keep = [];
  for (let a = 0; a < D; a++) { const s = S.XtX[a * D + a]; if (a === 0 || (s > 0 && s < n)) keep.push(a); }
  const k = keep.length;
  const A = keep.map(a => keep.map(b => S.XtX[a * D + b])), b = keep.map(a => S.Xty[a]);
  const inv = invert(A);
  if (!inv) return null;
  const beta = inv.map(row => row.reduce((s, v, j) => s + v * b[j], 0));
  const rss = S.yy - beta.reduce((s, v, j) => s + v * b[j], 0);
  const sigma2 = Math.max(0, rss) / Math.max(1, n - k);
  const out = new Array(D).fill(null);
  keep.forEach((a, i) => { out[a] = { b: beta[i], se: Math.sqrt(sigma2 * inv[i][i]) }; });
  return out;
}
function invert(A) {
  const n = A.length, M = A.map((r, i) => [...r, ...r.map((_, j) => i === j ? 1 : 0)]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-9) return null;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c]; for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; if (f) for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map(r => r.slice(n));
}

function render(msg = '') {
  const { model, esc, gName } = ctx, G = model.games, P = model.players;
  const sch = schedule?.slots?.length
    ? `${schedule.slots.length} time slots from “${esc(schedule.tab ?? 'schedule')}”`
    : 'no schedule found: everyone, Friday evening plus two full days';
  let list = '<p class="muted">Simulating…</p>', head = '';
  if (snap?.n >= 60) {
    const est = ols(snap);
    if (est) {
      const rows = G.map((g, i) => ({ g, e: est[1 + i], used: snap.used[i] / Math.max(1, snap.brought[i]) }))
        .filter(r => r.e).sort((a, b) => b.e.b - a.e.b);
      const max = Math.max(...rows.map(r => r.e.b + 1.96 * r.e.se), 0.01);
      const cut = rows.findIndex(r => r.e.b - 1.96 * r.e.se <= 0);
      const nKeep = cut < 0 ? rows.length : cut;
      const out = G.filter((g, i) => !est[1 + i]);
      const pct = x => `${Math.max(0, Math.min(100, x / max * 100))}%`;
      head = `<p class="br-sum"><b>${nKeep}</b> of ${rows.length} games make a measurable difference.</p>`;
      list = `<ol class="br-list">${rows.map((r, i) => {
        const lo = r.e.b - 1.96 * r.e.se, hi = r.e.b + 1.96 * r.e.se;
        const owner = r.g.bringers.map(p => P[p]).join(', ');
        return `${i === nKeep ? '<li class="br-cut"><span>Below here: no measurable benefit</span></li>' : ''}
        <li class="${i >= nKeep ? 'br-low' : ''}">
          <div class="br-top"><span class="br-name">${esc(gName(r.g))}</span><span class="br-val">${r.e.b.toFixed(1)}</span></div>
          <div class="br-bar" title="95% interval ${lo.toFixed(1)} to ${hi.toFixed(1)}">
            <i class="br-ci" style="left:${pct(lo)};width:calc(${pct(hi)} - ${pct(lo)})"></i><i class="br-pt" style="left:${pct(r.e.b)}"></i></div>
          <div class="br-sub muted">${owner ? esc(owner) : 'no owner listed'} · played in ${Math.round(r.used * 100)}% of weekends it's there</div>
        </li>`;
      }).join('')}</ol>${out.length ? `<p class="muted small">Left out (⊘): ${out.map(g => esc(gName(g))).join(', ')}</p>` : ''}`;
    }
  }
  const prog = snap ? `${snap.n.toLocaleString('en')} weekends${running ? '…' : ''} · ${snap.rounds ? Math.round(snap.fails / snap.rounds * 100) : 0}% of rounds without a fitting seating` : '';
  $('#bringBody').innerHTML = `
    <p class="small">How many points a game adds to the weekend just by being there. It's a bit like asking “what if we left it at home?”, tried over thousands of simulated weekends.</p>
    <div class="br-ctl">
      <span>Up to</span><span class="stepper"><button type="button" data-bt="-1" aria-label="Fewer tables">−</button><output>${tables}</output><button type="button" data-bt="1" aria-label="More tables">+</button></span><span>tables a round</span>
      <button type="button" id="brRun" class="ghost-btn">${running ? 'Stop' : 'Run again'}</button>
    </div>
    <p class="muted small">${prog}${msg ? ` · ${esc(msg)}` : ''}</p>
    ${head}
    ${list}
    <details class="br-how"><summary>How this works</summary>
      <ul class="small">
        <li><b>Schedule:</b> ${sch}. Each simulated weekend has 5–7 rounds: per day two long slots, with a short party/filler round in between most of the time.</li>
        <li><b>Who's there:</b> as in the schedule, with surprises: 5% of people come or go unexpectedly, blanks are 50/50.</li>
        <li><b>Games:</b> each weekend, every game is there or not at random (50/50). Each game is played at most once per weekend.</li>
        <li><b>Each round:</b> the best seating for whoever is there, with your settings (player counts, ratings, explainer, owner present, ⊘).</li>
        <li><b>Points:</b> each seat is worth its rating × (hours / 3)<sup>½</sup>: a 2 in a 3-hour game is 2 points, in a 1-hour game 1.2. Short rounds count up to 1½ h and only fit games up to 2 h; day slots count up to 5 h; evenings have no limit.</li>
        <li><b>Score:</b> a regression of weekend points on which games were there. A game's number is the points it adds on average, whatever else is there. The bar is the 95% interval: the dot is the estimate, the band how sure it is. More weekends make it narrower.</li>
        <li><b>Cutoff:</b> once the band touches 0, bringing the game makes no measurable difference.</li>
      </ul>
    </details>`;
}

export function onBringClick(e) {
  const b = e.target.closest('button');
  if (!b || !b.closest('#bringView')) return false;
  if (b.id === 'brRun') { if (running) { stopRun(); render(); } else start(); return true; }
  if (b.dataset.bt) {
    tables = Math.max(1, Math.min(8, tables + +b.dataset.bt));
    start(); return true;
  }
  return false;
}
