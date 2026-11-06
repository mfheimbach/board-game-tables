import { sheetCsvUrl, parseCSV, parseSheet, allowedCounts } from './sheet.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n).toLocaleString('en');
const ICON = {
  lock: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  drop: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 6 4 3H6l4-3zM12 13v7"/></svg>',
};
const DEFAULTS = {
  attend: null, maxTables: 3, locks: [], excluded: [],
  set: { source: 'rec', minRating: 1, blanks: 'neutral', minPerTable: 2, explainer: true, owner: true },
};

let cfg, model, bgg, storeKey, state, last = null, shown = 10, gamesOpen = false;
const openAlts = new Set();

// ---------- state ----------
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(storeKey));
    if (s) return { ...structuredClone(DEFAULTS), ...s, set: { ...DEFAULTS.set, ...s.set } };
  } catch {}
  return structuredClone(DEFAULTS);
}
const save = () => { try { localStorage.setItem(storeKey, JSON.stringify(state)); } catch {} };

const pIdx = () => new Map(model.players.map((p, i) => [p, i]));
function attendIdx() {
  if (!state.attend) return model.players.map((_, i) => i);
  const m = pIdx();
  return state.attend.map(n => m.get(n)).filter(i => i !== undefined).sort((a, b) => a - b);
}
const gameById = id => model.games.findIndex(g => g.id === id);
const gName = g => g.name || bgg.games[g.id]?.name || `#${g.id}`;
const hasExplainers = () => model.games.some(g => g.explainerText);

function status(g, att = new Set(attendIdx())) {
  const s = state.set;
  let counts = allowedCounts(g, bgg.games[g.id], s.source);
  const noCounts = !counts;
  if (noCounts) counts = [2, 3, 4];
  return {
    counts, noCounts,
    noExplainer: s.explainer && hasExplainers() && !g.explainers.some(i => att.has(i)),
    ownerAway: s.owner && g.bringers.length > 0 && !g.bringers.some(i => att.has(i)),
  };
}

// ---------- packing for the WASM core (layout documented in core/wasm_api.cpp) ----------
function pack(alt) {
  const s = state.set, G = model.games, att = attendIdx(), attSet = new Set(att), pm = pIdx();
  const locks = state.locks.filter(l => gameById(l.id) >= 0);
  const lockFor = id => locks.find(l => l.id === id);
  const buf = [model.players.length, G.length, alt ? alt.length : state.maxTables, +s.minRating,
    s.blanks === 'zero' ? 1 : 0, s.explainer && hasExplainers() ? 1 : 0, +s.minPerTable,
    alt ? 1 : 30, alt ? 6 : 1, alt ? 1 : 0, 200];
  buf.push(att.length, ...att);
  for (const g of G) {
    const st = status(g, attSet);
    buf.push(st.counts.reduce((m, k) => m | (1 << k), 0), g.explainers.length, ...g.explainers, ...g.ratings);
  }
  const lockedIds = new Set(locks.map(l => l.id));
  const excl = G.map((_, i) => i).filter(i => alt ? !alt.includes(i)
    : !lockedIds.has(G[i].id) && (state.excluded.includes(G[i].id) || status(G[i], attSet).ownerAway));
  buf.push(excl.length, ...excl);
  const frozen = (alt ? alt.map(i => lockFor(G[i].id) ?? { id: G[i].id, players: [], exact: false }) : locks)
    .map(l => {
      const req = l.players.map(n => pm.get(n)).filter(i => i !== undefined && attSet.has(i));
      return [gameById(l.id), l.exact && req.length ? 1 : 0, req.length, ...req];
    });
  buf.push(frozen.length, ...frozen.flat());
  return buf;
}

// ---------- workers: one for the main list, one for "other seatings" ----------
const slots = {};
function solve(slot, buf) {
  return new Promise(resolve => {
    let s = slots[slot];
    if (s?.busy) { s.w.terminate(); s = null; }
    if (!s) s = slots[slot] = { w: new Worker('worker.js'), busy: false, id: 0 };
    const id = ++s.id;
    s.busy = true;
    s.w.onmessage = e => { if (e.data.id !== id) return; s.busy = false; resolve(e.data); };
    s.w.postMessage({ id, buf });
  });
}

