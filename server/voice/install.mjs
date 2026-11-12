#!/usr/bin/env node
/**
 * install.mjs — descarga y prepara el modelo Whisper ONNX para el dictado local.
 *
 * Uso:
 *   node install.mjs                # descarga el modelo por defecto
 *   node install.mjs --force        # vuelve a descargar aunque ya esté instalado
 *   node install.mjs --model Xenova/whisper-small
 *   node install.mjs --dtype q8     # q8 (por defecto) | fp32
 *
 * Descarga desde hf-mirror.com (espejo de Hugging Face; comprobado que funciona
 * cuando huggingface.co falla). Si el espejo falla se reintenta contra
 * huggingface.co. Los ficheros quedan en `server/voice/models/<repo>/...` y a
 * partir de ahí la transcripción NO vuelve a tocar la red (worker.mjs arranca
 * con `allowRemoteModels = false`).
 *
 * Al terminar escribe `models/.installed.json` (marcador que lee la fachada
 * `server/src/transcribe.js` para saber si el motor está disponible).
 */
import { pipeline, env } from '@huggingface/transformers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.join(HERE, 'models');
const MARKER = path.join(MODELS_DIR, '.installed.json');

export const DEFAULT_MODEL = 'Xenova/whisper-base';
export const DEFAULT_DTYPE = 'q8';
export const MIRRORS = [
  process.env.NEXO_VOICE_MIRROR || 'https://hf-mirror.com',
  'https://hf-mirror.com',
  'https://huggingface.co',
];

function parseArgs(argv) {
  const out = { force: false, model: DEFAULT_MODEL, dtype: DEFAULT_DTYPE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') out.force = true;
    else if (a === '--model') out.model = argv[++i] || out.model;
    else if (a === '--dtype') out.dtype = argv[++i] || out.dtype;
  }
  return out;
}

function human(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/** Suma el tamaño real de todo lo descargado bajo models/ */
export function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size;
        } catch {}
      }
    }
  }
  return total;
}

function installedFiles(model) {
  const rel = model.replace(/\//g, path.sep);
  try {
    const marker = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
    return marker.model === model && fs.existsSync(path.join(MODELS_DIR, rel));
  } catch {
    return false;
  }
}

/** Lista relativa de ficheros de un directorio (para el marcador). */
function listFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(path.relative(dir, p).replace(/\\/g, '/'));
    }
  }
  return out.sort();
}

async function withMirror(mirror, model, dtype, onFile) {
  // Aísla la configuración de la librería: todo va a models/ y se descarga del espejo.
  env.cacheDir = MODELS_DIR;
  env.localModelPath = MODELS_DIR;
  env.allowRemoteModels = true;
  env.allowLocalModels = true;
  env.remoteHost = mirror;
  env.remotePathTemplate = '{model}/resolve/{revision}/';

  const seen = new Map();
  const progress_callback = (p) => {
    if (!p || !p.file) return;
    if (p.status === 'progress') {
      seen.set(p.file, { loaded: p.loaded, total: p.total });
      onFile?.(p);
    } else if (p.status === 'done') {
      const prev = seen.get(p.file);
      onFile?.({ ...p, loaded: prev?.total ?? prev?.loaded ?? 0, total: prev?.total ?? 0, done: true });
    }
  };

  const pipe = await pipeline('automatic-speech-recognition', model, {
    dtype: dtype,
    progress_callback,
  });
  await pipe?.dispose?.();
  return seen;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  fs.mkdirSync(MODELS_DIR, { recursive: true });

  if (!args.force && installedFiles(args.model)) {
    const prev = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
    const size = dirSize(MODELS_DIR);
    console.log(`[voz] Modelo ya instalado: ${prev.model} (${human(size)}) en ${MODELS_DIR}`);
    console.log('[voz] Nada que hacer. Usa --force para volver a descargarlo.');
    return;
  }

  console.log(`[voz] Modelo: ${args.model}  (dtype ${args.dtype})`);
  console.log(`[voz] Destino: ${MODELS_DIR}`);
  console.log('[voz] Descargando (puede tardar unos minutos)...');

  const started = Date.now();
  let lastError;
  let lastPct = -1;

  for (const mirror of MIRRORS) {
    const t0 = Date.now();
    try {
      console.log(`[voz] Espejo: ${mirror}`);
      const files = await withMirror(mirror, args.model, args.dtype, (p) => {
        if (p.done) {
          console.log(`[voz]   ok   ${p.file} (${human(p.total || p.loaded)})`);
          return;
        }
        const pct = Math.floor(p.progress ?? 0);
        if (pct !== lastPct && (pct % 10 === 0 || pct === 100)) {
          lastPct = pct;
          console.log(`[voz]   ...  ${p.file} ${pct}% (${human(p.loaded)}/${human(p.total)})`);
        }
      });
      const modelDir = path.join(MODELS_DIR, args.model.replace(/\//g, path.sep));
      const size = dirSize(modelDir);
      const totalB = dirSize(MODELS_DIR);
      const marker = {
        model: args.model,
        dtype: args.dtype,
        engine: 'whisper-onnx',
        mirror,
        bytes: size,
        totalModelsBytes: totalB,
        files: listFiles(modelDir),
        installedAt: new Date().toISOString(),
        installMs: Date.now() - t0,
        node: process.version,
      };
      fs.writeFileSync(MARKER, JSON.stringify(marker, null, 2), 'utf8');
      console.log('');
      console.log(`[voz] LISTO. Modelo en disco: ${human(size)} (${marker.files.length} ficheros)`);
      console.log(`[voz] models/ completo: ${human(totalB)}`);
      console.log(`[voz] Tiempo de descarga: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      console.log(`[voz] Marcador: ${MARKER}`);
      console.log(`[voz] Total: ${((Date.now() - started) / 1000).toFixed(1)} s`);
      return;
    } catch (err) {
      lastError = err;
      console.warn(`[voz] Espejo ${mirror} falló: ${err?.message || err}`);
    }
  }

  throw new Error(`No se pudo descargar el modelo ${args.model}: ${lastError?.message || lastError}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`[voz] ERROR: ${err?.message || err}`);
    process.exitCode = 1;
  });
}
