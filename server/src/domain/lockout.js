// Bloqueo progresivo de ingreso, misma curva que 2.1: desde el 5.º intento fallido seguido
// hay que esperar 30 s, y el doble en cada nuevo error, hasta 15 minutos.
export const LOCK_AFTER = 5;
export const LOCK_BASE_SECONDS = 30;
export const LOCK_MAX_SECONDS = 900;

export function lockSeconds(fails) {
  if (fails < LOCK_AFTER) return 0;
  return Math.min(LOCK_MAX_SECONDS, LOCK_BASE_SECONDS * 2 ** (fails - LOCK_AFTER));
}

export const lockMessage = (s) => `Demasiados intentos fallidos. Esperá ${s > 90 ? Math.ceil(s / 60) + ' min' : s + ' s'} y volvé a probar.`;
