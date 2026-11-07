// BoardGameGeek XML API2 -> plain game records. Shared by the GitHub Action
// (scripts/fetch_data.mjs) and the Cloudflare Worker (worker/src/index.js).
import { parseCounts } from './sheet.js';

const decode = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const attr = (xml, tag) => { const m = xml.match(new RegExp(`<${tag}[^>]*\\svalue="([^"]*)"`)); return m ? decode(m[1]) : null; };

const links = (x, type) => [...x.matchAll(new RegExp(`<link[^>]*type="${type}"[^>]*value="([^"]*)"`, 'g'))].map(m => decode(m[1])).filter(v => v && v !== '(Uncredited)');

export function parseItem(x) {
  const num = t => { const v = attr(x, t); return v === null || v === '' ? null : +v; };
  const g = {
    name: decode((x.match(/<name[^>]*type="primary"[^>]*value="([^"]*)"/) || [])[1] ?? ''),
    year: num('yearpublished'), min: num('minplayers'), max: num('maxplayers'),
    minTime: num('minplaytime'), maxTime: num('maxplaytime'),
    weight: (x.match(/<averageweight[^>]*value="([^"]*)"/) || [])[1] ? +(x.match(/<averageweight[^>]*value="([^"]*)"/)[1]) : null,
    best: [], rec: [],
    categories: links(x, 'boardgamecategory'), mechanics: links(x, 'boardgamemechanic'), designers: links(x, 'boardgamedesigner'),
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

// <items>…</items> -> { id: game }
export function parseThings(xml) {
  const out = {};
  for (const m of xml.matchAll(/<item[^>]*\sid="(\d+)"[^>]*>([\s\S]*?)<\/item>/g)) out[m[1]] = parseItem(m[2]);
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fetch up to 20 ids per request; retries on 202 (queued) / 429 / 5xx.
export async function fetchThings(ids, token, { log = () => {}, tries = 6 } = {}) {
  const url = `https://boardgamegeek.com/xmlapi2/thing?id=${ids.join(',')}&stats=1`;
  for (let attempt = 0; attempt < tries; attempt++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'board-game-tables' } });
    if (r.status === 200) return parseThings(await r.text());
    log(`  BGG ${r.status}, retrying`);
    await sleep(r.status === 202 ? 3000 : 2000 * (attempt + 1));
  }
  throw new Error('BGG API kept failing');
}
