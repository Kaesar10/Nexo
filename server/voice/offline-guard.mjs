/**
 * offline-guard.mjs — ayuda de prueba: envenena las primitivas de red del
 * proceso para demostrar que el dictado local transcribe SIN internet.
 *
 * Uso:
 *   node --import ./offline-guard.mjs worker.mjs audio.wav --language es
 *
 * Si el motor intentase descargar cualquier cosa, reventaría aquí en vez de
 * usar la red. Que la transcripción funcione con este guard activo demuestra
 * que todos los ficheros del modelo ya están en disco.
 */
import net from 'node:net';
import tls from 'node:tls';

function boom(what) {
  const err = new Error(`[offline-guard] red bloqueada: se intentó usar ${what}`);
  err.code = 'OFFLINE_GUARD';
  throw err;
}

// fetch (lo que usa @huggingface/transformers para descargar de HF)
globalThis.fetch = async (url, ...rest) => boom(`fetch(${String(url).slice(0, 80)}, ...)`);

// http/https a nivel de socket (por si alguna librería evita fetch)
net.Socket.prototype.connect = function connect() {
  boom('net.Socket.connect');
};
tls.connect = () => boom('tls.connect');
