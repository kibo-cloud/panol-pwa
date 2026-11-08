// Listas ordenables (etapa 3): arrastrar y soltar en la computadora (eventos de puntero sobre la
// manija), teclado (foco en un elemento y Alt+↑/↓) y flechas subir/bajar (botones de 44 px, los
// que se usan en el celular). Sin código en línea: un listener por tipo de evento en document.
//
// Marcado: <ol class="ordlist" data-scope="..."> con <li class="orditem" data-id="..." tabindex="0">,
// una manija [data-grip] y botones data-act="ordMove" data-d="-1|1". El dueño de cada alcance
// registra su lista con registerScope(prefijo, { ids(scope), set(scope, ids) }).
import { esc } from './dom.js';
import { icon } from './icons.js';
import { ACT } from './actions.js';
import { render } from './registry.js';
import { moveBy, moveTo } from '../state/orden.js';

const owners = [];
export function registerScope(prefix, owner) { owners.push({ prefix, ...owner }); }
const ownerOf = (scope) => owners.find((o) => scope.startsWith(o.prefix));

function move(scope, id, delta) {
  const o = ownerOf(scope); if (!o) return;
  o.set(scope, moveBy(o.ids(scope), id, delta));
  render();
  // El foco sigue al elemento movido (teclado y lectores de pantalla).
  requestAnimationFrame(() => { const el = document.querySelector(`.ordlist[data-scope="${CSS.escape(scope)}"] .orditem[data-id="${CSS.escape(id)}"]`); if (el) el.focus(); });
}

ACT.ordMove = (ds, el) => { const li = el.closest('.orditem'); const ol = el.closest('.ordlist'); if (li && ol) move(ol.dataset.scope, li.dataset.id, +ds.d); };

// Botones y manija de un elemento: `label` describe el elemento para los lectores de pantalla.
export function ordControls(label, i, n, { drag = true } = {}) {
  return `${drag ? `<span class="grip" data-grip aria-hidden="true" title="Arrastrar para ordenar">${icon('grip', 18)}</span>` : ''}<span class="ordbtns"><button type="button" class="icon-btn ordbtn" data-act="ordMove" data-d="-1" aria-label="Subir ${esc(label)}" ${i === 0 ? 'disabled' : ''}>${icon('up', 18)}</button><button type="button" class="icon-btn ordbtn" data-act="ordMove" data-d="1" aria-label="Bajar ${esc(label)}" ${i === n - 1 ? 'disabled' : ''}>${icon('down', 18)}</button></span>`;
}

let drag = null;
// Un cambio en vivo (SSE) puede volver a dibujar la lista durante el arrastre: los elementos se
// buscan de nuevo por alcance e id en cada movimiento.
function live(d) {
  if (d.ol.isConnected) return true;
  const ol = document.querySelector(`.ordlist[data-scope="${CSS.escape(d.scope)}"]`);
  const li = ol && ol.querySelector(`:scope > .orditem[data-id="${CSS.escape(d.id)}"]`);
  if (!li) return false;
  d.ol = ol; d.li = li; li.classList.add('dragging'); ol.classList.add('sorting');
  return true;
}
function onDown(e) {
  const grip = e.target.closest && e.target.closest('[data-grip]'); if (!grip || e.button !== 0) return;
  const li = grip.closest('.orditem'); const ol = li && li.closest('.ordlist'); if (!ol) return;
  e.preventDefault();
  const items = [...ol.querySelectorAll(':scope > .orditem')];
  drag = { ol, li, id: li.dataset.id, scope: ol.dataset.scope, from: items.indexOf(li), to: items.indexOf(li), y0: e.clientY, pointerId: e.pointerId };
  li.classList.add('dragging'); ol.classList.add('sorting');
  try { grip.setPointerCapture(e.pointerId); } catch { /* sin captura */ }
}
function onMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  e.preventDefault();
  if (!live(drag)) { drag = null; return; }
  const items = [...drag.ol.querySelectorAll(':scope > .orditem')];
  drag.li.style.transform = `translateY(${e.clientY - drag.y0}px)`;
  // Posición de destino: cuántos elementos (sin el que se arrastra) tienen su centro arriba del puntero.
  let to = 0;
  for (const it of items) { if (it === drag.li) continue; const r = it.getBoundingClientRect(); if (e.clientY > r.top + r.height / 2) to++; }
  if (to !== drag.to) {
    drag.to = to;
    for (const it of items) it.classList.remove('dropbefore', 'dropafter');
    const others = items.filter((it) => it !== drag.li);
    if (others[to]) others[to].classList.add('dropbefore'); else if (others.length) others[others.length - 1].classList.add('dropafter');
  }
}
function onUp(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag; drag = null;
  if (!live(d)) return;
  d.li.style.transform = ''; d.li.classList.remove('dragging'); d.ol.classList.remove('sorting');
  for (const it of d.ol.querySelectorAll('.dropbefore,.dropafter')) it.classList.remove('dropbefore', 'dropafter');
  if (d.to === d.from) return;
  const o = ownerOf(d.scope); if (!o) return;
  o.set(d.scope, moveTo(o.ids(d.scope), d.from, d.to));
  render();
}
function onKey(e) {
  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  const li = e.target.closest && e.target.closest('.orditem'); const ol = li && li.closest('.ordlist'); if (!ol) return;
  e.preventDefault();
  move(ol.dataset.scope, li.dataset.id, e.key === 'ArrowUp' ? -1 : 1);
}

let installed = false;
export function installSortable() {
  if (installed || typeof document === 'undefined') return; installed = true;
  document.addEventListener('pointerdown', onDown);
  document.addEventListener('pointermove', onMove, { passive: false });
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
  document.addEventListener('keydown', onKey);
}
