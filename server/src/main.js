// Punto de entrada del servidor: carga la configuración, aplica migraciones (con el dueño, si
// hay MIGRATION_DATABASE_URL) y escucha conectado con el rol de la app.
import { loadConfig } from './config.js';
import { createPool } from './adapters/pg/pool.js';
import { runMigrations } from './adapters/pg/migrate.js';
import { provisionAppRole, assertNotPrivileged } from './adapters/pg/app-role.js';
import { buildApp } from './app.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, { onError: (e) => console.error('pg:', e.message) });
const app = await buildApp({ config, pool });

try {
  if (config.migrationDatabaseUrl) {
    const owner = createPool(config.migrationDatabaseUrl, { max: 1 });
    try {
      await runMigrations(owner, { log: (m) => app.log.info(m) });
      await provisionAppRole(owner, config.databaseUrl);
    } finally {
      await owner.end();
    }
  } else {
    app.log.info('sin MIGRATION_DATABASE_URL: no se aplican migraciones al arrancar (npm run db:migrate)');
  }
  await assertNotPrivileged(pool);
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
}

const shutdown = async () => {
  await app.close().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
