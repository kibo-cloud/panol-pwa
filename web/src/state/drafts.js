// Borrador del control en curso guardado en el equipo (IndexedDB, almacén `panol-drafts`):
// si no hay conexión queda acá y se reenvía al volver, con su Idempotency-Key. La lógica es
// pura (se prueba con un almacén en memoria); el adaptador de IndexedDB está al final.
import { pkeyOf } from './period.js';
import { holderBody } from './plantillas.js';

export const DRAFT_STORE = 'panol-drafts';

// Una clave por poseedor (técnico, o `caja:<id>` para una caja compartida) y período (las correcciones llevan además el control corregido).
export const draftKey = (techId, period, correctionOf = null) => `${techId}|${pkeyOf(period)}${correctionOf ? '|corr-' + correctionOf : ''}`;

const payloadOf = (r) => JSON.stringify([r.controlId || null, r.version ?? null, r.correctionOf || null, r.techId, r.pkey, r.items]);

// Arma el registro nuevo. Si el contenido a enviar es el mismo que el anterior se conserva la
// clave de idempotencia (un reenvío no duplica nada); si cambió, se usa una clave nueva.
export function nextDraft(prev, { techId, period, correctionOf = null, controlId = null, version = null, items }, newKey, now = new Date().toISOString()) {
  const rec = { key: draftKey(techId, period, correctionOf), techId, period, pkey: pkeyOf(period), correctionOf, controlId, version, items, savedAt: now, conflict: false };
  rec.idemKey = prev && payloadOf(prev) === payloadOf(rec) ? prev.idemKey : newKey;
  return rec;
}

// Qué pedido corresponde: crear el control (todavía no existe en el servidor) o guardar el borrador.
export function requestFor(rec) {
  if (!rec.controlId) {
    const body = rec.correctionOf ? { correctionOf: rec.correctionOf, items: rec.items } : { ...holderBody(rec.techId), period: rec.period, items: rec.items };
    return { kind: 'create', body, idempotencyKey: rec.idemKey };
  }
  return { kind: 'save', id: rec.controlId, items: rec.items, version: rec.version, idempotencyKey: rec.idemKey };
}

// Envía los borradores pendientes. `send(req)` devuelve el control guardado o lanza un error
// con `kind` ('network'/'offline' corta el envío; 'conflict' deja el borrador marcado).
export async function flushDrafts(store, send) {
  const out = { sent: [], conflicts: [], failed: [], stopped: false };
  for (const rec of await store.all()) {
    if (rec.conflict) { out.conflicts.push(rec); continue; }
    try {
      const control = await send(requestFor(rec), rec);
      await store.del(rec.key);
      out.sent.push({ rec, control });
    } catch (e) {
      if (e && (e.kind === 'network' || e.kind === 'offline')) { out.stopped = true; break; }
      if (e && e.kind === 'conflict') { await store.put({ ...rec, conflict: true }); out.conflicts.push(rec); continue; }
      out.failed.push({ rec, error: e });
      if (e && (e.kind === 'validation' || e.kind === 'not_found' || e.kind === 'forbidden')) await store.del(rec.key);
    }
  }
  return out;
}

// Almacén en memoria (pruebas y navegadores sin IndexedDB).
export function memoryStore() {
  const m = new Map();
  return { all: async () => [...m.values()], get: async (k) => m.get(k), put: async (r) => { m.set(r.key, r); }, del: async (k) => { m.delete(k); } };
}

// Adaptador de IndexedDB (base `panol-v3`, almacén `panol-drafts`).
export function idbStore(name = 'panol-v3') {
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(DRAFT_STORE, { keyPath: 'key' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(DRAFT_STORE, mode); const st = t.objectStore(DRAFT_STORE); let out;
      const q = fn(st); if (q) q.onsuccess = () => { out = q.result; };
      t.oncomplete = () => res(out); t.onerror = t.onabort = () => rej(t.error);
    });
  };
  return {
    all: () => tx('readonly', (s) => s.getAll()).then((x) => x || []),
    get: (k) => tx('readonly', (s) => s.get(k)),
    put: (r) => tx('readwrite', (s) => s.put(r)),
    del: (k) => tx('readwrite', (s) => s.delete(k)),
  };
}