// ---------- rendering ----------
function renderControls() {
  const att = new Set(attendIdx());
  $('#players').innerHTML = model.players.map((p, i) =>
    `<button class="chip" data-p="${esc(p)}" aria-pressed="${att.has(i)}">${esc(p)}</button>`).join('');
  $('#whoCount').textContent = `${att.size} of ${model.players.length}`;
  $('#tVal').textContent = state.maxTables;
  $('#tMinus').disabled = state.maxTables <= 1;
  $('#tPlus').disabled = state.maxTables >= 5;

  // games: same chips as players; tap cycles normal -> must play -> out -> normal
  const rows = model.games.map(g => {
    const want = [...att].filter(p => g.ratings[p] === 2).length;
    const would = [...att].filter(p => g.ratings[p] === 1).length;
    const lk = lockOf(g.id), out = state.excluded.includes(g.id), st = status(g, att);
    const off = st.noExplainer ? 'nobody here can explain it' : st.ownerAway ? 'owner is not here' : '';
    return { g, want, would, lk, out, off, set: !!lk || out };
  }).sort((a, b) => b.want - a.want || b.would - a.would || gName(a.g).localeCompare(gName(b.g)));
  const visible = gamesOpen ? rows : rows.filter((r, i) => i < 12 || r.set);
  $('#gameChips').innerHTML = visible.map(r => {
    const cls = r.lk ? (r.lk.exact ? 'g-lock' : 'g-pin') : r.out ? 'g-out' : r.off ? 'g-off' : '';
    const icon = r.lk ? (r.lk.exact ? '🔒 ' : '📌 ') : r.out ? '⊘ ' : '';
    const who = r.lk?.players.length ? ` · ${r.lk.players.join(', ')}` : '';
    const tip = r.off || `${r.want} want, ${r.would} would play`;
    return `<button class="chip g ${cls}" data-g="${r.g.id}" title="${esc(tip)}">${icon}${esc(gName(r.g))}${esc(who)}<span class="want">${r.want}</span></button>`;
  }).join('');
  const nSet = rows.filter(r => r.set).length;
  $('#gameCount').textContent = nSet ? `${nSet} set` : '';
  $('#gamesMore').textContent = gamesOpen ? 'fewer' : `all ${rows.length}`;
  $('#gamesReset').hidden = !nSet;
}

function seatHtml(g, p) {
  const r = g.ratings[p], eff = r < 0 ? (state.set.blanks === 'zero' ? 0 : 1) : r;
  const cls = r < 0 && eff === 1 ? 'rq' : `r${eff}`;
  const ex = g.explainers.includes(p) ? ' 📖' : '';
  const tip = r < 0 ? 'no rating (guessed)' : ['won\'t play', 'would play', 'wants to play'][r];
  return `<span class="seat ${cls}" title="${tip}${ex ? ', can explain' : ''}">${esc(model.players[p])}${r < 0 ? '?' : ''}${ex}</span>`;
}

function lockOf(id) { return state.locks.find(l => l.id === id); }

function tableHtml(t) {
  const g = model.games[t.g], b = bgg.games[g.id], lk = lockOf(g.id);
  const time = b?.minTime ? `${b.minTime}${b.maxTime && b.maxTime !== b.minTime ? '–' + b.maxTime : ''}′` : '';
  return `<div class="tbl${lk ? ' locked' : ''}">
    <div><a class="game" href="https://boardgamegeek.com/boardgame/${g.id}" target="_blank" rel="noopener">${esc(gName(g))}</a><span class="meta">${t.p.length}p${time ? ' · ' + time : ''}</span></div>
    <div class="seats">${t.p.map(p => seatHtml(g, p)).join('')}</div>
    <div class="acts">
      <button class="act${lk ? ' on' : ''}" data-lock="${t.g}" data-players="${t.p.join(',')}" aria-label="${lk ? 'Unlock' : 'Lock this table'}" title="${lk ? 'Unlock' : 'Keep this table'}">${ICON.lock}</button>
      <button class="act" data-drop="${g.id}" aria-label="Leave this game out" title="Leave this game out">${ICON.drop}</button>
    </div></div>`;
}

function cardHtml(c, i, nAtt) {
  const s = c.seatings[0];
  const pct = Math.round(100 * s.score / (2 * nAtt));
  const tables = [...s.tables].sort((a, b) => b.p.length - a.p.length);
  const allLocked = tables.every(t => lockOf(model.games[t.g].id)?.exact);
  return `<article class="card" data-i="${i}">
    <div class="card-head">
      <span class="rank">#${i + 1}</span><span class="score">${pct}%</span>
      <span class="score-bar"><i style="width:${pct}%"></i></span>
      ${s.guesses ? `<span class="muted small">${s.guesses} guessed</span>` : ''}
      <span class="spacer"></span>
      <button class="ghost" data-alts="${i}">${openAlts.has(key(s)) ? 'Hide' : 'Other seatings'}</button>
      ${allLocked ? '' : `<button class="ghost" data-lockall="${i}" title="Lock all tables">${ICON.lock}</button>`}
    </div>
    ${tables.map(tableHtml).join('')}
    <div class="alts" hidden></div>
  </article>`;
}
const key = s => s.tables.map(t => t.g).sort((a, b) => a - b).join('-');

