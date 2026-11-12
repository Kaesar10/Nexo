import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createActivity } from '../src/activity.js';

test('activity: registra, ordena de más reciente a más antiguo y sobrevive al reinicio', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexo-activity-'));
  const file = join(dir, 'activity.json');
  try {
    const activity = createActivity({ file });
    activity.record({
      chatId: 'session-1',
      workspacePath: 'C:\\proyecto',
      status: 'completed',
      durationMs: 18300,
      tools: ['read', 'pwsh'],
      model: 'deepseek-flash',
    });
    activity.record({
      chatId: 'session-2',
      status: 'error',
      durationMs: 5000,
      tools: [],
      model: 'deepseek-v4-pro',
    });
    const list = activity.list(10);
    assert.equal(list.length, 2);
    assert.equal(list[0].chatId, 'session-2', 'el último registrado va primero');
    assert.equal(list[1].durationMs, 18300);
    assert.deepEqual(list[1].tools, ['read', 'pwsh']);

    const again = createActivity({ file });
    assert.equal(again.list(10).length, 2, 'persistido en disco');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('activity: respeta el límite y recorta a 200', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexo-activity-'));
  try {
    const activity = createActivity({ file: join(dir, 'activity.json') });
    for (let index = 0; index < 230; index += 1) {
      activity.record({ chatId: `session-${index}`, durationMs: 1000 * index });
    }
    assert.equal(activity.list(5).length, 5);
    assert.equal(activity.list(1000).length, 200);
    assert.equal(activity.list(1)[0].chatId, 'session-229');
    // sin límite válido cae al valor por defecto
    assert.ok(activity.list(0).length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
