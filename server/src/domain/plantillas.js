// Plantillas por supervisor (reemplazan a los turnos fijos de 2.1).
// La pertenencia de un técnico es una lista de rangos [desde, hasta) sin superposición
// (tabla tech_plantilla_history): `desde` nulo = desde siempre, `hasta` nulo = abierto.
// La plantilla efectiva en una fecha es el único rango que la cubre. Una cobertura temporal
// es un rango con `hasta` y `temporary`; el técnico vuelve solo a su plantilla base porque
// después del rango temporal hay otro rango abierto con la plantilla base (sin tareas
// programadas). Un rango con desde = hasta queda anulado (corrección del mismo día).
import { DomainError, tooLong } from './errors.js';
import { LIM } from './constants.js';
import { can } from './permissions.js';
import { validDay } from './catalog.js';
import { daysIn, pad } from './period.js';

const fail = (msg, code = 'invalid_input') => {
  throw new DomainError(msg, code, 422);
};
const trim = (v) => String(v ?? '').trim();

export const covers = (r, day) => (r.validFrom == null || r.validFrom <= day) && (r.validTo == null || day < r.validTo);

// Rangos ordenados por fecha desde (el de "desde siempre" primero).
export const sortRanges = (ranges) => ranges.slice().sort((a, b) => (a.validFrom ?? '').localeCompare(b.validFrom ?? '') || (a.validTo ?? '9999').localeCompare(b.validTo ?? '9999'));

export function effectiveRange(ranges, day) {
  return (ranges || []).find((r) => covers(r, day)) || null;
}

// Plan de un cambio de plantilla (o de una cobertura temporal si viene `until`).
// ranges: historial del técnico. Devuelve { close, inserts, fromPlantillaId }.
export function planMove(ranges, { techId, targetId, from, until = null, reason }, { newId }) {
  if (!targetId) fail('Elegí la plantilla destino.', 'invalid_plantilla');
  if (!validDay(from)) fail('La fecha desde no es válida.', 'invalid_date');
  if (until != null && until !== '') {
    if (!validDay(until)) fail('La fecha hasta no es válida.', 'invalid_date');
    if (until <= from) fail('La fecha hasta tiene que ser posterior a la fecha desde.', 'invalid_date');
  } else until = null;
  const why = trim(reason);
  if (!why) fail('Ingresá el motivo.');
  tooLong(why, LIM.text, 'El motivo');

  const sorted = sortRanges(ranges || []);
  const open = sorted.find((r) => r.validTo == null) || null;
  const coverage = activeCoverage(sorted, open, from);
  if (coverage) {
    // Durante una cobertura (en curso o programada): otra cobertura no; un cambio definitivo
    // sí, desde el comienzo de la cobertura. La cobertura termina en la fecha del cambio y la
    // vuelta automática a la base se anula (se cierra en su propio comienzo).
    if (until) fail(`El técnico tiene una cobertura temporal hasta el ${coverage.validTo}. Para otra cobertura, elegí una fecha desde el ${coverage.validTo} en adelante, o hacé un cambio definitivo.`, 'coverage_active');
    if (from < coverage.validFrom) fail(`El técnico tiene cambios de plantilla desde el ${coverage.validFrom}: la fecha desde no puede ser anterior al ${coverage.validFrom}.`, 'move_before_last');
    return {
      shorten: { id: coverage.id, validTo: from },
      close: { id: open.id, validTo: open.validFrom },
      inserts: [{ id: newId('ph'), techId, plantillaId: targetId, validFrom: from, validTo: null, temporary: false, reason: why }],
      fromPlantillaId: coverage.plantillaId,
      cancelledReturn: { plantillaId: open.plantillaId, from: open.validFrom },
    };
  }
  // Solo se cambia desde el último tramo en adelante: el historial anterior no se reescribe.
  const last = open || sorted.filter((r) => r.validTo != null).sort((a, b) => b.validTo.localeCompare(a.validTo))[0] || null;
  const floor = open ? open.validFrom : last ? last.validTo : null;
  if (floor && from < floor) fail(`El técnico tiene cambios de plantilla desde el ${floor}: la fecha desde no puede ser anterior al ${floor}.`, 'move_before_last');
  if (open && open.plantillaId === targetId) fail('El técnico ya está en esa plantilla.', 'same_plantilla');

  const inserts = [{ id: newId('ph'), techId, plantillaId: targetId, validFrom: from, validTo: until, temporary: !!until, reason: why }];
  if (until && open) {
    inserts.push({ id: newId('ph'), techId, plantillaId: open.plantillaId, validFrom: until, validTo: null, temporary: false, reason: 'Vuelve de la cobertura temporal' });
  }
  return { shorten: null, close: open ? { id: open.id, validTo: from } : null, inserts, fromPlantillaId: open ? open.plantillaId : null, cancelledReturn: null };
}

