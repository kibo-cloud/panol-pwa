// Plugin de Vite: copia xlsx y jspdf (versiones fijadas en package-lock) a `vendor/` y
// genera el módulo `virtual:panol-vendor` con la ruta y el hash SRI (sha384) de cada uno.
// Así se cargan bajo demanda desde el propio servidor, sin CDN, con `script-src 'self'`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LIBS = {
  xlsx: { pkg: 'xlsx', file: 'dist/xlsx.full.min.js' },
  jspdf: { pkg: 'jspdf', file: 'dist/jspdf.umd.min.js' },
};
const VIRTUAL = 'virtual:panol-vendor';

export function vendorFiles() {
  const out = {};
  for (const [key, lib] of Object.entries(LIBS)) {
    const dir = path.dirname(require.resolve(`${lib.pkg}/package.json`));
    const { version } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const source = fs.readFileSync(path.join(dir, lib.file));
    const name = `vendor/${lib.pkg}-${version}.${path.basename(lib.file).replace(/^[^.]+\./, '')}`;
    out[key] = { name, source, src: '/' + name, integrity: 'sha384-' + crypto.createHash('sha384').update(source).digest('base64') };
  }
  return out;
}

export function panolVendor() {
  let files = null;
  const get = () => files || (files = vendorFiles());
  return {
    name: 'panol-vendor',
    resolveId(id) { return id === VIRTUAL ? '\0' + VIRTUAL : null; },
    load(id) {
      if (id !== '\0' + VIRTUAL) return null;
      const meta = Object.fromEntries(Object.entries(get()).map(([k, f]) => [k, { src: f.src, integrity: f.integrity }]));
      return `export default ${JSON.stringify(meta)};`;
    },
    generateBundle() {
      for (const f of Object.values(get())) this.emitFile({ type: 'asset', fileName: f.name, source: f.source });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const f = Object.values(get()).find((x) => req.url === x.src);
        if (!f) return next();
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.end(f.source);
      });
    },
  };
}
