// Stats page: awards, group numbers and SVG charts from the ratings (+ BGG data).
// Everything is computed in the browser from the loaded tab.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pct = x => `${Math.round(100 * x)}%`;
const f2 = x => (Number.isFinite(x) ? x.toFixed(2) : '–');

function corr(xs, ys) {
  const n = xs.length;
  if (n < 6) return NaN;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}

// Top-2 classical MDS via power iteration on the double-centred matrix.
function mds(D) {
  const n = D.length;
  const D2 = D.map(r => r.map(x => x * x));
  const rm = D2.map(r => mean(r)), gm = mean(rm);
  const B = D2.map((r, i) => r.map((x, j) => -0.5 * (x - rm[i] - rm[j] + gm)));
  const eig = [];
  for (let k = 0; k < 2; k++) {
    let v = Array.from({ length: n }, (_, i) => Math.sin(i + 1 + k));
    let lam = 0;
    for (let it = 0; it < 300; it++) {
      let w = B.map(r => r.reduce((s, x, j) => s + x * v[j], 0));
      for (const e of eig) { const d = w.reduce((s, x, i) => s + x * e.v[i], 0); w = w.map((x, i) => x - d * e.v[i]); }
      const norm = Math.hypot(...w) || 1;
      lam = norm; v = w.map(x => x / norm);
    }
    eig.push({ v, lam });
  }
  return D.map((_, i) => [eig[0].v[i] * Math.sqrt(eig[0].lam), eig[1].v[i] * Math.sqrt(eig[1].lam)]);
}

