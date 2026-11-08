// Datos inventados de las pruebas E2E: un usuario por perfil, sin técnicos ni herramientas
// (cada prueba arma lo que necesita por la interfaz, la API o los datos de demostración).
import { hashPassword } from '../../server/src/application/passwords.js';

export const PASSWORD = 'panol-e2e-1234';
export const USERS = {
  admin: { id: 'u-admin', name: 'Admin Prueba', role: 'admin' },
  gerencia: { id: 'u-gerencia', name: 'Gerencia Prueba', role: 'gerencia' },
  supervisor: { id: 'u-supervisor', name: 'Supervisor Prueba', role: 'supervisor' },
  responsable: { id: 'u-responsable', name: 'Responsable Prueba', role: 'responsable' },
  consulta: { id: 'u-consulta', name: 'Consulta Prueba', role: 'consulta' },
};

export async function seedUsers(pool) {
  const hash = await hashPassword(PASSWORD);
  for (const [username, u] of Object.entries(USERS)) {
    await pool.query('INSERT INTO users (id, username, name, role, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5,false)', [u.id, username, u.name, u.role, hash]);
  }
}
