// Etapa 10: Administración › Empresa: nombre y logo del encabezado de las impresiones
// (auditoría y existencia). Logo PNG o JPEG de hasta 512 KB; el servidor revisa los primeros
// bytes y lo sirve desde el mismo origen. Se cambia con el permiso de la configuración
// (plantillas_edit) y la versión (If-Match), como los otros ajustes.
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { UI, render } from '../../ui/registry.js';
import { ACT, IN, CH } from '../../ui/actions.js';
import { act, toast, errMsg } from '../../ui/feedback.js';
import { field } from '../../ui/components.js';
import { gateUI } from '../tecnicos/view.js';
import { api } from '../../api/index.js';
import { can, refresh } from '../../state/store.js';
import { toBase64 } from '../../state/excelimport.js';

export const LOGO_MAX = 512 * 1024;
const LOGO_TYPES = ['image/png', 'image/jpeg'];
const E = () => UI.emp || (UI.emp = { data: null, name: '', dirty: false, loading: false, busy: false });

async function load(force) {
  const e = E();
  if (e.loading || (e.data && !force)) return;
  e.loading = true;
  try { const r = await api.empresa(); e.data = r; if (!e.dirty) e.name = r.name; } catch (err) { toast(errMsg(err), 'err'); } finally { e.loading = false; render(); }
}
export const reloadEmpresa = () => load(true);

export function empresaTab() {
  const e = E(); load();
  if (!e.data) return '<div class="loading"><div class="spin"></div>Cargando…</div>';
  const ed = can('plantillas_edit');
  const logo = e.data.logo;
  const pic = logo ? `<img class="emp-logo" id="emp-img" src="${esc(logo.url)}" alt="Logo de la empresa">` : `<div class="emp-nologo" id="emp-img">${icon('box', 20)}Sin logo</div>`;
  return `<div class="card cfgcard" id="empcard"><h2 class="si">Empresa</h2><p class="muted sm cfgp">El nombre y el logo van en el encabezado de cada página de la impresión para auditoría y de la existencia por técnico.</p>
  ${ed ? `${field('Nombre de la empresa', `<input id="emp-name" maxlength="120" data-in="empName" value="${esc(e.name)}">`, 'emp-name')}
  <div class="toolbar cfgbar"><span class="s grow">${e.dirty ? 'Cambios sin guardar' : 'Sin cambios sin guardar'}</span><button class="btn sm" data-act="empReset" ${e.dirty ? '' : 'disabled'}>Descartar</button><button class="btn sm pri" data-act="empSave" ${e.dirty ? '' : 'disabled'}>Guardar nombre</button></div>` : `<p><b>${esc(e.data.name)}</b></p><p class="muted sm">Tu perfil puede ver estos datos pero no modificarlos.</p>`}
  <h3 class="emp-h">Logo</h3><div class="emp-row">${pic}<div class="emp-acts">${ed ? `<label class="btn sm emp-file" for="emp-logo">${icon('dl', 16)}${logo ? 'Cambiar logo' : 'Subir logo'}<input id="emp-logo" class="emp-input" type="file" accept="image/png,image/jpeg" data-ch="empLogo"></label>${logo ? '<button class="btn sm danger" data-act="empLogoDel">Quitar logo</button>' : ''}` : ''}<p class="muted xs">PNG o JPEG, hasta 512 KB. No se aceptan SVG.</p></div></div></div>`;
}

IN.empName = (v) => { const e = E(); e.name = v; e.dirty = true; render(); };
ACT.empReset = () => { const e = E(); if (e.data) e.name = e.data.name; e.dirty = false; render(); };
ACT.empSave = async () => {
  const e = E(); if (!e.data || !gateUI('plantillas_edit')) return;
  const name = e.name.replace(/\s+/g, ' ').trim();
  if (!name) { toast('Escribí el nombre de la empresa.', 'err'); return; }
  const r = await act(() => api.setEmpresaName(name, e.data.version), 'Nombre de la empresa guardado');
  if (r) { e.data = r; e.name = r.name; e.dirty = false; await refresh().catch(() => {}); render(); }
};

// Revisión en el navegador (el servidor vuelve a revisar los bytes).
export function logoProblem(f) {
  if (!f) return 'Elegí una imagen.';
  if (!LOGO_TYPES.includes(f.type)) return 'El logo tiene que ser una imagen PNG o JPEG (no se aceptan SVG ni otros formatos).';
  if (f.size > LOGO_MAX) return 'El logo puede pesar hasta 512 KB.';
  if (!f.size) return 'El archivo está vacío.';
  return null;
}

CH.empLogo = async (v, el) => {
  const e = E(); const f = el.files && el.files[0];
  if (!f || !e.data || !gateUI('plantillas_edit')) return;
  const bad = logoProblem(f);
  if (bad) { toast(bad, 'err'); el.value = ''; return; }
  let b64;
  try { b64 = toBase64(new Uint8Array(await f.arrayBuffer())); } catch { toast('No se pudo leer el archivo.', 'err'); return; }
  const r = await act(() => api.setLogo(b64, e.data.version), 'Logo guardado');
  if (r) { e.data = r; await refresh().catch(() => {}); render(); }
};
ACT.empLogoDel = async () => {
  const e = E(); if (!e.data || !gateUI('plantillas_edit')) return;
  const r = await act(() => api.removeLogo(e.data.version), 'Logo quitado');
  if (r) { e.data = r; await refresh().catch(() => {}); render(); }
};
