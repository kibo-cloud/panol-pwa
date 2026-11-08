// `npm run db:reset`: borra y recrea la base, aplica migraciones con el dueño
// (MIGRATION_DATABASE_URL), habilita el rol de la app (DATABASE_URL) y carga datos inventados
// de desarrollo. Nunca usa datos reales y solo corre con NODE_ENV=development o test.
import { loadConfig, requireDevEnvironment } from '../src/config.js';
import { createPool } from '../src/adapters/pg/pool.js';
import { runMigrations } from '../src/adapters/pg/migrate.js';
import { provisionAppRole } from '../src/adapters/pg/app-role.js';
import { withDevServer, recreateDatabase, parseDbUrl } from './lib/dev-db.js';
import { seed } from './seed.js';

try {
  const config = loadConfig();
  requireDevEnvironment(config, 'db:reset');
  const ownerUrl = config.migrationDatabaseUrl;
  await withDevServer(ownerUrl, async () => {
    await recreateDatabase(ownerUrl);
    console.log(`base ${parseDbUrl(ownerUrl).database} recreada`);
    const pool = createPool(ownerUrl);
    try {
      await runMigrations(pool, { log: console.log });
      await provisionAppRole(pool, config.databaseUrl);
      const summary = await seed(pool, { config });
      console.log('datos de desarrollo cargados:', JSON.stringify(summary));
    } finally {
      await pool.end();
    }
  });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
