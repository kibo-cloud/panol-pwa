// Estado de la conexión: `navigator.onLine` más el resultado real de cada pedido.
// Sin conexión se sondea /api/health cada pocos segundos hasta que el servidor responda.
const listeners = new Set();
let probeTimer = null;

export const net = {
  offline: typeof navigator !== 'undefined' && navigator.onLine === false,
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  report(ok) { set(!ok); },
};

function set(offline) {
  if (net.offline === offline) return;
  net.offline = offline;
  for (const fn of listeners) { try { fn(offline); } catch (e) { console.warn(e); } }
  if (offline) startProbe(); else stopProbe();
}

async function probe() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' });
    if (r.ok) set(false);
  } catch { set(true); }
}
function startProbe() { if (!probeTimer && typeof window !== 'undefined') probeTimer = setInterval(probe, 5000); }
function stopProbe() { clearInterval(probeTimer); probeTimer = null; }

// Los eventos del navegador son una pista: al volver se confirma contra el servidor.
export function watchBrowser() {
  window.addEventListener('offline', () => set(true));
  window.addEventListener('online', () => { probe(); });
  if (net.offline) startProbe();
}
// Fuerza una verificación (p. ej. cuando se corta el flujo SSE).
export const checkNow = probe;
export const markOffline = () => set(true);
