// Sheet + BGG data -> model. Shared by the web app and scripts/fetch_data.mjs.

export function sheetCsvUrl(cfg) {
  const q = new URLSearchParams({
    tqx: 'out:csv', sheet: cfg.tab, headers: '1', range: `A${cfg.headerRow}:ZZ`,
  });
  return `https://docs.google.com/spreadsheets/d/${cfg.sheetId}/gviz/tq?${q}`;
}

// One tab as CSV via the gviz endpoint (works from browsers for link-shared sheets).
// tab = { gid } or { name }; the range starts at the header row so gviz keeps the
// header labels (it drops text in numeric columns otherwise).
export function gvizUrl(sheetId, tab, headerRow) {
  const q = new URLSearchParams({ tqx: 'out:csv', headers: '1', range: `A${headerRow}:ZZ` });
  if (tab.gid !== undefined && tab.gid !== null) q.set('gid', tab.gid); else q.set('sheet', tab.name);
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?${q}`;
}

export const sheetIdFromUrl = u => (String(u).match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/) || String(u).match(/^([a-zA-Z0-9_-]{30,})$/) || [])[1] ?? null;
export const gidFromUrl = u => (String(u).match(/[#&?]gid=(\d+)/) || [])[1] ?? null;

// Fetch + parse one tab. Unknown header row: try likely rows until the BGG column
// is the header. Returns { model, headerRow, csv } or throws if the tab doesn't fit.
export async function loadTab(fetchText, sheetId, tab, cfg) {
  const tries = [...new Set([tab.headerRow, cfg.headerRow, 1, 2, 3, 4, 5, 6, 7, 8].filter(Boolean))];
  let lastErr = new Error('no fitting header row');
  for (const h of tries) {
    try {
      const csv = await fetchText(gvizUrl(sheetId, tab, h));
      const rows = parseCSV(csv);
      if (!rows.length || !rows[0].some(c => norm(c) === norm(cfg.columns.bgg))) continue;
      const model = parseSheet(rows, cfg);
      if (model.games.length && model.players.length) return { model, headerRow: h, csv };
      lastErr = new Error('no games or players found');
    } catch (e) { lastErr = e; if (/HTTP|abort|fetch/i.test(e.message)) throw e; }
  }
  throw lastErr;
}

// Cell A1 of a tab holds its title by convention ("CORE GAMES").
export async function fetchTitle(fetchText, sheetId, tab) {
  const q = new URLSearchParams({ tqx: 'out:csv', headers: '0', range: 'A1:A1' });
  if (tab.gid !== undefined && tab.gid !== null) q.set('gid', tab.gid); else q.set('sheet', tab.name);
  try {
    const cell = (parseCSV(await fetchText(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?${q}`))[0] ?? [])[0];
    return String(cell ?? '').trim() || null;
  } catch { return null; }
}

export function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function bggId(v) {
  const s = String(v ?? '').trim();
  const m = s.match(/boardgame(?:expansion)?\/(\d+)/) || s.match(/^(\d+)(?:\.0+)?$/);
  return m ? +m[1] : null;
}

// Player counts from free text: "2-5", "2 – 5", "2 bis 4", "3, 4", "3;4", "3/4",
// "3 oder 4", "4+", "2-4, 6", "3.4" (a German "3,4" that became a decimal),
// "2-4 (5 mit Exp.)". Returns { list, bad }: bad = something non-empty couldn't be read.
export function readCounts(v, max = 12) {
  const out = new Set();
  let bad = false;
  const text = String(v ?? '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')                 // comments in brackets
    .replace(/[–—]/g, '-')
    .replace(/\s*\b(?:bis|to|until)\b\s*/gi, '-');
  for (const raw of text.split(/[,;/|&]|\b(?:oder|or|und|and)\b/i)) {
    // drop words around the numbers ("best 3", "3 players", "ca. 4")
    const p = raw.replace(/^[^\d]+/, '').replace(/[^\d+]+$/, '').trim();
    if (!p) { if (/\d/.test(raw)) bad = true; continue; }
    let m;
    if ((m = p.match(/^(\d+)\s*-\s*(\d+)$/))) {
      const [a, b] = [+m[1], +m[2]].sort((x, y) => x - y);
      for (let k = a; k <= b; k++) out.add(k);
    } else if ((m = p.match(/^(\d+)\s*\+$/))) for (let k = +m[1]; k <= Math.max(max, +m[1]); k++) out.add(k);
    else if ((m = p.match(/^(\d+)\.(\d+)$/))) { out.add(+m[1]); out.add(+m[2]); }
    else if ((m = p.match(/^(\d+)$/))) out.add(+m[1]);
    else bad = true;
  }
  out.delete(0);
  const list = [...out].filter(k => k <= 99).sort((a, b) => a - b);
  if (!list.length && String(v ?? '').trim()) bad = true;
  return { list, bad };
}
export const parseCounts = (v, max = 12) => readCounts(v, max).list;

