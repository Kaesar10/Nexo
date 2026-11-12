import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { shortId, writeJsonAtomic } from './util.js';

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB: una foto comprimida o un PDF normal
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/avif': '.avif',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};

/** Extensiones con las que trabajamos; nada ejecutable entra por aquí. */
const ALLOWED_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.heif', '.avif',
  '.pdf', '.txt', '.md', '.csv', '.json', '.log', '.xml', '.yaml', '.yml',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
]);

/** Nunca se aceptan: son ejecutables o scripts que el agente podría lanzar. */
const BLOCKED_EXT = new Set([
  '.exe', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.mjs', '.cjs',
  '.msi', '.dll', '.scr', '.lnk', '.jar', '.com', '.pif', '.hta', '.reg', '.wsf', '.wsh', '.cpl',
]);

const SAFE_NAME = /[^a-zA-Z0-9._-]+/g;

/**
 * Subidas de archivos desde el móvil (imágenes y documentos).
 *
 * El archivo se guarda DENTRO del workspace (`<proyecto>/.nexo/adjuntos/`) a
 * propósito: el sandbox del agente es `workspace-write`, así que solo puede leer
 * lo que esté bajo el proyecto. El mensaje que se manda a DSH incluye la ruta y
 * el agente la abre con sus herramientas (read_image, unzip, PDF, etc.).
 */
export function createUploads({ dataDir }) {
  const indexFile = join(dataDir, 'attachments.json');
  mkdirSync(dataDir, { recursive: true });
  let index = {};
  if (existsSync(indexFile)) {
    try {
      index = JSON.parse(readFileSync(indexFile, 'utf8')) ?? {};
    } catch {
      index = {};
    }
  }

  function persist() {
    try {
      writeJsonAtomic(indexFile, index);
    } catch {
      /* no crítico */
    }
  }

  function resolveExtension(name, mime) {
    const fromMime = EXT_BY_MIME[String(mime ?? '').toLowerCase()];
    if (fromMime) return fromMime;
    const fromName = extname(String(name ?? '')).toLowerCase();
    if (BLOCKED_EXT.has(fromName)) {
      throw Object.assign(new Error('Ese tipo de archivo no está permitido'), {
        code: 'BAD_REQUEST',
        status: 400,
      });
    }
    if (ALLOWED_EXT.has(fromName)) return fromName;
    throw Object.assign(new Error('Tipo de archivo no admitido'), {
      code: 'BAD_REQUEST',
      status: 400,
    });
  }

  function save({ workspacePath, name, mime, data }) {
    const raw = String(data ?? '');
    if (!raw) {
      throw Object.assign(new Error('El archivo viene vacío'), { code: 'BAD_REQUEST', status: 400 });
    }
    const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
    let buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch {
      throw Object.assign(new Error('Archivo mal codificado'), { code: 'BAD_REQUEST', status: 400 });
    }
    if (buffer.length === 0) {
      throw Object.assign(new Error('El archivo viene vacío'), { code: 'BAD_REQUEST', status: 400 });
    }

    const type = String(mime ?? '').toLowerCase() || 'application/octet-stream';
    const ext = resolveExtension(name, type);
    const limit = type.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_BYTES;
    if (buffer.length > limit) {
      const mb = Math.round(limit / (1024 * 1024));
      throw Object.assign(new Error(`El archivo supera los ${mb} MB`), {
        code: 'PAYLOAD_TOO_LARGE',
        status: 413,
      });
    }

    const dir = join(workspacePath, '.nexo', 'adjuntos');
    mkdirSync(dir, { recursive: true });
    const id = shortId('att');
    const cleanName = basename(String(name ?? 'archivo')).replace(SAFE_NAME, '_').slice(-60);
    const fileName = `${Date.now()}-${id}${ext}`;
    const filePath = join(dir, fileName);
    writeFileSync(filePath, buffer);

    index[id] = {
      id,
      path: filePath,
      name: cleanName || fileName,
      mime: type,
      size: buffer.length,
      kind: type.startsWith('image/') ? 'image' : 'file',
      at: Date.now(),
    };
    persist();
    return publicEntry(index[id]);
  }

  function publicEntry(entry) {
    return {
      id: entry.id,
      name: entry.name,
      mime: entry.mime,
      size: entry.size,
      kind: entry.kind ?? (String(entry.mime).startsWith('image/') ? 'image' : 'file'),
      url: `/api/attachments/${entry.id}`,
      path: entry.path,
    };
  }

  function get(id) {
    return index[id] ?? null;
  }

  /** Resuelve las rutas citadas en un mensaje del historial. */
  function byPath(path) {
    return Object.values(index).find((entry) => entry.path === path) ?? null;
  }

  /** Adjuntos presentes en un texto con líneas `[Adjunto: <ruta>]`. */
  function fromText(text) {
    const found = [];
    const regex = /\[Adjunto:\s*([^\]\n]+)\]/g;
    let match;
    while ((match = regex.exec(String(text ?? ''))) !== null) {
      const entry = byPath(match[1].trim());
      if (entry) found.push(publicEntry(entry));
    }
    return found;
  }

  function toPublic(id) {
    const entry = index[id];
    return entry ? publicEntry(entry) : null;
  }

  /** Existe y sigue en disco (el usuario pudo borrar la carpeta). */
  function isReadable(id) {
    const entry = index[id];
    if (!entry) return false;
    try {
      return statSync(entry.path).size > 0;
    } catch {
      return false;
    }
  }

  return {
    save,
    get,
    toPublic,
    fromText,
    byPath,
    isReadable,
    maxBytes: MAX_BYTES,
    maxImageBytes: MAX_IMAGE_BYTES,
  };
}
