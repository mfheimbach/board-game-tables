import { estimate, bin, boxTime, hm } from './time.js';
let statsMod = null;
const loadStats = () => (statsMod ??= import('./stats.js'));
let bringMod = null;
const loadBring = async () => (bringMod ??= await import('./bring.js'));
import { loadTab, fetchTitle, parseCSV, parseSheet, allowedCounts, resolveCounts, sheetIdFromUrl, gidFromUrl } from './sheet.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n).toLocaleString('en');
const ICON = {
  share: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M8 8l4-4 4 4M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  drop: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 6 4 3H6l4-3zM12 13v7"/></svg>',
};
const MAX_TABLES = 8;  // matches core/tables.hpp
const DEFAULTS = {
  attend: null, maxTables: 3, locks: [], excluded: [], bans: {}, known: {},
  set: { source: 'rec', minRating: 1, blanks: 'neutral', minPerTable: 2, explainer: true, owner: true, gap: 3, minutes: false, picky: false, tmin: 0, tmax: 0 },
};

let cfg, model, bgg, storeKey, state, last = null, shown = 10, gamesOpen = false, gamesFolded = true, sheetGame = null, sheetFocus = null;
let sheets = [], custom = null, cur = null;   // cur = { sheetId, tabs, i }
const openAlts = new Set();

