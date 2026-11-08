// Contraseñas con argon2id (parámetros mínimos recomendados por OWASP).
import crypto from 'node:crypto';
import argon2 from 'argon2';
import { DomainError } from '../domain/errors.js';

const OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

export const hashPassword = (pw) => argon2.hash(pw, OPTS);

export async function verifyPassword(hash, pw) {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}

export const needsRehash = (hash) => {
  try {
    return argon2.needsRehash(hash, OPTS);
  } catch {
    return false;
  }
};

// Hash de una contraseña al azar: se verifica contra él cuando el usuario no existe, para que
// el tiempo de respuesta no revele si el usuario existe.
let dummy = null;
export async function verifyDummy(pw) {
  dummy ||= hashPassword(crypto.randomBytes(16).toString('hex'));
  await verifyPassword(await dummy, pw);
  return false;
}

export function checkPasswordPolicy(pw) {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) throw new DomainError(`La contraseña tiene que tener al menos ${PASSWORD_MIN} caracteres.`, 'weak_password', 400);
  if (pw.length > PASSWORD_MAX) throw new DomainError(`La contraseña admite hasta ${PASSWORD_MAX} caracteres.`, 'weak_password', 400);
  if (!pw.trim()) throw new DomainError('La contraseña no puede ser solo espacios.', 'weak_password', 400);
}

// Contraseña temporal legible (sin caracteres que se confunden).
const ALPHA = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generateTemporaryPassword(len = 14) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHA[crypto.randomInt(ALPHA.length)];
  return s;
}