// Cobertura que sigue vigente (o todavía no empezó) en `day`: el rango temporal no anulado que
// termina donde empieza la vuelta automática (el rango abierto), con fin posterior a `day`.
export function activeCoverage(sorted, open, day) {
  if (!open || open.validFrom == null) return null;
  return sorted.find((r) => r.temporary && r.validTo === open.validFrom && r.validFrom != null && r.validFrom < r.validTo && day < r.validTo) || null;
}

// Rotación de la plantilla completa: cambia el turno actual (dato informativo).
export function planRotation({ labels, current, label, from, today }) {
  const l = trim(label);
  if (!labels.includes(l)) fail('Elegí un turno de la lista.', 'invalid_shift_label');
  if (l === current) fail('La plantilla ya está en ese turno.', 'same_shift_label');
  const day = from == null || from === '' ? today : from;
  if (!validDay(day)) fail('La fecha de la rotación no es válida.', 'invalid_date');
  if (day > today) fail('La fecha de la rotación no puede ser futura.', 'invalid_date');
  return { label: l, from: day };
}

// Rota quien tiene plantilla_rotate o el supervisor de esa plantilla (si su perfil puede
// operar: consulta y gerencia son de solo lectura).
export function canRotate(actor, plantilla, overrides) {
  if (can(actor.role, 'plantilla_rotate', overrides)) return true;
  return actor.role === 'supervisor' && !!plantilla && plantilla.supervisorUserId === actor.id;
}

export const defaultPlantillaName = (supervisorName) => `Plantilla de ${supervisorName}`;

export function cleanPlantillaName(name, supervisorName) {
  let n = trim(name);
  if (!n && supervisorName) n = defaultPlantillaName(trim(supervisorName));
  if (n.length < 2) fail('Ingresá un nombre o elegí un supervisor.');
  tooLong(n, LIM.name, 'El nombre');
  return n;
}

// Lista configurable de turnos (rótulos informativos).
export function cleanShiftLabels(list) {
  if (!Array.isArray(list) || !list.length || list.length > 20) fail('Ingresá entre 1 y 20 turnos.');
  const out = [];
  for (const x of list) {
    const l = trim(x);
    if (l.length < 2) fail('Cada turno necesita un nombre.');
    tooLong(l, LIM.name, 'El nombre del turno');
    if (out.some((y) => y.toLowerCase() === l.toLowerCase())) fail(`El turno ${l} está repetido.`);
    out.push(l);
  }
  return out;
}

// Historial -> cambios de turno de 2.1 (`shiftChanges` del .txt v2): un cambio por cada rango
// con fecha desde (el de "desde siempre" no es un cambio). Los anulados no salen.
// byTech: { techId: ranges }, names: { plantillaId: nombre }.
export function shiftChangesFromHistory(byTech, names) {
  const out = {};
  for (const [techId, ranges] of Object.entries(byTech)) {
    const live = sortRanges(ranges).filter((r) => !(r.validFrom != null && r.validTo != null && r.validTo <= r.validFrom));
    live.forEach((r, i) => {
      if (r.validFrom == null) return;
      const prev = i > 0 && live[i - 1].validTo === r.validFrom ? live[i - 1] : null;
      out[r.id] = {
        techId,
        from: prev ? prev.plantillaId : null,
        to: r.plantillaId,
        fromName: prev ? names[prev.plantillaId] ?? '' : '',
        toName: names[r.plantillaId] ?? '',
        effectiveFrom: r.validFrom,
        note: r.reason || '',
        at: r.createdAt,
        by: r.by ?? null,
        demo: !!r.demo,
      };
    });
  }
  return out;
}

// Último día (fecha local) de la semana de un período.
export function periodEndDay(p) {
  const d = p.w < 4 ? p.w * 7 : daysIn(p.y, p.m);
  return `${p.y}-${pad(p.m)}-${pad(d)}`;
}

// Fecha con la que se toma la plantilla de un control: la del día en que se hace, salvo que
// sea un período ya terminado (entonces, el último día de esa semana).
export function controlRefDate(period, today) {
  const end = periodEndDay(period);
  return today < end ? today : end;
}

// Plantilla con la que un técnico entra en un informe de un período: la foto del último
// control del período; si no hay control, la del historial en `day`; si no, la actual.
export function reportPlantillaOf(tech, { lastControl, hist, day }) {
  if (lastControl && lastControl.plantillaId) return lastControl.plantillaId;
  const r = effectiveRange((hist || {})[tech.id], day);
  if (r) return r.plantillaId;
  return tech.shiftId ?? null;
}
