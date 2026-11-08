// Menú Más y copia de seguridad: descargar el .txt, importar un .txt de Pañol 2.x (con
// informe previo y confirmación) e instalar la app.
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS, scheduleRender } from '../../ui/registry.js';
import { ACT } from '../../ui/actions.js';
import { openModal, modalRerender, MOD } from '../../ui/modal.js';
import { toast, errMsg, UErr } from '../../ui/feedback.js';
import { pageHead, avatar, nf } from '../../ui/components.js';
import { saveFile } from '../../ui/files.js';
import { api } from '../../api/index.js';
import { B, derive, who, myRole, ME, refresh } from '../../state/store.js';
import { ROLES, ROLE_SHORT, APP_VERSION } from '../../state/constants.js';
import { fdt } from '../../state/period.js';

VIEWS.mas = () => {
  const d = derive(); const meName = who(ME.id).replace(/ \(vos\)$/, '');
  const groups = [['Operación', [['control', 'Control de herramientas', 'check', d.kpi.pendCtl, 'Controles semanales por técnico'], ['entregas', 'Entregas y reposiciones', 'swap', d.pendingReturns.length, 'Entregas, devoluciones y retiros'], ['alertas', 'Alertas', 'alert', d.alertsOpen.length, 'Situaciones que requieren atención']]], ['Gestión', [['tecnicos', 'Técnicos', 'users', 0, `${d.kpi.techs} activos`], ['turnos', 'Turnos', 'clock', 0, `${d.shifts.length} turnos`], ['inventario', 'Inventario general', 'box', 0, 'Stock, unidades y movimientos']]], ['Análisis', [['controles', 'Historial de controles', 'hist', 0, 'Cuatro controles por mes'], ['reportes', 'Reportes y estadísticas', 'chart', 0, 'Exportá a Excel y PDF']]], ['Configuración', [['config', 'Configuración de herramientas', 'sliders', 0, 'Categorías y tipos'], ['admin', 'Administración', 'shield', 0, 'Usuarios, permisos y auditoría']]]];
  const row = ([k, l, ic, b, s]) => `<a class="mrow" href="#${esc(k)}"><span class="mi">${icon(ic, 18)}</span><span class="grow"><span class="t">${l}</span><span class="s">${esc(s)}</span></span>${b ? `<span class="badge">${b}</span>` : ''}${icon('right', 18)}</a>`;
  return `<div class="desk">${pageHead('Más', '')}</div><div class="card" data-css="display:flex;align-items:center;gap:12px">${avatar(meName, null, true)}<span class="grow"><span class="t" data-css="display:block">${esc(meName)}</span><span class="s">${ROLES[myRole()] || ''}</span></span><span class="chip pri">${ROLE_SHORT[myRole()] || ''}</span></div>
  ${groups.map(([g, items]) => `<section class="grp"><h2>${g}</h2><div class="list">${items.map(row).join('')}</div></section>`).join('')}
  <section class="grp"><h2>Datos y app</h2><div class="list"><button class="mrow" data-act="backup"><span class="mi">${icon('db', 18)}</span><span class="grow"><span class="t">Copia de seguridad (.txt)</span><span class="s">Descargá una copia o importá el archivo de Pañol 2.x</span></span>${icon('right', 18)}</button>${B.installEvt ? `<button class="mrow" data-act="install"><span class="mi">${icon('dl', 18)}</span><span class="grow"><span class="t">Instalar Pañol</span><span class="s">Usala como app, a pantalla completa</span></span>${icon('right', 18)}</button>` : ''}<button class="mrow" data-act="myPassword"><span class="mi">${icon('pencil', 18)}</span><span class="grow"><span class="t">Cambiar mi contraseña</span><span class="s">La contraseña con la que ingresás</span></span>${icon('right', 18)}</button></div></section>
  <button class="btn danger lg block" data-css="margin-top:18px" data-act="logout">Cerrar sesión</button>
  <p class="s" data-css="text-align:center;margin-top:12px">Pañol ${APP_VERSION} · Datos guardados en el servidor</p>`;
};

ACT.install = async () => { const e = B.installEvt; if (!e) { toast('Abrí el menú del navegador y elegí Instalar app.'); return; } e.prompt(); try { await e.userChoice; } catch { /* sin respuesta */ } B.installEvt = null; scheduleRender(); };

