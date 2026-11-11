// Lectura + plan del Excel en un worker_threads con tiempo y memoria máximos (E9.V1): si tarda
// más de `timeoutMs` se termina el worker y se responde `import_timeout`; si se queda sin memoria,
// `too_complex`. El hilo principal (el servidor) nunca queda bloqueado por un archivo.
import { Worker } from 'node:worker_threads';
import { WorkbookError } from './workbook.js';

export const MAX_EXCEL_BYTES = 10 * 1024 * 1024;
export const WORKER_LIMITS = Object.freeze({ timeoutMs: 30_000, maxOldGenerationSizeMb: 768 });
const WORKER_URL = new URL('./worker.js', import.meta.url);

// job: { file: Buffer, server, decisions, today, now }. Devuelve el plan (planExcelImport).
export function planInWorker(job, { timeoutMs = WORKER_LIMITS.timeoutMs } = {}) {
  const { file } = job;
  if (!Buffer.isBuffer(file) || !file.length) return Promise.reject(new WorkbookError('El archivo está vacío.'));
  if (file.length > MAX_EXCEL_BYTES) return Promise.reject(new WorkbookError(`El archivo supera ${MAX_EXCEL_BYTES / 1024 / 1024} MB.`, 'too_large'));
  return new Promise((resolve, reject) => {
    let done = false;
    const worker = new Worker(WORKER_URL, {
      workerData: { file, server: job.server, decisions: job.decisions || {}, today: job.today, now: job.now ?? Date.now() },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_LIMITS.maxOldGenerationSizeMb },
      stdout: false,
      stderr: false,
    });
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new WorkbookError('El archivo tardó demasiado en leerse y se canceló la importación. Revisá que sea el Excel de herramientas.', 'import_timeout')), timeoutMs);
    worker.on('message', (m) => {
      if (m && m.ok) finish(resolve, m.plan);
      else if (m && m.error && m.error.code !== 'internal') finish(reject, new WorkbookError(m.error.message, m.error.code));
      else finish(reject, new Error(`excel worker: ${m && m.error ? m.error.message : 'sin respuesta'}`));
    });
    worker.on('error', (err) => {
      if (err && err.code === 'ERR_WORKER_OUT_OF_MEMORY') finish(reject, new WorkbookError('El libro es demasiado grande o complejo para importarlo de una vez.', 'too_complex'));
      else finish(reject, err);
    });
    worker.on('exit', (code) => finish(reject, new Error(`excel worker: terminó sin respuesta (${code})`)));
  });
}
