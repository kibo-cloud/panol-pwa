// Registro de manejadores por atributo (`data-act`, `data-in`, `data-ch`), como en 2.1:
// un solo listener por tipo de evento, sin código en línea.
import { toast, errMsg } from './feedback.js';

export const ACT = {}, IN = {}, CH = {};
// El modal abierto recibe primero los `data-mi` (campos del formulario del modal).
let modalField = () => false;
export const setModalFieldHandler = (fn) => { modalField = fn; };

function handlerFailed(e) { console.warn(e); document.body.classList.remove('busy'); toast(errMsg(e), 'err'); }
function runHandler(fn, ...args) { try { const r = fn(...args); if (r && typeof r.catch === 'function') r.catch(handlerFailed); } catch (e) { handlerFailed(e); } }

export function installDelegation() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const fn = ACT[el.dataset.act]; if (!fn) return;
    if (el.tagName !== 'A') e.preventDefault();
    runHandler(fn, el.dataset, el, e);
  });
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (modalField(el)) return;
    if (el.dataset && el.dataset.in && IN[el.dataset.in]) runHandler(IN[el.dataset.in], el.value, el);
  });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (modalField(el)) return;
    if (el.dataset && el.dataset.ch && CH[el.dataset.ch]) runHandler(CH[el.dataset.ch], el.value, el);
  });
}
