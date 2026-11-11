// Etapa 10: impresión. Cada pantalla imprimible tiene su raíz y su página con nombre (@page):
// la auditoría en A4 vertical (`print-aud`), la existencia en A4 apaisado (`print-exi`). Con
// Ctrl+P (sin pasar por el botón Imprimir) se elige la raíz según la pantalla abierta; en las
// demás se imprime la pantalla limpia (`print-screen`). El menú y las barras nunca se imprimen.
import { parseRoute } from './router.js';

// Funciones que corren antes de imprimir (por ejemplo, terminar de dibujar todas las páginas).
export const beforePrint = [];
const CLASSES = ['print-aud', 'print-exi', 'print-screen'];

export function printClassFor(routeName, doc = document) {
  if (routeName === 'auditoria' && doc.getElementById('audprint')) return 'print-aud';
  if (routeName === 'existencia' && doc.getElementById('exitbl')) return 'print-exi';
  return 'print-screen';
}

export function installPrint() {
  window.addEventListener('beforeprint', () => {
    for (const fn of beforePrint) { try { fn(); } catch (e) { console.warn(e); } }
    if (CLASSES.some((c) => document.body.classList.contains(c))) return;
    document.body.classList.add(printClassFor(parseRoute(location.hash).name));
  });
  window.addEventListener('afterprint', () => { for (const c of CLASSES) document.body.classList.remove(c); });
}