function renderResults(r, ms) {
  const nAtt = attendIdx().length, s = state.set, out = $('#results');
  $('#stats').textContent = r ? `${fmt(r.nCand)} possible tables · ${fmt(r.seatings)} seatings checked · ${ms < 1 ? '<1' : Math.round(ms)} ms${r.truncated ? ' · search capped' : ''}` : '';
  if (nAtt < 2) { out.innerHTML = `<div class="empty"><h2>Who's playing?</h2><p class="muted">Tap at least two names.</p></div>`; return; }
  if (r.blocked.length) {
    const names = r.blocked.map(k => state.locks[k]).filter(Boolean)
      .map(l => `<button data-unlock="${l.id}">Unpin ${esc(gName(model.games[gameById(l.id)]))}</button>`);
    out.innerHTML = `<div class="empty"><h2>A pinned game can't be set up</h2><p class="muted">Not enough of its players are here, the player count doesn't fit, or nobody can explain it.</p><div class="btns">${names.join('')}</div></div>`;
    return;
  }
  if (!r.combos.length) {
    const fixes = [];
    if (state.maxTables < 5) fixes.push(['+1 table', 'tables']);
    if (+s.minRating === 2) fixes.push(['Also seat "would play"', 'rating']);
    if (s.source !== 'any') fixes.push(['Any player count', 'source']);
    if (s.explainer && hasExplainers()) fixes.push(['Ignore explainers', 'explainer']);
    if (state.locks.length) fixes.push(['Clear locks', 'locks']);
    if (state.excluded.length) fixes.push(['Bring back left-out games', 'excluded']);
    out.innerHTML = `<div class="empty"><h2>No way to seat exactly these ${nAtt}</h2><p class="muted">Try one of these:</p><div class="btns">${fixes.slice(0, 4).map(([t, k]) => `<button data-fix="${k}">${t}</button>`).join('')}</div></div>`;
    return;
  }
  const list = r.combos.slice(0, shown);
  out.innerHTML = list.map((c, i) => cardHtml(c, i, nAtt)).join('') +
    (r.combos.length > shown ? `<div class="btns" style="justify-content:center"><button id="more">Show more</button></div>` : '');
  list.forEach((c, i) => { if (openAlts.has(key(c.seatings[0]))) showAlts(i); });
}

async function showAlts(i) {
  const c = last.result.combos[i], card = $(`.card[data-i="${i}"]`), box = card?.querySelector('.alts');
  if (!box) return;
  box.hidden = false;
  box.innerHTML = '<span class="muted small">Looking…</span>';
  const games = c.seatings[0].tables.map(t => t.g);
  const { result } = await solve('alt', pack(games));
  const seats = result.combos[0]?.seatings ?? [];
  const nAtt = attendIdx().length;
  box.innerHTML = seats.map((s, k) => `<div class="alt"><div class="who">${
    [...s.tables].sort((a, b) => b.p.length - a.p.length).map(t => `<b>${esc(gName(model.games[t.g]))}</b>: ${t.p.map(p => esc(model.players[p])).join(', ')}`).join('<br>')
  }</div><span class="muted">${Math.round(100 * s.score / (2 * nAtt))}%</span><button data-use="${i}:${k}">Use</button></div>`).join('') || '<span class="muted small">No other seatings.</span>';
  box._seats = seats;
}

