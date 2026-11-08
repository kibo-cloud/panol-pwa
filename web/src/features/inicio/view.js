// Panel de inicio (como 2.1): héroe de la semana, KPI, plantillas, gráfico, alertas y movimientos.
// Para un supervisor, "Mi plantilla" y las alertas de su gente van primero.
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS, render } from '../../ui/registry.js';
import { ACT } from '../../ui/actions.js';
import { kpi, pageHead, barChart, alertList, mvList } from '../../ui/components.js';
import { plantillaCard } from '../plantillas/view.js';
import { mineFirst } from '../../state/plantillas.js';
import { derive, can, B } from '../../state/store.js';
import { MSHORT } from '../../state/constants.js';
import { plabel, wrange, prevMonth } from '../../state/period.js';

export function monthTotals(y, m) { const d = derive(); let c = 0, f = 0, has = false; for (const t of d.activeTechs) { const cs = (d.effByTech[t.id] || []).filter((x) => x.period.y === y && x.period.m === m); const l = cs[cs.length - 1]; if (l) { has = true; c += (l.counts || {}).cambio || 0; f += (l.counts || {}).faltante || 0; } } return { cambio: c, faltante: f, has }; }
const signed = (n, lab) => (n === 0 ? `Igual que ${lab}` : `${n > 0 ? '+' : '−'}${Math.abs(n)} vs. ${lab}`);
function homeNotices() {
  let dis = false; try { dis = localStorage.getItem('panol-install-hide') === '1'; } catch { /* sin almacenamiento */ }
  return B.installEvt && !dis ? `<div class="banner"><div><b>Instalá Pañol como app.</b><div class="sm">Se abre desde la pantalla de inicio, a pantalla completa.</div></div><div class="acts"><button class="btn sm ghost" data-act="installHide">Ahora no</button><button class="btn sm pri" data-act="install">Instalar</button></div></div>` : '';
}

