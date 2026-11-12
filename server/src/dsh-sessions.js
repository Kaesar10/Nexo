/**
 * Lector directo del almacén de sesiones de DeepSeek Harness (DSH).
 *
 * El GUI de DSH y este puente comparten el mismo almacén, así que leerlo aquí es
 * lo que hace que el histórico del móvil y el del PC estén sincronizados:
 *
 *   <DSH_HOME>/sessions/<project-key>/<session-id>/session.v<versión>.jsonl.zstd
 *
 * `<DSH_HOME>` es `%USERPROFILE%\.dsh` por defecto y `$DSH_HOME` si está definido
 * (misma precedencia que `@deepseek-ai/dsh-home-paths`).
 *
 * ## Codificación del nombre de proyecto (`encodeWorkspacePath`)
 *
 * El nombre del directorio se deriva de la ruta absoluta del workspace con el
 * mismo algoritmo que usa DSH (`projectKey` en `dsh-session-persistence-jsonl`):
 *
 * - separadores `/`, `\` y `:` -> `-`, colapsando una racha de separadores en
 *   un único `-`;
 * - caracteres seguros `[A-Za-z0-9._-]` -> literales;
 * - `~` y cualquier otro code unit UTF-16 -> `~XXXX` (hex de 4 dígitos, en
 *   mayúsculas);
 * - el resultado se envuelve en `--…--` y se recorta a 251 caracteres.
 *
 * Ejemplo real verificado: `C:\Users\demo\Desktop\proyecto\_probe_ws`
 * -> `--C-Users-demo-Desktop-proyecto-_probe_ws--`.
 *
 * La decodificación es **ambigua por diseño** (igual que DSH): separadores y
 * guiones literales comparten `-`, y la cola puede venir truncada. Por eso
 * `decodeWorkspaceDirName` es solo un respaldo: la fuente primaria de la ruta
 * es el campo `cwd` de la cabecera `session` que hay dentro del propio log.
 * No existe índice SQLite (`session-query-sqlite`) en esta instalación: no hay
 * base de datos en `~/.dsh/storages` ni en `~/.dsh/cache`.
 *
 * ## Formato del log
 *
 * El `.zstd` es un contenedor **multiframe**: cada frame es un lote JSONL
 * independiente. `zlib.zstdDecompressSync` solo devuelve el primer frame, así
 * que se localizan estructuralmente los frames completos (magic `28 B5 2F FD`)
 * y se descomprime cada uno por separado; el frame final incompleto (escritura
 * en curso) se ignora.
 *
 * ## Qué es un "mensaje" para el móvil
 *
 * El contrato móvil (`docs/API.md`) pinta una conversación de chat: prompts del
 * usuario y **respuestas finales** del asistente. Por eso se excluyen:
 *
 * - los mensajes inyectados por el harness (`user/message` con
 *   `data.source.kind` distinto de `'user'`: `runtime-context`, `skill-catalog`,
 *   y cualquier `kind` de plugin). Verificado empíricamente: "Current runtime
 *   context…" llega como `source.kind === 'runtime-context'` y
 *   "<system-reminder>…" como `source.kind === 'skill-catalog'`; los mensajes
 *   reales llevan `source.kind === 'user'` y pueden traer campos extra
 *   (`rpcId`, `clientTimeZone`), así que la regla es el `kind`, no la forma;
 * - los pasos intermedios del asistente (`assistant/message` con `tool-call` en
 *   `data.message.content`): solo la respuesta final de cada turno no lleva
 *   tool-calls;
 * - `reasoning` y `tool-call`: nunca son texto visible.
 *
 * Los `surfaceOp: { op: 'replace', … }` (compactación) se respetan: el mensaje
 * sombreado por un reemplazo no se devuelve. En datos reales DSH publica esos
 * reemplazos como `user/message` con `source.kind === 'plugin'` (plugin
 * `compact`), que se aplican al rango `startSeq..endSeq` pero no se muestran.
 *
 * ## Título
 *
 * El título vigente puede cambiar con el tiempo, así que no basta el primero del
 * fichero. Se toma del caché durable de proyecciones de DSH
 * (`<DSH_HOME>/storages/session_projcache/sessions/<id>.json`, fila `title`),
 * validándolo contra el `seq` del último evento del log (lectura de cola O(1));
 * si el caché no existe o está atrasado, se recorre el log (último
 * `session/title` gana).
 *
 * ## Continuación desde el móvil: `adoptable`
 *
 * `dsh-headless` rechaza continuar sesiones cuyo header define `agentPreset`
 * (el runner one-shot no compone presets) y las de subagente no son
 * conversaciones de proyecto. Cada sesión devuelve `adoptable`, calculado con
 * el header ya leído: `true` solo si no hay `agentPreset`, `origin !== 'subagent'`
 * y hay `cwd`; si la cabecera no se puede leer se devuelve `true` (mejor que
 * falle el agente con su error a esconder un chat válido).
 *
 * Módulo sin dependencias externas, sin clases y sin estado mutable de módulo.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/** Magic little-endian de un frame Zstandard (`0xFD2FB528`). */
