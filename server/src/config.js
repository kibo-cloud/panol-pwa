// Configuración del servidor. Se lee de variables de entorno y, si existe, del archivo `.env`
// en la raíz del repositorio (las variables ya definidas en el entorno tienen prioridad).
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { TIME_ZONE } from './domain/period.js';

export { TIME_ZONE };
// Toda la aplicación trabaja con la hora local de la empresa, sin depender del equipo.
process.env.TZ = TIME_ZONE;

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Solo desarrollo y pruebas: la app entra con el rol `panol_app` (sin privilegios de dueño) y
// las migraciones con el dueño del cluster local. En producción no hay valores por defecto.
export const DEFAULT_DATABASE_URL = 'postgres://panol_app:panol-app-dev@127.0.0.1:54329/panol';
export const DEFAULT_MIGRATION_DATABASE_URL = 'postgres://postgres:panol-dev@127.0.0.1:54329/panol';
const NODE_ENVS = ['development', 'test', 'production'];

// Carga `.env` sin pisar lo que ya viene del entorno.
export function loadEnvFile(file = path.join(ROOT_DIR, '.env'), env = process.env) {
  if (!fs.existsSync(file)) return false;
  const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) if (env[k] === undefined) env[k] = v;
  return true;
}

const int = (v, def, min = 0) => {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`Valor numérico inválido en la configuración: ${v}`);
  return n;
};
const bool = (v, def) => (v === undefined || v === '' ? def : /^(1|true|yes|si|sí)$/i.test(String(v)));

// Sin NODE_ENV se asume producción (falla cerrado): exige APP_ORIGIN y DATABASE_URL y no
// relaja la cookie. Desarrollo y pruebas tienen que declararlo (`.env` o el script de npm).
export function buildConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'production';
  if (!NODE_ENVS.includes(nodeEnv)) throw new Error(`NODE_ENV inválido: ${nodeEnv} (development, test o production).`);
  const relaxed = nodeEnv === 'development' || nodeEnv === 'test';
  if (!relaxed) {
    if (!env.APP_ORIGIN) throw new Error('En producción falta APP_ORIGIN (origen público de la app, p. ej. https://panol.example).');
    if (!env.DATABASE_URL) throw new Error('En producción falta DATABASE_URL (conexión de la app con el rol panol_app).');
  }
  const cfg = {
    nodeEnv,
    host: env.HOST || '127.0.0.1',
    port: int(env.PORT, 3000),
    databaseUrl: env.DATABASE_URL || DEFAULT_DATABASE_URL,
    // Conexión del dueño de las tablas: migraciones y aprovisionamiento del rol de la app.
    migrationDatabaseUrl: env.MIGRATION_DATABASE_URL || (relaxed ? DEFAULT_MIGRATION_DATABASE_URL : ''),
    appOrigin: env.APP_ORIGIN || '',
    trustProxy: bool(env.TRUST_PROXY, false),
    // La cookie Secure solo se puede relajar en desarrollo/pruebas sobre http://localhost.
    cookieSecure: relaxed ? bool(env.COOKIE_SECURE, false) : true,
    session: {
      idleMinutes: int(env.SESSION_IDLE_MINUTES, 12 * 60, 1),
      absoluteHours: int(env.SESSION_ABSOLUTE_HOURS, 24, 1),
      rememberDays: int(env.SESSION_REMEMBER_DAYS, 30, 1),
    },
    logLevel: env.LOG_LEVEL || (nodeEnv === 'test' ? 'silent' : 'info'),
  };
  return Object.freeze(cfg);
}

// Herramientas que borran o cargan datos inventados: nunca fuera de desarrollo o pruebas.
export function requireDevEnvironment(config, what) {
  if (config.nodeEnv !== 'development' && config.nodeEnv !== 'test') {
    throw new Error(`${what} solo se ejecuta con NODE_ENV=development o test (ahora: ${config.nodeEnv}). En desarrollo, copiá .env.example a .env.`);
  }
}

export function loadConfig(env = process.env) {
  loadEnvFile(undefined, env);
  return buildConfig(env);
}
