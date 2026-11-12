import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, parse, resolve } from 'node:path';
import { shortId } from './util.js';

const SKIP_DIRS = new Set(['node_modules', '$Recycle.Bin', 'System Volume Information', '__pycache__']);
const MAX_ENTRIES = 300;

/** Importa el lector del almacén DSH de forma tolerante (puede no estar aún). */
async function sessionsStore() {
  try {
    return await import('./dsh-sessions.js');
  } catch {
    return null;
  }
}

function samePath(a, b) {
  return normalize(a).toLowerCase() === normalize(b).toLowerCase();
}

/** ¿Hay un `.git` en la carpeta o en algún ancestro cercano? */
function looksLikeGitRepo(path) {
  if (existsSync(join(path, '.git'))) return true;
  return false;
}

export function createWorkspaces({ config, save }) {
  function get(id) {
    return config.workspaces.find((workspace) => workspace.id === id) ?? null;
  }

  function decorate(workspace) {
    const exists = existsSync(workspace.path);
    return {
      id: workspace.id,
      name: workspace.name,
      path: workspace.path,
      exists,
      isGit: exists && looksLikeGitRepo(workspace.path),
      lastActiveAt: workspace.lastActiveAt ?? 0,
      chatsCount: workspace.chatsCount ?? 0,
    };
  }

  /**
   * Resumen barato de un workspace: número de sesiones y última actividad.
   * Solo hace stat de los directorios de sesión — leer los `.zstd` completos de
   * cada proyecto para pintar la lista de proyectos sería demasiado caro.
   */
  async function summarize(workspace) {
    const store = await sessionsStore();
    if (!store) return { chatsCount: 0, lastActiveAt: 0 };
    try {
      const dir = join(store.dshSessionsRoot(), store.encodeWorkspacePath(workspace.path));
      let names = [];
      try {
        names = readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return { chatsCount: 0, lastActiveAt: 0 };
      }
      let lastActiveAt = 0;
      for (const name of names) {
        try {
          const stats = statSync(join(dir, name));
          if (stats.mtimeMs > lastActiveAt) lastActiveAt = stats.mtimeMs;
        } catch {
          /* una sesión borrada a medias no debe romper el listado */
        }
      }
      return { chatsCount: names.length, lastActiveAt: Math.round(lastActiveAt) };
    } catch {
      return { chatsCount: 0, lastActiveAt: 0 };
    }
  }

  async function list() {
    const items = await Promise.all(
      config.workspaces.map(async (workspace) => {
        const item = decorate(workspace);
        if (item.exists) {
          const summary = await summarize(workspace);
          item.chatsCount = summary.chatsCount;
          item.lastActiveAt = summary.lastActiveAt;
        }
        return item;
      }),
    );
    items.sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.name.localeCompare(b.name));
    return items;
  }

  /** Añade un workspace. Valida que sea una carpeta absoluta existente. */
  function add({ path, name }) {
    const raw = String(path ?? '').trim();
    if (!raw) throw Object.assign(new Error('Falta la ruta'), { code: 'BAD_REQUEST', status: 400 });
    if (!isAbsolute(raw)) {
      throw Object.assign(new Error('La ruta debe ser absoluta'), { code: 'BAD_REQUEST', status: 400 });
    }
    const absolute = resolve(raw);
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      throw Object.assign(new Error(`La carpeta no existe: ${absolute}`), {
        code: 'BAD_REQUEST',
        status: 400,
      });
    }
    if (!stats.isDirectory()) {
      throw Object.assign(new Error('La ruta no es una carpeta'), { code: 'BAD_REQUEST', status: 400 });
    }
    const existing = config.workspaces.find((workspace) => samePath(workspace.path, absolute));
    if (existing) return decorate(existing);

    const workspace = {
      id: shortId('ws'),
      name: String(name ?? '').trim().slice(0, 60) || basename(absolute) || absolute,
      path: absolute,
      addedAt: Date.now(),
    };
    config.workspaces.push(workspace);
    save();
    return decorate(workspace);
  }

  function remove(id) {
    const before = config.workspaces.length;
    config.workspaces = config.workspaces.filter((workspace) => workspace.id !== id);
    if (config.workspaces.length !== before) {
      save();
      return true;
    }
    return false;
  }

  /** Primera puesta en marcha: importa los proyectos que ya usa DSH. */
  async function seedFromDsh(limit = 24) {
    if (config.workspaces.length > 0) return 0;
    const store = await sessionsStore();
    if (!store) return 0;
    let stored = [];
    try {
      stored = store.listStoredWorkspaces() ?? [];
    } catch {
      return 0;
    }
    let added = 0;
    for (const entry of stored.slice(0, limit)) {
      try {
        if (!entry.path || !existsSync(entry.path)) continue;
        add({ path: entry.path });
        added += 1;
      } catch {
        /* rutas raras se ignoran sin romper el arranque */
      }
    }
    return added;
  }

  /** Navegador de carpetas del PC para elegir proyecto desde el móvil. */
  function browse(rawPath) {
    const home = homedir();
    const quickLinks = [
      { label: 'Inicio', path: home },
      { label: 'Escritorio', path: join(home, 'Desktop') },
      { label: 'Proyectos', path: join(home, 'Desktop', 'App') },
    ].filter((link) => existsSync(link.path));

    if (!rawPath || rawPath === 'roots') {
      const drives = 'CDEFGHIJKLMNOPQRSTUVWXYZ'
        .split('')
        .map((letter) => `${letter}:\\`)
        .filter((drive) => existsSync(drive))
        .map((drive) => ({ name: drive, path: drive, isDir: true }));
      return { path: null, parent: null, quickLinks, entries: drives };
    }

    const absolute = resolve(String(rawPath));
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      throw Object.assign(new Error(`La carpeta no existe: ${absolute}`), {
        code: 'NOT_FOUND',
        status: 404,
      });
    }
    if (!stats.isDirectory()) {
      throw Object.assign(new Error('La ruta no es una carpeta'), { code: 'BAD_REQUEST', status: 400 });
    }

    let entries = [];
    try {
      entries = readdirSync(absolute, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => !entry.name.startsWith('.'))
        .filter((entry) => !SKIP_DIRS.has(entry.name))
        .map((entry) => ({ name: entry.name, path: join(absolute, entry.name), isDir: true }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es'))
        .slice(0, MAX_ENTRIES);
    } catch {
      entries = [];
    }

    const root = parse(absolute).root;
    const parent = samePath(root, absolute) ? null : dirname(absolute);
    return { path: absolute, parent, quickLinks, entries };
  }

  return { get, list, add, remove, seedFromDsh, browse };
}