const ZSTD_MAGIC = 0xfd2fb528;
/** Límite de frames completos por frame al leer solo la cabecera. */
const FIRST_FRAME_PROBE_BYTES = 16 * 1024;
/** Tope del sondeo de cabecera (aunque un frame de cabecera nunca es así de grande). */
const FIRST_FRAME_PROBE_MAX = 8 * 1024 * 1024;
/** Mensajes devueltos por defecto cuando `opts.maxMessages` no se especifica. */
const DEFAULT_MAX_MESSAGES = 200;
/** Tope duro de mensajes, para que una petición absurda no agote la memoria del PC. */
const MAX_MESSAGES_LIMIT = 10_000;
/** Frames que se inspeccionan desde el principio para localizar el título. */
const TITLE_SCAN_FRAMES = 32;
/** Por debajo de este tamaño, el modo rápido reutiliza el recorrido completo (es barato). */
const FAST_FULL_SCAN_BYTES = 512 * 1024;
/** Ventana inicial de sondeo de la cola para el `preview` del modo rápido. */
const TAIL_PROBE_BYTES = 256 * 1024;
/** Tope de la ventana de cola del modo rápido. */
const TAIL_PROBE_MAX = 4 * 1024 * 1024;
/** Bytes mágicos de Zstandard para localizar frames desde la cola. */
const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** Prefijo de texto guardado por candidato al listar (solo para `preview`). */
const PREVIEW_SOURCE_CHARS = 400;
/** Longitud final del `preview` que consume la app. */
const PREVIEW_CHARS = 160;
/** Nombre canónico de un artefacto de log, con versión de formato y compresión. */
const LOG_FILE_RE = /^session\.v(\d+)\.jsonl(\.zstd)?$/;
/** Ids de sesión aceptables para construir rutas (UUID o `session-<uuid>`). */
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9._~-]+$/;

/** Aviso único y silencioso: los listados nunca rompen la petición HTTP. */
function warn(message) {
  console.error(`[dsh-sessions] ${message}`);
}

/** Texto de un error para logs. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** ¿Es una ruta de directorio existente? */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Forma canónica para comparar rutas de workspace (case-insensitive en Windows). */
function compareKey(path) {
  return String(path)
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** Ruta del home de DSH: `$DSH_HOME` si es válido, si no `~/.dsh`. */
function dshHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  if (!configured) return join(homedir(), '.dsh');
  if (configured === '~') return homedir();
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return join(homedir(), configured.slice(2));
  }
  return resolve(configured);
}

// ---------------------------------------------------------------------------
// Zstandard multiframe
// ---------------------------------------------------------------------------

/**
 * Recorre la estructura de un contenedor de frames Zstandard concatenados sin
 * descomprimir los bloques.
 *
 * Adaptado del escáner de `@deepseek-ai/dsh-session-persistence-jsonl`: recorre
 * cabeceras de frame, cabeceras de bloque y longitudes, así que el resultado es
 * exacto aunque los bytes mágicos aparezcan por casualidad dentro de datos
 * comprimidos.
 *
 * @param {Buffer} buffer - bytes completos del artefacto.
 * @param {number} [maxFrames] - corta al encontrar tantos frames completos.
 * @returns {{ frames: Array<{start:number,end:number}>, tornStart?: number }}
 */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`log Zstandard corrupto: magic de frame inválido en el byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };

    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`log Zstandard corrupto: bit reservado en la cabecera de frame (byte ${offset - 1})`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`log Zstandard corrupto: tipo de bloque reservado en el byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/** Descomprime un frame completo y valida su checksum. */
function decompressFrame(buffer, frame) {
  try {
    return zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8');
  } catch (error) {
    throw new Error(
      `log Zstandard corrupto: el frame en el byte ${frame.start} no se puede descomprimir (${errorText(error)})`,
      { cause: error },
    );
  }
}

/** Carga un log en memoria: `.zstd` multiframe o `.jsonl` plano (respaldo). */
function loadLog(logPath) {
  const buffer = readFileSync(logPath);
  if (!/\.zstd$/i.test(logPath)) return { plain: true, text: buffer.toString('utf8') };
  const scan = scanZstdFrames(buffer);
  return { plain: false, buffer, frames: scan.frames };
}

/** Itera el texto descomprimido de cada frame, en orden de escritura. */
function* logFrames(log) {
  if (log.plain) {
    yield log.text;
    return;
  }
  for (const frame of log.frames) yield decompressFrame(log.buffer, frame);
}

/** Itera el texto descomprimido de cada frame, del último al primero. */
function* logFramesReverse(log) {
  if (log.plain) {
    yield log.text;
    return;
  }
  for (let index = log.frames.length - 1; index >= 0; index -= 1) {
    yield decompressFrame(log.buffer, log.frames[index]);
  }
}

