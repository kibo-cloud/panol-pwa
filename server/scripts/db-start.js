// `npm run db:start`: deja corriendo el PostgreSQL local (`.pgdata/`) y crea la base si falta.
// Usa la conexión del dueño (MIGRATION_DATABASE_URL). Se detiene con `npm run db:stop`.
import { loadConfig, requireDevEnvironment } from '../src/config.js';
import { ensureServer, createDatabaseIfMissing, parseDbUrl } from './lib/dev-db.js';

try {
  const config = loadConfig();
  requireDevEnvironment(config, 'db:start');
  const ownerUrl = config.migrationDatabaseUrl;
  const started = await ensureServer(ownerUrl);
  if (!started) console.log('PostgreSQL ya estaba corriendo.');
  if (await createDatabaseIfMissing(ownerUrl)) console.log(`base ${parseDbUrl(ownerUrl).database} creada`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
