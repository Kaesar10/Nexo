/**
 * Tests del lector del almacén de sesiones de DSH.
 *
 * - Codificación/decodificación de nombres de workspace.
 * - Almacén sintético completo (multiframe zstd, títulos, inyectados, compactación,
 *   sesión vacía, fichero corrupto, modo rápido).
 * - Un test contra el almacén real de `~/.dsh/sessions` que se salta limpiamente
 *   si no existe.
 *
 * Ejecutar desde la raíz del proyecto:
 *   node --test server/test/dsh-sessions.test.js
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import {
  decodeWorkspaceDirName,
  dshSessionsRoot,
  encodeWorkspacePath,
  findSession,
  listSessions,
  listStoredWorkspaces,
  readSession,
} from '../src/dsh-sessions.js';

// ---------------------------------------------------------------------------
// Almacén sintético
// ---------------------------------------------------------------------------

const WORKSPACE = 'C:\\Users\\demo\\Desktop\\App\\Agente Movil\\_fixtures\\mi-proyecto';
const MAIN_ID = 'session-11111111-2222-3333-4444-555555555555';
const REPLACE_ID = 'session-22222222-3333-4444-5555-666666666666';
const EMPTY_ID = 'session-33333333-4444-5555-6666-777777777777';
const CORRUPT_ID = 'session-44444444-5555-6666-7777-888888888888';
const LEGACY_ID = '99999999-aaaa-bbbb-cccc-dddddddddddd';
const BIG_ID = 'session-55555555-6666-7777-8888-999999999999';
const PRESET_ID = 'session-77777777-8888-9999-aaaa-bbbbbbbbbbbb';
const SUBAGENT_ID = 'session-88888888-9999-aaaa-bbbb-cccccccccccc';
const NO_HEADER_ID = 'session-99999999-aaaa-bbbb-cccc-ddddddddddde';
const OTHER_WORKSPACE = 'C:\\tmp\\my-proj';

const TMP = mkdtempSync(join(tmpdir(), 'dsh-sessions-test-'));
const STORE_HOME = join(TMP, 'dsh-home');
const STORE_ROOT = join(STORE_HOME, 'sessions');
const PREVIOUS_DSH_HOME = process.env.DSH_HOME;

const T_MAIN = Date.UTC(2026, 0, 2, 10, 0, 0);
const T_REPLACE = Date.UTC(2026, 0, 2, 9, 0, 0);
const T_EMPTY = Date.UTC(2026, 0, 1, 8, 0, 0);
const T_OTHER = Date.UTC(2026, 0, 3, 11, 0, 0);

function setMtime(file, timeMs) {
  const date = new Date(timeMs);
  utimesSync(file, date, date);
}

/** Un frame Zstandard independiente con las líneas JSONL indicadas. */
function frame(events) {
  const body = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  return zstdCompressSync(Buffer.from(body, 'utf8'));
}

/** Escribe un log multiframe (un frame por grupo de eventos). */
function writeSession(projectDir, sessionId, eventFrames, mtimeMs) {
  const dir = join(projectDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, 'session.v4.jsonl.zstd');
  writeFileSync(logPath, Buffer.concat(eventFrames.map((events) => frame(events))));
  setMtime(logPath, mtimeMs);
  return dir;
}

function header(id, cwd = WORKSPACE) {
  return {
    type: 'session',
    version: 4,
    id,
    createdAt: 1790000000000,
    ...(cwd === null ? {} : { cwd }),
    isSeeded: false,
    delegationDepth: 0,
  };
}

/** Cabecera con campos extra del header (preset, origen de subagente). */
function headerWith(id, extra, cwd = WORKSPACE) {
  return { ...header(id, cwd), ...extra };
}

function marker(type, seq, time, data = {}) {
  return { type, seq, time, data };
}

function userMessage(seq, time, id, text, extraSource = {}) {
  return {
    type: 'user/message',
    seq,
    time,
    data: {
      content: [{ type: 'text', text }],
      source: { kind: 'user', ...extraSource },
      role: 'user',
      id,
    },
    surfaceOp: 'append',
  };
}