// ---------------------------------------------------------------------------
// Codificación / decodificación de nombres
// ---------------------------------------------------------------------------

/**
 * Invierte la codificación `~XXXX` de un segmento (id de sesión).
 *
 * @param {string} name - nombre de directorio tal cual.
 * @returns {string|null} el valor original, o `null` si la codificación no es válida.
 */
function decodeSegment(name) {
  if (typeof name !== 'string' || name.length === 0) return null;
  let out = '';
  for (let index = 0; index < name.length; index += 1) {
    const ch = name[index];
    if (ch !== '~') {
      out += ch;
      continue;
    }
    const hex = name.slice(index + 1, index + 5);
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null;
    out += String.fromCharCode(Number.parseInt(hex, 16));
    index += 4;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Utilidades del almacén
// ---------------------------------------------------------------------------

/** Directorio raíz del almacén de sesiones de DSH. */
export function dshSessionsRoot() {
  return join(dshHome(), 'sessions');
}

/**
 * Directorio de proyecto que DSH usa para una ruta absoluta.
 *
 * Réplica exacta de `projectKey` (`dsh-session-persistence-jsonl`).
 *
 * @param {string} absPath - ruta absoluta del workspace.
 * @returns {string} nombre de directorio, p. ej. `--C-Users-demo-App--`.
 */
export function encodeWorkspacePath(absPath) {
  const cwd = typeof absPath === 'string' ? absPath : '';
  if (cwd.length === 0) throw new TypeError('encodeWorkspacePath necesita una ruta absoluta no vacía');
  let readable = '';
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/**
 * Decodifica (de forma aproximada) el nombre de directorio de un workspace.
 *
 * Es intrínsecamente ambiguo: separadores y `-` literales comparten carácter, y
 * la cola puede estar truncada a 251 caracteres. Úsalo solo como respaldo del
 * campo `cwd` de la cabecera del log.
 *
 * @param {string} dirName - nombre de directorio, p. ej. `--C-Users-demo-App--`.
 * @returns {string|null} ruta plausible, o `null` si no es un nombre codificado.
 */
export function decodeWorkspaceDirName(dirName) {
  if (typeof dirName !== 'string' || dirName.length < 4) return null;
  if (!dirName.startsWith('--') || !dirName.endsWith('--')) return null;
  const inner = dirName.slice(2, -2);
  if (inner.length === 0) return null;

  let raw = '';
  for (let index = 0; index < inner.length; index += 1) {
    const ch = inner[index];
    if (ch !== '~') {
      raw += ch;
      continue;
    }
    const hex = inner.slice(index + 1, index + 5);
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null;
    raw += String.fromCharCode(Number.parseInt(hex, 16));
    index += 4;
  }

  // Sin contenido legible, DSH usa la clave centinela `root`.
  if (raw === 'root') return process.platform === 'win32' ? '\\' : '/';

  if (/^[A-Za-z]-/.test(raw)) {
    const letter = raw[0];
    const rest = raw.slice(2).replace(/-/g, '\\');
    return `${letter}:\\${rest}`;
  }
  return `/${raw.replace(/-/g, '/')}`;
}

/** Lista canónica de directorios de sesión de un directorio de proyecto. */
function sessionDirNames(projectDir) {
  try {
    return readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Ruta del log vigente de un directorio de sesión (mayor versión de formato).
 *
 * @param {string} sessionDir - directorio `<session-id>`.
 * @returns {string|null} ruta del artefacto, o `null` si no hay ninguno.
 */
function logPathOf(sessionDir) {
  let names;
  try {
    names = readdirSync(sessionDir);
  } catch {
    return null;
  }
  let best = null;
  let bestVersion = -1;
  let bestCompressed = false;
  for (const name of names) {
    const match = LOG_FILE_RE.exec(name);
    if (!match) continue;
    const version = Number.parseInt(match[1], 10);
    const compressed = Boolean(match[2]);
    if (version > bestVersion || (version === bestVersion && compressed && !bestCompressed)) {
      best = name;
      bestVersion = version;
      bestCompressed = compressed;
    }
  }
  return best === null ? null : join(sessionDir, best);
}

/** Primer frame descomprimido de un log (la cabecera `session`). */
function firstFrameText(log) {
  if (log.plain) return log.text;
  if (log.frames.length === 0) return null;
  return decompressFrame(log.buffer, log.frames[0]);
}

/** Lee por posición y cantidad desde un fichero. */
function readAt(logPath, position, length) {
  const fd = openSync(logPath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, position);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * Texto de los primeros frames de un log, sin cargar el resto del fichero.
 *
 * @param {string} logPath - artefacto `.jsonl.zstd` (o `.jsonl` plano).
 * @param {number} [maxFrames] - frames a devolver como máximo.
 * @returns {string[]} textos descomprimidos, en orden.
 */
function readPrefixFrameTexts(logPath, maxFrames = 1) {
  let stats;
  try {
    stats = statSync(logPath);
  } catch {
    return [];
  }
  if (stats.size === 0) return [];
  if (!/\.zstd$/i.test(logPath)) {
    try {
      return [readFileSync(logPath, 'utf8')];
    } catch {
      return [];
    }
  }
  let size = FIRST_FRAME_PROBE_BYTES;
  for (;;) {
    const take = Math.min(size, stats.size);
    let chunk;
    try {
      chunk = readAt(logPath, 0, take);
    } catch {
      return [];
    }
    let scan;
    try {
      scan = scanZstdFrames(chunk, maxFrames);
    } catch {
      return [];
    }
    if (scan.frames.length === maxFrames || take >= stats.size || size >= FIRST_FRAME_PROBE_MAX) {
      const texts = [];
      for (const frame of scan.frames) {
        try {
          texts.push(decompressFrame(chunk, frame));
        } catch {
          return texts;
        }
      }
      return texts;
    }
    size *= 2;
  }
}

/** Primer frame descomprimido de un `.zstd` (la cabecera `session`). */
function readFirstFrameText(logPath) {
  const texts = readPrefixFrameTexts(logPath, 1);
  return texts.length > 0 ? texts[0] : null;
}

/** Parsea una línea JSON, devolviendo `null` en vez de lanzar. */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Cabecera `session` a partir de la primera línea del log, o `null`. */
function parseHeaderLine(line) {
  if (typeof line !== 'string' || !/^\{"type":"session",/.test(line)) return null;
  const header = parseJson(line);
  return header && header.type === 'session' ? header : null;
}

/**
 * ¿El puente puede continuar esta sesión con `dsh headless --session-id`?
 *
 * `dsh-headless` rechaza las sesiones cuyo header define `agentPreset` (el
 * runner one-shot no compone presets), y las de subagente o sin `cwd` no son
 * conversaciones de un proyecto. Si no se puede leer la cabecera se devuelve
 * `true`: mejor intentarlo y que falle el agente con su error que esconder un
 * chat válido.
 */
function isAdoptable(header) {
  if (!header) return true;
  if (header.agentPreset !== undefined) return false;
  if (header.origin === 'subagent') return false;
  if (typeof header.cwd !== 'string' || header.cwd.length === 0) return false;
  return true;
}

/** Cabecera `session` del log (id, cwd, createdAt), o `null`. */
function readHeader(log) {
  const text = firstFrameText(log);
  if (!text) return null;
  return parseHeaderLine(text.split('\n')[0]);
}

/** `cwd` de la cabecera de un log concreto, leyendo solo su primer frame. */
function headerCwdOf(logPath) {
  const header = parseHeaderLine(readFirstFrameText(logPath));
  return header && typeof header.cwd === 'string' ? header.cwd : null;
}

/**
 * Busca el directorio de proyecto de una ruta de workspace.
 *
 * Orden: codificación exacta, `cwd` de las cabeceras (autoritativo), y por
 * último el decodificado aproximado del nombre (respaldo).
 */
function resolveWorkspaceDir(workspacePath) {
  const raw = typeof workspacePath === 'string' ? workspacePath.trim() : '';
  if (!raw) return null;
  const root = dshSessionsRoot();
  if (!isDirectory(root)) return null;

  const direct = join(root, encodeWorkspacePath(raw));
  if (isDirectory(direct)) return direct;

  const wanted = compareKey(raw);
  let names;
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name.startsWith('--'));
  } catch {
    return null;
  }

  // Fuente primaria: `cwd` de la cabecera del primer log legible de cada dir.
  for (const name of names) {
    const projectDir = join(root, name);
    for (const sessionName of sessionDirNames(projectDir)) {
      const logPath = logPathOf(join(projectDir, sessionName));
      if (!logPath) continue;
      const cwd = headerCwdOf(logPath);
      if (cwd !== null && compareKey(cwd) === wanted) return projectDir;
    }
  }

  // Respaldo: decodificado del nombre.
  for (const name of names) {
    const decoded = decodeWorkspaceDirName(name);
    if (decoded !== null && compareKey(decoded) === wanted) return join(root, name);
  }
  return null;
}

/**
 * Localiza el directorio de una sesión dentro de su proyecto.
 *
 * Acepta tanto el formato actual (el nombre del directorio es el id literal,
 * p. ej. `session-<uuid>`) como el legado (`session-<uuid>` para un id sin
 * prefijo).
 */
function findSessionDir(projectDir, sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id || !SAFE_SESSION_ID_RE.test(id) || id === '.' || id === '..') return null;
  const candidates = [id, `session-${id}`, `session-${id.replace(/^session-/, '')}`];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const dir = join(projectDir, candidate);
    if (!isDirectory(dir)) continue;
    if (logPathOf(dir)) return dir;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extracción de mensajes de chat
// ---------------------------------------------------------------------------

/** Bloques de contenido de un evento de mensaje (`content[]`). */
function contentBlocks(event) {
  const blocks = event.type === 'user/message' ? event.data?.content : event.data?.message?.content;
  return Array.isArray(blocks) ? blocks : null;
}

/** Texto plano de un evento de mensaje: solo bloques `text`, unidos. */
function messageText(event) {
  const blocks = contentBlocks(event);
  if (!blocks) return '';
  const parts = [];
  for (const block of blocks) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
    parts.push(block.text);
  }
  return parts.join('\n');
}

/** Id estable del mensaje: `data.id` para usuario, `data.message.id` para el agente. */
function messageId(event, sessionId) {
  const raw =
    event.type === 'user/message'
      ? event.data?.id
      : event.data?.message?.id;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  const seq = Number.isSafeInteger(event.seq) ? event.seq : 'x';
  return `${sessionId}:${seq}`;
}

/** Rango sombreado por un `surfaceOp: { op: 'replace' }`. */
function shadowRangeOf(event) {
  const op = event.surfaceOp;
  if (!op || typeof op !== 'object' || op.op !== 'replace') return null;
  const start = op.startSeq;
  const end = op.endSeq;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  return [start, end];
}

/** ¿El evento cae dentro de algún rango sombreado? */
function isShadowed(seq, ranges) {
  for (const [start, end] of ranges) {
    if (seq >= start && seq <= end) return true;
  }
  return false;
}

/** Convierte un evento válido en el mensaje del contrato. */
function toChatMessage(event, text, sessionId) {
  return {
    id: messageId(event, sessionId),
    role: event.type === 'user/message' ? 'user' : 'assistant',
    text,
    at: Number.isSafeInteger(event.time) ? event.time : 0,
  };
}

/**
 * ¿La línea es una respuesta final del asistente?
 *
 * Se comprueba sobre el JSON crudo para no parsear los pasos intermedios, que
 * son las líneas más grandes del log (llevan el stream del proveedor):
 * - contiene un bloque `text`, y
 * - no contiene ningún `tool-call` (un paso con tool-calls no cierra el turno),
 * - el bloque de texto no está vacío.
 *
 * Validado contra las 128 sesiones reales del equipo: coincide al 100 % con el
 * parseo completo para los logs actuales.
 */
function isAssistantReplyLine(line) {
  return (
    line.includes('"type":"text"') &&
    !line.includes('"type":"tool-call"') &&
    !line.includes('"type":"text","text":""')
  );
}

/** ¿La línea es un mensaje escrito por el usuario (no inyectado por el harness)? */
function isUserMessageLine(line) {
  return line.includes('"type":"user/message"') && line.includes('"source":{"kind":"user"');
}

/** Recoge los mensajes de chat visibles, en orden cronológico, desde el final. */
function collectChatMessages(log, sessionId, maxMessages) {
  if (maxMessages <= 0) return [];
  const reversed = [];
  const shadows = [];
  for (const frameText of logFramesReverse(log)) {
    const lines = frameText.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].replace(/\r$/, '');
      if (!line) continue;
      const isUser = line.includes('"type":"user/message"');
      if (!isUser && !line.includes('"type":"assistant/message"')) continue;
      const candidate = isUser ? isUserMessageLine(line) : isAssistantReplyLine(line);
      const hasReplace = line.includes('"surfaceOp":{"op":"replace"');
      if (!candidate && !hasReplace) continue;

      const event = parseJson(line);
      if (!event) continue;
      const range = shadowRangeOf(event);
      if (range) shadows.push(range);
      if (!candidate) continue;

      const text = messageText(event);
      if (!text.trim()) continue;
      const seq = Number.isSafeInteger(event.seq) ? event.seq : -1;
      if (isShadowed(seq, shadows)) continue;
      reversed.push(toChatMessage(event, text, sessionId));
      if (reversed.length >= maxMessages) return reversed.reverse();
    }
  }
  return reversed.reverse();
}

/** Último título de una lista de textos de frame (el último `session/title` gana). */
function lastTitleInTexts(texts) {
  let title = null;
  for (const frameText of texts) {
    for (const rawLine of frameText.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (!line.includes('"type":"session/title"')) continue;
      const event = parseJson(line);
      if (event && typeof event.data?.title === 'string') title = event.data.title;
    }
  }
  return title;
}

/**
 * Título vigente recorriendo todo el log (último `session/title` gana).
 *
 * Solo se usa como respaldo del caché de proyecciones: un título puede
 * regenerarse más tarde, así que el primero del fichero no siempre es el bueno.
 */
function findTitle(log) {
  return lastTitleInTexts([...logFrames(log)]);
}

// --- caché durable de proyecciones (`storages/session_projcache`) ----------

/**
 * Título cacheado por DSH para una sesión, si el registro es utilizable.
 *
 * El caché de proyecciones (`@deepseek-ai/dsh-session-projection-cache`) se
 * escribe en los puntos obligatorios (creación, `turn/end`, cierre), así que es
 * la forma barata de conocer el título *vigente* sin recorrer el log entero.
 * Nunca es autoritativo: se valida contra el `seq` del último evento del log.
 */
function readCachedTitle(sessionId, header) {
  try {
    const file = join(dshHome(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
    if (!existsSync(file)) return null;
    const record = parseJson(readFileSync(file, 'utf8'));
    const cached = record?.record;
    const row = cached?.rows?.title;
    if (!cached || !row || typeof row.val !== 'string') return null;
    const identity = cached.identity;
    if (!identity || typeof identity !== 'object') return null;
    if (header && typeof header.cwd === 'string' && typeof identity.cwd === 'string' && identity.cwd !== header.cwd) {
      return null;
    }
    if (header && Number.isInteger(identity.formatVersion) && header.version !== identity.formatVersion) return null;
    return { title: row.val, seq: Number.isSafeInteger(row.seq) ? row.seq : null };
  } catch {
    return null;
  }
}

/** Texto del último frame de un log, leyendo solo su cola. */
function lastFrameText(logPath, fileSize) {
  let size = Math.min(TAIL_PROBE_BYTES, fileSize);
  for (;;) {
    const take = Math.min(size, fileSize);
    let chunk;
    try {
      chunk = readAt(logPath, fileSize - take, take);
    } catch {
      return null;
    }
    let cursor = chunk.length;
    while (cursor > 0) {
      const found = chunk.lastIndexOf(ZSTD_MAGIC_BYTES, cursor - 1);
      if (found < 0) break;
      cursor = found;
      try {
        return zstdDecompressSync(chunk.subarray(found)).toString('utf8');
      } catch {
        /* candidato falso o frame final a medio escribir */
      }
    }
    if (take >= fileSize || size >= TAIL_PROBE_MAX) return null;
    size *= 2;
  }
}

/** `seq` del último evento del log, para validar que el caché está al día. */
function lastEventSeq(logPath, fileSize) {
  const text = lastFrameText(logPath, fileSize);
  if (!text) return null;
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^\{"type":"[^"]+","seq":(\d+)/.exec(lines[index]);
    if (match) return Number.parseInt(match[1], 10);
  }
  return null;
}

/** ¿El caché corresponde al último evento del log (o no se puede comprobar)? */
function cachedSeqIsFresh(logPath, fileSize, cachedSeq) {
  if (cachedSeq === null) return true;
  return lastEventSeq(logPath, fileSize) === cachedSeq;
}

/** Título del caché si está al día; `null` si toca leerlo del log. */
function cachedTitleIfFresh(logPath, fileSize, sessionId, header) {
  const cached = readCachedTitle(sessionId, header);
  if (!cached) return null;
  return cachedSeqIsFresh(logPath, fileSize, cached.seq) ? cached.title : null;
}

/** Formatea un texto como preview de una línea. */
function makePreview(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/gu, ' ').trim().slice(0, PREVIEW_CHARS);
}

/** Metadatos de una sesión para el listado, recorriendo su log una sola vez. */
function inspectSessionDir(sessionDir) {
  const logPath = logPathOf(sessionDir);
  if (!logPath) return null;
  const stats = statSync(logPath);
  const dirName = sessionDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const id = decodeSegment(dirName) ?? dirName;

  const log = loadLog(logPath);
  let header = null;
  let title = null;
  const candidates = [];
  const shadows = [];

  for (const frameText of logFrames(log)) {
    for (const rawLine of frameText.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (!line) continue;
      if (header === null) {
        const parsed = parseHeaderLine(line);
        if (parsed) {
          header = parsed;
          continue;
        }
      }
      if (line.includes('"type":"session/title"')) {
        const event = parseJson(line);
        if (event && typeof event.data?.title === 'string') title = event.data.title;
        continue;
      }
      const isUser = line.includes('"type":"user/message"');
      if (!isUser && !line.includes('"type":"assistant/message"')) continue;
      const candidate = isUser ? isUserMessageLine(line) : isAssistantReplyLine(line);
      const hasReplace = line.includes('"surfaceOp":{"op":"replace"');
      if (!candidate && !hasReplace) continue;

      const event = parseJson(line);
      if (!event) continue;
      const range = shadowRangeOf(event);
      if (range) shadows.push(range);
      if (!candidate) continue;
      const text = messageText(event);
      if (!text.trim()) continue;
      candidates.push({
        seq: Number.isSafeInteger(event.seq) ? event.seq : -1,
        text: text.slice(0, PREVIEW_SOURCE_CHARS),
      });
    }
  }

  const visible = candidates.filter((entry) => !isShadowed(entry.seq, shadows));
  return {
    id,
    title,
    updatedAt: Math.round(stats.mtimeMs),
    messageCount: visible.length,
    preview: makePreview(visible.length > 0 ? visible[visible.length - 1].text : ''),
    adoptable: isAdoptable(header),
  };
}

/**
 * Último mensaje visible de chat leyendo solo la cola del fichero.
 *
 * Los frames son independientes: `zstdDecompressSync` de una rebanada que empieza
 * en un frame real devuelve ese frame e ignora los siguientes, así que un
 * candidato a magic se valida con una sola descompresión O(1) — sin recorrer la
 * estructura de todo el resto del fichero.
 */
function findTailPreview(logPath, fileSize) {
  let size = Math.min(TAIL_PROBE_BYTES, fileSize);
  for (;;) {
    const take = Math.min(size, fileSize);
    let chunk;
    try {
      chunk = readAt(logPath, fileSize - take, take);
    } catch {
      return '';
    }
    let cursor = chunk.length;
    while (cursor > 0) {
      const found = chunk.lastIndexOf(ZSTD_MAGIC_BYTES, cursor - 1);
      if (found < 0) break;
      cursor = found;
      let text;
      try {
        text = zstdDecompressSync(chunk.subarray(found)).toString('utf8');
      } catch {
        continue; // no era un inicio de frame
      }
      const lines = text.split('\n');
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].replace(/\r$/, '');
        if (!line) continue;
        const isUser = line.includes('"type":"user/message"');
        if (!isUser && !line.includes('"type":"assistant/message"')) continue;
        const candidate = isUser ? isUserMessageLine(line) : isAssistantReplyLine(line);
        if (!candidate) continue;
        const event = parseJson(line);
        if (!event) continue;
        const message = messageText(event);
        if (message.trim()) return message;
      }
    }
    if (take >= fileSize || size >= TAIL_PROBE_MAX) return '';
    size *= 2;
  }
}