function renderGameList() {
  const dlg = $('#settings');
  if (!dlg.open) return;
  const att = new Set(attendIdx()), q = $('#gameSearch').value.trim().toLowerCase();
  const rows = model.games.map((g, i) => {
    const want = [...att].filter(p => g.ratings[p] === 2).length;
    const would = [...att].filter(p => g.ratings[p] === 1).length;
    return { g, i, want, would, st: status(g, att) };
  }).filter(x => !q || gName(x.g).toLowerCase().includes(q))
    .sort((a, b) => b.want - a.want || b.would - a.would || gName(a.g).localeCompare(gName(b.g)));
  $('#gameList').innerHTML = rows.map(({ g, want, would, st }) => {
    const lk = lockOf(g.id), out = state.excluded.includes(g.id);
    const c = st.counts, cnt = c.length ? (c.length > 1 && c[c.length - 1] - c[0] === c.length - 1 ? `${c[0]}–${c[c.length - 1]}p` : `${c.join(',')}p`) : '';
    const badges = [st.noCounts && 'no player counts', st.noExplainer && 'no explainer here', st.ownerAway && 'owner away']
      .filter(Boolean).map(b => `<span class="badge">${b}</span>`).join('');
    const w = bgg.games[g.id]?.weight;
    const pick = lk ? `<div class="pick">${[...att].map(p => `<button type="button" class="chip" data-pickp="${g.id}:${esc(model.players[p])}" aria-pressed="${lk.players.includes(model.players[p])}">${esc(model.players[p])}</button>`).join('')}</div>` : '';
    return `<li class="gl${out ? ' out' : ''}"><div class="gl-main">
      <div class="gl-name"><span class="n">${esc(gName(g))}</span>${badges}
        <span class="d">${cnt} · ${want} want · ${would} would${w ? ` · weight ${w.toFixed(1)}` : ''} · <a href="https://boardgamegeek.com/boardgame/${g.id}" target="_blank" rel="noopener">BGG</a></span></div>
      <button type="button" class="act${lk ? ' on' : ''}" data-pin="${g.id}" title="Must be played">${ICON.pin}</button>
      <button type="button" class="act${out ? ' on out' : ''}" data-exclude="${g.id}" title="Leave out">${ICON.drop}</button>
    </div>${pick}</li>`;
  }).join('');

  for (const el of document.querySelectorAll('.seg')) {
    const v = String(state.set[el.dataset.key]);
    el.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.value === v));
  }
  document.querySelectorAll('.toggle input').forEach(i => { i.checked = !!state.set[i.dataset.key]; });
  const nb = Object.keys(bgg.games).length;
  $('#dataInfo').innerHTML = `
    <p>Ratings: ${model.source === 'live' ? 'live from the sheet' : 'saved copy (sheet unreachable)'}, loaded ${model.loadedAt.toLocaleTimeString()} — ${model.players.length} players, ${model.games.length} games.</p>
    <p>BoardGameGeek data: ${nb} games${bgg.updated ? `, updated ${new Date(bgg.updated).toLocaleDateString()}` : ''}${bgg.sample ? ' <span class="badge">sample data</span>' : ''}.</p>
    ${model.warnings.map(w => `<p class="muted">⚠ ${esc(w)}</p>`).join('')}`;
}

function renderBanner() {
  const msgs = [];
  if (bgg.sample) msgs.push('Player counts are placeholders until the "Update game data" workflow has run.');
  if (model.source !== 'live') msgs.push('Couldn\'t reach the sheet — showing the saved copy.');
  $('#banner').hidden = !msgs.length;
  $('#banner').textContent = msgs.join(' ');
  $('#dataState').textContent = model.source === 'live' ? '' : 'saved copy';
}

// ---------- update loop ----------
let timer;
function update() {
  save();
  renderControls();
  renderGameList();
  clearTimeout(timer);
  timer = setTimeout(run, 20);
}
async function run() {
  if (attendIdx().length < 2) { last = null; renderResults(null, 0); return; }
  const slow = setTimeout(() => { $('#results').innerHTML = '<div class="empty muted">Thinking…</div>'; }, 250);
  const { result, ms } = await solve('main', pack());
  clearTimeout(slow);
  last = { result };
  renderResults(result, ms);
}

// ---------- actions ----------
function setLock(gameIdx, players, exact = true) {
  const id = model.games[gameIdx].id;
  state.locks = state.locks.filter(l => l.id !== id);
  state.locks.push({ id, players: players.map(p => model.players[p]), exact });
  state.excluded = state.excluded.filter(x => x !== id);
}

