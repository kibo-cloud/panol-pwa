import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, effectivePermissions, DEFAULT_PERMS } from '../../src/domain/permissions.js';
import { PERM_KEYS, ROLE_KEYS } from '../../src/domain/constants.js';

test('roles y claves de permiso de 2.1 más gerencia y supervisor', () => {
  assert.deepEqual(ROLE_KEYS, ['admin', 'gerencia', 'supervisor', 'responsable', 'consulta']);
  assert.deepEqual(PERM_KEYS, ['controls_do', 'movements_do', 'techs_edit', 'shift_change', 'tools_edit', 'inventory_edit', 'alerts_resolve', 'shifts_edit', 'reports_export', 'demo_manage', 'plantillas_edit', 'plantilla_rotate', 'lineas_edit', 'kits_edit', 'records_delete', 'movements_void', 'novedades_view', 'novedades_create', 'novedades_edit']);
});

test('etapa 2: plantillas, rotación y líneas son solo de admin por defecto', () => {
  for (const p of ['plantillas_edit', 'plantilla_rotate', 'lineas_edit', 'kits_edit', 'records_delete', 'movements_void', 'novedades_edit']) {
    for (const r of ['gerencia', 'supervisor', 'responsable', 'consulta']) assert.equal(can(r, p), false, r + ' ' + p);
    assert.equal(can('admin', p), true);
  }
});

test('admin puede todo, aunque haya un override en contra', () => {
  for (const p of PERM_KEYS) assert.equal(can('admin', p, { admin: { [p]: false } }), true);
});

test('valores por defecto como en 2.1', () => {
  assert.equal(can('responsable', 'controls_do'), true);
  assert.equal(can('responsable', 'movements_do'), true);
  assert.equal(can('responsable', 'alerts_resolve'), true);
  assert.equal(can('responsable', 'reports_export'), true);
  assert.equal(can('responsable', 'techs_edit'), false);
  assert.equal(can('consulta', 'reports_export'), true);
  assert.equal(can('consulta', 'controls_do'), false);
});

test('etapa 6: ver y cargar novedades, por defecto para quien opera el pañol', () => {
  for (const p of ['novedades_view', 'novedades_create']) {
    for (const r of ['admin', 'supervisor', 'responsable']) assert.equal(can(r, p), true, r + ' ' + p);
    for (const r of ['gerencia', 'consulta']) assert.equal(can(r, p), false, r + ' ' + p);
  }
});

test('supervisor = responsable + shift_change; gerencia = solo reports_export', () => {
  for (const p of PERM_KEYS) {
    assert.equal(can('supervisor', p), can('responsable', p) || p === 'shift_change', p);
    assert.equal(can('gerencia', p), p === 'reports_export', p);
  }
  assert.equal(DEFAULT_PERMS.supervisor.shift_change, true);
});

test('override por rol gana sobre el valor por defecto', () => {
  const ov = { consulta: { controls_do: true }, responsable: { reports_export: false } };
  assert.equal(can('consulta', 'controls_do', ov), true);
  assert.equal(can('responsable', 'reports_export', ov), false);
  assert.equal(can('responsable', 'controls_do', ov), true);
});

test('rol o permiso desconocido: no', () => {
  assert.equal(can('otro', 'controls_do'), false);
  assert.equal(can('responsable', 'nada'), false);
  assert.equal(can(undefined, 'controls_do'), false);
});

test('effectivePermissions lista todas las claves', () => {
  const e = effectivePermissions('gerencia', {});
  assert.deepEqual(Object.keys(e), PERM_KEYS);
  assert.equal(e.reports_export, true);
});