// Stable negative id for games without a BGG entry.
export const localId = name => { let h = 7; for (const c of name.toLowerCase()) h = (h * 31 + c.codePointAt(0)) | 0; return -(Math.abs(h) % 1e9) - 1; };
const norm = s => String(s ?? '').trim().toLowerCase();

// Which players does a cell like "Christoph, Daniel" name?
export function matchPlayers(cell, players) {
  const text = norm(cell);
  if (!text) return [];
  const tokens = text.split(/\s*(?:,|;|\/|&|\+|\bund\b|\band\b)\s*/).filter(Boolean);
  const first = players.map(p => norm(p).split(/\s+/)[0]);
  return players.map((p, i) => {
    const full = norm(p);
    const uniqueFirst = first.filter(f => f === first[i]).length === 1;
    return tokens.some(t => t === full || (uniqueFirst && t === first[i])) || text.includes(full) ? i : -1;
  }).filter(i => i >= 0);
}

// rows: CSV rows with the header row first (as fetched with range/headers=1).
export function parseSheet(rows, cfg) {
  const col = cfg.columns, warnings = [];
  const h = rows.findIndex(r => r.some(c => norm(c) === norm(col.bgg)));
  if (h < 0) throw new Error(`Column "${col.bgg}" not found in the sheet`);
  const head = rows[h].map(c => String(c).trim());
  const find = name => (name ? head.findIndex(c => norm(c) === norm(name)) : -1);
  const ci = {
    game: find(col.game), bgg: find(col.bgg), explainer: find(col.explainer),
    bringer: find(col.bringer), min: find(col.minPlayers), max: find(col.maxPlayers),
    rec: find(col.recPlayers), best: find(col.bestPlayers),
    known: find(col.known), minTime: find(col.minTime), maxTime: find(col.maxTime), weight: find(col.weight),
  };
  const known = new Set(Object.values(ci).filter(i => i >= 0));
  // Rows with a BGG id, or (small/obscure games) a real name instead. Totals rows
  // ("40") have neither and are skipped.
  const nameOf = r => (ci.game >= 0 ? String(r[ci.game] ?? '').trim() : '');
  const body = rows.slice(h + 1).filter(r => bggId(r[ci.bgg]) !== null || /\p{L}/u.test(nameOf(r)));

  const isRating = v => /^\s*$/.test(v) || /^\s*-?\d+(\.\d+)?\s*$/.test(v);
  let playerCols = head.map((c, i) => i).filter(i =>
    !known.has(i) && head[i] && !head[i].startsWith('*') &&
    body.every(r => isRating(r[i] ?? '')) && body.some(r => /\d/.test(r[i] ?? '')));

  const rate = v => {
    const s = String(v ?? '').trim();
    if (s === '') return -1;
    const x = Number(s);
    if (!Number.isFinite(x)) return -1;
    if (x > 2) return 2; if (x < 0) return 0;
    return Number.isInteger(x) ? x : 1;
  };
  // players who never rated anything 1 or 2 are dropped (as in the R version)
  const silent = playerCols.filter(i => !body.some(r => rate(r[i]) >= 1));
  if (silent.length) warnings.push(`No ratings from: ${silent.map(i => head[i]).join(', ')}`);
  playerCols = playerCols.filter(i => !silent.includes(i));
  const players = playerCols.map(i => head[i]);

  const seen = new Set();
  const games = [];
  for (const r of body) {
    const id = bggId(r[ci.bgg]) ?? localId(nameOf(r));
    if (seen.has(id)) { warnings.push(`Duplicate BGG id ${id} skipped`); continue; }
    seen.add(id);
    const g = {
      id,
      name: (ci.game >= 0 && String(r[ci.game]).trim()) || null,
      ratings: playerCols.map(i => rate(r[i])),
      explainers: ci.explainer >= 0 ? matchPlayers(r[ci.explainer], players) : [],
      explainerText: ci.explainer >= 0 ? String(r[ci.explainer] ?? '').trim() : '',
      bringers: ci.bringer >= 0 ? matchPlayers(r[ci.bringer], players) : [],
      knownBy: ci.known >= 0 ? matchPlayers(r[ci.known], players) : [],
      manual: null,
      manualTime: null,
    };
    const num = i => (i >= 0 ? Number(String(r[i] ?? '').replace(',', '.')) : NaN);
    if (num(ci.minTime) > 0 || num(ci.maxTime) > 0 || num(ci.weight) > 0)
      g.manualTime = { minTime: num(ci.minTime) || null, maxTime: num(ci.maxTime) || null, weight: num(ci.weight) || null };
    // hand-entered player counts: each field on its own (missing ones fall back to BGG)
    const label = g.name ?? `#${id}`;
    const one = (i, what) => {
      if (i < 0) return null;
      const cell = String(r[i] ?? '').trim();
      if (!cell) return null;
      const { list, bad } = readCounts(cell);
      if (bad || list.length !== 1) { warnings.push(`${label}: couldn't read ${what} "${cell}"`); return list.length ? list[0] : null; }
      return list[0];
    };
    const many = (i, what) => {
      if (i < 0) return null;
      const cell = String(r[i] ?? '').trim();
      if (!cell) return null;
      const { list, bad } = readCounts(cell);
      if (bad) warnings.push(`${label}: couldn't fully read ${what} "${cell}"`);
      return list.length ? list : null;
    };
    const man = { min: one(ci.min, 'min players'), max: one(ci.max, 'max players'), rec: many(ci.rec, 'recommended'), best: many(ci.best, 'best') };
    if (Object.values(man).some(v => v !== null)) g.manual = man;
    if (ci.explainer >= 0 && g.explainerText && !g.explainers.length)
      warnings.push(`${g.name ?? id}: explainer "${g.explainerText}" is not a player column`);
    games.push(g);
  }
  return { players, games, warnings };
}

