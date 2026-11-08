// `npm run admin:create -- <usuario> "<Nombre y apellido>"`: crea un administrador con una
// contraseña temporal (se muestra una sola vez y se cambia en el primer ingreso). Sirve para
// el primer ingreso en una instalación nueva y para recuperar el acceso si no queda ningún
// administrador que pueda entrar. En el VPS:
//   docker compose exec app npm run admin:create -- admin "Nombre Apellido"
// Se conecta como la app (DATABASE_URL, rol panol_app) y queda en la auditoría.
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/adapters/pg/pool.js';
import { createUser } from '../src/application/users.js';

const [username, ...rest] = process.argv.slice(2);
const name = rest.join(' ').trim();
if (!username || !name) {
  console.error('Uso: npm run admin:create -- <usuario> "<Nombre y apellido>"');
  process.exit(2);
}

let pool = null;
try {
  const config = loadConfig();
  pool = createPool(config.databaseUrl, { max: 1 });
  const r = await createUser(pool, { id: null, ip: null }, { username, name, role: 'admin' });
  console.log(`Administrador creado: ${r.user.username} (${r.user.name}).`);
  console.log(`Contraseña temporal: ${r.temporaryPassword}`);
  console.log('Anotala ahora: no se vuelve a mostrar. Se cambia en el primer ingreso.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool?.end().catch(() => {});
}
