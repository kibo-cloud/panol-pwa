// Reportes y estadísticas (igual que 2.1): filtros, KPI, evolución, turnos y técnicos.
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS, UI, render } from '../../ui/registry.js';
import { CH } from '../../ui/actions.js';
import { kpi, pageHead, emptyBox, field, optList, lineChart } from '../../ui/components.js';
import { S, derive, can, shiftName } from '../../state/store.js';
import { MONTHS } from '../../state/constants.js';
import { pad, pnumOf, weekRange, monthRange, inRange, parsePkey, prevMonth, mlabel, plabel } from '../../state/period.js';

export function computeReport() {
  const d = derive(); if (!UI.rep) UI.rep = { ym: `${d.cur.y}-${pad(d.cur.m)}`, w: 'all', shift: 'all', tech: 'all' };
  const f = UI.rep; const [y, m] = f.ym.split('-').map(Number);
  const weeks = f.w === 'all' ? [1, 2, 3, 4] : [+f.w];
  const range = f.w === 'all' ? monthRange(y, m) : weekRange({ y, m, w: +f.w });
  const started = weeks.filter((w) => pnumOf({ y, m, w }) <= d.curNum);
  const ts = d.activeTechs.filter((t) => (f.shift === 'all' || t.shiftId === f.shift) && (f.tech === 'all' || t.id === f.tech));
  const inPer = (x, yy, mo, ws) => { const p = parsePkey(x.pkey); return p.y === yy && p.m === mo && (!ws || ws.includes(p.w)); };
  const rows = ts.map((t) => {
    const cs = (d.effByTech[t.id] || []).filter((c) => c.period.y === y && c.period.m === m && weeks.includes(c.period.w));
    const last = cs[cs.length - 1]; const cn = last ? last.counts : null; const i = d.techInfo[t.id];
    const ok = cn ? cn.bueno : i.bueno, ch = cn ? cn.cambio : i.cambio, fa = cn ? cn.faltante : i.faltante; const den = ok + ch + fa;
    const repos = d.movs.filter((x) => x.techId === t.id && x.type === 'reposicion' && inRange(x.at, range)).length;
    const recup = d.transitions.filter((x) => x.techId === t.id && x.from === 'faltante' && x.to !== 'faltante' && inPer(x, y, m, weeks)).length;
    return { id: t.id, name: t.name, legajo: t.legajo, shiftId: t.shiftId, shift: shiftName(t.shiftId), total: i.total, bueno: ok, cambio: ch, faltante: fa, pct: den ? Math.round(ok / den * 100) : null, ctl: cs.length, expected: started.length, repos, recup, fromControl: !!last };
  });
  const shifts = d.shifts.filter((s) => f.shift === 'all' || s.id === f.shift).map((s) => { const rs = rows.filter((r) => r.shiftId === s.id); const sum = (k) => rs.reduce((a, r) => a + r[k], 0); const den = sum('bueno') + sum('cambio') + sum('faltante'); return { id: s.id, name: s.name, techs: rs.length, total: sum('total'), bueno: sum('bueno'), cambio: sum('cambio'), faltante: sum('faltante'), pct: den ? Math.round(sum('bueno') / den * 100) : null, ctl: sum('ctl'), pend: Math.max(0, rs.length * started.length - sum('ctl')), repos: sum('repos') }; });
  const ids = new Set(ts.map((t) => t.id)); const evo = []; let mm = { y, m }; const ms = []; for (let i = 0; i < 6; i++) { ms.unshift(mm); mm = prevMonth(mm.y, mm.m); }
  for (const { y: yy, m: mo } of ms) {
    let cam = 0, fal = 0, ctl = 0; for (const id of ids) { const cs = (d.effByTech[id] || []).filter((c) => c.period.y === yy && c.period.m === mo); ctl += cs.length; const last = cs[cs.length - 1]; if (last) { cam += last.counts.cambio; fal += last.counts.faltante; } }
    const r = monthRange(yy, mo);
    evo.push({ label: MONTHS[mo - 1].slice(0, 3) + ' ' + String(yy).slice(2), y: yy, m: mo, cambio: cam, faltante: fal, ctl, repos: d.movs.filter((x) => ids.has(x.techId) && x.type === 'reposicion' && inRange(x.at, r)).length, recup: d.transitions.filter((x) => ids.has(x.techId) && x.from === 'faltante' && x.to !== 'faltante' && inPer(x, yy, mo)).length });
  }
  const label = `${f.w === 'all' ? mlabel(y, m) : plabel({ y, m, w: +f.w })}${f.shift !== 'all' ? ', ' + shiftName(f.shift) : ''}${f.tech !== 'all' && S.techs[f.tech] ? ', ' + S.techs[f.tech].name : ''}`;
  return { f, y, m, rows, shifts, evo, label, started };
}

