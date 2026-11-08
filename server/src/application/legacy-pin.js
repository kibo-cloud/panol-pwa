// Verificación de los PIN de Pañol 2.x migrados desde el .txt (mismos algoritmos que 2.1,
// index.html verifyPin/legacyHash): pbkdf2$<iteraciones>$<hex> (PBKDF2-SHA-256 de 32 bytes),
// y los de 2.0.0: sha256:<hex> de "salt:pin" o fnv:<hex> (respaldo sin crypto.subtle).
// La comparación final es en tiempo constante.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2 = promisify(crypto.pbkdf2);
const PBKDF2_RE = /^pbkdf2\$(\d{4,8})\$([0-9a-f]{64})$/;

export function fnvHash(salt, pin) {
  const txt = salt + ':' + pin;
  let h1 = 0x811c9dc5;
  let h2 = 0x1234567;
  for (let i = 0; i < txt.length; i++) {
    h1 = Math.imul(h1 ^ txt.charCodeAt(i), 16777619);
    h2 = Math.imul(h2 + txt.charCodeAt(i), 2654435761);
  }
  return 'fnv:' + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
}

export const sha256Hash = (salt, pin) => 'sha256:' + crypto.createHash('sha256').update(salt + ':' + pin, 'utf8').digest('hex');

export async function pbkdf2Hash(salt, pin, iterations) {
  const b = await pbkdf2(Buffer.from(String(pin), 'utf8'), Buffer.from(String(salt), 'utf8'), iterations, 32, 'sha256');
  return `pbkdf2$${iterations}$${b.toString('hex')}`;
}

function sameStr(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) {
    crypto.timingSafeEqual(x, x);
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

// true si el PIN coincide con el hash guardado de 2.x.
export async function verifyLegacyPin(pin, salt, hash) {
  if (typeof pin !== 'string' || typeof hash !== 'string') return false;
  const s = String(salt ?? '');
  const m = PBKDF2_RE.exec(hash);
  if (m) {
    const it = Number(m[1]);
    if (it < 10000 || it > 5000000) return false;
    return sameStr(await pbkdf2Hash(s, pin, it), hash);
  }
  if (hash.startsWith('fnv:')) return sameStr(fnvHash(s, pin), hash);
  return sameStr(sha256Hash(s, pin), hash);
}

// Formato de hash de PIN reconocido (para validar lo que se importa).
export const isLegacyPinHash = (h) => typeof h === 'string' && (PBKDF2_RE.test(h) || /^sha256:[0-9a-f]{64}$/.test(h) || /^fnv:[0-9a-f]{2,16}$/.test(h));