// ---------- state ----------
function load() {
  try {
    // tabs used to be keyed by name; pick up those saves once they're keyed by gid
    const t = cur && curTab(), old = t?.gid != null && t.name ? `bgt:${cur.sheetId}:${t.name}` : null;
    const s = JSON.parse(localStorage.getItem(storeKey) ?? (old && localStorage.getItem(old)));
    if (s) return { ...structuredClone(DEFAULTS), ...s, set: { ...DEFAULTS.set, ...s.set }, bans: s.bans ?? {}, known: s.known ?? {} };
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
// Ranking points per player and game (64 = one rating step). With "cater to picky
// players" each person's ratings are standardized (z-score, rescaled to the group's
// mean/sd, like a T-score) and blended 50/50 with the raw rating, so a "yes" from
// someone who rarely says yes counts a bit more.
function rankValues() {
  const blank = state.set.blanks === 'zero' ? 0 : 1;
  const eff = (g, p) => (g.ratings[p] < 0 ? blank : g.ratings[p]);
  const G = model.games, P = model.players.map((_, i) => i);
  if (!state.set.picky) return G.map(g => P.map(p => 64 * eff(g, p)));
  const all = G.flatMap(g => P.map(p => eff(g, p)));
  const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
  const gm = mean(all), gs = sd(all) || 1;
  const stats = P.map(p => { const own = G.map(g => eff(g, p)); return { m: mean(own), s: sd(own) }; });
  return G.map(g => P.map(p => {
    const r = eff(g, p), { m, s } = stats[p];
    const t = s > 0 ? gm + (r - m) / s * gs : gm;
    return Math.round(64 * (0.5 * r + 0.5 * Math.min(2.5, Math.max(0, t))));
  }));
}

function pack(alt) {
  const values = rankValues();
  const s = state.set, G = model.games, att = attendIdx(), attSet = new Set(att), pm = pIdx();
  const locks = state.locks.filter(l => gameById(l.id) >= 0);
  const lockFor = id => locks.find(l => l.id === id);
  // pinned games win over the table limit
  const buf = [model.players.length, G.length, alt ? alt.length : Math.min(MAX_TABLES, Math.max(state.maxTables, locks.length)), +s.minRating,
    s.blanks === 'zero' ? 1 : 0, s.explainer && hasExplainers() ? 1 : 0, +s.minPerTable,
    alt ? 1 : 30, alt ? 6 : 1, alt ? 1 : 0, 200, GAPS[s.gap]?.[0] ?? 0, alt ? 1500 : budgetOnce || 1500,
    alt ? 0 : lowEdge(s.tmin), alt ? 0 : highEdge(s.tmax)];
  buf.push(att.length, ...att, ...model.players.map(() => 0));   // fairness weights: unused
  for (const g of G) {
    const st = status(g, attSet);
    const ban = bansOf(g.id).map(n => pm.get(n)).filter(i => i !== undefined);
    const kn = [...knownSet(g)].map(n => pm.get(n)).filter(i => i !== undefined);
    const d = timeData(g), nd = Math.min(32, model.players.length + 1);
    const durs = allKnow => Array.from({ length: nd }, (_, k) => k ? Math.round(estimate(d, k, allKnow)?.total ?? 0) : 0);
    buf.push(st.counts.reduce((m, k) => m | (1 << k), 0), g.explainers.length, ...g.explainers, ban.length, ...ban,
      kn.length, ...kn, nd, ...durs(false), ...durs(true), ...g.ratings, ...values[G.indexOf(g)]);
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
  $('#tWord').textContent = state.maxTables === 1 ? 'table' : 'tables';
  renderTime();
  $('#tMinus').disabled = state.maxTables <= 1;
  $('#tPlus').disabled = state.maxTables >= MAX_TABLES;

  // games: same chips as players; tap cycles normal -> must play -> out -> normal
  const rows = model.games.map(g => {
    const want = [...att].filter(p => g.ratings[p] === 2).length;
    const would = [...att].filter(p => g.ratings[p] === 1).length;
    const lk = lockOf(g.id), out = state.excluded.includes(g.id), st = status(g, att);
    const off = st.noExplainer ? 'nobody here can explain it' : st.ownerAway ? 'owner is not here' : '';
    return { g, want, would, lk, out, off, bans: bansOf(g.id), set: !!lk || out || bansOf(g.id).length > 0 };
  }).sort((a, b) => b.want - a.want || b.would - a.would || gName(a.g).localeCompare(gName(b.g)));
  // folded: only games with a pin/exclusion/picks; open: top 12 (or all) plus those
  const visible = gamesFolded ? rows.filter(r => r.set) : gamesOpen ? rows : rows.filter((r, i) => i < 12 || r.set);
  $('#gameChips').innerHTML = visible.map(r => {
    const cls = r.lk ? (r.lk.exact ? 'g-lock' : 'g-pin') : r.out ? 'g-out' : r.off ? 'g-off' : '';
    const icon = r.lk ? (r.lk.exact ? '🔒 ' : '📌 ') : r.out ? '⊘ ' : '';
    const who = (r.lk?.players.length ? ` · ✓ ${r.lk.players.join(', ')}` : '') + (r.bans.length ? ` · ✕ ${r.bans.join(', ')}` : '');
    const tip = r.off || `${r.want} want, ${r.would} would play`;
    return `<button class="chip g ${cls}" data-g="${r.g.id}" title="${esc(tip)}">${icon}${esc(gName(r.g))}${esc(who)}<span class="want">${r.want}</span></button>`;
  }).join('');
  const nSet = rows.filter(r => r.set).length;
  $('#gameCount').textContent = nSet ? `· ${nSet} set` : `· ${rows.length}`;
  $('#gamesMore').textContent = gamesOpen ? 'fewer' : `all ${rows.length}`;
  $('#gamesMore').hidden = gamesFolded;
  $('#gamesReset').hidden = !nSet;
  $('#gamesFold').setAttribute('aria-expanded', !gamesFolded);
  $('#gameChips').hidden = gamesFolded && !nSet;
}

function seatHtml(g, p) {
  const r = g.ratings[p], eff = r < 0 ? (state.set.blanks === 'zero' ? 0 : 1) : r;
  const cls = r < 0 && eff === 1 ? 'rq' : `r${eff}`;
  const ex = g.explainers.includes(p) ? ' 📖' : '';
  const tip = r < 0 ? 'no rating (guessed)' : ['won\'t play', 'would play', 'wants to play'][r];
  const forced = lockOf(g.id)?.players.includes(model.players[p]) ? '✓ ' : '';
  return `<button class="seat ${cls}" data-open="${g.id}" data-focus="${esc(model.players[p])}" title="${tip}${ex ? ', can explain' : ''} · tap to change who plays">${forced}${esc(model.players[p])}${r < 0 ? '?' : ''}${ex}</button>`;
}

function lockOf(id) { return state.locks.find(l => l.id === id); }

// ---------- time ----------
function timeData(g) {
  const b = bgg.games[g.id] ?? {}, m = g.manual ?? {}, t = g.manualTime ?? {};
  return { min: m.min ?? b.min, max: m.max ?? b.max, minTime: t.minTime ?? b.minTime, maxTime: t.maxTime ?? b.maxTime, weight: t.weight ?? b.weight };
}
function knownSet(g) {
  return new Set([...g.explainers, ...(g.knownBy ?? [])].map(i => model.players[i]).concat(state.known?.[g.id] ?? []));
}
const boxText = d => d.minTime || d.maxTime ? `${d.minTime ?? d.maxTime}${d.maxTime && d.maxTime !== d.minTime ? '–' + d.maxTime : ''}′` : '?';
function fmtDiff(m) {
  const q = Math.round(m / 15) * 15;
  if (q < 60) return `${q}′`;
  const h = Math.floor(q / 60), f = ['', '¼', '½', '¾'][(q % 60) / 15];
  return `${h}${f} h`;
}

function tableHtml(t, ctx = {}) {
  const g = model.games[t.g], lk = lockOf(g.id), d = timeData(g);
  const kn = knownSet(g), allKnow = t.p.every(p => kn.has(model.players[p]));
  const est = t.d ? estimate(d, t.p.length, allKnow) : null, bn = bin(t.d);
  // colour relative to the other tables: longest bold, clear outliers amber/red
  const r = ctx.lo && t.d ? t.d / ctx.lo : 1;
  const tone = [r >= 1.6 ? 'epic' : r >= 1.25 ? 'long' : '', ctx.spread && t.d >= ctx.hi * 0.97 ? 'max' : ''].join(' ');
  const dur = bn ? ` · <span class="dur ${tone}" title="${allKnow ? 'everyone knows it: no teach' : 'with teach for newcomers'}">${bn.label}${allKnow ? ' 🎓' : ''}</span>` : '';
  const nerd = state.set.minutes && est ? `<div class="nerd">box ${boxText(d)} → ${Math.round(est.box)}′ at ${t.p.length}p · ${est.teach ? `teach ${Math.round(est.teach)} + ` : ''}play ${Math.round(est.play)} = <b>${hm(est.total)}</b> (${hm(est.total * 0.8)}–${hm(est.total * 1.5)})</div>` : '';
  return `<div class="tbl${lk ? ' locked' : ''}">
    <div class="tline"><button class="game" data-open="${g.id}" title="Who plays this?">${esc(gName(g))}</button><span class="meta">${t.p.length}p${dur}</span>
      <button class="act${lk ? ' on' : ''}" data-lock="${t.g}" data-players="${t.p.join(',')}" aria-label="${lk ? 'Unlock' : 'Lock this table'}" title="${lk ? 'Unlock' : 'Keep this table'}">${ICON.lock}</button>${nerd}</div>
    <div class="seats">${t.p.map(p => seatHtml(g, p)).join('')}</div></div>`;
}

// ---------- time slot (min/max length per table) ----------
// Steps match the displayed bins; a filter includes the whole bin, so "at most 3 h"
// keeps every table that shows "~3 h" (edges = geometric midpoints between steps).
const TSTEPS = [45, 60, 90, 120, 180, 240, 360];
const tLabel = m => ({ 45: '¾ h', 60: '1 h', 90: '1½ h', 120: '2 h', 180: '3 h', 240: '4 h', 360: '6 h' })[m];
// floor/ceil so a table exactly on a bin boundary is filtered the way its label reads
const lowEdge = m => { const i = TSTEPS.indexOf(m); return i > 0 ? Math.ceil(Math.sqrt(TSTEPS[i - 1] * m)) : 0; };
const highEdge = m => { const i = TSTEPS.indexOf(m); return i >= 0 && i < TSTEPS.length - 1 ? Math.floor(Math.sqrt(TSTEPS[i + 1] * m)) : 0; };
function renderTime() {
  const s = state.set, lo = s.tmin || 0, hi = s.tmax || 0;
  $('#timeLabel').textContent = !lo && !hi ? 'any length' : lo && hi ? `${tLabel(lo)}–${tLabel(hi)}` : lo ? `at least ${tLabel(lo)}` : `up to ${tLabel(hi)}`;
  $('#timeBtn').classList.toggle('on', !!(lo || hi));
  const chip = (key, v, label, on, dis) => `<button class="chip t" data-tset="${key}:${v}" aria-pressed="${on}"${dis ? ' disabled' : ''}>${label}</button>`;
  $('#tminChips').innerHTML = [0, 60, 90, 120, 180].map(v => chip('tmin', v, v ? tLabel(v) : 'any', lo === v, hi && v > hi)).join('');
  $('#tmaxChips').innerHTML = [0, 60, 90, 120, 180].map(v => chip('tmax', v, v ? tLabel(v) : 'any', hi === v, v && lo > v)).join('');
}

// "tables finish within": slider ticks (minutes, 0 = any), roughly doubling
const GAPS = [[30, '½ h'], [60, '1 h'], [120, '2 h'], [0, 'any']];
const gapLabel = i => `All tables finish within <b>${GAPS[i]?.[0] ? GAPS[i][1] + ' of each other' : 'any time'}</b>`;

function syncChip(tables) {
  const ds = tables.filter(t => t.d > 0);
  if (ds.length < 2) return '';
  const lo = Math.min(...ds.map(t => t.d)), long = ds.reduce((a, b) => (b.d > a.d ? b : a)), r = long.d / lo;
  const tone = r <= 1.25 ? 'ok' : r <= 1.6 ? 'mid' : 'far';
  const tip = tone === 'ok' ? 'Tables end at about the same time' : `${gName(model.games[long.g])} runs ~${fmtDiff(long.d - lo)} longer than the shortest table`;
  return `<span class="sync ${tone}" title="${esc(tip)}" aria-label="${esc(tip)}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 3h6"/></svg></span>`;
}

function cardHtml(c, i, nAtt, list = []) {
  const s = c.seatings[0];
  const pct = Math.round(100 * s.score / (2 * nAtt));
  const tables = [...s.tables].sort((a, b) => b.p.length - a.p.length);
  const ds = tables.map(t => t.d).filter(d => d > 0);
  const ctx = ds.length > 1 ? { lo: Math.min(...ds), hi: Math.max(...ds), spread: Math.max(...ds) / Math.min(...ds) > 1.05 } : {};
  return `<article class="card" data-i="${i}">
    <div class="card-head">
      <span class="rank">#${i + 1}</span><span class="score">${pct}%</span>
      <span class="score-bar"><i style="width:${pct}%"></i></span>
      ${s.guesses ? `<span class="muted small">${s.guesses} guessed</span>` : ''}
      ${syncChip(tables)}
      <span class="spacer"></span>
      <button class="ghost" data-alts="${i}" title="Other seatings with the same games">${openAlts.has(key(s)) ? 'Hide' : 'Seatings'}</button>
      <button class="ghost icon" data-share="${i}" title="Send to the group" aria-label="Send to the group">${ICON.share}</button>
      ${tieHtml(list, i, ctx)}
    </div>
    ${tables.map(t => tableHtml(t, ctx)).join('')}
    <div class="alts" hidden></div>
  </article>`;
}
const key = s => s.tables.map(t => t.g).sort((a, b) => a - b).join('-');
// Same score as a neighbour: say what decided the order (fewer guesses, then tables ending closer together)
function tieHtml(list, i, ctx) {
  const sc = k => list[k]?.seatings[0].score;
  if (sc(i) !== sc(i - 1) && sc(i) !== sc(i + 1)) return '';
  const end = !ctx.lo ? '' : ctx.hi - ctx.lo < 15 ? 'tables end together' : `longest table runs ${fmtDiff(ctx.hi - ctx.lo)} longer`;
  return `<div class="why muted small">Same score as ${sc(i) === sc(i - 1) ? 'the one above' : 'the one below'}${end ? ` · ${end}` : ''}</div>`;
}

const HORST = `<picture><source srcset="img/horst-chan-still.webp" media="(prefers-reduced-motion: reduce)"><img class="horst-art" src="img/horst-chan.webp?v=3" alt="" width="280" height="184"></picture>`;
// Horst Chan: tap her face for a tip; new visitors get a hello once.
const HORST_TIPS = [
  'Hold a game chip and pick who plays it. Your ✓ beats every rule, promise! 🤞',
  'Tap a game once and it’s 📌 a must. Twice and it’s ⊘ out. I won’t judge 💙',
  'Dinner soon? Tap ⏱ “at most 1 h” and I’ll find something quick for you 🍝',
  'Found a table you love? 🔒 Lock it and I’ll gently shuffle everyone else.',
  'Tap “Seatings” for the same games with other people. Maybe someone wants to swap? 🙈',
  'Played it before? Tick it in the game sheet. No teach, more play time for you 🎓',
  'Want everyone to finish together? There’s a little slider in the settings for that ⏳',
  'Got a friend who rarely says yes? Turn on “Cater to picky players”. Their 2s will count a bit more 💅',
  'Psst… 📊 has awards! I wonder who gets Biggest hater this year 👀',
  'Sending it to the group? Only if it’s <i>really</i> decided, okay? Plans in the chat tend to stick 😇',
  'Everything you tap stays on your phone. Nobody else sees it, so play around as much as you like 🌸',
  'Lost? <a href="help.html">How it works</a> explains everything, and I’m right here too 🫶',
  'Not sure what to pack? 🧳 shows which games make the weekend better. Your back will thank me!',
  'In 🧳 the dot is my best guess, and the band shows how sure I am. I try my best 🥺',
  'Games below the dashed line in 🧳 don’t change much. Still lovely games, just maybe not this time 🫂',
  'Love numbers as much as I love coffee? 🧳 → Knobs → “until I stop” ☕✨',
  'A ? after a name means they haven’t rated it yet. I counted it as a 1, just guessing for now 🤔',
  '📖 next to a name means they can explain it. No rulebook reading tonight 🥳',
  'Green clock = all tables finish around the same time. Nobody waits alone 🕰️💚',
  'Amber or red time? That table will run a while longer. Maybe grab snacks for the others 🍪',
  'Only want games people really love? Settings → “2 only”. Maximum happiness! 💖',
  'Seven people and only four-player games? Let me use “any” player count in the settings, I’ll make it work 💪',
  'Someone needs a break? Untap their name and I’ll replan in a blink ✨',
  'Did ratings change in the sheet? Settings → Reload ratings, and I’ll catch up 📝',
  'Have your own game group? Settings → Data → Use another sheet. I’d love to help them too 🥰',
  'Want exact minutes instead of ~2 h? Settings → Show minutes ⏱️',
  'Game still at home? Turn on “Only games whose owner is here” and I won’t suggest it 🏠',
  'Your ✓ can even seat someone at a game they rated 0. Please be gentle with them 😬💙',
  'Tap a game’s name in a result to see who plays it and who already knows it 🔍',
  'Hi again! I’m Horst Chan. I love coffee, meeples and the Kölner Dom ☕🎲🏰',
];
let horstT, horstI = -1;
function horstHide() { clearTimeout(horstT); const p = $('#horstPop'); p.hidden = true; p.innerHTML = ''; }
function horstSay(text) {
  if (text === undefined) {
    try { horstI = +(localStorage.getItem('bgt:horstTip') ?? -1); } catch {}
    horstI = (horstI + 1) % HORST_TIPS.length;
    try { localStorage.setItem('bgt:horstTip', horstI); } catch {}
    text = HORST_TIPS[horstI];
  }
  const p = $('#horstPop'); clearTimeout(horstT);
  p.innerHTML = HORST.replace('class="horst-art" ', '') + `<p class="horst-say">${text}</p>`;
  p.hidden = false;
  horstT = setTimeout(horstHide, 4000 + 60 * text.replace(/<[^>]*>/g, "").length);   // longer tips stay longer
}
function horstHello() {
  try { if (localStorage.getItem('bgt:horstHi')) return; localStorage.setItem('bgt:horstHi', '1'); } catch { return; }
  setTimeout(() => horstSay('Hi, I’m Horst Chan! 👋 I’ll help you find the perfect tables. Tap me any time for a tip ☕💙'), 1500);
}
function renderResults(r, ms) {
  const nAtt = attendIdx().length, s = state.set, out = $('#results');
  $('#stats').textContent = r ? `${fmt(r.nCand)} possible tables · ${fmt(r.seatings)} seatings checked · ${ms < 1 ? '<1' : Math.round(ms)} ms${r.truncated ? ' · stopped after 1.5 s, best found' : ''}` : '';
  if (nAtt < 2) { out.innerHTML = `<div class="empty"><h2>Who's playing?</h2><p class="muted">Tap at least two names.</p><p class="small"><a href="help.html">How does this work?</a></p></div>`; return; }
  if (r.blocked.length) {
    const names = r.blocked.map(k => state.locks[k]).filter(Boolean)
      .map(l => `<button data-unlock="${l.id}">Unpin ${esc(gName(model.games[gameById(l.id)]))}</button>`);
    out.innerHTML = `<div class="empty">${HORST}<h2>A pinned game can't be set up</h2><p class="muted">Not enough of its players are here, the player count doesn't fit, or nobody can explain it.</p><div class="btns">${names.join('')}</div></div>`;
    return;
  }
  if (!r.combos.length) {
    const fixes = [];
    if (state.maxTables < MAX_TABLES) fixes.push(['+1 table', 'tables']);
    if (+s.minRating === 2) fixes.push(['Also seat "would play"', 'rating']);
    if (s.source !== 'any') fixes.push(['Any player count', 'source']);
    if (GAPS[s.gap]?.[0]) fixes.unshift(['Allow different lengths', 'sync']);
    if (s.tmin || s.tmax) fixes.unshift(['Any length', 'time']);
    if (s.explainer && hasExplainers()) fixes.push(['Ignore explainers', 'explainer']);
    if (state.locks.length) fixes.push(['Clear locks', 'locks']);
    if (state.excluded.length) fixes.push(['Bring back left-out games', 'excluded']);
    const clash = conflicts();
    out.innerHTML = `<div class="empty">${HORST}<h2>No way to seat exactly these ${nAtt}</h2>${clash.map(c => `<p>⚠ ${esc(c)}</p>`).join('')}<p class="muted">Try one of these:</p><div class="btns">${fixes.slice(0, 4).map(([t, k]) => `<button data-fix="${k}">${t}</button>`).join('')}</div></div>`;
    return;
  }
  const list = r.combos.slice(0, shown);
  const capped = r.truncated ? `<div class="capped">⏳ Big group: these are the best seatings found in ${budgetUsed / 1000} s, not guaranteed to be the very best.
    ${budgetUsed < 10000 ? '<button id="deepSearch">Search for 10 s</button>' : ''}</div>` : '';
  requestAnimationFrame(() => keepAnchor(true));
  out.innerHTML = capped + list.map((c, i) => cardHtml(c, i, nAtt, list)).join('') +
    (r.combos.length > shown ? `<div class="btns" style="justify-content:center"><button id="more">Show more</button></div>` : '');
  list.forEach((c, i) => { if (openAlts.has(key(c.seatings[0]))) showAlts(i); });
}

// Describe an alternative seating by who moves compared to the shown one:
// pairs that trade places become "A ↔ B", everyone else "A → Game".
function altsHtml(base, seats, i, nAtt) {
  const where = s => { const m = new Map(); s.tables.forEach(t => t.p.forEach(p => m.set(p, t.g))); return m; };
  const b = where(base);
  return seats.map((s, k) => {
    const a = where(s), moved = [...a.keys()].filter(p => a.get(p) !== b.get(p));
    if (!moved.length) return '';
    const done = new Set(), parts = [];
    for (const p of moved) {
      if (done.has(p)) continue;
      const q = moved.find(q => !done.has(q) && q !== p && a.get(p) === b.get(q) && a.get(q) === b.get(p));
      if (q !== undefined) { done.add(p); done.add(q); parts.push(`<b>${esc(model.players[p])}</b> ↔ <b>${esc(model.players[q])}</b>`); }
    }
    for (const p of moved) if (!done.has(p)) parts.push(`<b>${esc(model.players[p])}</b> → ${esc(gName(model.games[a.get(p)]))}`);
    return `<div class="alt"><div class="who">${parts.join('<br>')}</div><span class="muted">${Math.round(100 * s.score / (2 * nAtt))}%</span><button data-use="${i}:${k}">Use</button></div>`;
  }).join('');
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
  box.innerHTML = altsHtml(c.seatings[0], seats, i, nAtt) || '<span class="muted small">No other seatings with these games.</span>';
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
    return `<li class="gl${out ? ' out' : ''}"><div class="gl-main">
      <div class="gl-name"><button type="button" class="n" data-open="${g.id}">${esc(gName(g))}</button>${badges}
        <span class="d">${cnt} · ${want} want · ${would} would${w ? ` · weight ${w.toFixed(1)}` : ''}${g.id > 0 ? ` · <a href="https://boardgamegeek.com/boardgame/${g.id}" target="_blank" rel="noopener">BGG</a>` : ' · not on BGG'}</span></div>
      <button type="button" class="act${lk ? ' on' : ''}" data-pin="${g.id}" title="Must be played">${ICON.pin}</button>
      <button type="button" class="act${out ? ' on out' : ''}" data-exclude="${g.id}" title="Leave out">${ICON.drop}</button>
    </div></li>`;
  }).join('');

  for (const el of document.querySelectorAll('.seg[data-key]')) {
    const v = String(state.set[el.dataset.key]);
    el.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.value === v));
  }
  document.querySelectorAll('.toggle input').forEach(i => { i.checked = !!state.set[i.dataset.key]; });
  $('#gap').value = state.set.gap ?? 3;
  $('#gapLabel').innerHTML = gapLabel(state.set.gap ?? 3);
  const nb = Object.keys(bgg.games).length;
  $('#dataInfo').innerHTML = `
    <p>${custom ? 'Your own sheet' : esc(curTab().name)}: ${{ live: 'live from the sheet', pending: 'saved copy, checking the sheet…' }[model.source] ?? 'saved copy (sheet unreachable)'}, loaded ${model.loadedAt.toLocaleTimeString()} — ${model.players.length} players, ${model.games.length} games.</p>
    <p>BoardGameGeek data: ${nb} games${bgg.updated ? `, updated ${new Date(bgg.updated).toLocaleDateString()}` : ''}${bgg.sample ? ' <span class="badge">sample data</span>' : ''}.</p>
    ${[...model.warnings, ...model.games.flatMap(g => (resolveCounts(g, bgg.games[g.id])?.notes ?? []).map(n => `${gName(g)}: ${n}`))]
      .map(w => `<p class="muted">⚠ ${esc(w)}</p>`).join('')}`;
}

