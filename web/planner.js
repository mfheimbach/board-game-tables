// Weekend planner page: who's there in which round, then one plan for all rounds (see plan.js).
// ctx comes from app.js: { model, bgg, state, status, bansOf, gName, esc, hasExplainers, attendIdx, key }
const $ = s => document.querySelector(s);
let ctx, ui, worker, busy = false, last = null, imp = null;

const MAXR = 12;
const load = () => { try { return JSON.parse(localStorage.getItem(ctx.key + ':plan')) ?? null; } catch { return null; } };
const store = () => { try { localStorage.setItem(ctx.key + ':plan', JSON.stringify(ui)); } catch {} };

export function openPlanner(c) {
  ctx = c;
  const P = ctx.model.players;
  const here = new Set(ctx.attendIdx().map(i => P[i]));
  ui = load() ?? { rounds: 6, tables: ctx.state.maxTables, fair: true, away: {} };
  // away[name] = [round idx...]; people not selected on the main screen start as away everywhere
  for (const n of P) if (!(n in ui.away)) ui.away[n] = here.has(n) ? [] : Array.from({ length: MAXR }, (_, r) => r);
  last = null; imp = null;
  render();
}
export function closePlanner() { if (worker && busy) { worker.terminate(); worker = null; busy = false; } }

function present(r) { return ctx.model.players.map((n, i) => [n, i]).filter(([n]) => !ui.away[n]?.includes(r)).map(([, i]) => i); }

function input() {
  const { model, state, status, bansOf, hasExplainers } = ctx, s = state.set;
  const rounds = Array.from({ length: ui.rounds }, (_, r) => present(r));
  const pm = new Map(model.players.map((n, i) => [n, i]));
  const explainerRule = s.explainer && hasExplainers();
  return {
    nPlayers: model.players.length, rounds, maxTables: ui.tables, minPerTable: +s.minPerTable, minRating: +s.minRating, fair: ui.fair,
    games: model.games.map(g => {
      const off = state.excluded.includes(g.id) ? rounds.map((_, r) => r)
        : rounds.map((ps, r) => status(g, new Set(ps)).ownerAway ? r : -1).filter(r => r >= 0);
      return {
        counts: status(g).counts,
        pts: g.ratings.map(r => r < 0 ? (s.blanks === 'zero' ? 0 : 1) : r),
        guess: g.ratings.map(r => r < 0 ? 1 : 0),
        banned: bansOf(g.id).map(n => pm.get(n)).filter(i => i !== undefined),
        explainers: explainerRule ? g.explainers : null,
        off,
      };
    }),
  };
}

function run(type, extra = {}) {
  if (busy) return;
  worker ??= new Worker(new URL('planworker.js', import.meta.url), { type: 'module' });
  busy = true;
  const I = input();
  if (type === 'plan') { last = null; imp = null; }
  render(type === 'plan' ? 'Planning… this can take up to a minute.' : 'Checking each game… a few minutes.');
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') { render(`Checking game ${data.i + 1} of ${data.n}…`); return; }
    busy = false;
    if (data.type === 'error') { render(`Something went wrong: ${data.message}`); return; }
    if (type === 'plan') last = { ...data.result, I }; else imp = data.result;
    render();
  };
  worker.onerror = e => { busy = false; render(`Something went wrong: ${e.message ?? 'the planner could not start'}`); };
  worker.postMessage({ type, input: I, ...extra });
}

