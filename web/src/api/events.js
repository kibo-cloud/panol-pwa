// Cambios en vivo: EventSource sobre /api/events. Cada `change` se junta con los siguientes
// (debounce) y dispara una sola recarga del estado.
import { checkNow } from './net.js';

export function connectEvents(onChanges, { debounceMs = 400 } = {}) {
  let es = null, timer = null, pending = [];
  const flush = () => { timer = null; const batch = pending; pending = []; onChanges(batch); };
  function open() {
    es = new EventSource('/api/events', { withCredentials: true });
    es.addEventListener('change', (ev) => {
      let data = null;
      try { data = JSON.parse(ev.data); } catch { data = null; }
      if (data) pending.push(data);
      clearTimeout(timer); timer = setTimeout(flush, debounceMs);
    });
    // El navegador reintenta solo; además se verifica si el servidor sigue respondiendo.
    es.onerror = () => { checkNow(); };
    es.onopen = () => { pending.push({ entity: '*', action: 'reconnect' }); clearTimeout(timer); timer = setTimeout(flush, debounceMs); };
  }
  open();
  return { close() { clearTimeout(timer); if (es) es.close(); es = null; } };
}
