// `npm run db:migrate`: aplica las migraciones pendientes con el dueño de las tablas
// (MIGRATION_DATABASE_URL) y habilita el rol de la app (usuario y contraseña de DATABASE_URL).
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/adapters/pg/pool.js';
import { runMigrations } from '../src/adapters/pg/migrate.js';
import { provisionAppRole } from '../src/adapters/pg/app-role.js';
import { withDevServer, createDatabaseIfMissing } from './lib/dev-db.js';

try {
  const config = loadConfig();
  const ownerUrl = config.migrationDatabaseUrl;
  if (!ownerUrl) throw new Error('Falta MIGRATION_DATABASE_URL (conexión del dueño de las tablas).');
  const work = async () => {
    await createDatabaseIfMissing(ownerUrl);
    const pool = createPool(ownerUrl);
    try {
      const applied = await runMigrations(pool, { log: console.log });
      console.log(applied.length ? `${applied.length} migraciones aplicadas.` : 'No hay migraciones pendientes.');
      await provisionAppRole(pool, config.databaseUrl);
      console.log('rol de la app habilitado.');
    } finally {
      await pool.end();
    }
  };
  // Solo en desarrollo se arranca el PostgreSQL local si no responde.
  if (config.nodeEnv === 'production') await work();
  else await withDevServer(ownerUrl, work);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
