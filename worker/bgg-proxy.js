// Cloudflare Worker: BGG proxy for Game Tables. Keeps the BGG token on Cloudflare.
// GET ?ids=1,2,3  (numbers only, at most 20)  ->  BGG xmlapi2 "thing" XML, cached for a day.
// Secret: BGG_TOKEN (Settings → Variables and Secrets).
const ORIGIN = 'https://mfheimbach.github.io';

export default {
  async fetch(req, env, ctx) {
    const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Vary': 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    if (req.method !== 'GET') return new Response('GET only', { status: 405, headers: cors });
    const origin = req.headers.get('Origin');
    if (origin && origin !== ORIGIN) return new Response('Not allowed', { status: 403 });

    const ids = [...new Set((new URL(req.url).searchParams.get('ids') ?? '').split(',').filter(x => /^\d{1,7}$/.test(x)))]
      .sort((a, b) => a - b);
    if (!ids.length || ids.length > 20) return new Response('ids: 1 to 20 numbers', { status: 400, headers: cors });

    // same ids → same cache entry, for a day
    const key = new Request(`https://bgg-proxy.cache/thing?ids=${ids.join(',')}`);
    const cache = caches.default;
    const hit = await cache.match(key);
    if (hit) return new Response(hit.body, { headers: { ...cors, 'Content-Type': 'text/xml; charset=utf-8', 'X-Cache': 'hit' } });

    const url = `https://boardgamegeek.com/xmlapi2/thing?id=${ids.join(',')}&stats=1`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${env.BGG_TOKEN}`, 'User-Agent': 'board-game-tables' } });
      if (r.status === 200) {
        const xml = await r.text();
        ctx.waitUntil(cache.put(key, new Response(xml, { headers: { 'Cache-Control': 'max-age=86400' } })));
        return new Response(xml, { headers: { ...cors, 'Content-Type': 'text/xml; charset=utf-8', 'X-Cache': 'miss' } });
      }
      await new Promise(res => setTimeout(res, r.status === 202 ? 2500 : 1500 * (attempt + 1)));   // 202 = BGG still preparing
    }
    return new Response('BGG did not answer', { status: 502, headers: cors });
  },
};
