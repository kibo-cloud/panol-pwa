// Punto de entrada del servidor: carga la configuración, aplica migraciones y escucha.
import { loadConfig } from './config.js';
import { createPool } from './adapters/pg/pool.js';
import { runMigrations } from './adapters/pg/migrate.js';
import { buildApp } from './app.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, { onError: (e) => console.error('pg:', e.message) });
const app = await buildApp({ config, pool });

try {
  await runMigrations(pool, { log: (m) => app.log.info(m) });
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
