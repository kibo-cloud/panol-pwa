// Líneas de producción, sectores y cajas compartidas (etapa 2).
// Una herramienta se asigna a un técnico o a una caja (nunca a los dos): el "poseedor".
// La caja pertenece a una línea o sector y tiene un técnico referente responsable.
import { DomainError, tooLong } from './errors.js';
import { LIM } from './constants.js';

const fail = (msg, code = 'invalid_input') => {
  throw new DomainError(msg, code, 422);
};
const trim = (v) => String(v ?? '').trim();

export const LINEA_KINDS = ['linea', 'sector'];

// Clave única de un poseedor (técnico o caja) para agrupar controles y asignaciones. Los
// técnicos conservan su id (como en 2.1); las cajas llevan el prefijo `caja:`.
export const holderKey = (x) => (x.cajaId ? `caja:${x.cajaId}` : x.techId);

export const sameHolder = (a, h) => (a.techId ?? null) === (h.techId ?? null) && (a.cajaId ?? null) === (h.cajaId ?? null);

export function cleanLinea(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.name !== undefined) {
    out.name = trim(input.name);
    if (out.name.length < 2) fail('Ingresá un nombre.');
    tooLong(out.name, LIM.name, 'El nombre');
  }
  if (!partial || input.kind !== undefined) {
    if (!LINEA_KINDS.includes(input.kind)) fail('Elegí si es una línea o un sector.');
    out.kind = input.kind;
  }
  return out;
}

export function cleanCaja(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.name !== undefined) {
    out.name = trim(input.name);
    if (out.name.length < 2) fail('Ingresá un nombre.');
    tooLong(out.name, LIM.name, 'El nombre');
  }
  return out;
}