function render(msg = '') {
  const { model, esc, gName } = ctx, P = model.players;
  const R = ui.rounds;
  const cell = (n, r) => !ui.away[n]?.includes(r);
  const grid = `<div class="pl-grid-wrap"><table class="pl-grid">
    <thead><tr><th></th>${Array.from({ length: R }, (_, r) => `<th><button type="button" data-col="${r}">R${r + 1}</button></th>`).join('')}</tr></thead>
    <tbody>${P.map(n => `<tr><th><button type="button" data-row="${esc(n)}">${esc(n)}</button></th>${Array.from({ length: R }, (_, r) =>
      `<td><button type="button" class="pl-cell" data-n="${esc(n)}" data-r="${r}" aria-pressed="${cell(n, r)}" aria-label="${esc(n)} round ${r + 1}">${cell(n, r) ? '✓' : ''}</button></td>`).join('')}</tr>`).join('')}
    <tr class="pl-count"><th>people</th>${Array.from({ length: R }, (_, r) => `<td>${present(r).length}</td>`).join('')}</tr></tbody></table></div>`;

  let res = '';
  if (last?.unseatable) {
    res = `<div class="empty"><h2>Someone can't be seated</h2><p class="muted">${last.unseatable.slice(0, 6).map(([p, r]) => `${esc(P[p])} in round ${r + 1}`).join(', ')} has no game that fits the rules. Allow "1 or 2" or "anything" ratings, or mark them away.</p></div>`;
  } else if (last && !last.plan) {
    res = `<div class="empty"><h2>No plan found</h2><p class="muted">${last.status === 'Time limit reached' ? 'The planner ran out of time before finding any plan. Try fewer rounds or more tables.' : 'These rounds can\'t all be set up under the current rules. Try more tables per round, "any" player count, or a smaller minimum table.'}</p></div>`;
  } else if (last) {
    const G = model.games, I = last.I;
    const used = new Map();
    last.plan.forEach((ts, r) => ts.forEach(t => used.set(t.g, [...(used.get(t.g) ?? []), r])));
    const bring = [...used].sort((a, b) => b[1].length - a[1].length || gName(G[a[0]]).localeCompare(gName(G[b[0]])));
    const avg = x => (Math.round(x * 100) / 100).toString().replace(/\.0+$/, '');
    res = `
      <div class="pl-sum card">
        <div><b>${last.nGames}</b><span>games to bring</span></div>
        <div><b>${last.ones}</b><span>× a “1”</span></div>
        <div><b>${avg(last.minAvg)}</b><span>worst-off average</span></div>
        <div><b>${last.guesses}</b><span>guessed</span></div>
      </div>
      <p class="muted small">${last.optimal ? '✓ Best possible plan for these rules.' : '≈ Good plan. The planner stopped at its time limit, so a slightly better one (usually: one game fewer to bring) might exist.'}</p>
      <h3>🧳 Bring list</h3>
      <ul class="pl-bring">${bring.map(([g, rs]) => {
        const who = G[g].bringers.map(i => P[i]).join(', ');
        return `<li><span>${esc(gName(G[g]))}</span><span class="muted small">${rs.length}× · ${who ? esc(who) : 'no owner listed'}</span></li>`;
      }).join('')}</ul>
      <div class="btns"><button type="button" id="plImp"${busy ? ' disabled' : ''}>How essential is each game?</button></div>
      ${imp ? impHtml() : ''}
      <h3>🗓 Rounds</h3>
      ${last.plan.map((ts, r) => `<div class="card pl-round"><div class="pl-rh">Round ${r + 1} <span class="muted small">· ${I.rounds[r].length} people</span></div>
        ${ts.sort((a, b) => b.p.length - a.p.length).map(t => `<div class="pl-t"><b>${esc(gName(G[t.g]))}</b><span>${t.p.map(p => {
          const s = I.games[t.g].pts[p], q = I.games[t.g].guess[p];
          return `<span class="pl-p s${s}">${esc(P[p])}${q ? '?' : s === 1 ? '¹' : ''}</span>`;
        }).join(' ')}</span></div>`).join('')}</div>`).join('')}
      <p class="muted small">¹ = rated 1 · ? = no rating, counted as a guess</p>
      <h3>🙋 Per person</h3>
      <table class="pl-people"><thead><tr><th></th><th>2s</th><th>1s</th><th>0s</th><th>?</th></tr></thead><tbody>
      ${last.per.map((o, p) => o.rounds ? `<tr><th>${esc(P[p])}</th><td>${o.twos}</td><td>${o.ones || ''}</td><td>${o.zeros || ''}</td><td>${o.guesses || ''}</td></tr>` : '').join('')}
      </tbody></table>`;
  }

  $('#planBody').innerHTML = `
    <p class="muted small">Plans all rounds at once. Nobody plays a game twice and there's one copy of each game. It looks after the worst-off person first, then keeps the number of 1s as low as possible, then needs as few games as possible. Uses your settings: player counts, ratings, explainer, owner, left-out games.</p>
    <div class="pl-controls">
      <label>Rounds <span class="stepper"><button type="button" data-step="rounds" data-d="-1" aria-label="Fewer rounds">−</button><output>${R}</output><button type="button" data-step="rounds" data-d="1" aria-label="More rounds">+</button></span></label>
      <label>Tables each <span class="stepper"><button type="button" data-step="tables" data-d="-1" aria-label="Fewer tables">−</button><output>${ui.tables}</output><button type="button" data-step="tables" data-d="1" aria-label="More tables">+</button></span></label>
    </div>
    <label class="toggle"><input type="checkbox" id="plFair"${ui.fair ? ' checked' : ''}> Look after the worst-off person first</label>
    <h3>Who's there when?</h3>
    <p class="muted small">Tap a box to mark someone away for a round. Tap a name or a round to switch the whole row or column.</p>
    ${grid}
    <div class="btns"><button type="button" id="plGo" class="primary"${busy ? ' disabled' : ''}>${last ? 'Plan again' : 'Plan the weekend'}</button></div>
    ${msg ? `<p class="pl-msg">${esc(msg)}</p>` : ''}
    <div id="plResult">${res}</div>`;
}

