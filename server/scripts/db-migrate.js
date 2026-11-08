// `npm run db:migrate`: aplica las migraciones pendientes sobre DATABASE_URL.
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/adapters/pg/pool.js';
import { runMigrations } from '../src/adapters/pg/migrate.js';
import { withDevServer, createDatabaseIfMissing } from './lib/dev-db.js';

const config = loadConfig();
try {
  await withDevServer(config.databaseUrl, async () => {
    await createDatabaseIfMissing(config.databaseUrl);
    const pool = createPool(config.databaseUrl);
    try {
      const applied = await runMigrations(pool, { log: console.log });
      console.log(applied.length ? `${applied.length} migraciones aplicadas.` : 'No hay migraciones pendientes.');
    } finally {
      await pool.end();
    }
  });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