export function computeStats(model, bgg, playerIdx) {
  const P = playerIdx, G = model.games;
  const name = p => model.players[p];
  const r = (g, p) => g.ratings[p];
  const b = g => bgg.games[g.id] ?? {};

  // per player
  const pl = P.map(p => {
    const rated = G.filter(g => r(g, p) >= 0);
    const c = [0, 0, 0];
    rated.forEach(g => c[r(g, p)]++);
    return { p, n: rated.length, c, blanks: G.length - rated.length, mean: mean(rated.map(g => r(g, p))) };
  });
  const byP = new Map(pl.map(x => [x.p, x]));

  // per game (among selected players)
  const gs = G.map(g => {
    const rs = P.map(p => r(g, p)).filter(x => x >= 0);
    const m = mean(rs);
    return { g, rs, n: rs.length, mean: m, n2: rs.filter(x => x === 2).length, n0: rs.filter(x => x === 0).length,
      var: rs.length > 1 ? mean(rs.map(x => (x - m) ** 2)) : 0, blanks: P.length - rs.length };
  });
  const looMean = (gi, p) => {
    const rs = P.filter(q => q !== p).map(q => r(G[gi], q)).filter(x => x >= 0);
    return rs.length ? mean(rs) : NaN;
  };

  // pairs
  const minOverlap = Math.max(5, Math.round(0.4 * G.length));
  const pairs = [];
  const agreeM = P.map(() => P.map(() => NaN));
  P.forEach((p, i) => P.forEach((q, j) => {
    if (j <= i) return;
    const both = G.filter(g => r(g, p) >= 0 && r(g, q) >= 0);
    if (both.length < minOverlap) return;
    const agree = mean(both.map(g => 1 - Math.abs(r(g, p) - r(g, q)) / 2));
    const clash = both.filter(g => Math.abs(r(g, p) - r(g, q)) === 2).length / both.length;
    const same = both.filter(g => r(g, p) === r(g, q)).length / both.length;
    pairs.push({ p, q, agree, clash, same, n: both.length });
    agreeM[i][j] = agreeM[j][i] = agree;
  }));

  // correlations per player
  const withW = G.map((g, gi) => ({ g, gi, w: b(g).weight, t: b(g).maxTime || b(g).minTime }));
  for (const x of pl) {
    const rated = withW.filter(o => r(o.g, x.p) >= 0);
    const rw = rated.filter(o => o.w > 0), rt = rated.filter(o => o.t > 0);
    x.cW = corr(rw.map(o => r(o.g, x.p)), rw.map(o => o.w));
    x.cT = corr(rt.map(o => r(o.g, x.p)), rt.map(o => Math.log(o.t)));
    const lo = rated.map(o => ({ v: r(o.g, x.p), m: looMean(o.gi, x.p) })).filter(o => Number.isFinite(o.m));
    x.cGroup = corr(lo.map(o => o.v), lo.map(o => o.m));
    // hipster: own mean on the group's least-loved third
    const sorted = [...lo].sort((a, z) => a.m - z.m).slice(0, Math.max(3, Math.floor(lo.length / 3)));
    x.hip = mean(sorted.map(o => o.v));
    // self-promoter: own rating vs others on games they brought
    const own = G.map((g, gi) => ({ g, gi })).filter(o => o.g.bringers?.includes(x.p) && r(o.g, x.p) >= 0);
    const diffs = own.map(o => r(o.g, x.p) - looMean(o.gi, x.p)).filter(Number.isFinite);
    x.self = diffs.length ? mean(diffs) : NaN; x.ownN = own.length;
    x.explains = G.filter(g => g.explainers.includes(x.p)).length;
    x.brought = G.filter(g => g.bringers?.includes(x.p)).length;
  }

  // mechanics / categories / designers
  const groupMean = mean(gs.flatMap(o => o.rs));
  const facet = key => {
    const m = new Map();
    G.forEach((g, gi) => (b(g)[key] ?? []).forEach(t => { if (!m.has(t)) m.set(t, []); m.get(t).push(gi); }));
    return [...m].filter(([, a]) => a.length >= 3).map(([t, a]) => ({ t, games: a, mean: mean(a.flatMap(gi => gs[gi].rs)) }));
  };
  const mech = facet('mechanics'), cats = facet('categories');
  const designers = (() => {
    const m = new Map();
    G.forEach((g, gi) => (b(g).designers ?? []).forEach(t => { if (!m.has(t)) m.set(t, []); m.get(t).push(gi); }));
    return [...m].filter(([, a]) => a.length >= 2).map(([t, a]) => ({ t, games: a }));
  })();
  const lift = (x, f) => {
    const own = f.games.map(gi => r(G[gi], x.p)).filter(v => v >= 0);
    if (own.length < 2) return NaN;
    return (mean(own) - x.mean) - (f.mean - groupMean);
  };
  for (const x of pl) {
    const ls = mech.map(f => ({ t: f.t, l: lift(x, f) })).filter(o => Number.isFinite(o.l)).sort((a, z) => z.l - a.l);
    x.favMech = ls[0]; x.hateMech = ls.length > 1 ? ls[ls.length - 1] : null;
    const ds = designers.map(f => ({ t: f.t, v: mean(f.games.map(gi => r(G[gi], x.p)).filter(v => v >= 0)), n: f.games.length }))
      .filter(o => Number.isFinite(o.v)).sort((a, z) => z.v - a.v);
    x.favDesigner = ds[0];
  }

  // taste map
  let coords = null;
  if (P.length >= 3) {
    const flat = agreeM.flat().filter(Number.isFinite), md = 1 - (flat.length ? mean(flat) : 0.5);
    const D = P.map((_, i) => P.map((_, j) => (i === j ? 0 : Number.isFinite(agreeM[i][j]) ? 1 - agreeM[i][j] : md)));
    coords = mds(D);
    // orient: heavier taste to the right, if that signal exists
    const cw = corr(coords.map(c => c[0]), pl.map(x => (Number.isFinite(x.cW) ? x.cW : 0)));
    if (cw < 0) coords = coords.map(([a, c]) => [-a, c]);
    coords.heavyAxis = Math.abs(cw) > 0.5;
  }

  return { P, pl, byP, gs, pairs, agreeM, mech, cats, coords, groupMean, name, G, b };
}

// ---------- rendering ----------
const pick = (arr, f, dir = 1) => arr.filter(x => Number.isFinite(f(x))).sort((a, z) => dir * (f(z) - f(a)));

