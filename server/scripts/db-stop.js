// `npm run db:stop`: detiene el PostgreSQL local de `.pgdata/`.
import { stopLocalServer } from './lib/dev-db.js';

try {
  await stopLocalServer();
  console.log('PostgreSQL local detenido.');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
