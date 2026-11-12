import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDesktopSync } from '../src/desktop-sync.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'nexo-desktop-'));
  const dir = join(home, '.dsh', 'storages');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'workspace.json');
  writeFileSync(
    file,
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['ws-a'], archivedSessionIds: [], pinnedSessionIds: [] },
      tables: {
        workspaces: {
          'ws-a': {
            path: 'C:\\proyectos\\alpha',
            title: 'alpha',
            sessionIds: ['session-old'],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      },
    }),
    'utf8',
  );
  return { home, file, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('desktop-sync: registra la sesión al principio de su proyecto', () => {
  const { home, file, cleanup } = fixture();
  try {
    const sync = createDesktopSync({ home, log: () => {} });
    assert.equal(sync.registerSession({ sessionId: 'session-new', workspacePath: 'C:\\proyectos\\alpha' }), true);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(data.tables.workspaces['ws-a'].sessionIds, ['session-new', 'session-old']);
    assert.equal(data.global.workspaceIds.length, 1, 'no toca el orden de proyectos');
  } finally {
    cleanup();
  }
});

test('desktop-sync: es idempotente y no duplica', () => {
  const { home, file, cleanup } = fixture();
  try {
    const sync = createDesktopSync({ home, log: () => {} });
    sync.registerSession({ sessionId: 'session-new', workspacePath: 'C:\\proyectos\\alpha' });
    sync.registerSession({ sessionId: 'session-new', workspacePath: 'C:\\proyectos\\ALPHA' });
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(data.tables.workspaces['ws-a'].sessionIds, ['session-new', 'session-old']);
  } finally {
    cleanup();
  }
});

test('desktop-sync: crea el proyecto si no estaba en el registro', () => {
  const { home, file, cleanup } = fixture();
  try {
    const sync = createDesktopSync({ home, log: () => {} });
    assert.equal(
      sync.registerSession({ sessionId: 'session-x', workspacePath: 'C:\\proyectos\\beta', title: 'beta' }),
      true,
    );
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const created = Object.values(data.tables.workspaces).find((workspace) => workspace.path === 'C:\\proyectos\\beta');
    assert.ok(created, 'proyecto creado');
    assert.deepEqual(created.sessionIds, ['session-x']);
    assert.equal(created.title, 'beta');
  } finally {
    cleanup();
  }
});

test('desktop-sync: no rompe si el fichero no existe o está corrupto', () => {
  const home = mkdtempSync(join(tmpdir(), 'nexo-desktop-'));
  try {
    const sync = createDesktopSync({ home, log: () => {} });
    assert.equal(sync.registerSession({ sessionId: 's', workspacePath: 'C:\\x' }), false);

    mkdirSync(join(home, '.dsh', 'storages'), { recursive: true });
    writeFileSync(join(home, '.dsh', 'storages', 'workspace.json'), '{roto', 'utf8');
    assert.equal(sync.registerSession({ sessionId: 's', workspacePath: 'C:\\x' }), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('desktop-sync: backfill registra solo las sesiones que faltan', () => {
  const { home, file, cleanup } = fixture();
  try {
    const sync = createDesktopSync({ home, log: () => {} });
    const added = sync.backfill(
      [{ path: 'C:\\proyectos\\alpha', name: 'alpha' }],
      () => [{ id: 'session-old' }, { id: 'session-a' }, { id: 'session-b' }],
    );
    assert.equal(added, 2);
    const ids = JSON.parse(readFileSync(file, 'utf8')).tables.workspaces['ws-a'].sessionIds;
    assert.deepEqual(ids, ['session-b', 'session-a', 'session-old']);
  } finally {
    cleanup();
  }
});