function award(emoji, title, list, line, note = '') {
  if (!list.length) return '';
  const [w, ...rest] = list;
  return `<article class="award"><div class="aw-emoji">${emoji}</div><div class="aw-body">
    <h3>${title}</h3><p class="aw-win">${line(w)}</p>
    ${rest.length ? `<p class="aw-run">runner-up: ${line(rest[0], true)}</p>` : ''}
    ${note ? `<p class="aw-note">${note}</p>` : ''}</div></article>`;
}

function tile(emoji, value, label) {
  return `<div class="tile"><span class="t-emoji">${emoji}</span><b>${value}</b><span>${label}</span></div>`;
}

const RC = ['var(--div-neg)', 'var(--div-mid)', 'var(--div-pos)'];

function heatmap(S) {
  const order = S.coords ? S.P.map((p, i) => ({ p, x: S.coords[i][0] })).sort((a, z) => a.x - z.x).map(o => o.p) : S.P;
  const px = order.map(p => S.P.indexOf(p));
  const games = S.gs.map(o => {
    const xs = [], ys = [];
    order.forEach((p, k) => { const v = o.g.ratings[p]; if (v >= 0) { xs.push(k); ys.push(v); } });
    return { o, load: corr(xs, ys) || 0 };
  }).sort((a, z) => (z.load - a.load) || (z.o.mean - a.o.mean));
  const lw = 118, cw = Math.max(12, Math.min(20, Math.floor((330 - lw) / order.length))), ch = 14, top = 70, W = lw + order.length * cw + 40, H = top + games.length * ch + 4;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" class="chart heat" role="img" aria-label="Ratings heatmap">`;
  order.forEach((p, k) => {
    s += `<text x="${lw + k * cw + cw / 2}" y="${top - 6}" transform="rotate(-55 ${lw + k * cw + cw / 2} ${top - 6})" class="ax">${esc(S.name(p))}</text>`;
  });
  games.forEach(({ o }, i) => {
    const y = top + i * ch;
    s += `<text x="${lw - 6}" y="${y + ch - 3}" text-anchor="end" class="ax">${esc(trunc(gname(S, o.g), 19))}</text>`;
    order.forEach((p, k) => {
      const v = o.g.ratings[p], x = lw + k * cw;
      const tip = `${S.name(p)} · ${gname(S, o.g)}: ${v < 0 ? 'no rating' : ['no', 'maybe', 'yes'][v]}`;
      s += v < 0
        ? `<g data-tip="${esc(tip)}"><rect x="${x + 1}" y="${y + 1}" width="${cw - 2}" height="${ch - 2}" rx="2" class="cell-blank"/><circle cx="${x + cw / 2}" cy="${y + ch / 2}" r="1.5" class="dot-blank"/></g>`
        : `<rect data-tip="${esc(tip)}" x="${x + 1}" y="${y + 1}" width="${cw - 2}" height="${ch - 2}" rx="2" fill="${RC[v]}"/>`;
    });
  });
  void px;
  return s + '</svg>';
}

function twinMatrix(S) {
  const idx = S.coords ? S.P.map((p, i) => ({ i, x: S.coords[i][0] })).sort((a, z) => a.x - z.x).map(o => o.i) : S.P.map((_, i) => i);
  const n = idx.length, lw = 96, c = Math.max(12, Math.min(26, Math.floor((330 - lw) / n))), top = 74, W = lw + n * c + 40, H = top + n * c + 4;
  const vals = S.agreeM.flat().filter(Number.isFinite), lo = Math.min(...vals), hi = Math.max(...vals);
  const ramp = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
  const col = v => ramp[Math.min(ramp.length - 1, Math.floor((v - lo) / ((hi - lo) || 1) * ramp.length))];
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" class="chart twin" role="img" aria-label="Taste agreement between players">`;
  idx.forEach((i, k) => {
    const nm = esc(S.name(S.P[i]));
    s += `<text x="${lw + k * c + c / 2}" y="${top - 6}" transform="rotate(-55 ${lw + k * c + c / 2} ${top - 6})" class="ax">${nm}</text>`;
    s += `<text x="${lw - 6}" y="${top + k * c + c / 2 + 4}" text-anchor="end" class="ax">${esc(trunc(S.name(S.P[i]), 14))}</text>`;
    idx.forEach((j, l) => {
      const v = S.agreeM[i][j], x = lw + l * c, y = top + k * c;
      if (i === j) return;
      s += Number.isFinite(v)
        ? `<rect data-tip="${esc(`${S.name(S.P[i])} & ${S.name(S.P[j])}: ${pct(v)} agreement`)}" x="${x + 1}" y="${y + 1}" width="${c - 2}" height="${c - 2}" rx="2" fill="${col(v)}"/>`
        : `<rect data-tip="too few shared ratings" x="${x + 1}" y="${y + 1}" width="${c - 2}" height="${c - 2}" rx="2" class="cell-blank"/>`;
    });
  });
  return s + `</svg><div class="legend"><span>${pct(lo)}</span><span class="ramp">${ramp.map(c => `<i style="background:${c}"></i>`).join('')}</span><span>${pct(hi)} agreement</span></div>`;
}

