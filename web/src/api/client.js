// Cliente HTTP de la API (sin DOM: se prueba con node --test inyectando `fetch`).
// - Cookies de sesión (same-origin), `X-CSRF-Token` en todo pedido que modifica.
// - `If-Match` con la versión del registro, `Idempotency-Key` en movimientos y controles.
// - Errores tipados por código HTTP; sin conexión, solo se intentan los envíos marcados
//   `allowOffline` (el borrador del control en curso).

export const OFFLINE_MESSAGE = 'Sin conexión con el servidor. Esta acción se puede hacer cuando vuelva la conexión; solo el borrador del control en curso se guarda en este equipo.';
const NETWORK_MESSAGE = 'No hay conexión con el servidor. Revisá la conexión e intentá de nuevo.';

const DEFAULT_MESSAGES = {
  unauthenticated: 'Tu sesión terminó. Ingresá de nuevo.',
  forbidden: 'Tu perfil no tiene permiso para esta acción.',
  password_change_required: 'Tenés que cambiar tu contraseña antes de seguir.',
  conflict: 'Alguien modificó este registro mientras lo editabas.',
  precondition: 'Falta la versión del registro. Recargá e intentá de nuevo.',
  validation: 'Los datos enviados no son válidos.',
  rate_limited: 'Demasiados intentos seguidos. Esperá y volvé a probar.',
  not_found: 'No se encontró el registro.',
  server: 'Ocurrió un error inesperado en el servidor.',
};

export class ApiError extends Error {
  constructor({ status = 0, kind, code, message, body = null, retryAfter = null }) {
    super(message || DEFAULT_MESSAGES[kind] || 'Ocurrió un error inesperado.');
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
    this.code = code || kind;
    this.body = body;
    this.retryAfter = retryAfter;
  }
  // El servidor devuelve el registro actual en los 409 de versión.
  get current() { return this.body && this.body.current ? this.body.current : null; }
}

// Clasifica una respuesta de error (status + cuerpo JSON + Retry-After) en un tipo estable.
export function kindOf(status, code) {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return code === 'password_change_required' ? 'password_change_required' : 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 428) return 'precondition';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 413 || status === 415 || status === 422) return 'validation';
  return 'server';
}

export function toApiError(status, body, retryAfterHeader) {
  const b = body && typeof body === 'object' ? body : {};
  const code = typeof b.error === 'string' ? b.error : undefined;
  const kind = kindOf(status, code);
  let retryAfter = Number(retryAfterHeader);
  if (!Number.isFinite(retryAfter) || retryAfter <= 0) retryAfter = Number.isFinite(b.retryAfter) ? b.retryAfter : null;
  return new ApiError({ status, kind, code, message: typeof b.message === 'string' ? b.message : undefined, body: b, retryAfter });
}

// Clave de idempotencia: letras, números y guiones (el servidor acepta 8 a 200 caracteres).
export function newIdempotencyKey(rand = Math.random) {
  let s = 'k' + Date.now().toString(36);
  while (s.length < 28) s += Math.floor(rand() * 36).toString(36);
  return s;
}

export function createClient({ fetchImpl, getCsrf = () => '', isOffline = () => false, onNetwork = () => {} } = {}) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));

  async function request(method, path, opts = {}) {
    const writing = method !== 'GET' && method !== 'HEAD';
    if (writing && isOffline() && !opts.allowOffline) throw new ApiError({ kind: 'offline', message: OFFLINE_MESSAGE });
    const headers = { Accept: opts.text ? 'text/plain' : 'application/json' };
    if (writing) headers['X-CSRF-Token'] = getCsrf() || '';
    if (opts.version != null) headers['If-Match'] = `"${opts.version}"`;
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    let body;
    if (opts.rawText != null) { headers['Content-Type'] = 'text/plain; charset=utf-8'; body = opts.rawText; }
    else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
    let res;
    try {
      res = await doFetch(path, { method, headers, body, credentials: 'same-origin', cache: 'no-store' });
    } catch (e) {
      onNetwork(false);
      throw new ApiError({ kind: 'network', message: NETWORK_MESSAGE });
    }
    onNetwork(true);
    if (res.ok) {
      if (opts.text) return res.text();
      if (res.status === 204) return null;
      const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      return ct.includes('application/json') ? res.json() : res.text();
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    throw toApiError(res.status, data, res.headers && res.headers.get ? res.headers.get('retry-after') : null);
  }

  return {
    request,
    get: (p, o) => request('GET', p, o),
    post: (p, body, o = {}) => request('POST', p, { ...o, body }),
    patch: (p, body, o = {}) => request('PATCH', p, { ...o, body }),
    put: (p, body, o = {}) => request('PUT', p, { ...o, body }),
    del: (p, o = {}) => request('DELETE', p, o),
  };
}
