// Rol de la aplicación. La migración 003 crea `panol_app` sin ingreso y le da solo los
// permisos que necesita; acá el dueño le habilita el ingreso con la contraseña de DATABASE_URL.
// La app nunca se conecta como dueño de las tablas.
export const APP_ROLE = 'panol_app';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function appCredentials(appUrl) {
  const u = new URL(appUrl);
  const user = decodeURIComponent(u.username || '');
  const password = decodeURIComponent(u.password || '');
  if (user !== APP_ROLE) throw new Error(`DATABASE_URL tiene que usar el usuario ${APP_ROLE} (ahora: ${user || 'ninguno'}).`);
  if (!password) throw new Error('DATABASE_URL no tiene contraseña para el rol de la app.');
  return { user, password };
}

// ownerPool: conexión del dueño (MIGRATION_DATABASE_URL), con las migraciones ya aplicadas.
export async function provisionAppRole(ownerPool, appUrl) {
  const { password } = appCredentials(appUrl);
  const { rows } = await ownerPool.query("SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS sql", [APP_ROLE, password]);
  // Varias bases del mismo servidor (pruebas en CI) pueden fijarla a la vez.
  for (let i = 0; ; i++) {
    try {
      await ownerPool.query(rows[0].sql);
      return;
    } catch (err) {
      if (err.code !== 'XX000' || i >= 5) throw err;
      await sleep(50 * (i + 1));
    }
  }
}

// La app conectada con un superusuario o con el dueño de las tablas es un error de despliegue.
export async function assertNotPrivileged(pool) {
  const { rows } = await pool.query(
    `SELECT r.rolsuper, EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owner
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  if (rows[0]?.rolsuper || rows[0]?.owner) throw new Error(`La app no puede conectarse como superusuario ni como dueño de las tablas: usá el rol ${APP_ROLE} en DATABASE_URL.`);
}
