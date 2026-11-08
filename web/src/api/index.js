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
  // plantillas (etapa 2)
  createPlantilla: (body) => http.post('/api/plantillas', body),
  updatePlantilla: (id, body, version) => http.patch(`/api/plantillas/${enc(id)}`, body, { version }),
  archivePlantilla: (id, version) => http.post(`/api/plantillas/${enc(id)}/archive`, undefined, { version }),
  rotatePlantilla: (id, body, version) => http.post(`/api/plantillas/${enc(id)}/rotate`, body, { version }),
  setSupervisor: (id, body, version) => http.post(`/api/plantillas/${enc(id)}/supervisor`, body, { version }),
  moveTech: (id, body, version, o) => http.post(`/api/techs/${enc(id)}/move`, body, idem({ ...o, version })),
  moveSelected: (id, body, o) => http.post(`/api/plantillas/${enc(id)}/move-selected`, body, idem(o)),
  shiftLabels: () => http.get('/api/settings/shift-labels'),
  setShiftLabels: (labels, version) => http.put('/api/settings/shift-labels', { labels }, { version }),

  // líneas, sectores y cajas (etapa 2)
  createLinea: (body) => http.post('/api/lineas', body),
  updateLinea: (id, body, version) => http.patch(`/api/lineas/${enc(id)}`, body, { version }),
  archiveLinea: (id, version) => http.post(`/api/lineas/${enc(id)}/archive`, undefined, { version }),
  createCaja: (body) => http.post('/api/cajas', body),
  updateCaja: (id, body, version) => http.patch(`/api/cajas/${enc(id)}`, body, { version }),
  archiveCaja: (id, version) => http.post(`/api/cajas/${enc(id)}/archive`, undefined, { version }),
  assign: (body, o) => http.post('/api/assignments', body, idem(o)),

  createCategory: (body) => http.post('/api/categories', body),
  updateCategory: (id, body, version) => http.patch(`/api/categories/${enc(id)}`, body, { version }),
  deleteCategory: (id, version) => http.del(`/api/categories/${enc(id)}`, { version }),
  createTool: (body) => http.post('/api/tools', body),
  // etapa 3: orden, especialidades y kits
  reorderCategories: (ids, version) => http.put('/api/categories/order', { ids }, { version }),
  reorderTools: (categoryId, ids, version) => http.put('/api/tools/order', { categoryId, ids }, { version }),
  createEspecialidad: (body) => http.post('/api/especialidades', body),
  updateEspecialidad: (id, body, version) => http.patch(`/api/especialidades/${enc(id)}`, body, { version }),
  archiveEspecialidad: (id, version) => http.post(`/api/especialidades/${enc(id)}/archive`, undefined, { version }),
  createKit: (body) => http.post('/api/kits', body),
  saveKit: (id, body, version) => http.put(`/api/kits/${enc(id)}`, body, { version }),
  deleteKit: (id, version) => http.del(`/api/kits/${enc(id)}`, { version }),
  deliverKit: (id, body, version, o) => http.post(`/api/kits/${enc(id)}/deliver`, body, idem({ ...o, version })),
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