const mbtn = (a, ic, t, s) => `<button class="mrow" data-act="${esc(a)}"><span class="mi">${icon(ic, 18)}</span><span class="grow"><span class="t">${t}</span><span class="s">${s}</span></span>${icon('right', 18)}</button>`;
ACT.backup = () => {
  const adm = myRole() === 'admin';
  openModal({ title: 'Copia de seguridad (.txt)', render: () => `<p class="muted" data-css="margin-top:0">Los datos viven en el servidor, que hace una copia todos los días. El archivo .txt sirve como copia manual y para traer los datos de Pañol 2.x.</p>${adm ? `<div class="list" data-css="margin-bottom:12px">${mbtn('fileDownload', 'dl', 'Descargar .txt', 'Una copia de todos los datos (sin contraseñas)')}${mbtn('dataImport', 'upload', 'Importar .txt', 'Traer los datos de Pañol 2.x: primero se muestra un informe')}</div>` : `<p class="hint">${icon('info', 16)}<span>Solo un administrador puede descargar o importar el archivo de datos.</span></p>`}` });
};
ACT.fileDownload = async () => {
  try { const txt = await api.exportTxt(); await saveFile(`panol-datos-${new Date().toISOString().slice(0, 10)}.txt`, txt); } catch (e) { toast(errMsg(e), 'err'); }
};

// ------------------------------------------------------------------ importar .txt
const MAX_IMPORT = 20 * 1024 * 1024;
const COL_LABEL = { techs: 'Técnicos', shiftChanges: 'Cambios de turno', categories: 'Categorías', tools: 'Herramientas', units: 'Unidades', assignments: 'Asignaciones', controls: 'Controles', movements: 'Movimientos', alertRes: 'Alertas resueltas', audit: 'Auditoría', users: 'Usuarios', config: 'Configuración', shifts: 'Turnos', permisos: 'Permisos' };
const colName = (c) => COL_LABEL[c] || c;
const PIN_KIND = { pbkdf2: 'PIN de 2.1', sha256: 'PIN de 2.0', fnv: 'PIN de 2.0', desconocido: 'PIN desconocido' };

ACT.dataImport = () => {
  if (myRole() !== 'admin') { toast('Solo un administrador puede importar archivos de datos.', 'err'); return; }
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.txt,text/plain'; inp.hidden = true; document.body.appendChild(inp);
  inp.onchange = async () => {
    const f = inp.files && inp.files[0]; inp.remove(); if (!f) return;
    if (f.size > MAX_IMPORT * 2) { toast('El archivo es demasiado grande para ser de Pañol.', 'err'); return; }
    try { openImport(await f.text(), f.name); } catch { toast('No se pudo leer el archivo.', 'err'); }
  };
  inp.click();
};

