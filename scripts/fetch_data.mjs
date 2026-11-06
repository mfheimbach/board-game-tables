// Finds every tab of the configured sheets that has the expected format, saves a
// snapshot of each, writes web/data/tabs.json, then fetches BGG data for all games.
// Runs server-side (GitHub Action) so the BGG token never reaches a browser.
//   BGG_TOKEN=... node scripts/fetch_data.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { loadTab, parseCounts } from '../web/sheet.js';

const root = new URL('../web/', import.meta.url);
const cfg = JSON.parse(await readFile(new URL('config.json', root), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fetchText = async url => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
};
const unescapeHtml = s => s.replace(/&amp;/g, '&').replace(/&#39;|&#039;/g, "'").replace(/&quot;/g, '"').trim();

// Tab names + gids from the sheet's public HTML view.
async function discoverTabs(sheetId) {
  try {
    const html = await fetchText(`https://docs.google.com/spreadsheets/d/${sheetId}/htmlview`);
    const found = new Map();
    for (const m of html.matchAll(/sheet-button-(\d+)"[\s\S]{0,300}?>([^<>]{1,100})</g)) found.set(m[1], unescapeHtml(m[2]));
    for (const m of html.matchAll(/\{[^{}]*?"name"\s*:\s*"([^"]{1,100})"[^{}]*?"gid"\s*:\s*"?(\d+)/g)) found.set(m[2], m[1]);
    console.log(`  htmlview: ${found.size} tabs found`);
    return [...found].map(([gid, name]) => ({ gid, name }));
  } catch (e) { console.log(`  htmlview failed: ${e.message}`); return []; }
}

const sheetIds = [cfg.sheetId, ...(cfg.extraSheets ?? [])];
const tabsOut = [], allIds = new Set();
for (const sheetId of sheetIds) {
  console.log(`sheet ${sheetId}`);
  const tabs = await discoverTabs(sheetId);
  for (const name of cfg.tabs ?? [cfg.tab]) if (name && !tabs.some(t => t.name === name)) tabs.push({ name });
  const kept = [];
  for (const tab of tabs) {
    try {
      const { model, headerRow, csv } = await loadTab(fetchText, sheetId, tab, cfg);
      const key = tab.gid ?? tab.name.replace(/\W+/g, '_');
      if (kept.some(k => k.name === tab.name)) continue;
      await writeFile(new URL(`data/sheet-${sheetId === cfg.sheetId ? '' : sheetId + '-'}${key}.csv`, root), csv);
      kept.push({ gid: tab.gid ?? null, name: tab.name ?? `Tab ${tab.gid}`, headerRow, snapshot: `data/sheet-${sheetId === cfg.sheetId ? '' : sheetId + '-'}${key}.csv`, games: model.games.length, players: model.players.length });
      model.games.forEach(g => allIds.add(g.id));
      console.log(`  ✓ ${tab.name ?? tab.gid}: ${model.players.length} players, ${model.games.length} games (header row ${headerRow})`);
      model.warnings.forEach(w => console.log('      warning:', w));
    } catch (e) { console.log(`  ✗ ${tab.name ?? tab.gid}: ${e.message}`); }
  }
  tabsOut.push({ sheetId, tabs: kept });
}
if (!tabsOut[0]?.tabs.length) throw new Error('No usable tab found in the main sheet');
await writeFile(new URL('data/tabs.json', root), JSON.stringify({ updated: new Date().toISOString(), sheets: tabsOut }, null, 1));

// 2) BoardGameGeek
const token = process.env.BGG_TOKEN;
if (!token) { console.log('BGG_TOKEN not set: kept existing bgg.json'); process.exit(0); }

let old = {};
try { old = JSON.parse(await readFile(new URL('data/bgg.json', root), 'utf8')).games ?? {}; } catch {}

const decode = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const attr = (xml, tag) => { const m = xml.match(new RegExp(`<${tag}[^>]*\\svalue="([^"]*)"`)); return m ? decode(m[1]) : null; };

function parseItem(x) {
  const num = t => { const v = attr(x, t); return v === null || v === '' ? null : +v; };
  const g = {
    name: decode((x.match(/<name[^>]*type="primary"[^>]*value="([^"]*)"/) || [])[1] ?? ''),
    year: num('yearpublished'), min: num('minplayers'), max: num('maxplayers'),
    minTime: num('minplaytime'), maxTime: num('maxplaytime'),
    weight: (x.match(/<averageweight[^>]*value="([^"]*)"/) || [])[1] ? +(x.match(/<averageweight[^>]*value="([^"]*)"/)[1]) : null,
    best: [], rec: [],
  };
  const sum = x.match(/<poll-summary[^>]*name="suggested_numplayers"[\s\S]*?<\/poll-summary>/);
  if (sum) {
    const best = (sum[0].match(/name="bestwith"[^>]*value="([^"]*)"/) || [])[1] ?? '';
    const rec = (sum[0].match(/name="recomm+endedwith"[^>]*value="([^"]*)"/) || [])[1] ?? '';
    const strip = s => decode(s).replace(/^.*?with\s*/i, '').replace(/\s*players?\s*$/i, '');
    g.best = parseCounts(strip(best), g.max ?? 12);
    g.rec = parseCounts(strip(rec), g.max ?? 12);
  }
  if (!g.best.length || !g.rec.length) {  // fall back to the raw poll
    for (const r of x.matchAll(/<results numplayers="(\d+)">([\s\S]*?)<\/results>/g)) {
      const v = k => +((r[2].match(new RegExp(`value="${k}"\\s+numvotes="(\\d+)"`)) || [])[1] ?? 0);
      const [b, rc, n] = [v('Best'), v('Recommended'), v('Not Recommended')];
      if (b + rc + n === 0) continue;
      if (!sum && b >= rc && b >= n) g.best.push(+r[1]);
      if (!sum && b + rc > n) g.rec.push(+r[1]);
    }
  }
  return g;
}

async function getThings(ids) {
  const url = `https://boardgamegeek.com/xmlapi2/thing?id=${ids.join(',')}&stats=1`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'board-game-tables' } });
    if (r.status === 200) return r.text();
    console.log(`  BGG ${r.status}, retrying`);
    await sleep(r.status === 202 ? 3000 : 5000 * (attempt + 1));
  }
  throw new Error('BGG API kept failing');
}

const games = {};
const ids = [...allIds];
for (let i = 0; i < ids.length; i += 20) {
  const xml = await getThings(ids.slice(i, i + 20));
  for (const m of xml.matchAll(/<item[^>]*\sid="(\d+)"[^>]*>([\s\S]*?)<\/item>/g)) games[m[1]] = parseItem(m[2]);
  await sleep(2000);
}
for (const id of ids) if (!games[id]) {
  console.log(`  no BGG data for ${id}${old[id] ? ' (kept previous)' : ''}`);
  if (old[id]) games[id] = old[id];
}
await writeFile(new URL('data/bgg.json', root), JSON.stringify({
  source: 'BoardGameGeek XML API2', updated: new Date().toISOString(), games,
}, null, 1));
console.log(`bgg: ${Object.keys(games).length} games written`);
