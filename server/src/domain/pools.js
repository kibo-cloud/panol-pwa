// El inventario sale siempre del libro: cada transferencia resta en `from` y suma en `to`.
import { POOL_K } from './constants.js';

export const emptyPool = () => Object.fromEntries(POOL_K.map((k) => [k, 0]));

export function poolsFromTransfers(transfers, toolIds = []) {
  const pools = {};
  const P = (t) => pools[t] || (pools[t] = emptyPool());
  for (const tr of transfers) {
    const p = P(tr.toolId);
    const q = Number(tr.qty) || 0;
    p[tr.from] = (p[tr.from] || 0) - q;
    p[tr.to] = (p[tr.to] || 0) + q;
  }
  for (const t of toolIds) P(t);
  return pools;
}