function reportHTML(st) {
  if (st.loading) return '<div class="loading"><div class="spin"></div>Revisando el archivo…</div>';
  const r = st.report; if (!r) return `<p class="hint warn">${esc(st.error || 'No se pudo revisar el archivo.')}</p>`;
  const counts = Object.entries(r.counts || {}).filter(([, n]) => n);
  const ch = Object.entries(r.changes || {}).filter(([, x]) => x.create.ids.length + x.update.ids.length + x.delete.ids.length + x.create.more + x.update.more + x.delete.more);
  const n = (x) => x.ids.length + x.more;
  const item = (x) => `<div class="row"><div class="grow"><div class="t">${esc(colName(x.collection))}${x.id ? ' · ' + esc(x.id) : ''}${x.field ? ' · ' + esc(x.field) : ''}</div><div class="s">${esc(x.message)}</div></div></div>`;
  return `<p class="muted" data-css="margin-top:0">${esc(st.name)}${r.savedAt ? `, guardado el ${fdt(r.savedAt)}` : ''}. ${nf(r.totalChanges || 0)} cambios a aplicar.</p>
  <div class="field"><label>¿Cómo se importa?</label><div class="opts"><button type="button" class="opt ${st.mode === 'merge' ? 'on' : ''}" data-act="importMode" data-v="merge"><span><b>Combinar</b><br><span class="s">Suma lo nuevo y se queda con la versión más reciente de cada registro.</span></span></button><button type="button" class="opt ${st.mode === 'replace' ? 'on' : ''}" data-act="importMode" data-v="replace"><span><b>Reemplazar todo</b><br><span class="s">Solo en un servidor sin movimientos ni controles: queda igual al archivo.</span></span></button></div></div>
  ${r.errorCount ? `<div class="hint warn">${icon('alert', 16)}<span><b>${r.errorCount} ${r.errorCount === 1 ? 'error' : 'errores'}.</b> No se puede importar hasta corregirlos.</span></div><div class="list" data-css="margin-bottom:12px">${r.errors.map(item).join('')}</div>` : `<div class="hint ok">${icon('ok', 16)}<span>El archivo se puede importar.</span></div>`}
  ${counts.length ? `<div class="flabel" data-css="margin-bottom:6px">Registros en el archivo</div><div class="list" data-css="margin-bottom:12px">${counts.map(([c, k]) => `<div class="row"><div class="grow"><div class="t">${esc(colName(c))}</div></div><span class="chip">${nf(k)}</span></div>`).join('')}</div>` : ''}
  ${ch.length ? `<div class="flabel" data-css="margin-bottom:6px">Cambios en el servidor</div><div class="list" data-css="margin-bottom:12px">${ch.map(([c, x]) => `<div class="row"><div class="grow"><div class="t">${esc(colName(c))}</div><div class="s">${n(x.create)} nuevos · ${n(x.update)} actualizados · ${n(x.delete)} eliminados</div></div></div>`).join('')}</div>` : ''}
  ${r.newUsers && r.newUsers.length ? `<div class="flabel" data-css="margin-bottom:6px">Usuarios nuevos (entran con su PIN de 2.x una vez y después eligen contraseña)</div><div class="list" data-css="margin-bottom:12px">${r.newUsers.map((u) => `<div class="row"><div class="grow"><div class="t">${esc(u.name)} · <span class="num">${esc(u.username)}</span></div><div class="s">${ROLES[u.role] || esc(u.role)} · ${u.pin ? PIN_KIND[u.pin] || esc(u.pin) : 'sin PIN: un administrador tiene que restablecer la contraseña'}</div></div></div>`).join('')}</div>` : ''}
  ${r.conflictCount ? `<div class="flabel" data-css="margin-bottom:6px">Conflictos (${r.conflictCount}): se conserva lo del servidor</div><div class="list" data-css="margin-bottom:12px">${r.conflicts.map(item).join('')}</div>` : ''}
  ${r.assumptionCount ? `<div class="flabel" data-css="margin-bottom:6px">Supuestos (${r.assumptionCount})</div><div class="list" data-css="margin-bottom:12px">${r.assumptions.map(item).join('')}</div>` : ''}
  ${r.permissionsChange ? '<p class="muted sm">También se actualizan los permisos por perfil.</p>' : ''}`;
}

async function runPreview(text) {
  const m = MOD; if (!m) return; m.st.loading = true; m.st.report = null; m.st.error = ''; modalRerender();
  try { m.st.report = await api.importTxt(text, m.st.mode); } catch (e) { m.st.report = (e.body && e.body.report) || null; m.st.error = errMsg(e); }
  m.st.loading = false; if (MOD === m) modalRerender();
}
function openImport(text, name) {
  openModal({ title: 'Importar archivo .txt', render: reportHTML, actions: [{ label: 'Cancelar', close: true }, { label: 'Confirmar importación', kind: 'pri', run: async (st) => {
    if (st.loading) return false;
    if (!st.report || !st.report.canApply || !st.report.token) throw new UErr('El archivo tiene errores: corregilos antes de importar.');
    try { await api.importTxt(text, st.mode, st.report.token); } catch (e) {
      // El plan cambió desde el informe: se muestra el informe nuevo para volver a confirmar.
      if (e.body && e.body.report) { st.report = e.body.report; modalRerender(); }
      throw e;
    }
    await refresh(); toast('Datos importados');
  } }] });
  MOD.st = { mode: 'merge', name, loading: true }; MOD.text = text; modalRerender();
  runPreview(text);
}
ACT.importMode = (ds) => { if (!MOD || !MOD.text || MOD.st.mode === ds.v) return; MOD.st.mode = ds.v; runPreview(MOD.text); };
