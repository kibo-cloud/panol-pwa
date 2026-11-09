// Etapa 5: reglas puras de eliminar, restaurar y eliminación definitiva.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanReason, checkConfirmName, planResolutions, ownActions, RECORD_TYPE_KEYS } from '../../src/domain/records.js';

test('tipos que se eliminan con el mismo modelo', () => {
  assert.deepEqual(RECORD_TYPE_KEYS, ['techs', 'cajas', 'tools', 'categories', 'plantillas', 'lineas', 'especialidades', 'kits', 'users']);
  assert.deepEqual(ownActions('techs'), ['tech_create', 'tech_archive', 'tech_restore']);
});

test('el motivo es obligatorio y tiene límite', () => {
  assert.throws(() => cleanReason('  '), /Indicá el motivo/);
  assert.equal(cleanReason('  Cargado por error '), 'Cargado por error');
  assert.throws(() => cleanReason('x'.repeat(2001)), /hasta 2000/);
});

test('la eliminación definitiva pide el nombre exacto', () => {
  assert.throws(() => checkConfirmName('Ana Prueba', 'ana prueba'), (e) => e.code === 'confirm_name' && /Ana Prueba/.test(e.message));
  assert.doesNotThrow(() => checkConfirmName('Ana Prueba', ' Ana Prueba '));
});

test('cada asignación activa se resuelve con una devolución o un retiro', () => {
  const active = [{ id: 'a1', toolName: 'Pinza', qty: 2 }, { id: 'a2', toolName: 'Taladro', qty: 1, unitCode: 'TAL-001' }];
  assert.throws(() => planResolutions(active, [{ assignmentId: 'a1', action: 'devolucion' }]), (e) => e.code === 'pending_assignments' && e.status === 409 && e.extra.pending.length === 1 && e.extra.pending[0].id === 'a2');
  assert.throws(() => planResolutions(active, [{ assignmentId: 'zz', action: 'retiro' }]), (e) => e.code === 'invalid_resolution');
  assert.throws(() => planResolutions(active, [{ assignmentId: 'a1', action: 'devolucion', cond: 'retirado' }, { assignmentId: 'a2', action: 'retiro' }]), /condición/);
  assert.throws(() => planResolutions(active, [{ assignmentId: 'a1', action: 'retiro' }, { assignmentId: 'a1', action: 'retiro' }]), /repetida/);
  assert.deepEqual(planResolutions(active, [{ assignmentId: 'a1', action: 'devolucion', cond: 'reparacion' }, { assignmentId: 'a2', action: 'retiro' }]), [
    { assignmentId: 'a1', action: 'devolucion', cond: 'reparacion', qty: 2 },
    { assignmentId: 'a2', action: 'retiro', cond: 'retirado', qty: 1 },
  ]);
  assert.deepEqual(planResolutions([], undefined), []);
});