function wire() {
  document.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.p) {
      const cur = new Set(state.attend ?? model.players);
      cur.has(d.p) ? cur.delete(d.p) : cur.add(d.p);
      state.attend = model.players.filter(p => cur.has(p));
    } else if (d.lock !== undefined) {
      const id = model.games[+d.lock].id;
      if (lockOf(id)) state.locks = state.locks.filter(l => l.id !== id);
      else setLock(+d.lock, d.players.split(',').map(Number));
    } else if (d.drop) {
      const id = +d.drop;
      state.locks = state.locks.filter(l => l.id !== id);
      if (!state.excluded.includes(id)) state.excluded.push(id);
    } else if (d.lockall !== undefined) {
      last.result.combos[+d.lockall].seatings[0].tables.forEach(t => setLock(t.g, t.p));
    } else if (d.alts !== undefined) {
      const k = key(last.result.combos[+d.alts].seatings[0]);
      if (openAlts.has(k)) { openAlts.delete(k); b.closest('.card').querySelector('.alts').hidden = true; b.textContent = 'Other seatings'; }
      else { openAlts.add(k); b.textContent = 'Hide'; showAlts(+d.alts); }
      return;
    } else if (d.use) {
      const k = +d.use.split(':')[1];
      b.closest('.alts')._seats[k].tables.forEach(t => setLock(t.g, t.p));
      openAlts.clear();
    } else if (d.unlock) state.locks = state.locks.filter(l => l.id !== +d.unlock);
    else if (d.unexclude) state.excluded = state.excluded.filter(x => x !== +d.unexclude);
    else if (b.id === 'clearAll') { state.locks = []; state.excluded = []; }
    else if (b.id === 'allBtn') state.attend = null;
    else if (b.id === 'noneBtn') state.attend = [];
    else if (b.id === 'tMinus') state.maxTables = Math.max(1, state.maxTables - 1);
    else if (b.id === 'tPlus') state.maxTables = Math.min(5, state.maxTables + 1);
    else if (d.g) {
      const id = +d.g;
      if (lockOf(id)) { state.locks = state.locks.filter(l => l.id !== id); state.excluded.push(id); }
      else if (state.excluded.includes(id)) state.excluded = state.excluded.filter(x => x !== id);
      else setLock(gameById(id), [], false);
    }
    else if (b.id === 'gamesMore') { gamesOpen = !gamesOpen; renderControls(); return; }
    else if (b.id === 'gamesReset') { state.locks = []; state.excluded = []; }
    else if (b.id === 'more') { shown += 20; renderResults(last.result, 0); return; }
    else if (d.fix) {
      const s = state.set;
      ({ tables: () => state.maxTables++, rating: () => { s.minRating = 1; }, source: () => { s.source = 'any'; },
        explainer: () => { s.explainer = false; }, locks: () => { state.locks = []; }, excluded: () => { state.excluded = []; } })[d.fix]();
    } else if (d.pin) {
      const id = +d.pin;
      if (lockOf(id)) state.locks = state.locks.filter(l => l.id !== id);
      else setLock(gameById(id), [], false);
    } else if (d.exclude) {
      const id = +d.exclude;
      if (state.excluded.includes(id)) state.excluded = state.excluded.filter(x => x !== id);
      else { state.excluded.push(id); state.locks = state.locks.filter(l => l.id !== id); }
    } else if (d.pickp) {
      const [id, name] = [+d.pickp.split(':')[0], d.pickp.slice(d.pickp.indexOf(':') + 1)];
      const l = lockOf(id);
      l.players = l.players.includes(name) ? l.players.filter(n => n !== name) : [...l.players, name];
      l.exact = false;
    } else if (b.closest('.seg')) {
      const k = b.closest('.seg').dataset.key;
      state.set[k] = ['minRating', 'minPerTable'].includes(k) ? +b.value : b.value;
    } else if (b.id === 'openSettings') { $('#settings').showModal(); renderGameList(); return; }
    else if (b.id === 'reload') { reload(); return; }
    else if (b.id === 'resetAll') { if (confirm('Reset players, locks and settings?')) state = structuredClone(DEFAULTS); }
    else return;
    if (!['more'].includes(b.id)) shown = 10;
    update();
  });
  document.addEventListener('change', e => {
    if (e.target.matches('.toggle input')) { state.set[e.target.dataset.key] = e.target.checked; update(); }
  });
  $('#gameSearch').addEventListener('input', renderGameList);
  $('#settings').addEventListener('click', e => { if (e.target === $('#settings')) $('#settings').close(); });
}

// ---------- data ----------
async function loadSheet() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(sheetCsvUrl(cfg), { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    model = parseSheet(parseCSV(await r.text()), cfg);
    model.source = 'live';
  } catch (err) {
    console.warn('live sheet failed, using snapshot:', err);
    model = parseSheet(parseCSV(await (await fetch('data/sheet.csv', { cache: 'no-store' })).text()), cfg);
    model.source = 'snapshot';
  }
  model.loadedAt = new Date();
}
async function reload() {
  $('#reload').disabled = true;
  await loadSheet();
  $('#reload').disabled = false;
  renderBanner();
  update();
}

async function init() {
  try {
    cfg = await (await fetch('config.json')).json();
    document.title = $('#title').textContent = cfg.title || 'Game Tables';
    storeKey = `bgt:${cfg.sheetId}:${cfg.tab}`;
    state = load();
    bgg = await fetch('data/bgg.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null) ?? { games: {} };
    await loadSheet();
  } catch (err) {
    $('#results').innerHTML = `<div class="empty"><h2>Couldn't load the data</h2><p class="muted">${esc(err.message)}</p></div>`;
    return;
  }
  renderBanner();
  wire();
  update();
}
init();
