import { existsSync, watch } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';

/**
 * Nexo Live Sync — mitad host.
 *
 * El escritorio de DSH solo muestra las sesiones que están registradas en la
 * lista `sessionIds` de cada proyecto (`workspaceRegistry`) y solo la rellena
 * cuando es él quien crea la conversación. Las sesiones que crea el puente del
 * móvil (otro proceso) se quedan en el almacén pero no en esa lista.
 *
 * Este plugin vigila `~/.dsh/sessions`, y por cada sesión nueva:
 *
 *   1. lee su cabecera (`cwd`),
 *   2. busca el proyecto cuyo `path` canónico coincide (lo crea si no existe),
 *   3. llama a `entity.attachSession(id)`.
 *
 * `attachSession` escribe en el dominio `workspace`; el controlador de
 * proyectos del escritorio escucha `domain/changed` y empuja la actualización
 * al GUI, así que la conversación aparece en su proyecto al instante, sin
 * reiniciar.
 *
 * También hace un barrido al arrancar para recuperar lo creado con DSH cerrado,
 * y un repaso periódico por si el sistema de ficheros no avisa de algún cambio.
 */

export const name = 'nexo-live-sync';

/** Servicios de DSH que necesita el plugin. */
export const inject = ['workspaceRegistry', 'sessionPersistence'];

/** Repaso de seguridad cuando el vigilante de ficheros no dispara. */
const SWEEP_MS = 30_000;
/** Espera tras detectar un fichero nuevo: la cabecera puede estar escribiéndose. */
const DEBOUNCE_MS = 700;
/** Intentos de lectura de la cabecera de una sesión recién creada. */
const HEADER_ATTEMPTS = 5;

/** `/ruta/a/session-<uuid>/session.v4.jsonl.zstd` -> `session-<uuid>` (o null). */
export function sessionIdFromPath(filePath) {
  const parts = String(filePath).split(/[\\/]/);
  const dir = parts.at(-2);
  return dir && /^session-[0-9a-zA-Z-]+$/.test(dir) ? dir : null;
}

/**
 * ¿Hay que adjuntar esta cabecera? No se tocan sesiones de subagente, sin `cwd`
 * ni archivadas.
 * @param {{ id?: string, cwd?: string, delegationDepth?: number }} header
 * @param {Set<string>} known - ids ya registrados en algún proyecto.
 * @param {Set<string>} archived - ids archivados por el usuario.
 * @returns {boolean}
 */
export function shouldAttach(header, known, archived) {
  if (!header?.id || typeof header.cwd !== 'string' || header.cwd.trim() === '') return false;
  if ((header.delegationDepth ?? 0) > 0) return false;
  if (known.has(header.id) || archived.has(header.id)) return false;
  return true;
}

/**
 * Busca el proyecto cuyo `path` canónico coincide con el `cwd` de la sesión.
 * @param {Array<{ id: string, path: string }>} workspaces
 * @param {string} canonicalPath
 * @returns {{ id: string, path: string } | undefined}
 */
export function matchWorkspace(workspaces, canonicalPath) {
  const target = canonicalPath.toLowerCase();
  return workspaces.find((workspace) => workspace.path?.toLowerCase() === target);
}

/** Cuerpo del plugin host. */
export function apply(ctx) {
  const registry = ctx.workspaceRegistry;
  const persistence = ctx.sessionPersistence;
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const sessionsRoot = join(home, 'sessions');

  const log = (message) => {
    try {
      ctx.logger?.info?.(message);
    } catch {
      /* el logger es opcional */
    }
    console.log(`[nexo-live-sync] ${message}`);
  };

  /** Ids ya presentes en algún proyecto (se refresca en cada barrido). */
  const known = new Set();
  /** Sesiones cuya cabecera aún no se pudo leer (se reintenta). */
  const pending = new Map();
  let sweepTimer;
  let watcher;
  let disposed = false;

  function refreshKnown() {
    for (const workspace of registry.list()) {
      for (const id of workspace.sessionIds) known.add(String(id));
    }
  }

  async function attach(header) {
    if (!header?.cwd) return false;
    let canonical;
    try {
      canonical = await realpath(header.cwd);
    } catch {
      return false;
    }
    let workspace = matchWorkspace(registry.list(), canonical);
    if (workspace === undefined) {
      try {
        workspace = await registry.create(canonical, basename(canonical));
        log(`proyecto «${basename(canonical)}» registrado`);
      } catch (error) {
        log(`no se pudo crear el proyecto para ${canonical}: ${error.message}`);
        return false;
      }
    }
    if (workspace.sessionIds.includes(header.id)) {
      known.add(header.id);
      return false;
    }
    try {
      await registry.get(workspace.id)?.attachSession(header.id);
      known.add(header.id);
      log(`sesión ${header.id} adjuntada a «${workspace.title ?? workspace.path}»`);
      return true;
    } catch (error) {
      log(`no se pudo adjuntar ${header.id}: ${error.message}`);
      return false;
    }
  }

  async function readHeader(sessionId) {
    for (let attempt = 0; attempt < HEADER_ATTEMPTS; attempt += 1) {
      try {
        const snapshot = await persistence.stat(sessionId);
        if (snapshot?.header) return snapshot.header;
      } catch {
        /* la sesión puede estar escribiéndose */
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      if (disposed) return null;
    }
    return null;
  }

  async function handleSession(sessionId) {
    if (disposed || known.has(sessionId)) return;
    if (pending.has(sessionId)) return;
    pending.set(sessionId, true);
    try {
      const header = await readHeader(sessionId);
      if (header === null) return;
      if (!shouldAttach(header, known, new Set(registry.archivedSessionIds))) return;
      await attach(header);
    } finally {
      pending.delete(sessionId);
    }
  }

  function schedule(sessionId) {
    const timer = setTimeout(() => {
      pending.delete(sessionId);
      void handleSession(sessionId);
    }, DEBOUNCE_MS);
    pending.set(sessionId, timer);
  }

  /** Recupera todo lo que ya está en disco y no está registrado. */
  async function sweep() {
    if (disposed) return;
    refreshKnown();
    let snapshots = [];
    try {
      snapshots = (await persistence.list()) ?? [];
    } catch (error) {
      log(`no se pudo listar el almacén: ${error.message}`);
      return;
    }
    const archived = new Set(registry.archivedSessionIds);
    let attached = 0;
    for (const snapshot of snapshots) {
      if (!shouldAttach(snapshot.header, known, archived)) continue;
      if (await attach(snapshot.header)) attached += 1;
    }
    if (attached > 0) log(`${attached} conversaciones recuperadas`);
  }

  // 1. Barrido inicial: lo creado con el escritorio cerrado.
  void sweep();

  // 2. Vigilancia en vivo del almacén de sesiones.
  try {
    watcher = watch(sessionsRoot, { recursive: true }, (_event, filename) => {
      if (disposed || !filename) return;
      const sessionId = sessionIdFromPath(String(filename));
      if (sessionId !== null && !known.has(sessionId) && !pending.has(sessionId)) schedule(sessionId);
    });
    watcher.on('error', (error) => log(`vigilante detenido: ${error.message}`));
  } catch (error) {
    log(`no se pudo vigilar ${sessionsRoot}: ${error.message}`);
  }

  // 3. Repaso periódico por si el vigilante se queda corto.
  sweepTimer = setInterval(() => void sweep(), SWEEP_MS);

  ctx.effect(() => () => {
    disposed = true;
    try {
      watcher?.close();
    } catch {
      /* ya cerrado */
    }
    clearInterval(sweepTimer);
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  }, 'nexo-live-sync.watch');
}