/**
 * Metadatos rápidos de una sesión: sin contar mensajes y sin recorrer el log.
 *
 * - `updatedAt`: `mtime` del artefacto.
 * - `title`: frames iniciales (el título de DSH se escribe al principio).
 * - `preview`: cola del fichero (último mensaje visible).
 * - `messageCount`: deliberadamente ausente (`undefined`).
 *
 * Si el fichero es pequeño se reutiliza el recorrido completo, que es barato.
 */
function inspectSessionFast(sessionDir) {
  const logPath = logPathOf(sessionDir);
  if (!logPath) return null;
  const stats = statSync(logPath);
  const dirName = sessionDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const meta = {
    id: decodeSegment(dirName) ?? dirName,
    title: null,
    updatedAt: Math.round(stats.mtimeMs),
    preview: '',
    adoptable: true,
  };
  if (stats.size <= FAST_FULL_SCAN_BYTES) {
    const full = inspectSessionDir(sessionDir);
    if (full) {
      meta.title = full.title;
      meta.preview = full.preview;
      meta.adoptable = full.adoptable;
    }
    return meta;
  }
  meta.adoptable = isAdoptable(parseHeaderLine(readFirstFrameText(logPath)));
  const cachedTitle = cachedTitleIfFresh(logPath, stats.size, meta.id, null);
  if (cachedTitle !== null) {
    meta.title = cachedTitle;
  } else {
    try {
      meta.title = lastTitleInTexts(readPrefixFrameTexts(logPath, TITLE_SCAN_FRAMES));
    } catch {
      /* el título es opcional */
    }
  }
  try {
    meta.preview = makePreview(findTailPreview(logPath, stats.size));
  } catch {
    /* el preview es opcional */
  }
  return meta;
}

