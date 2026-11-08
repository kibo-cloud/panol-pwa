// `npm run dev`: levanta la API (Fastify) y Vite juntos. Vite atiende la app en
// http://127.0.0.1:5173 y pasa /api (incluido el flujo SSE) al servidor.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = 'http://127.0.0.1:5173';
// En desarrollo el origen público es el de Vite: el control de origen (CSRF) lo usa.
const env = { ...process.env, NODE_ENV: process.env.NODE_ENV || 'development', APP_ORIGIN: WEB };

const procs = [
  spawn(process.execPath, ['server/src/main.js'], { cwd: root, env, stdio: 'inherit' }),
  spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')], { cwd: root, env, stdio: 'inherit' }),
];
console.log(`Pañol en desarrollo: abrí ${WEB}`);
const stop = () => { for (const p of procs) if (!p.killed) p.kill(); };
for (const p of procs) p.on('exit', (code) => { stop(); process.exitCode = code ?? 0; });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
