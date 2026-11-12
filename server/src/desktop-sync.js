import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from './util.js';

/**
 * Sincronización con el escritorio de DSH.
 *
 * El GUI de escritorio no descubre sesiones nuevas por sí solo: mantiene en
 * `~/.dsh/storages/workspace.json` la lista `sessionIds` de cada proyecto y solo
 * muestra las que están ahí. Las sesiones que crea el puente (proceso aparte)
 * no aparecen hasta que se registran y el escritorio vuelve a arrancar.
 *
 * Este módulo hace la parte que sí podemos hacer: dejar la sesión registrada en
 * el proyecto que le corresponde (por `cwd`), incluida la recuperación de las
 * que ya existían. Es tolerante a fallos: si el fichero no está, está bloqueado
 * o cambia mientras escribimos, no rompe el turno.
 */
export function createDesktopSync({ log = console.log, home = homedir() } = {}) {
  const file = join(home, '.dsh', 'storages', 'workspace.json');

  function readStore() {
    if (!existsSync(file)) return null;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const workspaces = data?.tables?.workspaces;
      if (!workspaces || typeof workspaces !== 'object') return null;
      return data;
    } catch {
      return null;
    }
  }

  function findWorkspace(workspaces, workspacePath) {
    const target = workspacePath.toLowerCase();
    return Object.entries(workspaces).find(
      ([, workspace]) => typeof workspace?.path === 'string' && workspace.path.toLowerCase() === target,
    );
  }

  /**
   * Registra una sesión en el proyecto cuyo `path` coincide con su `cwd`.
   * Si el proyecto no está registrado, lo crea (el escritorio lo mostrará al
   * arrancar). Nunca lanza.
   */
  function registerSession({ sessionId, workspacePath, title }) {
    if (!sessionId || !workspacePath) return false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const data = readStore();
      if (!data) return false;
      const workspaces = data.tables.workspaces;
      const found = findWorkspace(workspaces, workspacePath);
      const now = new Date().toISOString();

      if (found) {
        const [id, workspace] = found;
        if (!Array.isArray(workspace.sessionIds)) workspace.sessionIds = [];
        if (workspace.sessionIds.includes(sessionId)) return true;
        workspace.sessionIds.unshift(sessionId);
        workspace.updatedAt = now;
        try {
          writeJsonAtomic(file, data);
          log(`[escritorio] sesión ${sessionId} registrada en «${workspace.title ?? id}»`);
          return true;
        } catch (error) {
          log(`[escritorio] no se pudo escribir (intento ${attempt + 1}): ${error.message}`);
          continue;
        }
      }

      const id = randomUUID();
      workspaces[id] = {
        path: workspacePath,
        title: String(title ?? basename(workspacePath) ?? 'Proyecto').slice(0, 80),
        sessionIds: [sessionId],
        createdAt: now,
        updatedAt: now,
      };
      try {
        writeJsonAtomic(file, data);
        log(`[escritorio] proyecto «${workspaces[id].title}» y sesión ${sessionId} registrados`);
        return true;
      } catch (error) {
        log(`[escritorio] no se pudo crear el proyecto (intento ${attempt + 1}): ${error.message}`);
      }
    }
    return false;
  }

  /**
   * Recupera las sesiones que ya existen en disco y no estaban registradas.
   * @param {Array<{ path: string, name?: string }>} workspaces
   * @param {(workspacePath: string) => Array<{ id: string }>} listSessions
   * @returns {number} sesiones registradas
   */
  function backfill(workspaces, listSessions) {
    let added = 0;
    for (const workspace of workspaces ?? []) {
      let sessions = [];
      try {
        sessions = listSessions(workspace.path) ?? [];
      } catch {
        continue;
      }
      const data = readStore();
      const registered = data ? findWorkspace(data.tables.workspaces, workspace.path) : null;
      const known = new Set(registered?.[1]?.sessionIds ?? []);
      for (const session of sessions) {
        if (!session?.id || known.has(session.id)) continue;
        if (registerSession({ sessionId: session.id, workspacePath: workspace.path, title: workspace.name })) {
          known.add(session.id);
          added += 1;
        }
      }
    }
    return added;
  }

  return { registerSession, backfill, file };
}