/** Sesión completa leída de un directorio ya resuelto. */
function readSessionDir(sessionDir, sessionId, maxMessages) {
  const logPath = logPathOf(sessionDir);
  if (!logPath) return null;
  const stats = statSync(logPath);
  const log = loadLog(logPath);
  const header = readHeader(log);
  const id = typeof header?.id === 'string' && header.id.length > 0 ? header.id : sessionId;
  const cachedTitle = cachedTitleIfFresh(logPath, stats.size, id, header);
  const title = cachedTitle !== null ? cachedTitle : findTitle(log);
  return {
    id,
    title,
    workspacePath: typeof header?.cwd === 'string' ? header.cwd : null,
    updatedAt: Math.round(stats.mtimeMs),
    messages: collectChatMessages(log, id, maxMessages),
    adoptable: isAdoptable(header),
  };
}

/** Normaliza `opts.maxMessages`: entero no negativo, con tope duro. */
function normalizeMaxMessages(value) {
  if (value === undefined || value === null) return DEFAULT_MAX_MESSAGES;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_MAX_MESSAGES;
  const integer = Math.trunc(numeric);
  if (integer < 0) return DEFAULT_MAX_MESSAGES;
  return Math.min(integer, MAX_MESSAGES_LIMIT);
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * Workspaces con sesiones guardadas en el almacén de DSH.
 *
 * La ruta sale del `cwd` de la cabecera del primer log legible (fuente
 * primaria); solo si no hay cabecera se usa el decodificado del nombre.
 *
 * @returns {Array<{ path: string, lastActiveAt: number, sessionCount: number }>}
 */
export function listStoredWorkspaces() {
  const root = dshSessionsRoot();
  if (!existsSync(root)) return [];
  const workspaces = [];
  let warned = false;
  let names;
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    warn(`no se pudo leer ${root}: ${errorText(error)}`);
    return [];
  }

  for (const name of names) {
    if (!name.startsWith('--') || !name.endsWith('--')) continue;
    const projectDir = join(root, name);
    let lastActiveAt = 0;
    let sessionCount = 0;
    let path = null;
    try {
      for (const sessionName of sessionDirNames(projectDir)) {
        const logPath = logPathOf(join(projectDir, sessionName));
        if (!logPath) continue;
        sessionCount += 1;
        let stats;
        try {
          stats = statSync(logPath);
        } catch {
          continue;
        }
        lastActiveAt = Math.max(lastActiveAt, Math.round(stats.mtimeMs));
        if (path === null) path = headerCwdOf(logPath);
      }
    } catch (error) {
      if (!warned) {
        warn(`sesión ilegible en ${projectDir}: ${errorText(error)}`);
        warned = true;
      }
    }
    if (path === null) path = decodeWorkspaceDirName(name);
    if (path === null) continue;
    workspaces.push({ path, lastActiveAt, sessionCount });
  }

  workspaces.sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.path.localeCompare(b.path));
  return workspaces;
}

