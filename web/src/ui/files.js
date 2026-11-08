// Descarga de archivos y carga de librerías propias (xlsx, jspdf) con integridad (SRI).
import { toast, UErr } from './feedback.js';

export async function saveFile(filename, data) {
  try {
    const blob = data instanceof Blob ? data : new Blob([data], { type: filename.endsWith('.txt') ? 'text/plain;charset=utf-8' : undefined });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Archivo descargado');
  } catch { toast('No se pudo descargar el archivo.', 'err'); }
}

// Las librerías se sirven desde el mismo servidor (vendor/) y el navegador verifica su hash:
// si el archivo cambia, no se ejecuta.
export function loadScript({ src, integrity }, test) {
  if (test()) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.integrity = integrity; s.crossOrigin = 'anonymous';
    s.onload = () => res();
    s.onerror = () => rej(new UErr('No se pudo cargar el generador de archivos. Revisá la conexión.'));
    document.head.appendChild(s);
  });
}
