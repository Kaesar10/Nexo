import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Hash estable para guardar tokens de dispositivo sin el secreto en claro. */
export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

/** Identificador corto legible: dev_ab12cd34 */
export function shortId(prefix = 'id') {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}

/** Token de dispositivo: 256 bits en hex. */
export function deviceToken() {
  return randomBytes(32).toString('hex');
}

/** Comparación en tiempo constante para secretos de igual longitud. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

/** PIN numérico de 6 dígitos, sin sesgo apreciable. */
export function newPin() {
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return String(n).padStart(6, '0');
}

/** Escritura atómica: escribe a .tmp y renombra, para no corromper la config. */
export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/** Lee el cuerpo de una petición con límite de tamaño. */
export function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** JSON parseado del cuerpo, o {} si viene vacío. */
export async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('JSON inválido'), { code: 'BAD_REQUEST' });
  }
}

/** Fecha relativa corta en español para logs/previews. */
export function relativeTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'ahora';
  if (diff < 3_600_000) return `hace ${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `hace ${Math.floor(diff / 3_600_000)} h`;
  return `hace ${Math.floor(diff / 86_400_000)} d`;
}