/**
 * Sesiones (chats) de un workspace, de la más reciente a la más antigua.
 *
 * Nunca lanza: si algo falla devuelve lo que se haya podido leer.
 *
 * @param {string} workspacePath - ruta absoluta del proyecto.
 * @param {{ fast?: boolean }} [opts] - `fast: true` evita recorrer cada log:
 *   omite `messageCount` y saca título de los primeros frames y `preview` de la
 *   cola del fichero. Ideal para abrir la lista de chats de un proyecto grande.
 * @returns {Array<{ id: string, title: string|null, updatedAt: number,
 *   messageCount?: number, preview: string, adoptable: boolean }>}
 */
export function listSessions(workspacePath, opts = {}) {
  const projectDir = resolveWorkspaceDir(workspacePath);
  if (!projectDir) return [];
  const fast = opts?.fast === true;
  const sessions = [];
  let warned = false;
  for (const sessionName of sessionDirNames(projectDir)) {
    const sessionDir = join(projectDir, sessionName);
    try {
      const meta = fast ? inspectSessionFast(sessionDir) : inspectSessionDir(sessionDir);
      if (meta) sessions.push(meta);
    } catch (error) {
      if (!warned) {
        warn(`log ilegible en ${sessionDir}: ${errorText(error)}`);
        warned = true;
      }
    }
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  return sessions;
}

/**
 * Lee una sesión del almacén.
 *
 * @param {string} workspacePath - ruta absoluta del proyecto (se usa también de respaldo).
 * @param {string} sessionId - id de la sesión (`session-<uuid>` en el formato actual).
 * @param {{ maxMessages?: number }} [opts] - cuántos mensajes devolver (por defecto 200).
 * @returns {{ id: string, title: string|null, workspacePath: string, updatedAt: number,
 *   adoptable: boolean,
 *   messages: Array<{ id: string, role: 'user'|'assistant', text: string, at: number }> } | null}
 */
export function readSession(workspacePath, sessionId, opts = {}) {
  try {
    const maxMessages = normalizeMaxMessages(opts?.maxMessages);
    const projectDir = resolveWorkspaceDir(workspacePath);
    if (!projectDir) return null;
    const sessionDir = findSessionDir(projectDir, sessionId);
    if (!sessionDir) return null;
    const session = readSessionDir(sessionDir, sessionId, maxMessages);
    if (!session) return null;
    if (session.workspacePath === null) session.workspacePath = String(workspacePath);
    return session;
  } catch (error) {
    warn(`no se pudo leer la sesión ${sessionId}: ${errorText(error)}`);
    return null;
  }
}

/**
 * Busca una sesión por id en todos los workspaces del almacén.
 *
 * @param {string} sessionId - id de la sesión.
 * @returns {{ workspacePath: string, session: object } | null} `null` si no está.
 */
export function findSession(sessionId) {
  try {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id || !SAFE_SESSION_ID_RE.test(id) || id === '.' || id === '..') return null;
    const root = dshSessionsRoot();
    let names;
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => name.startsWith('--'));
    } catch {
      return null;
    }
    for (const name of names) {
      const projectDir = join(root, name);
      const sessionDir = findSessionDir(projectDir, id);
      if (!sessionDir) continue;
      try {
        const session = readSessionDir(sessionDir, id, DEFAULT_MAX_MESSAGES);
        if (!session) continue;
        const workspacePath = session.workspacePath ?? decodeWorkspaceDirName(name);
        if (workspacePath === null) continue;
        session.workspacePath = workspacePath;
        return { workspacePath, session };
      } catch (error) {
        warn(`no se pudo leer la sesión ${id}: ${errorText(error)}`);
      }
    }
    return null;
  } catch (error) {
    warn(`no se pudo buscar la sesión ${sessionId}: ${errorText(error)}`);
    return null;
  }
}
