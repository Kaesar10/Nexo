import assert from 'node:assert/strict';
import test from 'node:test';
import { createPushHub } from '../src/push.js';

test('push: entrega inmediata a quien está esperando', async () => {
  const hub = createPushHub({ log: () => {} });
  const waiting = hub.take('dev_1', { waitMs: 5000 });
  hub.enqueue({ chatId: 'session-1', title: 'Nexo · Proyecto', body: 'Listo' });
  const batch = await waiting;
  assert.equal(batch.length, 1);
  assert.equal(batch[0].chatId, 'session-1');
  assert.equal(batch[0].body, 'Listo');
});

test('push: encola si el móvil no está esperando y lo entrega al volver', async () => {
  const hub = createPushHub({ log: () => {} });
  hub.enqueue({ chatId: 'session-2', title: 'Nexo · Otro', body: 'Terminado' }, ['dev_2']);
  const batch = await hub.take('dev_2', { waitMs: 0 });
  assert.equal(batch.length, 1);
  assert.equal(batch[0].chatId, 'session-2');
  // la segunda llamada ya no tiene nada
  assert.equal((await hub.take('dev_2', { waitMs: 0 })).length, 0);
});

test('push: espera y devuelve vacío cuando expira el long-poll', async () => {
  const hub = createPushHub({ log: () => {} });
  const started = Date.now();
  const batch = await hub.take('dev_3', { waitMs: 150 });
  assert.equal(batch.length, 0);
  assert.ok(Date.now() - started >= 120, 'debe haber esperado');
});

test('push: varios avisos se entregan juntos y respetan el tope', async () => {
  const hub = createPushHub({ log: () => {} });
  for (let index = 0; index < 25; index += 1) {
    hub.enqueue({ chatId: `session-${index}`, title: 'Nexo', body: `tarea ${index}` }, ['dev_4']);
  }
  const batch = await hub.take('dev_4', { waitMs: 0 });
  assert.equal(batch.length, 20, 'tope por dispositivo');
  assert.equal(batch.at(-1).body, 'tarea 24');
});
