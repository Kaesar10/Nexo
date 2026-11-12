#!/usr/bin/env node
/**
 * Prueba de humo de extremo a extremo del puente Nexo.
 *
 *   node scripts/smoke.mjs
 *
 * Empareja un dispositivo de prueba, elige un workspace, manda un mensaje y
 * comprueba que llegan los eventos SSE y la respuesta del agente.
 * Usa el PIN de `server/data/config.json`. Necesita el puente en marcha.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE ?? 'http://127.0.0.1:8790';
const WORKSPACE = process.env.WORKSPACE ?? root;

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(join(root, 'server', 'data', 'config.json'), 'utf8'));

const health = await fetch(`${BASE}/api/health`).then((response) => response.json());
if (!health.ok) fail('el puente no responde en /api/health');
console.log(`  · puente v${health.version}, dsh ok=${health.dsh.ok}`);

const paired = await fetch(`${BASE}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: config.pin, deviceName: 'smoke-test' }),
}).then((response) => response.json());
if (!paired.token) fail(`emparejamiento fallido: ${JSON.stringify(paired)}`);
const auth = { Authorization: `Bearer ${paired.token}` };
console.log('  · emparejado como dispositivo de prueba');

const workspaces = await fetch(`${BASE}/api/workspaces`, { headers: auth }).then((response) => response.json());
let workspace = (workspaces.workspaces ?? []).find(
  (item) => item.path.toLowerCase() === WORKSPACE.toLowerCase(),
);
if (!workspace) {
  workspace = (
    await fetch(`${BASE}/api/workspaces`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ path: WORKSPACE }),
    }).then((response) => response.json())
  ).workspace;
  if (!workspace) fail('no se pudo registrar el workspace');
}
console.log(`  · workspace ${workspace.name}`);

const controller = new AbortController();
const stream = await fetch(`${BASE}/api/events?token=${paired.token}`, { signal: controller.signal });
const reader = stream.body.getReader();
const decoder = new TextDecoder();
const events = [];
let buffer = '';
let sawTurnEnd = null;

const finished = (async () => {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const line = chunk.split('\n').find((item) => item.startsWith('data: '));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      events.push(event);
      if (event.type === 'turn_end') {
        sawTurnEnd = event;
        return;
      }
    }
  }
})();

const started = Date.now();
const response = await fetch(`${BASE}/api/workspaces/${workspace.id}/messages`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'Responde exactamente: PONG. No uses herramientas.' }),
});
const created = await response.json();
if (!response.ok) fail(`el turno no arrancó: ${JSON.stringify(created)}`);
console.log(`  · turno ${created.turnId} creado en ${Date.now() - started} ms`);

const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout 120 s')), 120_000));
try {
  await Promise.race([finished, timeout]);
} catch (error) {
  fail(error.message);
}
controller.abort();

const text = events.filter((event) => event.type === 'delta').map((event) => event.text).join('');
const tools = events.filter((event) => event.type === 'tool').length;

console.log(`  · eventos: ${events.map((event) => event.type).join(', ')}`);
console.log(`  · actividad de herramientas: ${tools}`);
console.log(`  · respuesta: ${JSON.stringify(text)}`);
console.log(`  · fin: ${sawTurnEnd?.status}`);

if (sawTurnEnd?.status !== 'completed') fail(`el turno terminó en ${sawTurnEnd?.status}: ${sawTurnEnd?.text ?? ''}`);
if (!text.includes('PONG')) fail('la respuesta no contiene PONG');
console.log('\n  ✓ puente OK: el móvil puede hablar con DSH\n');
process.exit(0);
