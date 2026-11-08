// `npm run db:start`: deja corriendo el PostgreSQL local (`.pgdata/`) y crea la base si falta.
// Se detiene con `npm run db:stop`.
import { loadConfig } from '../src/config.js';
import { ensureServer, createDatabaseIfMissing, parseDbUrl } from './lib/dev-db.js';

const config = loadConfig();
try {
  const started = await ensureServer(config.databaseUrl);
  if (!started) console.log('PostgreSQL ya estaba corriendo.');
  if (await createDatabaseIfMissing(config.databaseUrl)) console.log(`base ${parseDbUrl(config.databaseUrl).database} creada`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