function renderBanner() {
  const msgs = [];
  if (bgg.sample) msgs.push('Player counts are placeholders until the "Update game data" workflow has run.');
  if (custom) msgs.push('Using your own sheet (settings → Data to switch back). Player counts only for games in our sheets or with min/max columns.');
  if (model.source === 'snapshot') msgs.push('Couldn\'t reach the sheet — showing the saved copy.');
  $('#banner').hidden = !msgs.length;
  $('#banner').textContent = msgs.join(' ');
  $('#dataState').textContent = model.source === 'pending' ? 'updating…' : '';   // a saved copy is announced by the banner
}

// ---------- update loop ----------
let budgetOnce = 0, budgetUsed = 1500;

// ---------- share ----------
function shareText(i) {
  const s = last.result.combos[i].seatings[0];
  const lines = ['🎲 Tables', ''];
  for (const t of [...s.tables].sort((a, b) => b.p.length - a.p.length)) {
    const g = model.games[t.g], bn = bin(t.d);
    lines.push(`🃏 ${gName(g)}${bn ? ` (${bn.label})` : ''}`);
    lines.push('   ' + t.p.map(p => model.players[p] + (g.explainers.includes(p) ? ' 📖' : '')).join(', '));
  }
  return lines.join('\n');
}
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(el._t); el._t = setTimeout(() => { el.hidden = true; }, 2500);
}

