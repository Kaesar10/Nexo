const HEARTBEAT_MS = 20_000;

/**
 * Bus de eventos SSE. La app abre un único EventSource y filtra por `chatId`;
 * así un turno largo sigue llegando aunque el usuario cambie de pantalla.
 */
export function createSseHub({ log = console.log } = {}) {
  const clients = new Set();

  function add(req, res, deviceId) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    write(res, { type: 'hello', serverVersion: '1.0.0' });
    const client = { res, deviceId };
    clients.add(client);
    req.on('close', () => {
      clients.delete(client);
    });
    return client;
  }

  function write(res, event) {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (error) {
      log(`[sse] error al escribir: ${error.message}`);
    }
  }

  function broadcast(event) {
    for (const client of [...clients]) {
      write(client.res, event);
    }
  }

  function count() {
    return clients.size;
  }

  const beat = setInterval(() => {
    for (const client of [...clients]) write(client.res, { type: 'heartbeat' });
  }, HEARTBEAT_MS);
  if (beat.unref) beat.unref();

  function close() {
    clearInterval(beat);
    for (const client of [...clients]) {
      try {
        client.res.end();
      } catch {
        /* ya cerrado */
      }
    }
    clients.clear();
  }

  return { add, broadcast, count, close };
}
