// Etapa 10: datos de la empresa para el encabezado de la impresión (Administración › Empresa):
// nombre y logo. Puro. El logo es PNG o JPEG (nunca SVG: puede llevar código), de hasta 512 KB,
// y el tipo sale de los primeros bytes del archivo, no del nombre ni de lo que diga el navegador.
import { DomainError } from './errors.js';

export const DEFAULT_COMPANY_NAME = "Villa D'agri · Mantenimiento";
export const MAX_COMPANY_NAME = 120;
export const MAX_LOGO_BYTES = 512 * 1024;
export const LOGO_TYPES = ['image/png', 'image/jpeg'];

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Nombre de la empresa: sin espacios de más, 1 a 120 caracteres, sin caracteres de control.
export function cleanCompanyName(v) {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!s) throw new DomainError('Escribí el nombre de la empresa.', 'invalid_name', 422);
  if (s.length > MAX_COMPANY_NAME) throw new DomainError(`El nombre de la empresa puede tener hasta ${MAX_COMPANY_NAME} caracteres.`, 'invalid_name', 422);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new DomainError('El nombre de la empresa tiene caracteres no válidos.', 'invalid_name', 422);
  return s;
}

// Tipo real de la imagen por sus primeros bytes (null si no es PNG ni JPEG).
// PNG: firma de 8 bytes y el bloque IHDR primero. JPEG: FF D8 FF al principio y FF D9 al final.
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (PNG_SIG.every((b, i) => buf[i] === b)) {
    return buf.length >= 16 && buf.toString('latin1', 12, 16) === 'IHDR' ? 'image/png' : null;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9) return 'image/jpeg';
  return null;
}

// Valida el logo subido: tamaño y tipo real. Devuelve el tipo (image/png | image/jpeg).
export function checkLogo(buf) {
  if (!buf || !buf.length) throw new DomainError('Elegí una imagen PNG o JPEG.', 'invalid_image', 422);
  if (buf.length > MAX_LOGO_BYTES) throw new DomainError('El logo puede pesar hasta 512 KB.', 'too_large', 413);
  const type = sniffImage(buf);
  if (!type) throw new DomainError('El logo tiene que ser una imagen PNG o JPEG (no se aceptan SVG ni otros formatos).', 'invalid_image', 422);
  return type;
}
