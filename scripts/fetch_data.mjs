// Finds every tab of the configured sheets that has the expected format, saves a
// snapshot of each, writes web/data/tabs.json, then fetches BGG data for all games.
// Runs server-side (GitHub Action) so the BGG token never reaches a browser.
//   BGG_TOKEN=... node scripts/fetch_data.mjs
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { loadTab, parseCSV, parseSchedule } from '../web/sheet.js';
import { fetchThings } from '../web/bgg.js';

const root = new URL('../web/', import.meta.url);
const cfg = JSON.parse(await readFile(new URL('config.json', root), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fetchText = async url => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
};
const unescapeJs = s => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, '$1');
const unescapeHtml = s => s.replace(/&amp;/g, '&').replace(/&#39;|&#039;/g, "'").replace(/&quot;/g, '"').trim();

// Document title + tab names/gids from the sheet's public HTML view.
async function discoverTabs(sheetId) {
  try {
    const html = await fetchText(`https://docs.google.com/spreadsheets/d/${sheetId}/htmlview`);
    const title = unescapeHtml((html.match(/<title>([^<]*)<\/title>/i) ?? [])[1] ?? '').replace(/\s+-\s+Google\s+\S+$/i, '') || null;
    const found = new Map();
    for (const m of html.matchAll(/sheet-button-(\d+)"[\s\S]{0,300}?>([^<>]{1,100})</g)) found.set(m[1], unescapeHtml(m[2]));
    // current format: items.push({name: "Core Games", pageUrl: "...", gid: "1866250012", ...})
    for (const m of html.matchAll(/name:\s*"((?:[^"\\]|\\.){1,200})",[^{}]*?gid:\s*"(\d+)"/g)) found.set(m[2], unescapeJs(m[1]));
    for (const m of html.matchAll(/\{[^{}]*?"name"\s*:\s*"([^"]{1,100})"[^{}]*?"gid"\s*:\s*"?(\d+)/g)) found.set(m[2], m[1]);
    console.log(`  htmlview: ${found.size} tabs found`);
    return { title, tabs: [...found].map(([gid, name]) => ({ gid, name })) };
  } catch (e) { console.log(`  htmlview failed: ${e.message}`); return { title: null, tabs: [] }; }
}

const sheetIds = [cfg.sheetId, ...(cfg.extraSheets ?? [])];
const tabsOut = [], allIds = new Set(), lastPlayers = [];
for (const sheetId of sheetIds) {
  console.log(`sheet ${sheetId}`);
  // The sheet itself decides which tabs exist. If they can't be read, stop here:
  // the action fails and the last good data stays online.
  const { title, tabs } = await discoverTabs(sheetId);
  if (!tabs.length) throw new Error(`Couldn't list the tabs of sheet ${sheetId} (has Google changed its page?)`);
  if (title) console.log(`  title: ${title}`);
  const kept = [], other = [];
  for (const tab of tabs) {
    try {
      const { model, headerRow, csv } = await loadTab(fetchText, sheetId, tab, cfg);
      const key = tab.gid ?? tab.name.replace(/\W+/g, '_');
      if (kept.some(k => k.name === tab.name)) continue;
      await writeFile(new URL(`data/sheet-${sheetId === cfg.sheetId ? '' : sheetId + '-'}${key}.csv`, root), csv);
      kept.push({ gid: tab.gid ?? null, name: tab.name ?? `Tab ${tab.gid}`, headerRow, snapshot: `data/sheet-${sheetId === cfg.sheetId ? '' : sheetId + '-'}${key}.csv`, games: model.games.length, players: model.players.length });
      model.games.forEach(g => { if (g.id > 0) allIds.add(g.id); });
      if (sheetId === cfg.sheetId) lastPlayers.push(...model.players);
      console.log(`  ✓ ${tab.name ?? tab.gid}: ${model.players.length} players, ${model.games.length} games (header row ${headerRow})`);
      model.warnings.forEach(w => console.log('      warning:', w));
    } catch (e) { console.log(`  ✗ ${tab.name ?? tab.gid}: ${e.message}`); other.push(tab); }
  }
  tabsOut.push({ sheetId, title, tabs: kept });
  // a schedule tab (who's there in which time slot), read via the full export: the quick CSV drops its name row
  if (sheetId === cfg.sheetId) {
    for (const tab of other) {
      if (tab.gid == null) continue;
      try {
        const csv = await fetchText(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${tab.gid}`);
        const names = [...new Set(lastPlayers)];
        const sch = parseSchedule(parseCSV(csv), names);
        if (sch) {
          await writeFile(new URL('data/schedule.json', root), JSON.stringify({ updated: new Date().toISOString(), tab: tab.name, ...sch }, null, 1));
          console.log(`  ✓ schedule in ${tab.name}: ${sch.slots.length} slots`);
          break;
        }
      } catch (e) { console.log(`  schedule ${tab.name}: ${e.message}`); }
    }
  }
}
if (!tabsOut[0]?.tabs.length) throw new Error('No usable tab found in the main sheet');
// drop snapshots of tabs that no longer exist
const keep = new Set(tabsOut.flatMap(s => s.tabs.map(t => t.snapshot.replace('data/', ''))));
for (const f of await readdir(new URL('data/', root))) if (/^sheet-.*\.csv$/.test(f) && !keep.has(f)) await unlink(new URL('data/' + f, root));
await writeFile(new URL('data/tabs.json', root), JSON.stringify({ updated: new Date().toISOString(), sheets: tabsOut }, null, 1));

// 2) BoardGameGeek
const token = process.env.BGG_TOKEN;
if (!token) { console.log('BGG_TOKEN not set: kept existing bgg.json'); process.exit(0); }

let old = {};
try { old = JSON.parse(await readFile(new URL('data/bgg.json', root), 'utf8')).games ?? {}; } catch {}

const games = {};
const ids = [...allIds];
for (let i = 0; i < ids.length; i += 20) {
  Object.assign(games, await fetchThings(ids.slice(i, i + 20), token, { log: console.log }));
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