// ---------- stats view ----------
let statsWho = 'all';
async function renderStatsView() {
  if ($('#statsView').hidden) return;
  const { computeStats, renderStats } = await loadStats();
  if ($('#statsView').hidden) return;
  const idx = statsWho === 'here' ? attendIdx() : model.players.map((_, i) => i);
  $('#statsWho').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.value === statsWho));
  let open = new Set(['numbers']);
  try { const o = JSON.parse(localStorage.getItem('bgt:statsOpen')); if (Array.isArray(o)) open = new Set(o); } catch {}
  // "Only who's here" = tonight: present players and the games actually on the table
  // (not left out; owner present if that rule is on). Pinned games always count.
  let view = model;
  if (statsWho === 'here') {
    const att = new Set(idx), pinned = new Set(state.locks.map(l => l.id));
    view = { ...model, allGames: model.games.length, games: model.games.filter(g => pinned.has(g.id) || (!state.excluded.includes(g.id) && !status(g, att).ownerAway)) };
  }
  $('#statsBody').innerHTML = idx.length < 2 ? '<div class="empty muted">Need at least two players.</div>'
    : view.games.length < 3 ? '<div class="empty muted">Too few games left to say anything.</div>'
    : renderStats(computeStats(view, bgg, idx), open);
}
async function showBring(on) {
  $('#bringView').hidden = !on;
  $('#openBring').setAttribute('aria-pressed', on);
  document.querySelector('.layout').hidden = on;
  if (on) {
    if (!$('#statsView').hidden) { showStats(false); document.querySelector('.layout').hidden = true; }
    const m = await loadBring();
    m.openBring({ model, bgg, state, status, bansOf, gName, esc, hasExplainers, timeData, estimate, sheetId: cur.sheetId });
    window.scrollTo(0, 0);
  } else bringMod?.closeBring();
}
function showStats(on) {
  if (on && !$('#bringView').hidden) showBring(false);
  $('#statsView').hidden = !on;
  document.querySelector('.layout').hidden = on;
  $('#openStats').setAttribute('aria-pressed', on);
  if (on) { renderStatsView(); window.scrollTo(0, 0); }
}

