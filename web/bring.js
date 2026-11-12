// "What to bring": how often each game would actually get played, over many simulated weekends.
// Simulation in simworker.js; here: inputs, intervals and the list.
// ctx from app.js: { model, bgg, state, status, bansOf, gName, esc, hasExplainers, timeData, estimate, sheetId }
const $ = s => document.querySelector(s);
let snapModel = null;
let ctx, workers = [], parts = [], running = false, stale = false, lastDraw = 0, snap = null, schedule, input = null, tables = 3;

const CUT = 0.1;   // worth bringing: played at least once every 10 weekends
// knobs for the curious, folded away: how many weekends, how strictly the group follows the ranking,
// how much long games are worth
const SIZES = [[4000, '4,000'], [20000, '20,000'], [Infinity, 'until I stop']];
const ALPHAS = [[0, 'same as short'], [0.25, 'a bit more'], [0.5, 'more (default)'], [0.75, 'a lot more'], [1, 'in proportion to time']];
const STRICT = [[Infinity, 'always #1'], [2, 'strictly'], [1, 'mostly (default)'], [0.5, 'loosely'], [0, 'any of the top 30']];
let opts = { size: 4000, alpha: 0.5, strict: 1 };
try { opts = { ...opts, ...JSON.parse(localStorage.getItem('bgt:bringOpts')) }; if (opts.size === null) opts.size = Infinity; if (opts.strict === null) opts.strict = Infinity; } catch {}
const saveOpts = () => { try { localStorage.setItem('bgt:bringOpts', JSON.stringify(opts)); } catch {} };   // Infinity → null