function tasteMap(S) {
  const pts = S.coords;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const W = 340, H = 260, m = 34;
  const sx = v => m + (v - Math.min(...xs)) / ((Math.max(...xs) - Math.min(...xs)) || 1) * (W - 2 * m);
  const sy = v => m + (v - Math.min(...ys)) / ((Math.max(...ys) - Math.min(...ys)) || 1) * (H - 2 * m);
  let s = `<svg viewBox="0 0 ${W} ${H}" class="chart map" role="img" aria-label="Taste map of players">`;
  s += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" class="frame"/>`;
  if (pts.heavyAxis) s += `<text x="10" y="${H - 10}" class="ax">← lighter games</text><text x="${W - 10}" y="${H - 10}" text-anchor="end" class="ax">heavier games →</text>`;
  pts.forEach((p, i) => {
    const x = sx(p[0]), y = sy(p[1]), nm = S.name(S.P[i]);
    s += `<g data-tip="${esc(nm)}"><circle cx="${x}" cy="${y}" r="12" fill="transparent"/><circle cx="${x}" cy="${y}" r="5" class="pt"/></g>`;
    s += `<text x="${x}" y="${y - 9}" text-anchor="middle" class="lbl">${esc(nm.split(' ')[0])}</text>`;
  });
  return s + '</svg>';
}

function gamesScatter(S) {
  const pts = S.gs.map(o => ({ o, w: S.b(o.g).weight, y: o.n ? o.n2 / o.n : NaN })).filter(p => p.w > 0 && Number.isFinite(p.y));
  if (pts.length < 5) return '';
  const W = 340, H = 240, l = 40, rgt = 12, t = 12, bt = 34;
  const sx = w => l + (w - 1) / 4 * (W - l - rgt), sy = v => t + (1 - v) * (H - t - bt);
  let s = `<svg viewBox="0 0 ${W} ${H}" class="chart scatter" role="img" aria-label="Game weight against how many want to play it">`;
  for (const v of [0, 0.5, 1]) s += `<line x1="${l}" x2="${W - rgt}" y1="${sy(v)}" y2="${sy(v)}" class="grid"/><text x="${l - 6}" y="${sy(v) + 4}" text-anchor="end" class="ax">${pct(v)}</text>`;
  for (const w of [1, 2, 3, 4, 5]) s += `<text x="${sx(w)}" y="${H - bt + 16}" text-anchor="middle" class="ax">${w}</text>`;
  s += `<text x="${(l + W) / 2}" y="${H - 4}" text-anchor="middle" class="ax">BGG weight →</text>`;
  // selective labels: most wanted + heaviest, skipping any that would collide
  const cand = [...pts].sort((a, z) => z.y - a.y).slice(0, 4).concat([...pts].sort((a, z) => z.w - a.w).slice(0, 2));
  const placed = [];
  for (const p of pts) {
    const x = sx(p.w), y = sy(p.y), nm = gname(S, p.o.g);
    s += `<g data-tip="${esc(`${nm}: weight ${p.w.toFixed(1)}, ${pct(p.y)} say yes`)}"><circle cx="${x}" cy="${y}" r="11" fill="transparent"/><circle cx="${x}" cy="${y}" r="4.5" class="pt ring"/></g>`;
  }
  for (const p of cand) {
    const x = sx(p.w), y = sy(p.y), txt = trunc(gname(S, p.o.g), 18), w = txt.length * 5.6;
    const right = x + 7 + w > W - 4, lx = right ? x - 7 - w : x + 7, ly = y - 6;
    if (placed.some(q => lx < q.x + q.w && q.x < lx + w && Math.abs(ly - q.y) < 12)) continue;
    placed.push({ x: lx, y: ly, w });
    s += `<text x="${right ? x - 7 : x + 7}" y="${ly}" text-anchor="${right ? 'end' : 'start'}" class="lbl">${esc(txt)}</text>`;
  }
  return s + '</svg>';
}

