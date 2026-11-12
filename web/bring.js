// "What to bring": how often each game would actually get played, over many simulated weekends.
// Simulation in simworker.js; here: inputs, intervals and the list.
// ctx from app.js: { model, bgg, state, status, bansOf, gName, esc, hasExplainers, timeData, estimate, sheetId }
const $ = s => document.querySelector(s);
let snapModel = null;
let ctx, workers = [], parts = [], running = false, stale = false, lastDraw = 0, snap = null, schedule, input = null, tables = 3;

const CUT = 0.1;   // worth bringing: played at least once every 10 weekends
const ZONE = [0.07, 0.13];   // close enough to the line that the side doesn't matter: "borderline"
// verdict per game from its 95% interval [lo, hi]
const verdict = ([lo, hi]) => lo >= CUT ? 'bring' : hi < CUT ? 'leave' : lo >= ZONE[0] && hi <= ZONE[1] ? 'border' : 'open';
// knobs for the curious, folded away: how many weekends, how strictly the group follows the ranking,
// how much long games are worth
const SIZES = [[4000, '4,000'], [20000, '20,000'], [Infinity, 'until I stop']];
const ALPHAS = [[0, 'the same as short ones', 'same'], [0.25, 'a bit more', 'a bit'], [0.5, 'more (default)', 'more'], [0.75, 'a lot more', 'a lot'], [1, 'in proportion to their length', '∝ time']];
const STRICT = [[Infinity, 'always #1', '#1 only'], [2, 'strictly', 'strict'], [1, 'mostly', 'mostly'], [0.5, 'loosely (default)', 'loosely'], [0, 'any of them', 'any']];
const TOPK = [[5, 'top 5'], [10, 'top 10 (default)'], [30, 'top 30 (slow)']];
let opts = { size: 4000, alpha: 0.5, strict: 0.5, topK: 10 };
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
  remind();
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
    alpha: opts.alpha, strict: opts.strict, topK: opts.topK, maxWeekends: opts.size,
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
  rows.forEach(r => { r.v = verdict(r.ci); });
  const open = rows.filter(r => r.v === 'open').length, border = rows.filter(r => r.v === 'border').length;
  const out = G.filter((g, i) => input?.games[i]?.out);
  const pct = x => `${(x * 100).toFixed(1)}%`;
  const status = open ? `${open} not decided yet. More weekends will tell.` : `All decided${border ? `, ${border} borderline (right at the line, either way is fine)` : ''}.`;
  return `<p class="br-sum"><b>${nKeep}</b> of ${rows.length} games get played at least once every 10 weekends. <span class="muted">${status}</span></p>
    <ol class="br-list">${rows.map((r, i) => {
      const owner = r.g.bringers.map(p => P[p]).join(', ');
      return `${i === nKeep ? '<li class="br-cut"><span>Below here: played less than once every 10 weekends</span></li>' : ''}
      <li class="br-${r.v}${i >= nKeep ? ' br-low' : ''}">
        <div class="br-top"><span class="br-name">${esc(gName(r.g))}</span><span class="br-val">${r.v === 'open' ? '<span class="br-tag">not sure yet</span>' : r.v === 'border' ? '<span class="br-tag">borderline</span>' : ''}${Math.round(r.p * 100)}%</span></div>
        <div class="br-bar" title="95% interval ${Math.round(r.ci[0] * 100)}–${Math.round(r.ci[1] * 100)}%">
          <i class="br-line" style="left:${pct(CUT)}"></i>
          <i class="br-ci" style="left:${pct(r.ci[0])};width:${pct(r.ci[1] - r.ci[0])}"></i><i class="br-pt" style="left:${pct(r.p)}"></i></div>
        <div class="br-sub muted">${oneIn(r.p)} · ${owner ? esc(owner) : 'no owner listed'}</div>
      </li>`;
    }).join('')}</ol>${out.length ? `<p class="muted small">Left out (⊘): ${out.map(g => esc(gName(g))).join(', ')}</p>` : ''}`;
}
function allDecided() {
  return ctx.model.games.every((g, i) => input?.games[i]?.out || verdict(wilson(snap.cnt[i], snap.n)) !== 'open');
}
function progText(msg = '') {
  if (!snap) return msg || 'Press Start to simulate. It takes about a minute.';
  return `${snap.n.toLocaleString('en')} weekends${running ? '…' : ''} · ${snap.rounds ? Math.round(snap.fails / snap.rounds * 100) : 0}% of rounds without a fitting seating${stale ? ' · settings changed since this run' : ''}${msg ? ` · ${msg}` : ''}`;
}
function update(force = false, msg = '') {
  const now = Date.now();
  if (running && snap?.n >= 200 && now - lastDraw >= 900 && allDecided()) { stopRun(); force = true; msg = msg || 'every game decided'; }
  $('#brRun').textContent = running ? 'Stop' : snap ? 'Start again' : 'Start';
  $('#brRun').classList.toggle('primary', !running);
  $('#brProg').textContent = progText(msg);
  if (!force && now - lastDraw < 900) return;
  lastDraw = now;
  $('#brResults').innerHTML = resultsHtml();
}
const knobSlider = (key, label, list) => {
  const i = Math.max(0, list.findIndex(([v]) => v === opts[key]));
  return `<label class="knob small">${label}: <b id="kv-${key}">${list[i][1]}</b>
    <input type="range" min="0" max="${list.length - 1}" step="1" value="${i}" data-knob="${key}" aria-label="${label}">
    <span class="ticks">${list.map(x => `<span>${x[2]}</span>`).join('')}</span></label>`;
};
function onKnob(e) {
  const key = e.target.dataset.knob, list = key === 'strict' ? STRICT : ALPHAS, [v, l] = list[+e.target.value];
  opts[key] = v; saveOpts();
  $(`#kv-${key}`).textContent = l;
  if (key === 'alpha') { $('#brAlpha').textContent = v; $('#brAlpha1').textContent = (2 * Math.pow(1 / 3, v)).toFixed(1); }
  if (snap) stale = true;
  update();
}
// The settings the simulation uses, so nobody forgets that e.g. "2 only" is still on.
// Non-default ones are highlighted, and Horst Chan points them out once per change.
function settingsInfo() {
  const { state, DEFAULTS: D, gName } = ctx, s = state.set, d = D.set;
  const L = {
    source: { best: 'best player counts', rec: 'recommended player counts', any: 'any player count' },
    minRating: { 2: 'only games rated 2', 1: 'games rated 1 or 2', 0: 'any rating' },
    blanks: { neutral: 'blank = 1 (guess)', zero: 'blank = 0' },
  };
  const items = [
    [L.source[s.source], s.source !== d.source],
    [L.minRating[s.minRating], +s.minRating !== +d.minRating],
    [L.blanks[s.blanks], s.blanks !== d.blanks],
    [`smallest table ${s.minPerTable}`, +s.minPerTable !== +d.minPerTable],
    [s.explainer ? 'explainer at the table' : 'no explainer needed', s.explainer !== d.explainer],
    [s.owner ? 'owner must be there' : 'owner may be away', s.owner !== d.owner],
  ];
  const nOut = state.excluded.length, nBans = Object.values(state.bans ?? {}).reduce((t, a) => t + a.length, 0);
  if (nOut) items.push([`⊘ ${nOut} game${nOut > 1 ? 's' : ''} left out`, true]);
  if (nBans) items.push([`✕ ${nBans} “never” pick${nBans > 1 ? 's' : ''}`, true]);
  const changed = items.filter(x => x[1]).map(x => x[0]);
  return { items, changed, sig: changed.join('|') };
}
function settingsHtml() {
  const { esc } = ctx, { items } = settingsInfo();
  return `<div class="br-set"><span class="muted small">Uses your settings:</span>
    ${items.map(([t, ch]) => `<span class="br-chip${ch ? ' ch' : ''}">${esc(t)}</span>`).join('')}
    <span class="muted small br-not">Not used here: who's playing (the schedule decides), pins, time slot, finish-within, picky.</span></div>`;
}
let remindedSig = '';
function remind() {
  const { changed, sig } = settingsInfo();
  if (!changed.length || sig === remindedSig) return;
  remindedSig = sig;
  setTimeout(() => ctx.horstSay(`Heads-up! 🧳 uses your settings, and some aren't the usual ones: <b>${changed.map(ctx.esc).join(', ')}</b>. Is that what you want? 💙`), 400);
}
export function onSettings() {
  const box = $('#brSet');
  if (!box) return;
  box.innerHTML = settingsHtml();
  if (snap) stale = true;
  update();
  remind();
}
function renderShell() {
  const { esc } = ctx;
  const sch = schedule?.slots?.length
    ? `${schedule.slots.length} time slots from “${esc(schedule.tab ?? 'schedule')}”`
    : 'no schedule found: everyone, Friday evening plus two full days';
  $('#bringBody').innerHTML = `
    <p class="small">How often each game would actually get played, over thousands of simulated weekends with everything on the shelf. Games that hardly ever make it to the table can stay at home.</p>
    <div id="brSet">${settingsHtml()}</div>
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
        <li><b>The thin line</b> on each bar is the cutoff: once every 10 weekends. <b>Not sure yet</b> means the band still crosses the line. <b>Borderline</b> means it sits right at the line (between 7 and 13%): either way is fine, so we stop asking. The simulation stops by itself once every game is decided.</li>
        <li><b>Below the dashed line:</b> games that hardly ever make it to the table, even though they were there every time. Something else was always a better fit.</li>
        <li><b>Similar games share their plays:</b> two near-twins at 25% each means one of the two gets played about half the time.</li>
      </ul>
    </details>
    <details class="br-how"><summary>How the simulation works</summary>
      <ul class="small">
        <li><b>Schedule:</b> ${sch}. Each simulated weekend has 5–7 rounds: per day two long slots, with a short party/filler round in between most of the time.</li>
        <li><b>Who's there:</b> as in the schedule, with surprises: 5% of people come or go unexpectedly, blanks are 50/50.</li>
        <li><b>Games:</b> all of them are there (except ⊘). Each game is played at most once per weekend.</li>
        <li><b>Each round:</b> the 10 best seatings (knob: 5 / 10 / 30) for whoever is there, with your settings (player counts, ratings, explainer, owner present). The group doesn't always take #1: one is picked at random, the higher the more likely (#1 twice as likely as #2, three times as likely as #3, … with the default knob).</li>
        <li><b>Ranking:</b> each seat is worth its rating × (hours / 3)<sup>α</sup>, now α = <span id="brAlpha">${opts.alpha}</span>: a 2 in a 3-hour game is 2 points, in a 1-hour game <span id="brAlpha1">${(2 * Math.pow(1 / 3, opts.alpha)).toFixed(1)}</span>. Short rounds count up to 1½ h and only fit games up to 2 h; day slots count up to 5 h; evenings have no limit.</li>
        <li><b>Intervals:</b> Wilson 95% intervals for each share.</li>
      </ul>
    </details>
    <details class="br-how br-knobs"><summary>Knobs</summary>
      <label class="field small">Weekends to simulate
        <div class="seg">${SIZES.map(([v, l]) => `<button type="button" data-size="${v}" aria-pressed="${opts.size === v}">${l}</button>`).join('')}</div>
      </label>
      <label class="field small">The group picks from the
        <div class="seg">${TOPK.map(([v, l]) => `<button type="button" data-topk="${v}" aria-pressed="${opts.topK === v}">${l}</button>`).join('')}</div>
      </label>
      ${knobSlider('strict', 'The group follows the ranking', STRICT)}
      ${knobSlider('alpha', 'Compared with short games, long games are worth', ALPHAS)}
      <p class="muted small">Changes apply to the next run.</p>
    </details>`;
  document.querySelectorAll('#bringBody [data-knob]').forEach(r => r.addEventListener('input', onKnob));
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
  if (b.dataset.topk) {
    opts.topK = +b.dataset.topk; saveOpts();
    b.parentElement.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
    knob(); return true;
  }
  if (b.dataset.bt) {
    tables = Math.max(1, Math.min(8, tables + +b.dataset.bt));
    $('#brTables').textContent = tables;
    knob(); return true;
  }
  return false;
}