function impHtml() {
  const { model, esc, gName } = ctx, G = model.games;
  const d = (x, unit) => x === Infinity ? 'no plan without it' : x > 0 ? `+${x} ${unit}` : '';
  return `<table class="pl-imp"><thead><tr><th>Without it…</th><th></th></tr></thead><tbody>${imp.map(x => {
    const parts = x.lostMin === Infinity ? ['no plan without it'] : [
      x.lostMin > 1e-9 ? `worst-off −${Math.round(x.lostMin * 100) / 100}` : '',
      d(x.extraOnes, '× “1”'), x.extraOnes <= 0 && x.lostPts > 0 ? `−${x.lostPts} points` : '', d(x.extraGames, x.extraGames === 1 ? 'game' : 'games'),
    ].filter(Boolean);
    return `<tr><th>${esc(gName(G[x.g]))}</th><td>${parts.length ? esc(parts.join(' · ')) : '<span class="muted">easy to replace</span>'}${x.exact ? '' : ' <span class="muted">≈</span>'}</td></tr>`;
  }).join('')}</tbody></table>`;
}

export function onPlanClick(e) {
  const b = e.target.closest('button, input');
  if (!b || !b.closest('#planView')) return false;
  if (b.id === 'plFair') { ui.fair = b.checked; store(); return true; }
  if (b.id === 'plGo') { run('plan'); return true; }
  if (b.id === 'plImp' && last?.plan) { run('importance', { base: { plan: last.plan, minAvg: last.minAvg, ones: last.ones, total: last.total, nGames: last.nGames } }); return true; }
  if (busy && b.closest('.pl-grid, .pl-controls')) return true;
  if (b.dataset.step) {
    const k = b.dataset.step, lim = k === 'rounds' ? [1, MAXR] : [1, 8];
    ui[k] = Math.max(lim[0], Math.min(lim[1], ui[k] + +b.dataset.d));
  } else if (b.dataset.n) {
    const a = ui.away[b.dataset.n], r = +b.dataset.r;
    ui.away[b.dataset.n] = a.includes(r) ? a.filter(x => x !== r) : [...a, r];
  } else if (b.dataset.row) {
    const n = b.dataset.row, all = ui.away[n].filter(r => r < ui.rounds).length === 0;
    ui.away[n] = all ? Array.from({ length: MAXR }, (_, r) => r) : [];
  } else if (b.dataset.col !== undefined) {
    const r = +b.dataset.col, P = ctx.model.players, anyHere = P.some(n => !ui.away[n].includes(r));
    for (const n of P) ui.away[n] = anyHere ? [...new Set([...ui.away[n], r])] : ui.away[n].filter(x => x !== r);
  } else return false;
  last = null; imp = null;
  store(); render();
  return true;
}
