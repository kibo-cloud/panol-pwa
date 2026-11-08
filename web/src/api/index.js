// Único acceso a datos de la app: cada función corresponde a un endpoint del servidor.
import { createClient, newIdempotencyKey } from './client.js';
import { net } from './net.js';

export { ApiError, OFFLINE_MESSAGE, newIdempotencyKey } from './client.js';

let csrf = '';
export const setCsrf = (t) => { csrf = t || ''; };

const http = createClient({
  getCsrf: () => csrf,
  isOffline: () => net.offline,
  onNetwork: (ok) => net.report(ok),
});

const enc = encodeURIComponent;
const idem = (o = {}) => ({ ...o, idempotencyKey: o.idempotencyKey || newIdempotencyKey() });

export const api = {
  // sesión
  me: () => http.get('/api/auth/me'),
  login: (username, password, remember) => http.post('/api/auth/login', { username, password, remember }, { allowOffline: true }),
  logout: () => http.post('/api/auth/logout', undefined, { allowOffline: true }),
  changePassword: (currentPassword, newPassword) => http.post('/api/auth/change-password', { currentPassword, newPassword }),
  health: () => http.get('/api/health'),

  // lecturas
  state: () => http.get('/api/state'),
  audit: (before) => http.get(`/api/audit?limit=50${before ? '&before=' + enc(before) : ''}`),

  // usuarios y permisos (admin)
  users: () => http.get('/api/users'),
  createUser: (body) => http.post('/api/users', body),
  updateUser: (id, body, version) => http.patch(`/api/users/${enc(id)}`, body, { version }),
  setUserActive: (id, active, version) => http.post(`/api/users/${enc(id)}/${active ? 'reactivate' : 'deactivate'}`, undefined, { version }),
  resetPassword: (id, version) => http.post(`/api/users/${enc(id)}/reset-password`, undefined, { version }),
  permissions: () => http.get('/api/permissions'),
  setPermissions: (overrides) => http.put('/api/permissions', { overrides }),

  // catálogo
  createTech: (body) => http.post('/api/techs', body),
  updateTech: (id, body, version) => http.patch(`/api/techs/${enc(id)}`, body, { version }),
  shiftChange: (id, body, version) => http.post(`/api/techs/${enc(id)}/shift-change`, body, { version }),
  createShift: (body) => http.post('/api/shifts', body),
  updateShift: (id, body, version) => http.patch(`/api/shifts/${enc(id)}`, body, { version }),
  deleteShift: (id, version) => http.del(`/api/shifts/${enc(id)}`, { version }),
  createCategory: (body) => http.post('/api/categories', body),
  updateCategory: (id, body, version) => http.patch(`/api/categories/${enc(id)}`, body, { version }),
  deleteCategory: (id, version) => http.del(`/api/categories/${enc(id)}`, { version }),
  createTool: (body) => http.post('/api/tools', body),
  updateTool: (id, body, version) => http.patch(`/api/tools/${enc(id)}`, body, { version }),

  // operaciones (con Idempotency-Key)
  movement: (body, o) => http.post('/api/movements', body, idem(o)),
  createControl: (body, o) => http.post('/api/controls', body, idem(o)),
  saveControl: (id, items, version, o) => http.patch(`/api/controls/${enc(id)}`, { items }, idem({ ...o, version })),
  finalizeControl: (id, version, o) => http.post(`/api/controls/${enc(id)}/finalize`, undefined, idem({ ...o, version })),
  resolveAlert: (key, note) => http.post(`/api/alerts/${enc(key)}/resolution`, { note }),
  loadDemo: () => http.post('/api/demo'),
  clearDemo: () => http.del('/api/demo'),

  // archivo .txt
  importTxt: (text, mode, token) => http.request('POST', `/api/import/txt?mode=${enc(mode)}${token ? '&token=' + enc(token) : '&dryRun=1'}`, { rawText: text }),
  exportTxt: () => http.get('/api/export/txt', { text: true }),
};
