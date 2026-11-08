// Informe por mes/semana, turno y técnico (portado de computeReport() de 2.1). Usa el resultado
// de deriveState(). Las fechas se comparan con la hora local de la empresa.
import { MONTHS } from './constants.js';
import { pad, pnumOf, parsePkey, weekRange, zonedDate, daysIn, plabel } from './period.js';

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

// f: { ym: 'YYYY-MM', w: 'all'|'1'..'4', shift: 'all'|id, tech: 'all'|id }
export function computeReport(d, filters = {}) {
  const f = {
    ym: filters.ym || `${d.cur.y}-${pad(d.cur.m)}`,
    w: filters.w || 'all',
    shift: filters.shift || 'all',
    tech: filters.tech || 'all',
  };
  const [y, m] = f.ym.split('-').map(Number);
  const weeks = f.w === 'all' ? [1, 2, 3, 4] : [+f.w];
  const range = f.w === 'all' ? monthRange(y, m) : weekRange({ y, m, w: +f.w });
  const started = weeks.filter((w) => pnumOf({ y, m, w }) <= d.curNum);
  const shiftName = (id) => (d.shiftById[id] ? d.shiftById[id].name : 'Sin turno');
  const recovered = (x) => x.from === 'faltante' && x.to !== 'faltante';

  const ts = d.activeTechs.filter((t) => (f.shift === 'all' || t.shiftId === f.shift) && (f.tech === 'all' || t.id === f.tech));
  const rows = ts.map((t) => {
    const cs = (d.effByTech[t.id] || []).filter((c) => c.period.y === y && c.period.m === m && weeks.includes(c.period.w));
    const last = cs[cs.length - 1];
    const cn = last ? last.counts : null;
    const i = d.techInfo[t.id];
    const ok = cn ? cn.bueno : i.bueno;
    const ch = cn ? cn.cambio : i.cambio;
    const fa = cn ? cn.faltante : i.faltante;
    const den = ok + ch + fa;
    const repos = d.movs.filter((x) => x.techId === t.id && x.type === 'reposicion' && inRange(x.at, range)).length;
    const recup = d.transitions.filter((x) => x.techId === t.id && recovered(x) && inPeriod(x.pkey, y, m, weeks)).length;
    return {
      id: t.id, name: t.name, legajo: t.legajo, shiftId: t.shiftId, shift: shiftName(t.shiftId), total: i.total,
      bueno: ok, cambio: ch, faltante: fa, pct: den ? Math.round((ok / den) * 100) : null, ctl: cs.length, expected: started.length,
      repos, recup, fromControl: !!last,
    };
  });

  const shifts = d.shifts.filter((s) => f.shift === 'all' || s.id === f.shift).map((s) => {
    const rs = rows.filter((r) => r.shiftId === s.id);
    const sum = (k) => rs.reduce((a, r) => a + r[k], 0);
    const den = sum('bueno') + sum('cambio') + sum('faltante');
    return {
      id: s.id, name: s.name, techs: rs.length, total: sum('total'), bueno: sum('bueno'), cambio: sum('cambio'), faltante: sum('faltante'),
      pct: den ? Math.round((sum('bueno') / den) * 100) : null, ctl: sum('ctl'), pend: Math.max(0, rs.length * started.length - sum('ctl')), repos: sum('repos'),
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
      repos: d.movs.filter((x) => ids.has(x.techId) && x.type === 'reposicion' && inRange(x.at, r)).length,
      recup: d.transitions.filter((x) => ids.has(x.techId) && recovered(x) && inPeriod(x.pkey, yy, mo)).length,
    };
  });

  const techById = Object.fromEntries(d.techs.map((t) => [t.id, t]));
  const label = `${f.w === 'all' ? mlabel(y, m) : plabel({ y, m, w: +f.w })}${f.shift !== 'all' ? ', ' + shiftName(f.shift) : ''}${f.tech !== 'all' && techById[f.tech] ? ', ' + techById[f.tech].name : ''}`;
  const T = (k) => rows.reduce((a, r) => a + r[k], 0);
  const den = T('bueno') + T('cambio') + T('faltante');
  const totals = { techs: rows.length, total: T('total'), bueno: T('bueno'), cambio: T('cambio'), faltante: T('faltante'), pct: den ? Math.round((T('bueno') / den) * 100) : 0, repos: T('repos') };
  return { f, y, m, rows, shifts, evo, label, started, totals };
}