VIEWS.reportes = () => {
  const d = derive(); const R = computeReport(); const f = R.f;
  const months = []; let mm = { y: d.cur.y, m: d.cur.m }; for (let i = 0; i < 12; i++) { months.push(mm); mm = prevMonth(mm.y, mm.m); }
  const T = (k) => R.rows.reduce((a, r) => a + r[k], 0); const den = T('bueno') + T('cambio') + T('faltante');
  const techOpts = d.activeTechs.filter((t) => f.shift === 'all' || t.shiftId === f.shift);
  return pageHead('Reportes y estadísticas', esc(R.label), { acts: can('reports_export') ? `<button class="btn" data-act="exportCsv">${icon('dl', 18)}CSV</button><button class="btn" data-act="exportXlsx">${icon('dl', 18)}Excel</button><button class="btn" data-act="exportPdf">${icon('dl', 18)}PDF</button>` : '' }) +
  `<div class="card" data-css="margin-bottom:14px"><div class="formgrid c2">${field('Mes', `<select id="rpm" data-ch="repYm">${months.map((x) => `<option value="${esc(x.y)}-${pad(x.m)}" ${f.ym === `${x.y}-${pad(x.m)}` ? 'selected' : ''}>${mlabel(x.y, x.m)}</option>`).join('')}</select>`, 'rpm')}${field('Semana', `<select id="rpw" data-ch="repW">${optList([['all', 'Todo el mes'], ['1', 'Semana 1'], ['2', 'Semana 2'], ['3', 'Semana 3'], ['4', 'Semana 4']], f.w)}</select>`, 'rpw')}${field('Turno', `<select id="rps" data-ch="repShift">${optList([['all', 'Todos los turnos'], ...d.shifts.map((s) => [s.id, s.name])], f.shift)}</select>`, 'rps')}${field('Técnico', `<select id="rpt" data-ch="repTech">${optList([['all', 'Todos los técnicos'], ...techOpts.map((t) => [t.id, t.name])], f.tech)}</select>`, 'rpt')}</div></div>
  <section class="kpis k7">${kpi(R.rows.length, 'Técnicos')}${kpi(T('total'), 'Herramientas asignadas')}${kpi(T('bueno'), 'En buen estado', '', 'ok')}${kpi(T('cambio'), 'Para cambio', '', 'warn')}${kpi(T('faltante'), 'Faltantes', '', 'bad')}${kpi(den ? Math.round(T('bueno') / den * 100) : 0, '% en condiciones')}${kpi(T('repos'), 'Reposiciones')}</section>
  <div class="two"><section class="card"><div class="srow"><h2 class="si">Evolución de los últimos 6 meses</h2></div>${lineChart(R.evo.map((e) => e.label), [{ name: 'Para cambio', color: 'var(--warn)', values: R.evo.map((e) => e.cambio) }, { name: 'Faltantes', color: 'var(--bad-ink)', values: R.evo.map((e) => e.faltante) }, { name: 'Reposiciones', color: 'var(--pri)', values: R.evo.map((e) => e.repos) }, { name: 'Recuperadas', color: 'var(--ok)', values: R.evo.map((e) => e.recup) }])}</section>
  <section class="card"><h2 class="si" data-css="margin-bottom:10px">Comparación entre turnos</h2>${R.shifts.map((s) => `<div class="hbar"><span class="ell">${esc(s.name)}</span><span class="track"><i data-css="width:${s.pct ?? 0}%"></i></span><b class="num" data-css="text-align:right">${s.pct == null ? '—' : s.pct + '%'}</b></div>`).join('')}<p class="muted xs" data-css="margin:4px 0 12px">Porcentaje de herramientas en condiciones según el último control del período.</p>
  <div class="twrap"><table class="tbl"><thead><tr><th>Turno</th><th class="n">Téc.</th><th class="n">Herr.</th><th class="n">Cambio</th><th class="n">Faltan</th><th class="n">Controles</th><th class="n">Pend.</th></tr></thead><tbody>${R.shifts.map((s) => `<tr><td>${esc(s.name)}</td><td class="n">${s.techs}</td><td class="n">${s.total}</td><td class="n">${s.cambio}</td><td class="n">${s.faltante}</td><td class="n">${s.ctl}</td><td class="n">${s.pend}</td></tr>`).join('')}</tbody></table></div></section></div>
  <h2 class="sec">Por técnico</h2>${R.rows.length ? `<div class="twrap"><table class="tbl cards"><thead><tr><th>Técnico</th><th>Turno</th><th class="n">Asignadas</th><th class="n">Bien</th><th class="n">Cambio</th><th class="n">Faltan</th><th class="n">% cond.</th><th class="n">Controles</th><th class="n">Reposic.</th><th class="n">Recup.</th></tr></thead><tbody>${R.rows.map((r) => `<tr><td class="lead" data-l="Técnico"><a href="#tecnico-${esc(r.id)}" data-css="font-weight:640">${esc(r.name)}</a>${r.fromControl ? '' : '<div class="muted xs">Sin control en el período: estado actual</div>'}</td><td data-l="Turno">${esc(r.shift)}</td><td class="n" data-l="Asignadas">${r.total}</td><td class="n" data-l="Buen estado">${r.bueno}</td><td class="n" data-l="Para cambio">${r.cambio}</td><td class="n" data-l="Faltantes">${r.faltante}</td><td class="n" data-l="% en condiciones">${r.pct == null ? '—' : r.pct + '%'}</td><td class="n" data-l="Controles">${r.ctl} de ${r.expected}</td><td class="n" data-l="Reposiciones">${r.repos}</td><td class="n" data-l="Recuperadas">${r.recup}</td></tr>`).join('')}</tbody></table></div>` : `<div class="list">${emptyBox('Sin técnicos para este filtro', '')}</div>`}`;
};

CH.repYm = (v) => { UI.rep.ym = v; render(); }; CH.repW = (v) => { UI.rep.w = v; render(); }; CH.repShift = (v) => { UI.rep.shift = v; UI.rep.tech = 'all'; render(); }; CH.repTech = (v) => { UI.rep.tech = v; render(); };
