import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apply, matchWorkspace, sessionIdFromPath, shouldAttach } from '../lib/index.js';

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'nexo-sync-'));
  mkdirSync(join(home, 'sessions'), { recursive: true });
  return home;
}

/** Registro de proyectos falso con la misma superficie que usa el plugin. */
function fakeRegistry(workspaces, archived = []) {
  const created = [];
  const attached = [];
  const list = () =>
    workspaces.map((workspace) => ({
      ...workspace,
      get sessionIds() {
        return workspace.sessionIds ?? [];
      },
    }));
  return {
    created,
    attached,
    archivedSessionIds: archived,
    list,
    get: (id) => {
      const workspace = list().find((candidate) => candidate.id === id);
      if (!workspace) return undefined;
      return {
        ...workspace,
        attachSession: async (sessionId) => {
          attached.push([sessionId, workspace.id]);
          workspace.sessionIds = [sessionId, ...(workspace.sessionIds ?? [])];
        },
      };
    },
    create: async (path, title) => {
      const workspace = { id: `ws-${created.length + 1}`, path, title, sessionIds: [] };
      workspaces.push(workspace);
      created.push(workspace);
      return workspace;
    },
  };
}

/** Persistencia falsa: cabeceras conocidas por id. */
function fakePersistence(headers) {
  const byId = new Map(headers.map((header) => [header.id, header]));
  return {
    stat: async (id) => (byId.has(id) ? { header: byId.get(id) } : undefined),
    list: async () => [...byId.values()].map((header) => ({ header })),
  };
}

function setup({ headers, workspaces, home, archived = [] }) {
  const ctx = {
    workspaceRegistry: fakeRegistry(workspaces, archived),
    sessionPersistence: fakePersistence(headers),
    logger: { info: () => {} },
    disposers: [],
    effect: (factory) => {
      ctx.disposers.push(factory());
    },
  };
  process.env.DSH_HOME = home;
  apply(ctx);
  return ctx;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('sessionIdFromPath reconoce la ruta del almacén', () => {
  assert.equal(
    sessionIdFromPath('C:\\Users\\demo\\.dsh\\sessions\\--C-proyecto--\\session-abc-123\\session.v4.jsonl.zstd'),
    'session-abc-123',
  );
  assert.equal(
    sessionIdFromPath('/home/demo/.dsh/sessions/--home-proyecto--/session-abc-123/session.v4.jsonl.zstd'),
    'session-abc-123',
  );
  assert.equal(sessionIdFromPath('C:\\tmp\\session.v4.jsonl.zstd'), null);
});

test('shouldAttach descarta conocidas, archivadas, subagentes y sin cwd', () => {
  const known = new Set(['session-known']);
  const archived = new Set(['session-archived']);
  assert.equal(shouldAttach({ id: 'session-new', cwd: 'C:\\p' }, known, archived), true);
  assert.equal(shouldAttach({ id: 'session-known', cwd: 'C:\\p' }, known, archived), false);
  assert.equal(shouldAttach({ id: 'session-archived', cwd: 'C:\\p' }, known, archived), false);
  assert.equal(shouldAttach({ id: 'session-sub', cwd: 'C:\\p', delegationDepth: 1 }, known, archived), false);
  assert.equal(shouldAttach({ id: 'session-nocwd' }, known, archived), false);
});

test('matchWorkspace ignora mayúsculas', () => {
  const workspaces = [{ id: 'ws-1', path: 'C:\\Proyectos\\Alpha' }];
  assert.equal(matchWorkspace(workspaces, 'c:\\proyectos\\alpha')?.id, 'ws-1');
  assert.equal(matchWorkspace(workspaces, 'C:\\otro'), undefined);
});

test('el barrido inicial adjunta las sesiones que faltan, sin reiniciar', async () => {
  const home = tempHome();
  const dir = join(home, 'proyectos', 'alpha');
  mkdirSync(dir, { recursive: true });
  const header = { id: 'session-new', cwd: dir };
  const workspaces = [{ id: 'ws-1', path: dir, title: 'alpha', sessionIds: ['session-old'] }];
  const ctx = setup({ headers: [header, { id: 'session-old', cwd: dir }], workspaces, home });
  try {
    await wait(150);
    assert.deepEqual(ctx.workspaceRegistry.attached, [['session-new', 'ws-1']]);
  } finally {
    for (const dispose of ctx.disposers) await dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

test('crea el proyecto cuando la sesión llega en una carpeta sin registrar', async () => {
  const home = tempHome();
  const dir = join(home, 'proyectos', 'nuevo');
  mkdirSync(dir, { recursive: true });
  const ctx = setup({ headers: [{ id: 'session-x', cwd: dir }], workspaces: [], home });
  try {
    await wait(150);
    assert.equal(ctx.workspaceRegistry.created.length, 1);
    assert.deepEqual(ctx.workspaceRegistry.attached, [['session-x', 'ws-1']]);
  } finally {
    for (const dispose of ctx.disposers) await dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

test('no toca las sesiones de subagente ni las archivadas', async () => {
  const home = tempHome();
  const dir = join(home, 'proyectos', 'alpha');
  mkdirSync(dir, { recursive: true });
  const ctx = setup({
    headers: [
      { id: 'session-sub', cwd: dir, delegationDepth: 2 },
      { id: 'session-archived', cwd: dir },
    ],
    workspaces: [{ id: 'ws-1', path: dir, title: 'alpha', sessionIds: [] }],
    archived: ['session-archived'],
    home,
  });
  try {
    await wait(150);
    assert.deepEqual(ctx.workspaceRegistry.attached, []);
  } finally {
    for (const dispose of ctx.disposers) await dispose();
    rmSync(home, { recursive: true, force: true });
  }
});