export async function openBring(c) {
  ctx = c;
  if (schedule === undefined) {
    try { schedule = c.sheetId ? await (await fetch('data/schedule.json', { cache: 'no-cache' })).json() : null; } catch { schedule = null; }
  }
  if (snap && snapModel !== c.model) { stopRun(); snap = null; }   // other tab or reloaded data: old result no longer fits
  if (!snap) tables = c.state.maxTables;
  renderShell();
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
    alpha: opts.alpha, strict: opts.strict, maxWeekends: opts.size,
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
  running = true; parts = []; snap = null; snapModel = ctx.model;
  let done = 0;
  for (let k = 0; k < NW; k++) {
    const w = new Worker('simworker.js');
    w.onmessage = ({ data }) => {
      if (data.type === 'progress') { parts[k] = data; snap = merge(parts); update(); }
      if (data.type === 'done' && ++done === NW) { running = false; update(true); }
    };
    w.onerror = e => { stopRun(); update(true, `The simulation stopped: ${e.message ?? 'unknown error'}`); };
    w.postMessage({ type: 'run', input: { ...input, seed: input.seed + 7919 * k, maxWeekends: Math.ceil(opts.size / NW) } });
    workers.push(w);
  }
  stale = false;
  update(true);
}
function stopRun() { workers.forEach(w => w.terminate()); workers = []; running = false; }
function merge(ps) {
  ps = ps.filter(Boolean);
  const s = { n: 0, fails: 0, rounds: 0, cnt: new Array(ps[0].cnt.length).fill(0) };
  for (const p of ps) { s.n += p.n; s.fails += p.fails; s.rounds += p.rounds; p.cnt.forEach((v, i) => { s.cnt[i] += v; }); }
  return s;
}
// Wilson 95% interval for a share: sensible near 0 % and 100 %
function wilson(k, n) {
  if (!n) return [0, 1];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const oneIn = p => p >= 0.95 ? 'almost every weekend' : p <= 0 ? 'never' : p >= 0.5 ? `${Math.round(p * 10)} in 10 weekends` : `1 in ${Math.round(1 / p)} weekends`;

// The page frame is drawn once; while the simulation runs only the progress line, the button and
// the list change (at most about once a second), so buttons and open folds stay put.
function resultsHtml() {
  const { model, esc, gName } = ctx, G = model.games, P = model.players;
  if (!snap) return '';
  if (snap.n < 30) return '<p class="muted">Simulating…</p>';
  const rows = G.map((g, i) => ({ g, k: snap.cnt[i], out: input?.games[i]?.out }))
    .filter(r => !r.out).map(r => ({ ...r, p: r.k / snap.n, ci: wilson(r.k, snap.n) }))
    .sort((a, b) => b.p - a.p || gName(a.g).localeCompare(gName(b.g)));
  const nKeep = rows.filter(r => r.p >= CUT).length;
  const unsure = rows.filter(r => r.ci[0] < CUT && r.ci[1] >= CUT).length;
  const out = G.filter((g, i) => input?.games[i]?.out);
  const pct = x => `${(x * 100).toFixed(1)}%`;
  return `<p class="br-sum"><b>${nKeep}</b> of ${rows.length} games get played at least once every 10 weekends.${unsure ? ` <span class="muted">${unsure} still too close to call, more weekends will tell.</span>` : ''}</p>
    <ol class="br-list">${rows.map((r, i) => {
      const owner = r.g.bringers.map(p => P[p]).join(', ');
      const close = r.ci[0] < CUT && r.ci[1] >= CUT;
      return `${i === nKeep ? '<li class="br-cut"><span>Below here: played less than once every 10 weekends</span></li>' : ''}
      <li class="${i >= nKeep ? 'br-low' : ''}">
        <div class="br-top"><span class="br-name">${esc(gName(r.g))}</span><span class="br-val">${Math.round(r.p * 100)}%${close ? ' <span class="muted" title="Too close to the line to call yet">?</span>' : ''}</span></div>
        <div class="br-bar" title="95% interval ${Math.round(r.ci[0] * 100)}–${Math.round(r.ci[1] * 100)}%">
          <i class="br-line" style="left:${pct(CUT)}"></i>
          <i class="br-ci" style="left:${pct(r.ci[0])};width:${pct(r.ci[1] - r.ci[0])}"></i><i class="br-pt" style="left:${pct(r.p)}"></i></div>
        <div class="br-sub muted">${oneIn(r.p)} · ${owner ? esc(owner) : 'no owner listed'}</div>
      </li>`;
    }).join('')}</ol>${out.length ? `<p class="muted small">Left out (⊘): ${out.map(g => esc(gName(g))).join(', ')}</p>` : ''}`;
}
function progText(msg = '') {
  if (!snap) return msg || 'Press Start to simulate. It takes about a minute.';
  return `${snap.n.toLocaleString('en')} weekends${running ? '…' : ''} · ${snap.rounds ? Math.round(snap.fails / snap.rounds * 100) : 0}% of rounds without a fitting seating${stale ? ' · settings changed since this run' : ''}${msg ? ` · ${msg}` : ''}`;
}
function update(force = false, msg = '') {
  const now = Date.now();
  $('#brRun').textContent = running ? 'Stop' : snap ? 'Start again' : 'Start';
  $('#brRun').classList.toggle('primary', !running);
  $('#brProg').textContent = progText(msg);
  if (!force && now - lastDraw < 900) return;
  lastDraw = now;
  $('#brResults').innerHTML = resultsHtml();
}
function renderShell() {
  const { esc } = ctx;
  const sch = schedule?.slots?.length
    ? `${schedule.slots.length} time slots from “${esc(schedule.tab ?? 'schedule')}”`
    : 'no schedule found: everyone, Friday evening plus two full days';
  $('#bringBody').innerHTML = `
    <p class="small">How often each game would actually get played, over thousands of simulated weekends with everything on the shelf. Games that hardly ever make it to the table can stay at home.</p>
    <div class="br-ctl">
      <span>Up to</span><span class="stepper"><button type="button" data-bt="-1" aria-label="Fewer tables">−</button><output id="brTables">${tables}</output><button type="button" data-bt="1" aria-label="More tables">+</button></span><span>tables a round</span>
      <button type="button" id="brRun" class="ghost-btn"></button>
    </div>
    <p class="muted small" id="brProg"></p>
    <div id="brResults"></div>
    <details class="br-how"><summary>How to read this</summary>
      <ul class="small">
        <li><b>The percentage</b> is the share of simulated weekends in which the game got played. 20% = about one weekend in five.</li>
        <li><b>The bar:</b> the dot is that share. The band around it shows how sure we are: the true value is very likely (95 %) inside it. The more weekends are simulated, the narrower it gets.</li>
        <li><b>The thin line</b> on each bar is the cutoff: once every 10 weekends. A <b>?</b> means the band still crosses the line, so it's too close to call yet. Keep simulating.</li>
        <li><b>Below the dashed line:</b> games that hardly ever make it to the table, even though they were there every time. Something else was always a better fit.</li>
        <li><b>Similar games share their plays:</b> two near-twins at 25% each means one of the two gets played about half the time.</li>
      </ul>
    </details>
    <details class="br-how"><summary>How the simulation works</summary>
      <ul class="small">
        <li><b>Schedule:</b> ${sch}. Each simulated weekend has 5–7 rounds: per day two long slots, with a short party/filler round in between most of the time.</li>
        <li><b>Who's there:</b> as in the schedule, with surprises: 5% of people come or go unexpectedly, blanks are 50/50.</li>
        <li><b>Games:</b> all of them are there (except ⊘). Each game is played at most once per weekend.</li>
        <li><b>Each round:</b> the 30 best seatings for whoever is there, with your settings (player counts, ratings, explainer, owner present). The group doesn't always take #1: one is picked at random, the higher the more likely (#1 twice as likely as #2, three times as likely as #3, … with the default knob).</li>
        <li><b>Ranking:</b> each seat is worth its rating × (hours / 3)<sup>α</sup>, now α = <span id="brAlpha">${opts.alpha}</span>: a 2 in a 3-hour game is 2 points, in a 1-hour game <span id="brAlpha1">${(2 * Math.pow(1 / 3, opts.alpha)).toFixed(1)}</span>. Short rounds count up to 1½ h and only fit games up to 2 h; day slots count up to 5 h; evenings have no limit.</li>
        <li><b>Intervals:</b> Wilson 95% intervals for each share.</li>
      </ul>
    </details>
    <details class="br-how br-knobs"><summary>Knobs</summary>
      <label class="field small">Weekends to simulate
        <div class="seg">${SIZES.map(([v, l]) => `<button type="button" data-size="${v}" aria-pressed="${opts.size === v}">${l}</button>`).join('')}</div>
      </label>
      <label class="field small">The group follows the ranking
        <div class="seg seg-wrap">${STRICT.map(([v, l]) => `<button type="button" data-strict="${v}" aria-pressed="${opts.strict === v}">${l}</button>`).join('')}</div>
      </label>
      <label class="field small">Compared with short games, long games are worth
        <div class="seg seg-wrap">${ALPHAS.map(([v, l]) => `<button type="button" data-alpha="${v}" aria-pressed="${opts.alpha === v}">${l}</button>`).join('')}</div>
      </label>
      <p class="muted small">Changes apply to the next run.</p>
    </details>`;
  update(true);
}

export function onBringClick(e) {
  const b = e.target.closest('button');
  if (!b || !b.closest('#bringView')) return false;
  if (b.id === 'brRun') { if (running) { stopRun(); update(true); } else start(); return true; }
  const knob = () => { if (snap) stale = true; update(); };
  if (b.dataset.size) {
    opts.size = +b.dataset.size; saveOpts();
    b.parentElement.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
    knob(); return true;
  }
  if (b.dataset.strict) {
    opts.strict = +b.dataset.strict; saveOpts();
    b.parentElement.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
    knob(); return true;
  }
  if (b.dataset.alpha) {
    opts.alpha = +b.dataset.alpha; saveOpts();
    b.parentElement.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
    $('#brAlpha').textContent = opts.alpha; $('#brAlpha1').textContent = (2 * Math.pow(1 / 3, opts.alpha)).toFixed(1);
    knob(); return true;
  }
  if (b.dataset.bt) {
    tables = Math.max(1, Math.min(8, tables + +b.dataset.bt));
    $('#brTables').textContent = tables;
    knob(); return true;
  }
  return false;
}
