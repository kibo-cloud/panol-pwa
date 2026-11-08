// Exportación inventada de Pañol 2.1 (.txt v2) para las pruebas del importador. Datos
// inventados; PIN con el mismo PBKDF2 de 2.1. `node server/test/fixtures/v21.js` regenera
// server/test/fixtures/v21-export.txt (para probar a mano con curl).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const HEAD = 'PAÑOL · archivo de datos\r\nGuardalo, compartilo o abrilo desde la app Pañol. No lo edites a mano.\r\n';
export const PINS = { u21admin: '1234', u21resp: '5678', u21cons: '0000' };
const pbkdf2 = (salt, pin) => `pbkdf2$210000$${crypto.pbkdf2Sync(pin, salt, 210000, 32, 'sha256').toString('hex')}`;

const AT = '2026-10-01T12:00:00.000Z';
const T = (d, h = 12) => `2026-${d}T${String(h).padStart(2, '0')}:00:00.000Z`;

let cachedHashes;
function hashes() {
  cachedHashes ||= Object.fromEntries(Object.entries(PINS).map(([id, pin]) => [id, pbkdf2(`salt-${id}`, pin)]));
  return cachedHashes;
}

export function buildV21() {
  const h = hashes();
  const user = (id, name, role) => ({ name, role, active: true, salt: `salt-${id}`, pinHash: h[id], createdAt: AT, updatedAt: AT });
  return {
    app: 'panol', format: 'panol-txt', version: 2, savedAt: T('10-05'),
    data: {
      users: { u21admin: user('u21admin', 'Ana Admin', 'admin'), u21resp: user('u21resp', 'Rocío Núñez', 'responsable'), u21cons: user('u21cons', 'Ana  Admin!', 'consulta') },
      config: {
        turnos: { list: [{ id: 'manana', name: 'Turno mañana', order: 1 }, { id: 'tarde', name: 'Turno tarde', order: 2 }, { id: 'rotativo', name: 'Rotativo', order: 3 }], updatedAt: AT },
        permisos: { responsable: { shift_change: true }, consulta: { reports_export: false }, updatedAt: AT },
      },
      techs: {
        t21a: { name: 'Tomás Uno', legajo: '2101', shiftId: 'manana', active: true, alta: '2026-01-10', createdAt: AT },
        t21b: { name: 'Berta Dos', legajo: 2102, shiftId: 'rotativo', active: true, alta: '', createdAt: AT },
      },
      categories: { g21: { name: 'Manuales', createdAt: AT } },
      tools: {
        h21p: { name: 'Pinza', description: '', categoryId: 'g21', serialized: false, active: true, createdAt: AT },
        h21m: { name: 'Multímetro', description: 'Digital', categoryId: null, serialized: true, active: true, createdAt: AT },
      },
      units: {
        n21m1: { toolId: 'h21m', code: 'M21-001', status: 'asignado', techId: 't21a', createdAt: AT, updatedAt: T('09-02') },
        n21m2: { toolId: 'h21m', code: 'M21-002', status: 'disponible', techId: null, createdAt: AT },
      },
      movements: {
        m21i1: { type: 'ingreso', toolId: 'h21p', qty: 5, transfers: [{ toolId: 'h21p', qty: 5, from: 'externo', to: 'disponible', unitId: null }], notes: 'Compra', at: T('09-01', 9), by: 'u21admin' },
        m21i2: {
          type: 'ingreso', toolId: 'h21m', qty: 2, at: T('09-01', 10), by: 'u21admin',
          transfers: [{ toolId: 'h21m', qty: 1, from: 'externo', to: 'disponible', unitId: 'n21m1' }, { toolId: 'h21m', qty: 1, from: 'externo', to: 'disponible', unitId: 'n21m2' }],
        },
        m21e1: { type: 'entrega_inicial', techId: 't21a', toolId: 'h21p', qty: 1, newAssignmentId: 'a21p', reason: 'Ingreso del técnico', transfers: [{ toolId: 'h21p', qty: 1, from: 'disponible', to: 'asignado', unitId: null }], at: T('09-02', 9) },
        m21e2: { type: 'entrega_inicial', techId: 't21a', toolId: 'h21m', unitId: 'n21m1', newAssignmentId: 'a21m', transfers: [{ toolId: 'h21m', qty: 1, from: 'disponible', to: 'asignado', unitId: 'n21m1' }], at: T('09-02', 10) },
      },
      assignments: {
        a21p: { techId: 't21a', toolId: 'h21p', unitId: null, qty: 1, active: true, since: T('09-02', 9), movementId: 'm21e1', replaces: null },
        a21m: { techId: 't21a', toolId: 'h21m', unitId: 'n21m1', qty: 1, active: true, since: T('09-02', 10), until: '', movementId: 'm21e2', replaces: null },
      },
      controls: {
        c21f: {
          techId: 't21a', techName: 'Tomás Uno', shiftId: 'manana', period: { y: 2026, m: 9, w: 4 }, pkey: '2026-09-4', pnum: 2026094, status: 'finalizado',
          items: { a21p: { state: 'bueno', note: '', toolId: 'h21p', toolName: 'Pinza', category: 'Manuales', unitId: null, unitCode: '', qty: 1 }, a21m: { state: 'cambio', note: 'Display', toolId: 'h21m', toolName: 'Multímetro', category: '', unitId: 'n21m1', unitCode: 'M21-001', qty: 1 } },
          counts: { bueno: 1, cambio: 1, faltante: 0 }, correction: false, supersedes: null, startedAt: T('09-25', 9), finishedAt: T('09-25', 10), updatedAt: T('09-25', 10),
        },
        c21d: { techId: 't21b', techName: 'Berta Dos', shiftId: 'rotativo', period: { y: 2026, m: 10, w: 1 }, pkey: '2026-10-1', status: 'borrador', items: {}, startedAt: '', updatedAt: T('10-02') },
      },
      shiftChanges: { sc21: { techId: 't21b', from: 'manana', to: 'rotativo', fromName: 'Turno mañana', toName: 'Rotativo', effectiveFrom: '2026-09-01', note: '', at: T('09-01', 8) } },
      alertRes: { 'cambio-a21m-c21f': { type: 'cambio', title: 'Multímetro para cambio', text: 'Tomás Uno', techId: 't21a', note: 'Pedido', at: T('09-26') } },
      audit: { l21a: { action: 'tech_create', entity: 'techs', entityId: 't21a', detail: 'Alta de Tomás Uno', at: AT, by: 'u21admin' } },
      deleted: { 'techs/t21gone': T('09-03'), 'categories/g21old': T('09-03') },
    },
  };
}

export const toTxt = (payload) => HEAD + JSON.stringify(payload);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'v21-export.txt');
  fs.writeFileSync(out, toTxt(buildV21()));
  console.log('escrito', out);
}