function injectedMessage(seq, time, kind, text, form = 'snapshot') {
  return {
    type: 'user/message',
    seq,
    time,
    data: {
      content: [{ type: 'text', text }],
      source: { kind, form },
      role: 'user',
      id: `injected-${seq}`,
    },
    surfaceOp: 'append',
  };
}

function assistantMessage(seq, time, id, content) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content,
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
        id,
      },
    },
    surfaceOp: 'append',
  };
}

function titleEvent(seq, time, title) {
  return { type: 'session/title', seq, time, data: { title, messageSeqs: [], source: { kind: 'fallback' } } };
}

/** Checkpoint de compactación: `user/message` de plugin que sustituye una franja. */
function compactionEvent(seq, time, id, text, startSeq, endSeq) {
  return {
    type: 'user/message',
    seq,
    time,
    data: {
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact-1' },
      role: 'user',
      id,
    },
    surfaceOp: { op: 'replace', startSeq, endSeq },
  };
}

/** Texto pseudoaleatorio determinista, para hinchar un log por encima de 512 KB. */
function noise(seed, length) {
  let state = seed;
  let out = '';
  while (out.length < length) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out += state.toString(36);
  }
  return out.slice(0, length);
}

function buildStore() {
  const projectA = join(STORE_ROOT, encodeWorkspacePath(WORKSPACE));
  const projectB = join(STORE_ROOT, encodeWorkspacePath(OTHER_WORKSPACE));

  // --- sesión principal: 4 frames, dos títulos, inyectados y pasos intermedios ---
  writeSession(
    projectA,
    MAIN_ID,
    [
      [header(MAIN_ID)],
      [
        marker('turn/start', 1, 10, { turn: 1 }),
        userMessage(2, 20, 'u-1', 'hola', { rpcId: 'rpc-1', clientTimeZone: 'Europe/Madrid' }),
        injectedMessage(3, 21, 'runtime-context', 'Current runtime context. This snapshot supersedes earlier…'),
        injectedMessage(4, 22, 'skill-catalog', '<system-reminder>\nA skill is a reusable set…', 'catalog'),
        assistantMessage(5, 30, 'a-0', [
          { type: 'reasoning', text: 'pienso' },
          { type: 'tool-call', name: 'read', id: 'call-1', input: {} },
        ]),
        assistantMessage(6, 31, 'a-1', [
          { type: 'text', text: 'voy a mirar' },
          { type: 'tool-call', name: 'pwsh', id: 'call-2', input: {} },
        ]),
        marker('turn/end', 7, 32, { turn: 1 }),
      ],
      [
        userMessage(8, 100, 'u-2', '¿y ahora?'),
        assistantMessage(9, 110, 'a-2', [
          { type: 'reasoning', text: 'razono' },
          { type: 'text', text: 'la respuesta' },
        ]),
        titleEvent(10, 111, 'Primer título'),
        marker('turn/end', 11, 112, { turn: 2 }),
      ],
      [
        userMessage(12, 200, 'u-3', 'tercera'),
        assistantMessage(13, 210, 'a-3', [{ type: 'text', text: 'segunda respuesta' }]),
        titleEvent(14, 211, 'Título final'),
        marker('turn/end', 15, 212, { turn: 3 }),
      ],
    ],
    T_MAIN,
  );

  // --- sesión compactada: la franja antigua queda sombreada por un checkpoint ---
  writeSession(
    projectA,
    REPLACE_ID,
    [
      [header(REPLACE_ID)],
      [
        userMessage(2, 10, 'u-old', 'pregunta vieja'),
        assistantMessage(3, 20, 'a-old', [{ type: 'text', text: 'respuesta vieja' }]),
      ],
      [
        compactionEvent(
          8,
          30,
          'u-checkpoint',
          'This is an automatically generated checkpoint condensing an earlier span…',
          2,
          3,
        ),
        marker('turn/end', 9, 31, { turn: 1 }),
      ],
    ],
    T_REPLACE,
  );

  // --- sesión vacía: solo cabecera ---
  writeSession(projectA, EMPTY_ID, [[header(EMPTY_ID)]], T_EMPTY);

  // --- sesión creada desde el escritorio: lleva agentPreset, no es adoptable ---
  writeSession(
    projectA,
    PRESET_ID,
    [
      [headerWith(PRESET_ID, { agentPreset: 'standard' })],
      [
        userMessage(2, 10, 'u-preset', 'hola preset'),
        assistantMessage(3, 20, 'a-preset', [{ type: 'text', text: 'respuesta preset' }]),
      ],
    ],
    T_REPLACE,
  );

  // --- sesión de subagente: tampoco es adoptable ---
  writeSession(
    projectA,
    SUBAGENT_ID,
    [
      [headerWith(SUBAGENT_ID, { origin: 'subagent', delegationDepth: 1 })],
      [userMessage(2, 10, 'u-sub', 'tarea del subagente')],
    ],
    T_EMPTY,
  );

  // --- log sin cabecera legible: `adoptable` por defecto (mejor intentarlo) ---
  writeSession(
    projectA,
    NO_HEADER_ID,
    [[marker('turn/start', 1, 10, { turn: 1 }), userMessage(2, 20, 'u-nohdr', 'sin cabecera')]],
    T_EMPTY,
  );

  // --- sesión corrupta: bytes que no son zstd ---
  const corruptDir = join(projectA, CORRUPT_ID);
  mkdirSync(corruptDir, { recursive: true });
  const corruptLog = join(corruptDir, 'session.v4.jsonl.zstd');
  writeFileSync(corruptLog, Buffer.from('esto no es un log zstd'));
  setMtime(corruptLog, T_EMPTY);

  // --- sesión grande (>512 KB) para el modo rápido y la lectura por cola ---
  const bigText = noise(7, 1_500_000);
  writeSession(
    projectA,
    BIG_ID,
    [
      [header(BIG_ID)],
      [
        marker('turn/start', 1, 10, { turn: 1 }),
        userMessage(2, 20, 'u-big', bigText),
        assistantMessage(3, 30, 'a-big', [{ type: 'text', text: 'respuesta grande' }]),
        marker('turn/end', 4, 31, { turn: 1 }),
        titleEvent(5, 32, 'Sesión grande'),
      ],
    ],
    T_OTHER,
  );

  // --- directorio de proyecto cuyo nombre decodifica mal (ruta con guion) ---
  writeSession(
    projectB,
    LEGACY_ID,
    [[header(LEGACY_ID, OTHER_WORKSPACE)], [userMessage(2, 20, 'u-other', 'hola otro')]],
    T_OTHER,
  );

  // --- `_no-cwd`: DSH lo usa para sesiones sin workspace y no debe listarse ---
  writeSession(join(STORE_ROOT, '_no-cwd'), 'session-66666666-7777-8888-9999-aaaaaaaaaaaa', [
    [header('session-66666666-7777-8888-9999-aaaaaaaaaaaa', null)],
  ], T_OTHER);

  return { projectA, projectB };
}

