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

// "2-5", "3, 4", "4+" -> [2,3,4,5] ...
export function parseCounts(v, max = 12) {
  const out = new Set();
  for (const part of String(v ?? '').split(/[,;/]|\bor\b|\bund\b|\band\b/)) {
    const p = part.trim().replace(/[–—]/g, '-');
    let m;
    if ((m = p.match(/^(\d+)\s*-\s*(\d+)$/))) for (let k = +m[1]; k <= +m[2]; k++) out.add(k);
    else if ((m = p.match(/^(\d+)\s*\+$/))) for (let k = +m[1]; k <= Math.max(max, +m[1]); k++) out.add(k);
    else if ((m = p.match(/^(\d+)$/))) out.add(+m[1]);
  }
  return [...out].sort((a, b) => a - b);
}

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
    if (ci.min >= 0 && ci.max >= 0 && +r[ci.min] > 0 && +r[ci.max] > 0) {
      g.manual = {
        min: +r[ci.min], max: +r[ci.max],
        rec: ci.rec >= 0 ? parseCounts(r[ci.rec]) : [],
        best: ci.best >= 0 ? parseCounts(r[ci.best]) : [],
      };
    }
    if (ci.explainer >= 0 && g.explainerText && !g.explainers.length)
      warnings.push(`${g.name ?? id}: explainer "${g.explainerText}" is not a player column`);
    games.push(g);
  }
  return { players, games, warnings };
}

// Player counts for one game: 'best' | 'rec' | 'any'. Sheet columns win over BGG.
export function allowedCounts(game, bgg, source) {
  const d = game.manual ?? bgg;
  if (!d || !(d.min > 0)) return null;
  const range = [];
  for (let k = d.min; k <= Math.min(d.max, 31); k++) range.push(k);
  const best = (d.best ?? []).filter(k => k <= 31);
  const rec = [...new Set([...(d.rec ?? []), ...best])].filter(k => k <= 31).sort((a, b) => a - b);
  if (source === 'any') return range;
  if (source === 'best') return best.length ? best : rec.length ? rec : range;
  return rec.length ? rec : range;
}