function facetBars(list, title) {
  if (list.length < 3) return '';
  const top = [...list].sort((a, z) => z.mean - a.mean).slice(0, 10);
  const W = 340, rh = 22, lw = 150, H = top.length * rh + 8;
  let s = `<svg viewBox="0 0 ${W} ${H}" class="chart bars" role="img" aria-label="${esc(title)}">`;
  top.forEach((f, i) => {
    const y = 4 + i * rh, w = Math.max(2, f.mean / 2 * (W - lw - 44));
    s += `<text x="${lw - 6}" y="${y + 15}" text-anchor="end" class="ax">${esc(trunc(f.t, 24))}</text>`;
    s += `<rect data-tip="${esc(`${f.t}: avg ${f.mean.toFixed(2)} over ${f.games.length} games`)}" x="${lw}" y="${y + 4}" width="${w}" height="${rh - 8}" rx="4" class="bar"/>`;
    s += `<text x="${lw + w + 6}" y="${y + 15}" class="val">${f.mean.toFixed(2)}</text>`;
  });
  return s + '</svg>';
}

// collapsible section; `open` = set of open section keys
const sec = (open, key, title, teaser, body) =>
  `<details class="st-sec" data-sec="${key}"${open.has(key) ? ' open' : ''}><summary><h2>${title}</h2>${teaser ? `<span class="teaser">${teaser}</span>` : ''}</summary>${body}</details>`;

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const gname = (S, g) => g.name || S.b(g).name || `#${g.id}`;