VIEWS.inicio = () => {
  const d = derive();
  if (!d.techs.length && !d.tools.length) {
    return `<div class="desk">${pageHead('Panel', plabel(d.cur))}</div><div class="card"><h2 class="si">Primeros pasos</h2><ol class="steps"><li><div><b>Creá las herramientas</b><div class="s">Definí categorías, herramientas y su stock o sus códigos de inventario.</div></div></li><li><div><b>Cargá a los técnicos</b><div class="s">Con legajo y plantilla.</div></div></li><li><div><b>Entregá herramientas</b><div class="s">Cada entrega crea la asignación y descuenta el inventario.</div></div></li><li><div><b>Hacé el control semanal</b><div class="s">Un toque por herramienta, desde el celular.</div></div></li></ol><div class="toolbar">${can('tools_edit') ? '<a class="btn pri" href="#config">Crear herramientas</a>' : ''}${can('demo_manage') ? '<button class="btn" data-act="loadDemo">Cargar datos de demostración</button>' : ''}</div></div>`;
  }
  const k = d.kpi; const ctlTechs = d.activeTechs.filter((t) => d.techInfo[t.id].lines); const done = ctlTechs.filter((t) => d.techInfo[t.id].curStatus === 'done').length; const tot = ctlTechs.length; const pend = tot - done;
  const all = k.bueno + k.cambio + k.faltante + k.pendiente; const pm = prevMonth(d.cur.y, d.cur.m); const pmT = monthTotals(pm.y, pm.m); const pml = MSHORT[pm.m - 1];
  const ms = []; let mm = { y: d.cur.y, m: d.cur.m }; for (let i = 0; i < 6; i++) { ms.unshift(mm); mm = prevMonth(mm.y, mm.m); } const mt = ms.map((x) => monthTotals(x.y, x.m));
  const hero = `<section class="hero" aria-label="Controles de la semana"><div class="rowb"><span class="hm">Controles de la semana</span><span class="hr">${wrange(d.cur)}</span></div><div data-css="display:flex;align-items:baseline;gap:8px"><span class="big">${done}</span><span class="of">de ${tot} ${tot === 1 ? 'técnico' : 'técnicos'}</span></div><div class="trk" role="img" aria-label="${done} de ${tot} controlados"><i data-css="width:${tot ? Math.round(done / tot * 100) : 0}%"></i></div>${pend && can('controls_do') ? `<a class="hbtn" href="#control">Continuar controles · ${pend} ${pend === 1 ? 'pendiente' : 'pendientes'}${icon('right', 18)}</a>` : `<a class="hbtn" href="#controles">${pend ? 'Ver controles' : 'Semana completa · ver historial'}${icon('right', 18)}</a>`}</section>`;
  const estado = `<section><h2 class="si">Estado de herramientas</h2><div class="kpis k3">${kpi(k.bueno, 'Buen estado', '', 'ok', all ? `${(k.bueno / all * 100).toLocaleString('es-AR', { maximumFractionDigits: 1 })} %` : '—')}${kpi(k.cambio, 'Para cambio', '#alertas', 'warn', pmT.has ? signed(k.cambio - pmT.cambio, pml) : '')}${kpi(k.faltante, 'Faltantes', '#alertas', 'bad', pmT.has ? signed(k.faltante - pmT.faltante, pml) : '')}</div><div class="kpis k3">${kpi(k.techs, 'Técnicos', '#tecnicos')}${kpi(k.tools, 'Asignadas', '#inventario')}${kpi(`${k.ctlMonth}<small> /${k.techs * 4}</small>`, `Controles ${MSHORT[d.cur.m - 1]}`, '#controles')}</div></section>`;
  const my = d.myPlantilla; const mine = d.shifts.filter((p) => my.plantillaIds.includes(p.id));
  const pls = mineFirst(d.shifts, my.plantillaIds).filter((p) => !mine.includes(p));
  const turnos = (mine.length ? `<section><div class="rowb"><h2 class="si">Mi plantilla</h2><span class="s">Controlados esta semana</span></div><div class="g1">${mine.map(plantillaCard).join('')}</div></section>` : '') + `<section><div class="rowb"><h2 class="si">${mine.length ? 'Otras plantillas' : 'Plantillas'}</h2>${mine.length ? '' : '<span class="s">Controlados esta semana</span>'}</div><div class="g1">${pls.map(plantillaCard).join('')}</div></section>`;
  const myAlerts = mine.length ? d.alertsOpen.filter((a) => my.alertKeys.has(a.key)) : [];
  const chart = `<section class="desk card"><div class="srow"><h2 class="si">Para cambio y faltantes, últimos 6 meses</h2></div>${barChart(ms.map((x) => MSHORT[x.m - 1]), [{ name: 'Para cambio', color: 'var(--warn)', values: mt.map((x) => x.cambio) }, { name: 'Faltantes', color: 'var(--bad-ink)', values: mt.map((x) => x.faltante) }])}</section>`;
  const aten = (mine.length ? `<section><div class="rowb"><h2 class="si">Alertas de tu gente</h2><a href="#alertas" class="lnk" data-act="alertPlMine">Ver todas (${myAlerts.length})</a></div>${alertList(myAlerts.slice(0, 4), false)}</section>` : '') + `<section><div class="rowb"><h2 class="si">${mine.length ? 'Otras alertas' : 'Requieren atención'}</h2><a href="#alertas" class="lnk" data-act="alertPlAll">Ver todas (${d.alertsOpen.length})</a></div>${alertList(d.alertsOpen.filter((a) => !my.alertKeys.has(a.key) || !mine.length).slice(0, 4), false)}</section>`;
  const movs = `<section><h2 class="si">Últimos movimientos</h2>${mvList(d.movs.slice(0, 5))}</section>`;
  return `<div class="desk">${pageHead('Panel', plabel(d.cur))}</div>${d.hasDemo ? '<a class="chip demobig" href="#admin" data-act="adminTab" data-v="data" data-css="margin-bottom:12px;display:inline-flex">Datos de demostración</a>' : ''}
  ${homeNotices()}<div class="dash"><div class="col">${hero}${estado}${turnos}</div><div class="col">${chart}${aten}${movs}</div></div>`;
};

ACT.installHide = () => { try { localStorage.setItem('panol-install-hide', '1'); } catch { /* sin almacenamiento */ } render(); };
