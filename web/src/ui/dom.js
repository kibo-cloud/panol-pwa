// Utilidades de DOM. `esc` es puro (se prueba con node --test); el resto usa `document`
// solo cuando se llama, nunca al importar el módulo.

// Escapa todo texto de usuario antes de meterlo en HTML.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const $ = (s, r = document) => r.querySelector(s);

// La CSP (`style-src 'self'`) bloquea los atributos `style` que llegan por innerHTML. Las
// plantillas usan `data-css="..."` y acá se aplican por CSSOM (permitido por la CSP).
export function applyCss(root) {
  if (root.dataset && root.dataset.css !== undefined) root.style.cssText = root.dataset.css;
  for (const el of root.querySelectorAll('[data-css]')) el.style.cssText = el.dataset.css;
}

// Único punto donde se escribe HTML armado con plantillas (todas pasan los datos por `esc`).
export function setHTML(el, html) {
  el.innerHTML = html;
  applyCss(el);
  return el;
}

// Crea un elemento a partir de una plantilla de un solo nodo raíz.
export function fromHTML(html) {
  const tmp = document.createElement('div');
  setHTML(tmp, html);
  return tmp.firstElementChild;
}
