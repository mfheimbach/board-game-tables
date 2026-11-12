// Runs the weekend planner off the main thread. Module worker.
import Module from './vendor/highs/highs.mjs';
import { solvePlan, importance } from './plan.js';

let highs;
const load = async () => (highs ??= await Module());
const revive = I => ({ ...I, games: I.games.map(g => ({ ...g, off: new Set(g.off), banned: new Set(g.banned) })) });

onmessage = async ({ data }) => {
  try {
    const h = await load();
    const I = revive(data.input);
    if (data.type === 'plan') postMessage({ type: 'done', result: solvePlan(h, I, { timeLimit: data.timeLimit ?? 30 }) });
    else if (data.type === 'importance')
      postMessage({ type: 'done', result: importance(h, I, data.base, { timeLimit: 10, onProgress: (i, n) => postMessage({ type: 'progress', i, n }) }) });
  } catch (e) { postMessage({ type: 'error', message: String(e?.message ?? e) }); }
};
