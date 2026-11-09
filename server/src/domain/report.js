// Informe por mes/semana, turno y técnico (portado de computeReport() de 2.1). Usa el resultado
// de deriveState(). Las fechas se comparan con la hora local de la empresa.
import { MONTHS } from './constants.js';
import { pad, pnumOf, parsePkey, weekRange, zonedDate, daysIn, plabel, localDateISO } from './period.js';
import { reportPlantillaOf } from './plantillas.js';
import { asgUnits, hasMissing, hasChange } from './controls.js';
import { holderKey } from './lineas.js';
import { voidedIds } from './alerts.js';

// Limpieza de los controles efectivos del período: limpios, que requieren limpieza y el % limpio
// (null sin datos; los controles viejos no tienen dato y no cuentan).
const cleaningOf = (cs) => {
  const limpio = cs.filter((c) => c.cleaning && c.cleaning.status === 'limpio').length;
  const sucio = cs.filter((c) => c.cleaning && c.cleaning.status === 'requiere_limpieza').length;
  return { limpio, sucio, pctLimpio: limpio + sucio ? Math.round((limpio / (limpio + sucio)) * 100) : null };
};

export const prevMonth = (y, m) => (m > 1 ? { y, m: m - 1 } : { y: y - 1, m: 12 });
export const monthRange = (y, m) => [zonedDate(y, m, 1), zonedDate(y, m, daysIn(y, m), 23, 59, 59, 999)];
export const mlabel = (y, m) => `${MONTHS[m - 1]} ${y}`;

export function inRange(iso, [a, b]) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= a.getTime() && t <= b.getTime();
}

const inPeriod = (pkey, y, m, weeks) => {
  const p = parsePkey(pkey);
  return p.y === y && p.m === m && (!weeks || weeks.includes(p.w));
};

