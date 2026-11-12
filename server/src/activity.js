import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeJsonAtomic } from './util.js';

const MAX_ITEMS = 200;

/**
 * Registro de actividad del agente: cada turno con su duración, herramientas
 * usadas, modelo y resultado. Es el "task log" que se muestra en la pantalla
 * del agente (estilo consola de Muse).
 *
 * Se guarda en disco para que sobreviva reinicios y se recorta a 200 entradas.
 */
export function createActivity({ file }) {
  mkdirSync(dirname(file), { recursive: true });
  let items = [];
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      items = [];
    }
  }
  let counter = items.length;

  function persist() {
    try {
      writeJsonAtomic(file, items);
    } catch {
      /* el registro no debe tumbar un turno */
    }
  }

  function record(entry) {
    const item = {
      id: `act_${Date.now().toString(36)}_${++counter}`,
      chatId: entry.chatId ?? null,
      workspacePath: entry.workspacePath ?? null,
      status: entry.status ?? 'completed',
      durationMs: Math.max(0, Number(entry.durationMs) || 0),
      tools: Array.isArray(entry.tools) ? entry.tools.slice(0, 12) : [],
      model: entry.model ?? null,
      at: entry.at ?? Date.now(),
    };
    items.unshift(item);
    if (items.length > MAX_ITEMS) items.length = MAX_ITEMS;
    persist();
    return item;
  }

  function list(limit = 30) {
    const size = Math.max(1, Math.min(Number(limit) || 30, MAX_ITEMS));
    return items.slice(0, size);
  }

  return { record, list };
}
