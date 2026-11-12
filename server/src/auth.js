import { deviceToken, safeEqual, sha256, shortId } from './util.js';

const FAIL_WINDOW_MS = 60_000;
const FAIL_LIMIT = 5;
const LOCK_MS = 60_000;

// Bloqueo global: el puente está expuesto a Internet (Tailscale Funnel), así que
// un atacante puede rotar IPs. Si hay muchos fallos en poco tiempo se cierra el
// emparejamiento para todos durante un rato.
const GLOBAL_WINDOW_MS = 15 * 60_000;
const GLOBAL_FAIL_LIMIT = 25;
const GLOBAL_LOCK_MS = 15 * 60_000;

/**
 * Emparejamiento por PIN + tokens de dispositivo persistentes.
 * El PIN solo se muestra en la consola del PC; nunca se sirve por HTTP.
 */
export function createAuth({ config, save, log = console.error }) {
  const failures = new Map(); // ip → { count, since, lockedUntil }
  const global = { count: 0, since: Date.now(), lockedUntil: 0 };

  function throttled(ip) {
    if (global.lockedUntil > Date.now()) {
      return Math.ceil((global.lockedUntil - Date.now()) / 1000);
    }
    const entry = failures.get(ip);
    if (!entry) return 0;
    if (entry.lockedUntil && entry.lockedUntil > Date.now()) {
      return Math.ceil((entry.lockedUntil - Date.now()) / 1000);
    }
    return 0;
  }

  function registerFailure(ip) {
    const now = Date.now();
    const entry = failures.get(ip) ?? { count: 0, since: now, lockedUntil: 0 };
    if (now - entry.since > FAIL_WINDOW_MS) {
      entry.count = 0;
      entry.since = now;
    }
    entry.count += 1;
    if (entry.count >= FAIL_LIMIT) entry.lockedUntil = now + LOCK_MS;
    failures.set(ip, entry);

    if (now - global.since > GLOBAL_WINDOW_MS) {
      global.count = 0;
      global.since = now;
      global.lockedUntil = 0;
    }
    global.count += 1;
    if (global.count >= GLOBAL_FAIL_LIMIT && global.lockedUntil <= now) {
      global.lockedUntil = now + GLOBAL_LOCK_MS;
      log(
        `[auth] ${global.count} intentos fallidos de emparejamiento: bloqueado 15 min. ` +
          `Si no eras tú, rota el PIN con: node server/src/index.js rotate-pin`,
      );
    }
  }

  function clearFailures(ip) {
    failures.delete(ip);
    global.count = 0;
    global.lockedUntil = 0;
  }

  /** Comprueba el PIN y devuelve un token nuevo de dispositivo. */
  function pair({ code, deviceName, ip }) {
    const wait = throttled(ip);
    if (wait > 0) {
      throw Object.assign(new Error(`Demasiados intentos. Espera ${wait} s.`), {
        code: 'RATE_LIMITED',
        status: 429,
      });
    }
    const pin = String(code ?? '').trim();
    if (!pin || !safeEqual(pin, config.pin)) {
      registerFailure(ip);
      throw Object.assign(new Error('Código incorrecto'), { code: 'UNAUTHORIZED', status: 401 });
    }    clearFailures(ip);
    const token = deviceToken();
    const device = {
      id: shortId('dev'),
      name: String(deviceName ?? 'Móvil').trim().slice(0, 60) || 'Móvil',
      hash: sha256(token),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    config.devices.push(device);
    save();
    return { token, deviceId: device.id, deviceName: device.name };
  }

  /** Valida un token y actualiza lastSeenAt (sin escribir en cada petición). */
  function verify(token) {
    if (!token) return null;
    const hash = sha256(token);
    for (const device of config.devices) {
      if (safeEqual(device.hash, hash)) {
        const now = Date.now();
        if (!device.lastSeenAt || now - device.lastSeenAt > 60_000) {
          device.lastSeenAt = now;
          save();
        }
        return device;
      }
    }
    return null;
  }

  function revoke(deviceId) {
    const before = config.devices.length;
    config.devices = config.devices.filter((device) => device.id !== deviceId);
    if (config.devices.length !== before) {
      save();
      return true;
    }
    return false;
  }

  /**
   * Crea un dispositivo sin PIN. Solo lo usa el aprovisionamiento local
   * (`POST /api/provision` desde loopback) para hornear el token en el APK y
   * que la app entre sola, sin pantalla de emparejamiento.
   */
  function provision(deviceName) {
    const token = deviceToken();
    const device = {
      id: shortId('dev'),
      name: String(deviceName ?? 'Móvil').trim().slice(0, 60) || 'Móvil',
      hash: sha256(token),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    config.devices.push(device);
    save();
    return { token, deviceId: device.id, deviceName: device.name };
  }

  return { pair, verify, revoke, provision };
}
