// `npm run db:reset`: borra y recrea la base de DATABASE_URL, aplica migraciones y carga datos
// inventados de desarrollo. Nunca usa datos reales.
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/adapters/pg/pool.js';
import { runMigrations } from '../src/adapters/pg/migrate.js';
import { withDevServer, recreateDatabase, parseDbUrl } from './lib/dev-db.js';
import { seed } from './seed.js';

const config = loadConfig();
if (config.nodeEnv === 'production') {
  console.error('db:reset no se ejecuta con NODE_ENV=production.');
  process.exit(1);
}
try {
  await withDevServer(config.databaseUrl, async () => {
    await recreateDatabase(config.databaseUrl);
    console.log(`base ${parseDbUrl(config.databaseUrl).database} recreada`);
    const pool = createPool(config.databaseUrl);
    try {
      await runMigrations(pool, { log: console.log });
      const summary = await seed(pool);
      console.log('datos de desarrollo cargados:', JSON.stringify(summary));
    } finally {
      await pool.end();
    }
  });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
