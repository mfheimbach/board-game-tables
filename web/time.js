// Session length estimate (minutes). Assumes newcomers at the table unless
// everyone seated has played the game.
//
//   box(n): BGG/box time for n players. A range maps its minimum to the fewest
//           legal players and its maximum to the most, linear in between. A single
//           number is read as the time at the most players, with 40% of it fixed
//           (setup, upkeep) and 60% scaling with players.
//   with newcomers:  teach(w) + box(n) * (1 + 0.08 w),  teach(w) = max(10, 10 + 25 (w - 2))
//   all know it:     1.1 * box(n)

export const DEFAULT_WEIGHT = 2.5;

export function boxTime(d, n) {
  if (!d || !(d.maxTime > 0 || d.minTime > 0)) return 0;
  const t0 = d.minTime > 0 ? d.minTime : d.maxTime, t1 = d.maxTime > 0 ? d.maxTime : d.minTime;
  const p0 = d.min > 0 ? d.min : 1, p1 = d.max >= p0 ? d.max : p0;
  if (t1 > t0 && p1 > p0) return Math.max(10, t0 + (t1 - t0) * (n - p0) / (p1 - p0));
  return t1 * (0.4 + 0.6 * n / p1);
}

export const teachTime = w => Math.max(10, 10 + 25 * (w - 2));

export function estimate(d, n, allKnow) {
  const box = boxTime(d, n);
  if (!box) return null;
  const w = d.weight > 0 ? d.weight : DEFAULT_WEIGHT;
  if (allKnow) return { total: 1.1 * box, teach: 0, play: 1.1 * box, box, w };
  const teach = teachTime(w), play = box * (1 + 0.08 * w);
  return { total: teach + play, teach, play, box, w };
}

// Log-ish bins: steps of roughly x1.33 / x1.5.
const BINS = [[45, '¾ h'], [60, '1 h'], [90, '1½ h'], [120, '2 h'], [180, '3 h'], [240, '4 h'], [360, '6 h']];
export function bin(min) {
  if (!(min > 0)) return null;
  let best = BINS[0], bd = Infinity;
  for (const b of BINS) { const dist = Math.abs(Math.log(min / b[0])); if (dist < bd) { bd = dist; best = b; } }
  const label = min > 300 ? '5 h+' : min < 38 ? '½ h' : '~' + best[1];
  const tone = min >= 210 ? 'epic' : min >= 150 ? 'long' : '';
  return { label, tone };
}

export const hm = m => `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, '0')}`;