let projectA;
let projectB;

before(() => {
  process.env.DSH_HOME = STORE_HOME;
  const built = buildStore();
  projectA = built.projectA;
  projectB = built.projectB;
});

after(() => {
  if (PREVIOUS_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREVIOUS_DSH_HOME;
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Codificación de nombres
// ---------------------------------------------------------------------------

test('encodeWorkspacePath replica la codificación de DSH', () => {
  assert.equal(
    encodeWorkspacePath('C:\\Users\\demo\\Desktop\\App\\Agente Movil\\_probe_ws'),
    '--C-Users-demo-Desktop-App-Agente~0020Movil-_probe_ws--',
  );
  assert.equal(
    encodeWorkspacePath('D:\\demo drive\\Flag-26-27'),
    '--D-demo~0020drive-Flag-26-27--',
  );
  // Caracteres no ASCII y `~`: se escapan como code unit UTF-16 en hex.
  assert.equal(encodeWorkspacePath('C:\\caf\u00e9\\a~b'), '--C-caf~00E9-a~007Eb--');
  // Rachas de separadores colapsan en un único `-`.
  assert.equal(encodeWorkspacePath('C:/Users//demo\\\\Desktop'), '--C-Users-demo-Desktop--');
  assert.throws(() => encodeWorkspacePath(''), TypeError);
});

test('encodeWorkspacePath recorta a 251 caracteres de clave', () => {
  const long = `C:\\${'a'.repeat(600)}`;
  const encoded = encodeWorkspacePath(long);
  assert.equal(encoded.length, 255);
  assert.ok(encoded.startsWith('--C-a'));
  assert.ok(encoded.endsWith('--'));
});

test('decodeWorkspaceDirName es el inverso (aproximado) documentado', () => {
  assert.equal(
    decodeWorkspaceDirName('--C-Users-demo-Desktop-App-Agente~0020Movil--'),
    'C:\\Users\\demo\\Desktop\\App\\Agente Movil',
  );
  assert.equal(
    decodeWorkspaceDirName('--D-demo~0020drive-Flag-26-27--'),
    'D:\\demo drive\\Flag\\26\\27',
  );
  assert.equal(decodeWorkspaceDirName('--C---'), 'C:\\');
  // Ambigüedad conocida: un guion literal es indistinguible de un separador.
  assert.equal(encodeWorkspacePath('C:\\Users\\a-b'), '--C-Users-a-b--');
  assert.equal(decodeWorkspaceDirName('--C-Users-a-b--'), 'C:\\Users\\a\\b');
  assert.equal(decodeWorkspaceDirName('no-es-codificado'), null);
  assert.equal(decodeWorkspaceDirName('--roto~00--'), null);
});

// ---------------------------------------------------------------------------
// Listados
// ---------------------------------------------------------------------------

test('listStoredWorkspaces usa el cwd de la cabecera (no el nombre) y cuenta sesiones', () => {
  assert.equal(dshSessionsRoot(), STORE_ROOT);
  const workspaces = listStoredWorkspaces();
  const paths = workspaces.map((workspace) => workspace.path);
  assert.ok(paths.includes(WORKSPACE), `falta ${WORKSPACE} en ${JSON.stringify(paths)}`);
  assert.ok(paths.includes(OTHER_WORKSPACE), `falta ${OTHER_WORKSPACE} en ${JSON.stringify(paths)}`);
  // `_no-cwd` no representa un workspace real.
  assert.ok(paths.every((path) => !path.includes('_no-cwd')));

  const other = workspaces.find((workspace) => workspace.path === OTHER_WORKSPACE);
  // El nombre del directorio decodifica como `C:\tmp\my\proj`; manda la cabecera.
  assert.equal(other.path, OTHER_WORKSPACE);
  assert.equal(other.sessionCount, 1);

  const main = workspaces.find((workspace) => workspace.path === WORKSPACE);
  // 8 directorios con log: principal, compactada, vacía, corrupta, grande, preset,
  // subagente y sin cabecera.
  assert.equal(main.sessionCount, 8);
  assert.equal(main.lastActiveAt, Math.round(statSync(join(projectA, BIG_ID, 'session.v4.jsonl.zstd')).mtimeMs));
  // Orden descendente por actividad.
  for (let index = 1; index < workspaces.length; index += 1) {
    assert.ok(workspaces[index - 1].lastActiveAt >= workspaces[index].lastActiveAt);
  }
});

test('listSessions devuelve metadatos exactos y ordena por fecha', () => {
  const sessions = listSessions(WORKSPACE);
  const ids = sessions.map((session) => session.id);
  assert.ok(ids.includes(MAIN_ID));
  assert.ok(ids.includes(REPLACE_ID));
  assert.ok(ids.includes(EMPTY_ID));
  assert.ok(ids.includes(BIG_ID));
  // La sesión corrupta se omite sin romper el listado.
  assert.ok(!ids.includes(CORRUPT_ID));

  const main = sessions.find((session) => session.id === MAIN_ID);
  assert.equal(main.title, 'Título final');
  assert.equal(main.preview, 'segunda respuesta');
  assert.equal(main.messageCount, 5);
  assert.equal(main.updatedAt, Math.round(T_MAIN));
  assert.equal(main.adoptable, true);

  // La compactación sombrea la franja antigua y el checkpoint de plugin no es un mensaje.
  const replaced = sessions.find((session) => session.id === REPLACE_ID);
  assert.equal(replaced.messageCount, 0);
  assert.equal(replaced.preview, '');

  const empty = sessions.find((session) => session.id === EMPTY_ID);
  assert.equal(empty.messageCount, 0);
  assert.equal(empty.title, null);
  assert.equal(empty.preview, '');

  // Más reciente primero: big (T_OTHER) → main (T_MAIN) → replace (T_REPLACE) → empty.
  const order = sessions.map((session) => session.id);
  assert.ok(order.indexOf(BIG_ID) < order.indexOf(MAIN_ID));
  assert.ok(order.indexOf(MAIN_ID) < order.indexOf(REPLACE_ID));
  assert.ok(order.indexOf(REPLACE_ID) < order.indexOf(EMPTY_ID));
});

test('listSessions tolera workspaces inexistentes o sin almacén', () => {
  assert.deepEqual(listSessions('C:\\no\\existe\\nunca'), []);
  assert.deepEqual(listSessions(''), []);
  assert.deepEqual(listSessions(null), []);
});

test('listSessions en modo rápido omite messageCount y no recorre el log', () => {
  const fast = listSessions(WORKSPACE, { fast: true });
  const ids = fast.map((session) => session.id);
  assert.ok(ids.includes(MAIN_ID));
  assert.ok(ids.includes(BIG_ID));
  for (const session of fast) {
    assert.ok(!('messageCount' in session), `messageCount presente en ${session.id}`);
    assert.equal(typeof session.updatedAt, 'number');
    assert.equal(typeof session.preview, 'string');
  }
  const main = fast.find((session) => session.id === MAIN_ID);
  assert.equal(main.title, 'Título final');
  assert.equal(main.preview, 'segunda respuesta');
  // Fichero > 512 KB: título del principio y preview de la cola.
  const big = fast.find((session) => session.id === BIG_ID);
  assert.equal(big.title, 'Sesión grande');
  assert.equal(big.preview, 'respuesta grande');
});

// ---------------------------------------------------------------------------
// Lectura de sesiones
// ---------------------------------------------------------------------------

test('readSession devuelve solo prompts y respuestas finales, en orden', () => {
  const session = readSession(WORKSPACE, MAIN_ID);
  assert.ok(session);
  assert.equal(session.id, MAIN_ID);
  assert.equal(session.title, 'Título final');
  assert.equal(session.workspacePath, WORKSPACE);
  assert.equal(session.updatedAt, Math.round(T_MAIN));
  assert.equal(session.adoptable, true);
  assert.deepEqual(session.messages, [
    { id: 'u-1', role: 'user', text: 'hola', at: 20 },
    { id: 'u-2', role: 'user', text: '¿y ahora?', at: 100 },
    { id: 'a-2', role: 'assistant', text: 'la respuesta', at: 110 },
    { id: 'u-3', role: 'user', text: 'tercera', at: 200 },
    { id: 'a-3', role: 'assistant', text: 'segunda respuesta', at: 210 },
  ]);
  // Ni inyectados del harness, ni reasoning, ni pasos intermedios.
  const all = session.messages.map((message) => message.text).join('\n');
  assert.ok(!all.includes('Current runtime context'));
  assert.ok(!all.includes('<system-reminder>'));
  assert.ok(!all.includes('pienso'));
  assert.ok(!all.includes('voy a mirar'));
});

test('readSession respeta maxMessages y su valor por defecto', () => {
  const two = readSession(WORKSPACE, MAIN_ID, { maxMessages: 2 });
  assert.deepEqual(two.messages.map((message) => message.text), ['tercera', 'segunda respuesta']);
  const none = readSession(WORKSPACE, MAIN_ID, { maxMessages: 0 });
  assert.deepEqual(none.messages, []);
  // Valores absurdos no rompen: se usa el máximo por defecto.
  const odd = readSession(WORKSPACE, MAIN_ID, { maxMessages: 'muchos' });
  assert.equal(odd.messages.length, 5);
  const all = readSession(WORKSPACE, MAIN_ID, { maxMessages: 10_000 });
  assert.equal(all.messages.length, 5);
});

test('readSession aplica los reemplazos surfaceOp (compactación)', () => {
  const session = readSession(WORKSPACE, REPLACE_ID);
  assert.ok(session);
  // La franja 2..3 queda sombreada y el checkpoint de plugin no es un mensaje de chat.
  assert.deepEqual(session.messages, []);
  assert.equal(session.title, null);
});

test('readSession lee una sesión vacía, una legacy y tolera la corrupta', () => {
  const empty = readSession(WORKSPACE, EMPTY_ID);
  assert.ok(empty);
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.title, null);

  const legacy = readSession(OTHER_WORKSPACE, LEGACY_ID);
  assert.ok(legacy);
  assert.equal(legacy.workspacePath, OTHER_WORKSPACE);
  assert.deepEqual(legacy.messages.map((message) => message.text), ['hola otro']);

  assert.equal(readSession(WORKSPACE, CORRUPT_ID), null);
  assert.equal(readSession(WORKSPACE, 'session-00000000-0000-0000-0000-000000000000'), null);
  assert.equal(readSession('C:\\no\\existe', MAIN_ID), null);
});

test('readSession resuelve el workspace por cwd aunque cambie el caso', () => {
  const upper = WORKSPACE.toUpperCase();
  assert.notEqual(encodeWorkspacePath(upper), encodeWorkspacePath(WORKSPACE));
  const session = readSession(upper, MAIN_ID);
  assert.ok(session);
  assert.equal(session.workspacePath, WORKSPACE);
});

test('readSession grande: multiframe, último mensaje y preview del modo rápido', () => {
  const big = readSession(WORKSPACE, BIG_ID);
  assert.ok(big);
  assert.equal(big.title, 'Sesión grande');
  assert.equal(big.messages.length, 2);
  assert.equal(big.messages[1].text, 'respuesta grande');
  assert.ok(big.messages[0].text.length > 1_000_000);
});

// ---------------------------------------------------------------------------
// Búsqueda por id
// ---------------------------------------------------------------------------

test('adoptable distingue sesiones del puente de las del escritorio y subagentes', () => {
  const sessions = listSessions(WORKSPACE);
  const listed = new Map(sessions.map((session) => [session.id, session]));
  // Sin agentPreset ni subagente: el puente puede continuarla.
  assert.equal(listed.get(MAIN_ID).adoptable, true);
  assert.equal(listed.get(LEGACY_ID), undefined); // está en otro workspace
  // Creada desde el escritorio: `dsh-headless` la rechaza.
  assert.equal(listed.get(PRESET_ID).adoptable, false);
  // Subagente: no es una conversación de proyecto.
  assert.equal(listed.get(SUBAGENT_ID).adoptable, false);
  // Sin cabecera legible: se intenta igualmente.
  assert.equal(listed.get(NO_HEADER_ID).adoptable, true);

  assert.equal(readSession(WORKSPACE, MAIN_ID).adoptable, true);
  assert.equal(readSession(WORKSPACE, PRESET_ID).adoptable, false);
  assert.equal(readSession(WORKSPACE, SUBAGENT_ID).adoptable, false);
  assert.equal(readSession(WORKSPACE, NO_HEADER_ID).adoptable, true);
  assert.equal(readSession(OTHER_WORKSPACE, LEGACY_ID).adoptable, true);
  assert.equal(findSession(PRESET_ID).session.adoptable, false);

  // El modo rápido calcula lo mismo (rama de fichero pequeño y rama de cola).
  const fast = new Map(listSessions(WORKSPACE, { fast: true }).map((session) => [session.id, session]));
  assert.equal(fast.get(MAIN_ID).adoptable, true);
  assert.equal(fast.get(PRESET_ID).adoptable, false);
  assert.equal(fast.get(NO_HEADER_ID).adoptable, true);
  assert.equal(fast.get(BIG_ID).adoptable, true);
});

test('findSession localiza la sesión en cualquier workspace', () => {
  const found = findSession(MAIN_ID);
  assert.ok(found);
  assert.equal(found.workspacePath, WORKSPACE);
  assert.equal(found.session.id, MAIN_ID);
  assert.equal(found.session.messages.length, 5);

  const legacy = findSession(LEGACY_ID);
  assert.ok(legacy);
  assert.equal(legacy.workspacePath, OTHER_WORKSPACE);

  assert.equal(findSession('session-00000000-0000-0000-0000-000000000000'), null);
  assert.equal(findSession(''), null);
  assert.equal(findSession(null), null);
});

test('ids con separadores o traversal no tocan rutas arbitrarias', () => {
  for (const dangerous of ['..', '../..', '..\\..\\x', 'C:\\Users\\demo', 'a/b', 'a\\b']) {
    assert.equal(readSession(WORKSPACE, dangerous), null, `readSession(${dangerous})`);
    assert.equal(findSession(dangerous), null, `findSession(${dangerous})`);
  }
});

// ---------------------------------------------------------------------------
// Datos reales
// ---------------------------------------------------------------------------

test('contra el almacén real de ~/.dsh/sessions (se omite si no existe)', () => {
  const saved = process.env.DSH_HOME;
  delete process.env.DSH_HOME;
  try {
    assert.equal(dshSessionsRoot(), join(homedir(), '.dsh', 'sessions'));
    let root;
    try {
      root = dshSessionsRoot();
      if (statSync(root) && !statSync(root).isDirectory()) throw new Error('no es un directorio');
    } catch {
      return; // sin almacén real: el test pasa sin más
    }

    const workspaces = listStoredWorkspaces();
    if (workspaces.length === 0) return;

    let workspacePath = null;
    let sessions = [];
    for (const workspace of workspaces) {
      if (typeof workspace.path !== 'string' || workspace.path.length === 0) continue;
      const candidate = listSessions(workspace.path);
      if (candidate.length > 0) {
        workspacePath = workspace.path;
        sessions = candidate;
        break;
      }
    }
    if (workspacePath === null) return;

    const summary = sessions[0];
    assert.equal(typeof summary.id, 'string');
    assert.ok(summary.id.length > 0);
    assert.ok(Number.isFinite(summary.updatedAt));
    assert.ok(Number.isInteger(summary.messageCount));
    assert.equal(typeof summary.preview, 'string');
    assert.equal(typeof summary.adoptable, 'boolean');

    const detail = readSession(workspacePath, summary.id);
    assert.ok(detail);
    assert.equal(detail.id, summary.id);
    assert.equal(typeof detail.adoptable, 'boolean');
    assert.ok(detail.messages.length <= 200);
    for (let index = 0; index < detail.messages.length; index += 1) {
      const message = detail.messages[index];
      assert.equal(message.role === 'user' || message.role === 'assistant', true);
      assert.equal(typeof message.text, 'string');
      assert.ok(Number.isFinite(message.at));
      if (message.role === 'user') {
        // Los inyectados por el harness nunca llegan como mensaje de usuario.
        assert.ok(!message.text.startsWith('Current runtime context'));
        assert.ok(!message.text.startsWith('<system-reminder>'));
      }
      if (index > 0) assert.ok(message.at >= detail.messages[index - 1].at);
    }

    const found = findSession(summary.id);
    assert.ok(found);
    assert.equal(found.session.id, summary.id);
    assert.equal(found.workspacePath.toLowerCase(), workspacePath.toLowerCase());

    // Modo rápido: sin recuento y con la misma identidad.
    const fast = listSessions(workspacePath, { fast: true });
    assert.equal(fast.length, sessions.length);
    for (const session of fast) {
      assert.ok(!('messageCount' in session));
      assert.equal(typeof session.updatedAt, 'number');
      assert.equal(typeof session.preview, 'string');
    }
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
  }
});

