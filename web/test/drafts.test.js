// Borrador del control guardado en el equipo y reenviado al volver la conexión.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftKey, nextDraft, requestFor, flushDrafts, memoryStore } from '../src/state/drafts.js';

const P = { y: 2026, m: 11, w: 2 };
const base = { techId: 't-ana', period: P, items: { a1: { state: 'bueno', note: '' } } };
const fail = (kind) => Object.assign(new Error(kind), { kind });

test('una clave por técnico y período; la corrección agrega el control corregido', () => {
  assert.equal(draftKey('t-ana', P), 't-ana|2026-11-2');
  assert.equal(draftKey('t-ana', P, 'c-1'), 't-ana|2026-11-2|corr-c-1');
});

test('mismo contenido conserva la clave de idempotencia; contenido nuevo usa otra', () => {
  const r1 = nextDraft(null, base, 'key-1');
  assert.equal(r1.idemKey, 'key-1');
  assert.equal(r1.key, 't-ana|2026-11-2');
  const r2 = nextDraft(r1, { ...base, items: { a1: { state: 'bueno', note: '' } } }, 'key-2');
  assert.equal(r2.idemKey, 'key-1');
  const r3 = nextDraft(r2, { ...base, items: { a1: { state: 'cambio', note: 'x' } } }, 'key-3');
  assert.equal(r3.idemKey, 'key-3');
  const r4 = nextDraft(r3, { ...base, items: r3.items, controlId: 'c1', version: 1 }, 'key-4');
  assert.equal(r4.idemKey, 'key-4');
});

test('sin control en el servidor se crea; con control se guarda con su versión', () => {
  assert.deepEqual(requestFor(nextDraft(null, base, 'k1')), { kind: 'create', body: { techId: 't-ana', period: P, items: base.items }, idempotencyKey: 'k1' });
  assert.deepEqual(requestFor(nextDraft(null, { ...base, correctionOf: 'c-0' }, 'k2')).body, { correctionOf: 'c-0', items: base.items });
  // Caja compartida: la clave del poseedor es caja:<id> y el pedido manda cajaId.
  const caja = nextDraft(null, { ...base, techId: 'caja:k-1' }, 'k3');
  assert.equal(caja.key, 'caja:k-1|' + caja.pkey);
  assert.deepEqual(requestFor(caja).body, { cajaId: 'k-1', period: P, items: base.items });
  assert.deepEqual(requestFor(nextDraft(null, { ...base, controlId: 'c1', version: 4 }, 'k3')), { kind: 'save', id: 'c1', items: base.items, version: 4, idempotencyKey: 'k3' });
});

test('al volver la conexión se envían con su clave y se borran del equipo', async () => {
  const st = memoryStore();
  await st.put(nextDraft(null, base, 'k1'));
  await st.put(nextDraft(null, { ...base, techId: 't-bruno' }, 'k2'));
  const sent = [];
  const out = await flushDrafts(st, async (req) => { sent.push(req.idempotencyKey); return { id: 'c-' + req.idempotencyKey, version: 1 }; });
  assert.deepEqual(sent.sort(), ['k1', 'k2']);
  assert.equal(out.sent.length, 2);
  assert.deepEqual(await st.all(), []);
});

test('si sigue sin conexión se corta y no se pierde nada', async () => {
  const st = memoryStore();
  await st.put(nextDraft(null, base, 'k1'));
  const out = await flushDrafts(st, async () => { throw fail('network'); });
  assert.equal(out.stopped, true);
  assert.equal((await st.all()).length, 1);
});

test('un conflicto deja el borrador marcado y no se vuelve a mandar solo', async () => {
  const st = memoryStore();
  await st.put(nextDraft(null, { ...base, controlId: 'c1', version: 1 }, 'k1'));
  let calls = 0;
  const send = async () => { calls++; throw fail('conflict'); };
  const out = await flushDrafts(st, send);
  assert.equal(out.conflicts.length, 1);
  assert.equal((await st.get('t-ana|2026-11-2')).conflict, true);
  await flushDrafts(st, send);
  assert.equal(calls, 1);
});

test('un rechazo (422/400) no borra el borrador: queda marcado para revisar con el mensaje', async () => {
  const st = memoryStore();
  await st.put(nextDraft(null, base, 'k1'));
  let calls = 0;
  const send = async () => { calls++; throw Object.assign(fail('validation'), { message: 'Elegí un técnico activo.' }); };
  const out = await flushDrafts(st, send);
  assert.equal(out.review.length, 1);
  const rec = await st.get('t-ana|2026-11-2');
  assert.ok(rec, 'el borrador sigue en el equipo');
  assert.deepEqual(rec.review, { message: 'Elegí un técnico activo.' });
  assert.deepEqual(rec.items, base.items);
  // No se reenvía solo: espera que la persona lo corrija o lo descarte.
  await flushDrafts(st, send);
  assert.equal(calls, 1);
  // Al guardarlo de nuevo se quita la marca (y se vuelve a enviar).
  const again = nextDraft(rec, { ...base, items: { a1: { state: 'cambio', note: 'x' } } }, 'k2');
  assert.equal(again.review, undefined);
  // Not found y forbidden tampoco lo borran.
  const st2 = memoryStore();
  await st2.put(nextDraft(null, base, 'k3'));
  await flushDrafts(st2, async () => { throw fail('not_found'); });
  assert.equal((await st2.all()).length, 1);
});

test('un error del servidor (500) se informa y el borrador queda para otro intento', async () => {
  const st = memoryStore();
  await st.put(nextDraft(null, base, 'k1'));
  const out = await flushDrafts(st, async () => { throw fail('server'); });
  assert.equal(out.failed.length, 1);
  assert.equal((await st.all()).length, 1);
});