export const MIN_POLL_VOTES = 10;

// Resolve player counts field by field:
//   1. the sheet, if readable   2. BGG (poll data only with enough votes)
//   3. derived: best <- recommended <- min..max, and min/max from the listed counts
// Recommended/best are then clipped to min..max. Returns null if nothing is known.
export function resolveCounts(game, b) {
  const m = game.manual ?? {}, notes = [];
  const pollOk = b && !(b.pollVotes >= 0 && b.pollVotes < MIN_POLL_VOTES);
  let min = m.min ?? (b?.min > 0 ? b.min : null), max = m.max ?? (b?.max > 0 ? b.max : null);
  let best = m.best ?? (pollOk && b.best?.length ? b.best : null);
  let rec = m.rec ?? (pollOk && b.rec?.length ? b.rec : null);
  if (b && !pollOk && (b.best?.length || b.rec?.length)) notes.push(`BGG poll has only ${b.pollVotes} votes, ignored`);
  const listed = [...(rec ?? []), ...(best ?? [])];
  if (min === null && listed.length) min = Math.min(...listed);
  if (max === null && listed.length) max = Math.max(...listed);
  if (min === null && max === null) return null;
  if (min === null) min = Math.min(2, max);
  if (max === null) max = Math.max(min, 4);
  if (min > max) [min, max] = [max, min];
  max = Math.min(max, 31);
  const clip = (l, what) => {
    if (!l) return null;
    const inside = l.filter(k => k >= min && k <= max);
    if (inside.length < l.length) notes.push(`${what} ${l.filter(k => k < min || k > max).join(', ')} outside ${min}–${max}, ignored`);
    return inside.length ? inside : null;
  };
  best = clip(best, 'best'); rec = clip(rec, 'recommended');
  const range = []; for (let k = min; k <= max; k++) range.push(k);
  // unknown recommended: best if known (conservative), else the full range
  rec = [...new Set([...(rec ?? best ?? range), ...(best ?? [])])].sort((a, z) => a - z);
  best = best ?? rec;
  return { min, max, range, rec, best, notes };
}

// Player counts for one game: 'best' | 'rec' | 'any'.
export function allowedCounts(game, b, source) {
  const r = resolveCounts(game, b);
  if (!r) return null;
  return source === 'any' ? r.range : source === 'best' ? r.best : r.rec;
}