// f: { ym: 'YYYY-MM', w: 'all'|'1'..'4', shift: 'all'|id, tech: 'all'|id, especialidad: 'all'|'none'|id }
// Etapa 4: unidades (% en condiciones = en buen estado / unidades controladas; "para recambio"
// nunca cuenta como faltante), % limpio y `lineas`: faltantes y recambios del último control del
// período de cada poseedor, por la línea indicada en el ítem (`id` null = sin línea). Las cajas
// entran en `lineas` solo sin filtro de técnico, plantilla ni especialidad.
// Etapa 3: filtro y columna de especialidad, y `tools`: las herramientas asignadas a los técnicos
// del informe, en el orden personalizado (estado actual de cada asignación).
// La plantilla de cada técnico es la del período (foto del último control, o el historial al
// final del período), así un informe viejo no cambia cuando alguien se mueve de plantilla.
// `plantilla` es otro nombre del filtro `shift`.
export function computeReport(d, filters = {}) {
  // Etapa 5: una reposición anulada no cuenta.
  const voided = voidedIds(d.movs || []);
  const f = {
    ym: filters.ym || `${d.cur.y}-${pad(d.cur.m)}`,
    w: filters.w || 'all',
    shift: filters.plantilla || filters.shift || 'all',
    tech: filters.tech || 'all',
    especialidad: filters.especialidad || 'all',
  };
  const espOf = (t) => t.especialidadId || null;
  const espOk = (t) => f.especialidad === 'all' || (f.especialidad === 'none' ? !espOf(t) : espOf(t) === f.especialidad);
  const espById = d.especialidadById || {};
  const espName = (id) => (id && espById[id] ? espById[id].name : '');
  const [y, m] = f.ym.split('-').map(Number);
  const weeks = f.w === 'all' ? [1, 2, 3, 4] : [+f.w];
  const range = f.w === 'all' ? monthRange(y, m) : weekRange({ y, m, w: +f.w });
  const started = weeks.filter((w) => pnumOf({ y, m, w }) <= d.curNum);
  const byId = d.plantillaById || d.shiftById;
  const shiftName = (id) => (byId[id] ? byId[id].name : 'Sin turno');
  const recovered = (x) => x.from === 'faltante' && x.to !== 'faltante';
  const endDay = localDateISO(range[1]);
  const today = d.today || endDay;
  const day = endDay < today ? endDay : today;

  const lastOf = (t) => {
    const cs = (d.effByTech[t.id] || []).filter((c) => c.period.y === y && c.period.m === m && weeks.includes(c.period.w));
    return { cs, last: cs[cs.length - 1] };
  };
  const plOf = (t) => reportPlantillaOf(t, { lastControl: lastOf(t).last, hist: d.plantillaHist, day });
  const ts = d.activeTechs.filter((t) => (f.tech === 'all' || t.id === f.tech) && (f.shift === 'all' || plOf(t) === f.shift) && espOk(t));
  const rows = ts.map((t) => {
    const { cs, last } = lastOf(t);
    const pid = plOf(t);
    const cn = last ? last.counts : null;
    const i = d.techInfo[t.id];
    const ok = cn ? cn.bueno : i.bueno;
    const ch = cn ? cn.cambio : i.cambio;
    const fa = cn ? cn.faltante : i.faltante;
    const den = ok + ch + fa;
    const repos = d.movs.filter((x) => x.techId === t.id && x.type === 'reposicion' && !voided.has(x.id) && inRange(x.at, range)).length;
    const recup = d.transitions.filter((x) => x.techId === t.id && recovered(x) && inPeriod(x.pkey, y, m, weeks)).length;
    return {
      id: t.id, name: t.name, legajo: t.legajo, shiftId: pid, plantillaId: pid, shift: shiftName(pid), especialidadId: espOf(t), especialidad: espName(espOf(t)), total: i.total,
      bueno: ok, cambio: ch, faltante: fa, pct: den ? Math.round((ok / den) * 100) : null, ctl: cs.length, expected: started.length,
      repos, recup, fromControl: !!last, ...cleaningOf(cs),
    };
  });

  // Grupos: las plantillas activas y las archivadas que aparecen en el período.
  const groups = [...d.shifts];
  for (const r of rows) if (r.shiftId && !groups.some((g) => g.id === r.shiftId) && byId[r.shiftId]) groups.push(byId[r.shiftId]);
  const shifts = groups.filter((s) => f.shift === 'all' || s.id === f.shift).map((s) => {
    const rs = rows.filter((r) => r.shiftId === s.id);
    const sum = (k) => rs.reduce((a, r) => a + r[k], 0);
    const den = sum('bueno') + sum('cambio') + sum('faltante');
    return {
      id: s.id, name: s.name, techs: rs.length, total: sum('total'), bueno: sum('bueno'), cambio: sum('cambio'), faltante: sum('faltante'),
      pct: den ? Math.round((sum('bueno') / den) * 100) : null, ctl: sum('ctl'), pend: Math.max(0, rs.length * started.length - sum('ctl')), repos: sum('repos'),
      limpio: sum('limpio'), sucio: sum('sucio'), pctLimpio: sum('limpio') + sum('sucio') ? Math.round((sum('limpio') / (sum('limpio') + sum('sucio'))) * 100) : null,
    };
  });

  const ids = new Set(ts.map((t) => t.id));
  const ms = [];
  let mm = { y, m };
  for (let i = 0; i < 6; i++) {
    ms.unshift(mm);
    mm = prevMonth(mm.y, mm.m);
  }
  const evo = ms.map(({ y: yy, m: mo }) => {
    let cam = 0;
    let fal = 0;
    let ctl = 0;
    for (const id of ids) {
      const cs = (d.effByTech[id] || []).filter((c) => c.period.y === yy && c.period.m === mo);
      ctl += cs.length;
      const last = cs[cs.length - 1];
      if (last) {
        cam += last.counts.cambio;
        fal += last.counts.faltante;
      }
    }
    const r = monthRange(yy, mo);
    return {
      label: MONTHS[mo - 1].slice(0, 3) + ' ' + String(yy).slice(2), y: yy, m: mo, cambio: cam, faltante: fal, ctl,
      repos: d.movs.filter((x) => ids.has(x.techId) && x.type === 'reposicion' && !voided.has(x.id) && inRange(x.at, r)).length,
      recup: d.transitions.filter((x) => ids.has(x.techId) && recovered(x) && inPeriod(x.pkey, yy, mo)).length,
    };
  });

  const techById = Object.fromEntries(d.techs.map((t) => [t.id, t]));
  const label = `${f.w === 'all' ? mlabel(y, m) : plabel({ y, m, w: +f.w })}${f.shift !== 'all' ? ', ' + shiftName(f.shift) : ''}${f.tech !== 'all' && techById[f.tech] ? ', ' + techById[f.tech].name : ''}${f.especialidad === 'none' ? ', sin especialidad' : f.especialidad !== 'all' ? ', ' + (espName(f.especialidad) || 'especialidad') : ''}`;
  const T = (k) => rows.reduce((a, r) => a + r[k], 0);
  const den = T('bueno') + T('cambio') + T('faltante');
  const cl = T('limpio') + T('sucio');
  const totals = {
    techs: rows.length, total: T('total'), bueno: T('bueno'), cambio: T('cambio'), faltante: T('faltante'), pct: den ? Math.round((T('bueno') / den) * 100) : 0, repos: T('repos'),
    limpio: T('limpio'), sucio: T('sucio'), pctLimpio: cl ? Math.round((T('limpio') / cl) * 100) : null,
  };
  // Herramientas en el orden personalizado, con el estado actual de sus asignaciones.
  const toolRows = [];
  for (const tool of d.tools) {
    const s = { bueno: 0, cambio: 0, faltante: 0, pendiente: 0, total: 0 };
    for (const id of ids) for (const a of d.asgByTech[id] || []) {
      if (a.toolId !== tool.id) continue;
      const q = a.qty || 1;
      const u = asgUnits(d.stateOf[a.id], q);
      for (const k of ['bueno', 'cambio', 'faltante', 'pendiente']) s[k] += u[k];
      s.total += q;
    }
    if (s.total) toolRows.push({ id: tool.id, name: tool.name, categoryId: tool.categoryId ?? null, ...s });
  }
  // Faltantes y recambios por línea (último control efectivo del período de cada poseedor).
  const withCajas = f.tech === 'all' && f.shift === 'all' && f.especialidad === 'all';
  const lastByHolder = {};
  for (const c of d.effList) {
    if (c.period.y !== y || c.period.m !== m || !weeks.includes(c.period.w)) continue;
    if (c.cajaId ? !withCajas : !ids.has(c.techId)) continue;
    lastByHolder[holderKey(c)] = c;
  }
  const byLinea = {};
  for (const c of Object.values(lastByHolder)) {
    for (const it of Object.values(c.items || {})) {
      if (!hasMissing(it) && !hasChange(it)) continue;
      const k = it.lineaId || '';
      const g = (byLinea[k] ||= { faltante: 0, cambio: 0 });
      g.faltante += it.missing ?? (it.state === 'faltante' ? it.qty || 1 : 0);
      g.cambio += it.change ?? (it.state === 'cambio' ? it.qty || 1 : 0);
    }
  }
  const lineaList = d.lineas || [];
  const lineas = [
    ...lineaList.filter((l) => byLinea[l.id]).map((l) => ({ id: l.id, name: l.name, kind: l.kind, ...byLinea[l.id] })),
    ...Object.keys(byLinea).filter((k) => k && !lineaList.some((l) => l.id === k)).map((k) => ({ id: k, name: k, kind: null, ...byLinea[k] })),
    ...(byLinea[''] ? [{ id: null, name: 'Sin línea', kind: null, ...byLinea[''] }] : []),
  ];
  return { f, y, m, rows, shifts, plantillas: shifts, evo, label, started, totals, tools: toolRows, lineas };
}
