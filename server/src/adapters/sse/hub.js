// Eventos en vivo (Server-Sent Events). Una conexión dedicada de PostgreSQL hace LISTEN y
// reparte cada aviso a los navegadores conectados. Si la conexión se corta, se reintenta.
import pg from 'pg';
import { EVENTS_CHANNEL } from '../pg/notify.js';
import { TIME_ZONE } from '../../config.js';

export function createEventHub({ connectionString, log = () => {}, heartbeatMs = 25000, retryMs = 2000 }) {
  const clients = new Set();
  let listener = null;
  let connecting = null;
  let heartbeat = null;
  let retry = null;
  let closed = false;

  const write = (res, chunk) => {
    try {
      res.write(chunk);
    } catch {
      clients.delete(res);
    }
  };
  const broadcast = (payload) => {
    for (const res of clients) write(res, `event: change\ndata: ${payload}\n\n`);
  };

  async function connect() {
    const c = new pg.Client({ connectionString, options: `-c timezone=${TIME_ZONE}` });
    c.on('notification', (msg) => {
      if (msg.channel === EVENTS_CHANNEL && msg.payload) broadcast(msg.payload);
    });
    c.on('error', (err) => {
      log(`sse: se cortó la conexión de eventos: ${err.message}`);
      if (listener === c) listener = null;
      c.end().catch(() => {});
      scheduleRetry();
    });
    await c.connect();
    await c.query(`LISTEN ${EVENTS_CHANNEL}`);
    if (closed) {
      await c.end().catch(() => {});
      return null;
    }
    listener = c;
    return c;
  }

  function scheduleRetry() {
    if (closed || retry || !clients.size) return;
    retry = setTimeout(() => {
      retry = null;
      ready().catch(() => scheduleRetry());
    }, retryMs);
    retry.unref?.();
  }

  // Asegura que el LISTEN esté activo antes de aceptar un cliente (no se pierden avisos).
  function ready() {
    if (listener) return Promise.resolve(listener);
    if (!connecting) connecting = connect().finally(() => { connecting = null; });
    return connecting;
  }

  function add(res) {
    clients.add(res);
    if (!heartbeat) {
      heartbeat = setInterval(() => {
        for (const r of clients) write(r, ': ping\n\n');
      }, heartbeatMs);
      heartbeat.unref?.();
    }
  }

  function remove(res) {
    clients.delete(res);
    if (!clients.size && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  async function close() {
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(retry);
    for (const res of clients) {
      try {
        res.end();
      } catch {
        // ya cerrada
      }
    }
    clients.clear();
    await connecting?.catch(() => {});
    if (listener) await listener.end().catch(() => {});
    listener = null;
  }

  return { ready, add, remove, close, get size() { return clients.size; } };
}