let timer;
// Locking pins the game, which reshapes the game chips above and the results: keep the tapped
// table at the same spot on screen instead of letting the page jump.
let anchor = null;
function keepAnchor(done) {
  if (!anchor) return;
  const el = document.querySelector(`#results [data-lock="${anchor.g}"]`);
  if (el) window.scrollBy(0, el.getBoundingClientRect().top - anchor.top);
  if (done) anchor = null;
}
function update() {
  save();
  renderControls();
  keepAnchor(false);
  renderGameList();
  renderSheet();
  renderStatsView();
  clearTimeout(timer);
  timer = setTimeout(run, 20);
}
async function run() {
  if (attendIdx().length < 2) { last = null; renderResults(null, 0); return; }
  const slow = setTimeout(() => { $('#results').innerHTML = '<div class="empty muted">Thinking…</div>'; }, 250);
  budgetUsed = budgetOnce || 1500;
  const { result, ms } = await solve('main', pack());
  budgetOnce = 0;
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

// ---------- per-game "who plays it" ----------
function bansOf(id) { return state.bans?.[id] ?? []; }

// tap cycle per person: open -> ✓ plays -> ✕ never -> open. Forcing pins the game.
function cyclePerson(id, name) {
  const bans = new Set(bansOf(id));
  const l = lockOf(id);
  if (l?.players.includes(name)) {
    l.players = l.players.filter(n => n !== name); l.exact = false;
    bans.add(name);
  } else if (bans.has(name)) bans.delete(name);
  else {
    if (!l) setLock(gameById(id), [], false);
    const L = lockOf(id);
    L.players = [...L.players, name]; L.exact = false;
  }
  if (bans.size) state.bans[id] = [...bans]; else delete state.bans[id];
}

function setGameState(id, v) {
  const l = lockOf(id);
  if (v === 'pin') { if (!l) setLock(gameById(id), [], false); return; }
  state.locks = state.locks.filter(x => x.id !== id);
  state.excluded = state.excluded.filter(x => x !== id);
  if (v === 'out') state.excluded.push(id);
}

// people forced into two pinned games at once
function conflicts() {
  const seen = new Map(), out = [];
  for (const l of state.locks) for (const n of l.players) {
    if (seen.has(n)) out.push(`${n} is set for ${gName(model.games[gameById(seen.get(n))])} and ${gName(model.games[gameById(l.id)])}.`);
    else seen.set(n, l.id);
  }
  return out;
}

function openGame(id, focus) {
  sheetGame = id; sheetFocus = focus ?? null;
  renderSheet();
  const dlg = $('#gameSheet');
  if (!dlg.open) dlg.showModal();
  if (focus) dlg.querySelector(`[data-person="${CSS.escape(focus)}"]`)?.focus();
}

function renderSheet() {
  const dlg = $('#gameSheet');
  if (sheetGame === null) return;
  const g = model.games[gameById(sheetGame)];
  if (!g) { if (dlg.open) dlg.close(); return; }
  const att = new Set(attendIdx()), st = status(g, att), lk = lockOf(g.id), out = state.excluded.includes(g.id);
  const bans = new Set(bansOf(g.id)), forced = new Set(lk?.players ?? []);
  const mode = lk ? 'pin' : out ? 'out' : 'normal';
  const b = bgg.games[g.id], c = st.counts;
  const cnt = c.length > 1 && c[c.length - 1] - c[0] === c.length - 1 ? `${c[0]}–${c[c.length - 1]} players` : `${c.join(', ')} players`;
  const td = timeData(g), nTyp = c[Math.floor((c.length - 1) / 2)] ?? 4, eT = estimate(td, nTyp, false);
  const time = eT ? ` · ${bin(eT.total).label} at ${nTyp}p with teach${state.set.minutes ? ` (box ${boxText(td)}, est. ${hm(eT.total)})` : ''}` : ' · no time data';
  const people = model.players.map((name, p) => ({ name, p, here: att.has(p), r: g.ratings[p] }))
    .sort((a, z) => z.here - a.here || forced.has(z.name) - forced.has(a.name) || z.r - a.r);
  const chip = ({ name, p, here, r }) => {
    const st = forced.has(name) ? 'force' : bans.has(name) ? 'ban' : '';
    const rc = r < 0 ? 'rq' : `r${r}`;
    const icon = st === 'force' ? '✓ ' : st === 'ban' ? '✕ ' : '';
    const label = r < 0 ? 'no rating' : ['won\'t play', 'would play', 'wants it'][r];
    return `<button type="button" class="pchip ${rc} ${st}${here ? '' : ' away'}${name === sheetFocus ? ' focus' : ''}" data-person="${esc(name)}" title="${label}">${icon}${esc(name)}${g.explainers.includes(p) ? ' 📖' : ''}<small>${here ? (r < 0 ? '?' : r) : 'not here'}</small></button>`;
  };
  const notes = [];
  if (lk?.exact) notes.push(`🔒 Locked as exactly these players. <button type="button" id="unexact" class="link">Let others join</button>`);
  const zero = [...forced].filter(n => g.ratings[model.players.indexOf(n)] === 0);
  if (zero.length) notes.push(`${esc(zero.join(', '))} rated it 0, seated anyway.`);
  if (forced.size > Math.max(...c)) notes.push(`More players than the box says. Allowed anyway.`);
  if (st.noExplainer) notes.push(mode === 'pin' ? 'Nobody here can explain it. Played anyway, since it\'s pinned.' : 'Nobody here can explain it, so it won\'t come up unless pinned.');
  if (st.ownerAway) notes.push(mode === 'pin' ? 'Owner isn\'t here. Played anyway, since it\'s pinned.' : 'Owner isn\'t here, so it won\'t come up unless pinned.');
  const clash = conflicts().filter(x => x.includes(gName(g)));
  clash.forEach(x => notes.push(`⚠ ${esc(x)}`));

  $('#gsTitle').innerHTML = g.id > 0
    ? `<a href="https://boardgamegeek.com/boardgame/${g.id}" target="_blank" rel="noopener">${esc(gName(g))} ↗</a>` : esc(gName(g));
  $('#gsMeta').textContent = `${cnt}${time}${b?.weight ? ` · weight ${b.weight.toFixed(1)}` : ''}`;
  $('#gsState').innerHTML = [['normal', 'Normal'], ['pin', '📌 Must play'], ['out', '⊘ Leave out']]
    .map(([v, t]) => `<button type="button" data-gstate="${v}" aria-pressed="${mode === v}">${t}</button>`).join('');
  $('#gsPeople').innerHTML = people.map(chip).join('');
  $('#gsNotes').innerHTML = notes.map(n => `<p>${n}</p>`).join('');
  $('#clearPeople').hidden = !forced.size && !bans.size;
  const kn = knownSet(g), fixed = new Set([...g.explainers, ...(g.knownBy ?? [])].map(i => model.players[i]));
  $('#gsKnownCount').textContent = [...att].filter(p => kn.has(model.players[p])).length ? `· ${[...att].filter(p => kn.has(model.players[p])).map(p => model.players[p]).join(', ')}` : '';
  $('#gsKnown').innerHTML = [...att].map(p => model.players[p]).map(n =>
    `<button type="button" class="chip kchip" data-known="${esc(n)}" aria-pressed="${kn.has(n)}"${fixed.has(n) ? ' disabled title="from the sheet (explainer or Kennen column)"' : ''}>${kn.has(n) ? '🎓 ' : ''}${esc(n)}</button>`).join('');
}

// hold (or right-click) a game chip to open its sheet
let pressTimer = null, longPressed = false;

function wireTips() {
  const tip = $('#tip');
  const show = e => {
    const el = e.target.closest?.('[data-tip]');
    if (!el || !el.closest('#statsView')) { if (e.type !== 'pointermove') tip.hidden = true; return; }
    tip.textContent = el.dataset.tip; tip.hidden = false;
    const x = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8), y = e.clientY - tip.offsetHeight - 12;
    tip.style.left = `${Math.max(8, x)}px`; tip.style.top = `${y < 8 ? e.clientY + 16 : y}px`;
  };
  document.addEventListener('pointermove', show);
  document.addEventListener('pointerdown', show);
  document.addEventListener('scroll', () => { tip.hidden = true; }, true);
}