export function renderStats(S, open = new Set(['numbers'])) {
  const nm = p => esc(S.name(p));
  const pl = S.pl.filter(x => x.n >= 3);
  const share = (x, k) => x.c[k] / x.n;
  const allR = S.gs.flatMap(o => o.rs);
  const wantW = S.gs.filter(o => S.b(o.g).weight > 0).map(o => ({ w: S.b(o.g).weight, k: o.n2 }));
  const avgWantedW = wantW.reduce((s, o) => s + o.w * o.k, 0) / (wantW.reduce((s, o) => s + o.k, 0) || 1);

  const tiles = `<div class="tiles">
    ${tile('🎲', S.G.length, 'games')}${tile('🧑‍🤝‍🧑', S.P.length, 'players')}
    ${tile('✅', pct(allR.filter(x => x === 2).length / (allR.length || 1)), 'of ratings are “yes”')}
    ${tile('🚫', pct(allR.filter(x => x === 0).length / (allR.length || 1)), 'are “no”')}
    ${tile('❓', pct(1 - allR.length / ((S.G.length * S.P.length) || 1)), 'left blank')}
    ${avgWantedW > 0 ? tile('⚖️', avgWantedW.toFixed(1), 'avg weight of a “yes”') : ''}
  </div>`;

  const P = [
    award('😤', 'Biggest hater', pick(pl, x => share(x, 0)), (x, s) => `${nm(x.p)} — ${pct(share(x, 0))} “no”${s ? '' : ` (${x.c[0]} of ${x.n})`}`),
    award('🥰', 'Easy to please', pick(pl, x => share(x, 2)), (x, s) => `${nm(x.p)} — ${pct(share(x, 2))} “yes”${s ? '' : ` (${x.c[2]} of ${x.n})`}`),
    award('🤷', 'Fence-sitter', pick(pl, x => share(x, 1)), x => `${nm(x.p)} — ${pct(share(x, 1))} “maybe”`),
    award('👻', 'Mystery guest', pick(S.pl, x => x.blanks).filter(x => x.blanks > 0), x => `${nm(x.p)} — ${x.blanks} games left blank`),
    award('👯', 'Identical twins', pick(S.pairs, x => x.agree), x => `${nm(x.p)} & ${nm(x.q)} — ${pct(x.same)} identical ratings`, 'Only games both rated count.'),
    award('🥊', 'Arch-enemies', pick(S.pairs, x => x.clash).filter(x => x.clash > 0), x => `${nm(x.p)} vs ${nm(x.q)} — “yes” vs “no” on ${pct(x.clash)} of shared games`),
    award('📣', 'Voice of the people', pick(pl, x => x.cGroup), x => `${nm(x.p)} — r = ${f2(x.cGroup)} with everyone else`),
    award('🙃', 'Contrarian', pick(pl, x => x.cGroup, -1), x => `${nm(x.p)} — r = ${f2(x.cGroup)} with everyone else`),
    award('🕶️', 'Hipster', pick(pl, x => x.hip), x => `${nm(x.p)} — avg ${f2(x.hip)} on the group's least-loved games`),
    award('🧠', 'Heavyweight', pick(pl, x => x.cW).filter(x => x.cW > 0), x => `${nm(x.p)} — the heavier, the better (r = ${f2(x.cW)})`),
    award('🪶', 'Featherweight', pick(pl, x => x.cW, -1).filter(x => x.cW < 0), x => `${nm(x.p)} — the lighter, the better (r = ${f2(x.cW)})`),
    award('🏃', 'Marathon runner', pick(pl, x => x.cT).filter(x => x.cT > 0), x => `${nm(x.p)} — loves long games (r = ${f2(x.cT)})`),
    award('🪞', 'Self-promoter', pick(pl, x => x.self).filter(x => x.self > 0), x => `${nm(x.p)} — rates own games ${f2(x.self)} above everyone else (${x.ownN} games)`),
    award('📖', 'Explainer of the year', pick(S.pl, x => x.explains).filter(x => x.explains > 0), x => `${nm(x.p)} — can explain ${x.explains} games`),
    award('🐴', 'Pack mule', pick(S.pl, x => x.brought).filter(x => x.brought > 0), x => `${nm(x.p)} — brought ${x.brought} games`),
  ].join('');

  const gs = S.gs.filter(o => o.n >= Math.max(2, Math.round(S.P.length * 0.4)));
  const bring = g => (g.bringers?.length ? ` · brought by ${g.bringers.map(p => esc(S.name(p))).join(', ')}` : '');
  const gn = o => esc(gname(S, o.g));
  const unicorns = pick(gs.filter(o => o.n0 === 0 && o.n >= S.P.length * 0.6), o => o.mean);
  const Gm = [
    award('👑', 'Crowd favorite', pick(gs, o => o.n2 + o.mean / 10), o => `${gn(o)} — ${o.n2} of ${o.n} say yes`),
    award('⚔️', 'Most divisive', pick(gs.filter(o => o.n2 && o.n0), o => o.var), o => `${gn(o)} — ${o.n2} yes vs ${o.n0} no`),
    award('🦄', 'Unicorn', unicorns, o => `${gn(o)} — nobody says no (avg ${f2(o.mean)})`, unicorns.length > 2 ? `Also: ${unicorns.slice(2, 6).map(gn).join(', ')}` : ''),
    award('🪦', 'Orphan', pick(gs, o => o.mean, -1), o => `${gn(o)} — avg ${f2(o.mean)}${bring(o.g)}`),
    award('🐎', 'Dark horse', pick(S.gs.filter(o => o.blanks >= S.P.length * 0.3 && o.n >= 2), o => o.mean), o => `${gn(o)} — ${o.blanks} blanks, but avg ${f2(o.mean)} from those who rated`),
    award('🧊', 'Most ignored', pick(S.gs, o => o.blanks).filter(o => o.blanks > 0), o => `${gn(o)} — ${o.blanks} of ${S.P.length} left it blank`),
    award('🏋️', 'Heaviest crowd-pleaser', pick(gs.filter(o => o.n2 / o.n >= 0.5 && S.b(o.g).weight > 0), o => S.b(o.g).weight), o => `${gn(o)} — weight ${S.b(o.g).weight.toFixed(1)}, ${o.n2} say yes`),
    award('⏳', 'Longest crowd-pleaser', pick(gs.filter(o => o.n2 / o.n >= 0.5 && (S.b(o.g).maxTime || S.b(o.g).minTime) > 0), o => S.b(o.g).maxTime || S.b(o.g).minTime), o => `${gn(o)} — up to ${S.b(o.g).maxTime || S.b(o.g).minTime} min on the box`),
  ].join('');

  const tastes = S.pl.filter(x => x.favMech || x.favDesigner).map(x => `<li><b>${nm(x.p)}</b>
    ${x.favMech ? `<span>💚 ${esc(x.favMech.t)}</span>` : ''}${x.hateMech ? `<span>💔 ${esc(x.hateMech.t)}</span>` : ''}
    ${x.favDesigner && x.favDesigner.v >= 1.5 ? `<span>🎨 ${esc(x.favDesigner.t)}</span>` : ''}</li>`).join('');
  const hasBggTags = S.mech.length || S.cats.length;

  const winner = (list, f) => (list.length ? f(list[0]) : '');
  const crowd = pick(gs, o => o.n2 + o.mean / 10), twins = pick(S.pairs, x => x.agree);
  const scatter = gamesScatter(S), mechB = facetBars(S.mech, 'Favorite mechanics'), catB = facetBars(S.cats, 'Favorite themes');
  return [
    sec(open, 'numbers', '📊 The numbers', '', tiles),
    sec(open, 'players', '🏆 Player awards', winner(twins, x => `👯 ${nm(x.p)} & ${nm(x.q)} …`), `<div class="awards">${P}</div>`),
    sec(open, 'games', '🎖️ Game awards', winner(crowd, o => `👑 ${gn(o)} …`), `<div class="awards">${Gm}</div>`),
    S.coords ? sec(open, 'map', '🗺️ Taste map', 'who sits where, taste-wise', `<p class="muted small">Close together = similar ratings. Distances are approximate.</p><div class="chart-box">${tasteMap(S)}</div>`) : '',
    S.pairs.length ? sec(open, 'twins', '💞 Who agrees with whom', '', `<div class="chart-box scroll">${twinMatrix(S)}</div>`) : '',
    sec(open, 'heat', '🌡️ Every rating', `${S.G.length} games × ${S.P.length} players`, `
      <div class="legend"><span><i style="background:var(--div-pos)"></i> yes</span><span><i style="background:var(--div-mid)"></i> maybe</span><span><i style="background:var(--div-neg)"></i> no</span><span><i class="blank-sw"></i> blank</span></div>
      <p class="muted small">Players sorted along the taste map, games by who likes them.</p>
      <div class="chart-box scroll">${heatmap(S)}</div>`),
    scatter ? sec(open, 'heavy', '🏋️ Heavy vs wanted', '', `<p class="muted small">Each dot is a game: how heavy it is and how many say “yes”.</p><div class="chart-box">${scatter}</div>`) : '',
    hasBggTags ? [
      mechB ? sec(open, 'mech', '⚙️ Favorite mechanics', '', `<p class="muted small">Average rating, mechanics with 3+ games.</p><div class="chart-box">${mechB}</div>`) : '',
      catB ? sec(open, 'cats', '🏷️ Favorite themes', '', `<div class="chart-box">${catB}</div>`) : '',
      tastes ? sec(open, 'tastes', '🧩 Personal tastes', '', `<p class="muted small">Mechanic each person likes most / least compared to the group, and a designer they rate highly.</p><ul class="tastes">${tastes}</ul>`) : '',
    ].join('') : '<p class="muted small st-foot">⚙️ Mechanics and themes appear once the BGG data has been refreshed.</p>',
  ].join('') + `
    <p class="muted small st-foot">r = correlation (−1 to 1). Pairs need ${S.pairs.length ? 'enough' : 'more'} shared ratings to count.</p>`;
}
