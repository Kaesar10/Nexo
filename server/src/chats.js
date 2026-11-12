import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeJsonAtomic } from './util.js';

/**
 * Metadatos propios de cada conversación: modelo elegido y, si se creó desde el
 * móvil, cuándo. DSH guarda la sesión, pero no el modelo por chat (vive en el
 * perfil), así que esto es el complemento que el móvil necesita.
 */
export function createChatMeta({ file }) {
  mkdirSync(dirname(file), { recursive: true });
  let data = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') data = parsed;
    } catch {
      data = {};
    }
  }

  function persist() {
    try {
      writeJsonAtomic(file, data);
    } catch {
      /* si el disco falla, no debe tumbar un turno */
    }
  }

  function get(chatId) {
    return data[chatId] ?? null;
  }

  function set(chatId, patch) {
    data[chatId] = { ...(data[chatId] ?? {}), ...patch, updatedAt: Date.now() };
    persist();
    return data[chatId];
  }

  function all() {
    return data;
  }

  return { get, set, all };
}