function wire() {
  wireTips();
  $('#statsBody').addEventListener('toggle', () => {
    const open = [...document.querySelectorAll('#statsBody details[open]')].map(d => d.dataset.sec);
    try { localStorage.setItem('bgt:statsOpen', JSON.stringify(open)); } catch {}
  }, true);
  document.addEventListener('pointerdown', e => {
    const c = e.target.closest('.chip.g');
    if (!c) return;
    longPressed = false;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => { longPressed = true; navigator.vibrate?.(12); openGame(+c.dataset.g); }, 450);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) document.addEventListener(ev, () => clearTimeout(pressTimer));
  document.addEventListener('contextmenu', e => {
    const c = e.target.closest('.chip.g');
    if (!c) return;
    e.preventDefault();
    if (!longPressed) openGame(+c.dataset.g);
  });
  $('#horstBtn').addEventListener('click', () => horstSay());
  $('#horstPop').addEventListener('click', e => { if (!e.target.closest('a')) horstHide(); });

  $('#gameSheet').addEventListener('click', e => { if (e.target === $('#gameSheet')) $('#gameSheet').close(); });
  $('#gameSheet').addEventListener('close', () => { sheetGame = null; });
  document.addEventListener('click', e => {
    if (bringMod && e.target.closest('#bringView') && bringMod.onBringClick(e)) return;
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (b.closest('#statsWho')) { statsWho = b.value; renderStatsView(); return; }
    if (d.tab !== undefined) { if (+d.tab !== cur.i) select(cur.sheetId, cur.tabs, +d.tab).catch(err => alert(err.message)); return; }
    if (b.id === 'useCustom') { useCustom(); return; }
    if (b.id === 'dropCustom') { dropCustom().then(() => { $('#customUrl').value = ''; renderGameList(); }).catch(err => alert(err.message)); return; }
    if (d.open) { openGame(+d.open, d.focus); return; }
    if (d.person) cyclePerson(sheetGame, d.person);
    else if (d.known) {
      const cur = new Set(state.known[sheetGame] ?? []);
      cur.has(d.known) ? cur.delete(d.known) : cur.add(d.known);
      if (cur.size) state.known[sheetGame] = [...cur]; else delete state.known[sheetGame];
    }
    else if (d.gstate) setGameState(sheetGame, d.gstate);
    else if (b.id === 'unexact') { lockOf(sheetGame).exact = false; }
    else if (b.id === 'clearPeople') { const l = lockOf(sheetGame); if (l) { l.players = []; l.exact = false; } delete state.bans[sheetGame]; }
    else if (d.p) {
      const cur = new Set(state.attend ?? model.players);
      cur.has(d.p) ? cur.delete(d.p) : cur.add(d.p);
      state.attend = model.players.filter(p => cur.has(p));
    } else if (d.lock !== undefined) {
      anchor = { g: d.lock, top: b.getBoundingClientRect().top };   // keep this table where the finger is
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
      if (openAlts.has(k)) { openAlts.delete(k); b.closest('.card').querySelector('.alts').hidden = true; b.textContent = 'Seatings'; }
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
    else if (b.id === 'tPlus') state.maxTables = Math.min(MAX_TABLES, state.maxTables + 1);
    else if (d.g) {
      if (longPressed) { longPressed = false; return; }
      const id = +d.g;
      if (lockOf(id)) { state.locks = state.locks.filter(l => l.id !== id); state.excluded.push(id); }
      else if (state.excluded.includes(id)) state.excluded = state.excluded.filter(x => x !== id);
      else setLock(gameById(id), [], false);
    }
    else if (b.id === 'gamesMore') { gamesOpen = !gamesOpen; renderControls(); return; }
    else if (b.id === 'timeBtn') { const p = $('#timePanel'); p.hidden = !p.hidden; b.setAttribute('aria-expanded', !p.hidden); return; }
    else if (d.tset) { const [k, v] = d.tset.split(':'); state.set[k] = +v; }
    else if (b.id === 'gamesFold') {
      gamesFolded = !gamesFolded;
      try { localStorage.setItem('bgt:gamesFold', gamesFolded ? '1' : '0'); } catch {}
      renderControls(); return;
    } else if (b.id === 'gamesInfo') {
      const l = $('#gamesLegend'); l.hidden = !l.hidden; b.setAttribute('aria-expanded', !l.hidden); return;
    }
    else if (b.id === 'gamesReset') { state.locks = []; state.excluded = []; state.bans = {}; }
    else if (b.id === 'more') { shown += 20; renderResults(last.result, 0); return; }
    else if (d.fix) {
      const s = state.set;
      ({ tables: () => state.maxTables++, rating: () => { s.minRating = 1; }, source: () => { s.source = 'any'; },
        explainer: () => { s.explainer = false; }, sync: () => { s.gap = 3; }, time: () => { s.tmin = 0; s.tmax = 0; }, locks: () => { state.locks = []; state.bans = {}; }, excluded: () => { state.excluded = []; } })[d.fix]();
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
    } else if (b.id === 'openBring') { showBring($('#bringView').hidden); return; }
    else if (b.id === 'closeBring') { showBring(false); return; }
    else if (b.id === 'openStats') { showStats($('#statsView').hidden); return; }
    else if (b.id === 'closeStats') { showStats(false); return; }
    else if (d.share !== undefined) {
      $('#shareText').textContent = shareText(+d.share);
      $('#shareDlg').showModal(); return;
    } else if (b.id === 'shareGo') {
      const text = $('#shareText').textContent;
      $('#shareDlg').close();
      if (navigator.share) navigator.share({ text }).catch(() => {});
      else navigator.clipboard?.writeText(text).then(() => toast('Copied — paste it in the chat'), () => toast('Couldn\'t copy'));
      return;
    } else if (b.id === 'deepSearch') { budgetOnce = 10000; b.disabled = true; b.textContent = 'Searching…'; run(); return; }
    else if (b.id === 'openSettings') { $('#settings').showModal(); renderGameList(); return; }
    else if (b.id === 'reload') { reload(); return; }
    else if (b.id === 'resetAll') { if (confirm('Reset players, locks and settings?')) state = structuredClone(DEFAULTS); }
    else return;
    if (!['more'].includes(b.id)) shown = 10;
    update();
  });
  document.addEventListener('change', e => {
    if (e.target.matches('.toggle input')) { state.set[e.target.dataset.key] = e.target.checked; update(); }
    if (e.target.id === 'gap') { state.set.gap = +e.target.value; update(); }
  });
  $('#gameSearch').addEventListener('input', renderGameList);
  $('#gap').addEventListener('input', e => { $('#gapLabel').innerHTML = gapLabel(+e.target.value); });
  $('#settings').addEventListener('click', e => { if (e.target === $('#settings')) $('#settings').close(); });
}

// ---------- data ----------
const tabKey = t => t.gid ?? t.name;
const curTab = () => cur.tabs[cur.i];

async function fetchText(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

// Parsed tabs stay in memory for the session: switching is instant, and the
// live sheet is re-read in the background.
const tabCache = new Map();
const cacheKey = (sheetId, tab) => `${sheetId}:${tabKey(tab)}`;
const fingerprint = m => JSON.stringify([m.players, m.games.map(g => [g.id, g.ratings, g.explainers, g.knownBy])]);

async function fetchModel(sheetId, tab) {
  let m;
  try {
    const res = await loadTab(fetchText, sheetId, tab, cfg);
    m = res.model; tab.headerRow = res.headerRow; m.source = 'live';
  } catch (err) {
    console.warn('live sheet failed:', err);
    if (!tab.snapshot) throw new Error(`Couldn't read that sheet (${err.message}). It must be shared as "anyone with the link" and use the same columns.`);
    m = parseSheet(parseCSV(await (await fetch(tab.snapshot, { cache: 'no-cache' })).text()), cfg);
    m.source = 'snapshot';
  }
  m.loadedAt = new Date();
  tabCache.set(cacheKey(sheetId, tab), m);
  return m;
}

async function loadSheet() { model = await fetchModel(cur.sheetId, curTab()); }

// Switch sheet/tab: keep who's here, table count and settings; pins/exclusions are per tab.
async function select(sheetId, tabs, i) {
  const carry = state && { attend: state.attend, maxTables: state.maxTables, set: state.set };
  const prev = cur, cached = tabCache.get(cacheKey(sheetId, tabs[i]));
  cur = { sheetId, tabs, i };
  storeKey = `bgt:${sheetId}:${tabKey(tabs[i])}`;
  const firstLoad = !prev && !cached && tabs[i].snapshot;
  if (cached) model = cached;
  else if (firstLoad) {
    model = parseSheet(parseCSV(await (await fetch(tabs[i].snapshot, { cache: 'no-cache' })).text()), cfg);
    model.source = 'pending'; model.loadedAt = new Date();
  } else {
    try { await loadSheet(); }
    catch (err) { cur = prev; if (prev) storeKey = `bgt:${prev.sheetId}:${tabKey(curTab())}`; throw err; }
  }
  state = load();
  if (carry) Object.assign(state, carry);
  try { localStorage.setItem('bgt:sel', JSON.stringify({ sheetId, key: tabKey(tabs[i]) })); } catch {}
  shown = 10; openAlts.clear(); last = null;
  renderTabs(); renderBanner(); update();
  if (cached || firstLoad) refreshInBackground(sheetId, tabs[i], model).then(prefetchTabs);
  else prefetchTabs();
  (window.requestIdleCallback ?? (f => setTimeout(f, 1500)))(() => loadStats());
}

async function refreshInBackground(sheetId, tab, before = tabCache.get(cacheKey(sheetId, tab))) {
  try {
    const fresh = await fetchModel(sheetId, tab);
    if (cur.sheetId !== sheetId || curTab() !== tab) return;
    if (fingerprint(fresh) !== fingerprint(before)) { model = fresh; renderBanner(); update(); }
    else if (fresh.source !== model.source) { model.source = fresh.source; renderBanner(); }
  } catch {}
}

let prefetched = false;
async function prefetchTabs() {
  if (prefetched) return;
  prefetched = true;
  for (const t of cur.tabs) {
    if (!tabCache.has(cacheKey(cur.sheetId, t))) { try { await fetchModel(cur.sheetId, t); } catch {} }
  }
}

function renderTabs() {
  const el = $('#tabSwitch');
  el.hidden = cur.tabs.length < 2;
  el.innerHTML = cur.tabs.map((t, i) => `<button type="button" data-tab="${i}" aria-pressed="${i === cur.i}">${esc(t.name)}</button>`).join('');
}
async function reload() {
  $('#reload').disabled = true;
  await loadSheet();
  $('#reload').disabled = false;
  renderBanner();
  update();
}

const getJSON = url => fetch(url, { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).catch(() => null);

function warmSolver() {
  if (!slots.main) slots.main = { w: new Worker('worker.js'), busy: false, id: 0 };
}

async function init() {
  warmSolver();
  try { gamesFolded = localStorage.getItem('bgt:gamesFold') !== '0'; } catch {}
  wire();
  try {
    const [c, bj, tj] = await Promise.all([fetch('config.json', { cache: 'no-cache' }).then(r => r.json()), getJSON('data/bgg.json'), getJSON('data/tabs.json')]);
    cfg = c;
    document.title = $('#title').textContent = tj?.sheets?.[0]?.title || 'Game Tables';
    bgg = bj ?? { games: {} };
    sheets = tj?.sheets?.filter(s => s.tabs.length) ?? [];
    if (!sheets.length) throw new Error('No game data yet. Run "Update game data" on GitHub once.');
    try { custom = JSON.parse(localStorage.getItem('bgt:custom')); } catch {}
    let sel = null;
    try { sel = JSON.parse(localStorage.getItem('bgt:sel')); } catch {}
    const pool = custom ? [custom] : sheets;
    const sh = pool.find(s => s.sheetId === sel?.sheetId) ?? pool[0];
    const i = Math.max(0, sh.tabs.findIndex(t => tabKey(t) === sel?.key || t.name === sel?.key));
    await select(sh.sheetId, sh.tabs, i);
    horstHello();
  } catch (err) {
    $('#results').innerHTML = `<div class="empty">${HORST}<h2>Couldn't load the data</h2><p class="muted">${esc(err.message)}</p>
      ${custom ? '<div class="btns"><button id="dropCustom">Back to the retreat sheet</button></div>' : ''}</div>`;
  }
}

async function useCustom() {
  const v = $('#customUrl').value.trim(), id = sheetIdFromUrl(v);
  if (!id) { alert('That doesn\'t look like a Google Sheets link.'); return; }
  const known = sheets.find(s => s.sheetId === id);
  const gid = gidFromUrl(v);
  const btn = $('#useCustom');
  btn.disabled = true; btn.textContent = 'Loading…';
  let tabs = known?.tabs;
  if (!tabs) {
    const tab = { gid: gid ?? '0' };
    tab.name = await fetchTitle(fetchText, id, tab) ?? 'Your sheet';
    tabs = [tab];
  }
  try {
    await select(id, tabs, Math.max(0, tabs.findIndex(t => gid && t.gid === gid)));
    custom = known ? null : { sheetId: id, tabs };
    try { custom ? localStorage.setItem('bgt:custom', JSON.stringify(custom)) : localStorage.removeItem('bgt:custom'); } catch {}
    renderBanner(); renderGameList();
  } catch (err) { alert(err.message); }
  btn.disabled = false; btn.textContent = 'Use it';
}

async function dropCustom() {
  custom = null;
  try { localStorage.removeItem('bgt:custom'); } catch {}
  await select(sheets[0].sheetId, sheets[0].tabs, 0);
}
init();
