/**
 * Canal de notificaciones para el servicio en primer plano del móvil.
 *
 * No usa FCM (no hace falta cuenta de Google ni proyecto de Firebase): el
 * servicio Android mantiene una petición larga contra `/api/push` y el puente
 * le entrega los avisos en cuanto el turno termina. Funciona con la app cerrada
 * (el servicio sigue vivo), sin depender del WebView ni del SSE.
 *
 * Cola en memoria, por dispositivo, con caducidad y tope: si el móvil está
 * desconectado los avisos se acumulan un rato y luego se tiran.
 */

const MAX_PER_DEVICE = 20;
const TTL_MS = 30 * 60_000;
const LONG_POLL_MS = 25_000;

export function createPushHub({ log = console.log } = {}) {
  const queues = new Map(); // deviceId → [{ id, chatId, title, body, at }]
  const waiters = new Map(); // deviceId → Set<resolve>
  let counter = 0;

  function queueOf(deviceId) {
    if (!queues.has(deviceId)) queues.set(deviceId, []);
    return queues.get(deviceId);
  }

  function prune(items) {
    const now = Date.now();
    while (items.length > 0 && now - items[0].at > TTL_MS) items.shift();
    while (items.length > MAX_PER_DEVICE) items.shift();
  }

  /** Encola un aviso para los dispositivos indicados (o todos los que ya esperan). */
  function enqueue({ chatId = null, title, body, kind = 'turn_end' }, deviceIds) {
    const item = {
      id: `push_${++counter}`,
      chatId,
      title: String(title ?? 'Nexo').slice(0, 80),
      body: String(body ?? '').slice(0, 240),
      kind,
      at: Date.now(),
    };
    const targets = Array.isArray(deviceIds) && deviceIds.length > 0
      ? deviceIds
      : [...queues.keys()];
    let delivered = 0;
    for (const deviceId of targets) {
      const items = queueOf(deviceId);
      items.push(item);
      prune(items);
      const waiting = waiters.get(deviceId);
      if (waiting && waiting.size > 0) {
        for (const resolve of [...waiting]) resolve(items.splice(0, items.length));
        waiters.delete(deviceId);
        delivered += 1;
      }
    }
    log(`[push] ${item.title} · ${item.body.slice(0, 40)} (dispositivos: ${targets.length}, entrega inmediata: ${delivered})`);
    return item;
  }

  /** Long-poll: devuelve lo pendiente o espera hasta `waitMs`. */
  function take(deviceId, { waitMs = LONG_POLL_MS } = {}) {
    const items = queueOf(deviceId);
    prune(items);
    if (items.length > 0) {
      const batch = items.splice(0, items.length);
      return Promise.resolve(batch);
    }
    return new Promise((resolve) => {
      const waiting = waiters.get(deviceId) ?? new Set();
      waiters.set(deviceId, waiting);
      const done = (batch) => {
        clearTimeout(timer);
        waiting.delete(done);
        if (waiting.size === 0) waiters.delete(deviceId);
        resolve(batch);
      };
      const timer = setTimeout(() => done([]), Math.max(0, Math.min(waitMs, LONG_POLL_MS)));
      if (timer.unref) timer.unref();
      waiting.add(done);
    });
  }

  function stats() {
    return { devices: queues.size, pending: [...queues.values()].reduce((max, items) => max + items.length, 0) };
  }

  return { enqueue, take, stats, LONG_POLL_MS, MAX_PER_DEVICE };
}
