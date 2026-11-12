/**
 * transcribe.js — fachada del dictado por voz 100% local (Whisper ONNX en el PC).
 *
 * Interfaz CONGELADA (no cambiar nombres ni forma de los retornos):
 *   voiceStatus()                     -> { available, engine, model, reason? }
 *   transcribeWav(buffer, {language}) -> { text, language, seconds, engine, ms }
 *   readWavInfo(buffer)               -> { sampleRate, channels, bitsPerSample, seconds } | null
 *
 * Diseño:
 *  - El motor vive aislado en server/voice/ con sus propias dependencias.
 *  - Aquí se lanza `server/voice/worker.mjs --serve` como proceso hijo: carga el
 *    modelo UNA vez y luego atiende transcripciones (la 2ª en adelante no paga
 *    la carga). El hijo se cierra solo al cerrarse stdin (si el padre muere) o
 *    tras 5 min sin uso: no quedan procesos huérfanos.
 *  - Solo se transcribe 1 audio a la vez (cola FIFO; máximo 8 en espera).
 *  - Timeout duro de 90 s por transcripción (NEXO_VOICE_TIMEOUT_MS lo cambia).
 *  - Si el motor no está instalado: voiceStatus() -> available:false y
 *    transcribeWav() lanza un error con code 'VOICE_UNAVAILABLE'.
 *  - Errores siempre en español, con `code` estable para que el puente los mapee.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineStatus, readWavHeader } from '../voice/worker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const VOICE_DIR = path.join(__dirname, '..', 'voice');
const WORKER_PATH = path.join(VOICE_DIR, 'worker.mjs');
const MODELS_MARKER = path.join(VOICE_DIR, 'models', '.installed.json');
const TMP_DIR = path.join(os.tmpdir(), 'nexo-voice');

const TIMEOUT_MS = Math.max(500, Number(process.env.NEXO_VOICE_TIMEOUT_MS) || 90_000);
const TIMEOUT_LABEL = TIMEOUT_MS >= 2000 ? `${Math.round(TIMEOUT_MS / 1000)} s` : `${TIMEOUT_MS} ms`;
const IDLE_MS = Math.max(30_000, Number(process.env.NEXO_VOICE_IDLE_MS) || 300_000);
const MAX_QUEUE = 8;

const ENGINE = 'whisper-onnx';

function voiceError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** ¿Están instaladas las dependencias del motor? (barato, sin cargarlas) */
function depsInstalled() {
  return (
    fs.existsSync(path.join(VOICE_DIR, 'node_modules', '@huggingface', 'transformers', 'package.json')) &&
    fs.existsSync(path.join(VOICE_DIR, 'node_modules', 'onnxruntime-node', 'package.json'))
  );
}

/**
 * Estado del motor de voz local.
 * @returns {Promise<{available:boolean, engine:string|null, model:string|null, reason?:string}>}
 */
export async function voiceStatus() {
  try {
    if (!fs.existsSync(WORKER_PATH)) {
      return {
        available: false,
        engine: null,
        model: null,
        reason: 'Falta server/voice/worker.mjs: el paquete de voz local está incompleto.',
      };
    }
    if (!depsInstalled()) {
      return {
        available: false,
        engine: null,
        model: null,
        reason:
          'Faltan las dependencias del motor de voz. Ejecuta scripts\\instalar-voz.ps1 (o `npm install` dentro de server\\voice).',
      };
    }
    const st = engineStatus();
    if (!st.available) return st;
    return { available: true, engine: st.engine || ENGINE, model: st.model };
  } catch (err) {
    return {
      available: false,
      engine: null,
      model: null,
      reason: `No se pudo comprobar el motor de voz: ${err?.message || err}`,
    };
  }
}

function wavIsValid(buffer) {
  return readWavHeader(buffer) !== null;
}

/**
 * Lee y valida la cabecera RIFF/WAVE (PCM 8/16/24/32 bits o float32).
 * @returns {{sampleRate:number, channels:number, bitsPerSample:number, seconds:number}|null}
 */
export function readWavInfo(buffer) {
  try {
    return readWavHeader(buffer);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Proceso hijo cálido (singleton)
// ---------------------------------------------------------------------------
let worker = null; // { child, pending: Map<id, {resolve,reject,timer}>, stderr, nextId, dead }
let queueTail = Promise.resolve();
let queueSize = 0;

function killWorker(reason) {
  const w = worker;
  if (!w) return;
  worker = null;
  for (const [, p] of w.pending) {
    clearTimeout(p.timer);
    p.reject(voiceError(`El motor de voz se cerró (${reason}).`, 'VOICE_ENGINE_ERROR'));
  }
  w.pending.clear();
  try {
    if (!w.child.killed) w.child.kill();
  } catch {
    /* ignorado */
  }
}

function ensureWorker() {
  if (worker && !worker.dead && worker.child.exitCode === null) return worker;

  if (!fs.existsSync(WORKER_PATH)) {
    throw voiceError('Falta server/voice/worker.mjs: el motor de voz local no está instalado.', 'VOICE_UNAVAILABLE');
  }
  if (!fs.existsSync(MODELS_MARKER)) {
    throw voiceError(
      'El motor de voz local no está instalado. Ejecuta scripts\\instalar-voz.ps1 para descargar el modelo.',
      'VOICE_UNAVAILABLE',
    );
  }

  const child = spawn(process.execPath, [WORKER_PATH, '--serve', '--idle-ms', String(IDLE_MS)], {
    cwd: VOICE_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const state = { child, pending: new Map(), stderr: '', nextId: 1, dead: false };
  worker = state;

  // El hijo cálido NO debe mantener vivo al proceso Node que lo lanzó (tests,
  // scripts de una sola vez): si el padre termina, stdin se cierra y el hijo sale.
  try {
    child.unref();
    child.stdin.unref?.();
    child.stdout.unref?.();
    child.stderr.unref?.();
  } catch {
    /* no crítico */
  }

  let outBuf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    outBuf += chunk;
    let idx;
    while ((idx = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, idx).trim();
      outBuf = outBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // línea suelta (logs de la librería): se ignora
      }
      const p = state.pending.get(msg.id);
      if (!p) continue;
      state.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(voiceError(msg.error || 'El motor de voz falló.', msg.code || 'VOICE_ENGINE_ERROR'));
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    state.stderr = (state.stderr + chunk).slice(-4000);
  });
  child.on('error', (err) => {
    state.dead = true;
    for (const [, p] of state.pending) {
      clearTimeout(p.timer);
      p.reject(voiceError(`No se pudo arrancar el motor de voz: ${err.message}`, 'VOICE_UNAVAILABLE'));
    }
    state.pending.clear();
    if (worker === state) worker = null;
  });
  child.on('exit', (code, signal) => {
    state.dead = true;
    const detail = code === 0 || signal ? 'se cerró' : `código de salida ${code}`;
    for (const [, p] of state.pending) {
      clearTimeout(p.timer);
      const extra = state.stderr ? ` Detalle: ${state.stderr.trim().slice(-500)}` : '';
      p.reject(voiceError(`El motor de voz ${detail}.${extra}`, 'VOICE_ENGINE_ERROR'));
    }
    state.pending.clear();
    if (worker === state) worker = null;
  });

  return state;
}

// Nunca dejar el hijo colgado si el proceso padre termina.
process.once('exit', () => {
  try {
    worker?.child.kill();
  } catch {
    /* ignorado */
  }
});

/** Envía una petición al hijo cálido y espera su respuesta (con timeout duro). */
function requestWorker(wavPath, language) {
  const state = ensureWorker();
  const id = state.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      // Un worker sordo ya no sirve: se mata para que la siguiente petición arranque limpia
      killWorker(`timeout de ${TIMEOUT_LABEL}`);
      reject(
        voiceError(
          `La transcripción tardó más de ${TIMEOUT_LABEL} y se canceló. Prueba con un audio más corto.`,
          'VOICE_TIMEOUT',
        ),
      );
    }, TIMEOUT_MS);
    state.pending.set(id, { resolve, reject, timer });
    try {
      state.child.stdin.write(`${JSON.stringify({ id, wav: wavPath, language })}\n`);
    } catch (err) {
      clearTimeout(timer);
      state.pending.delete(id);
      reject(voiceError(`No se pudo enviar el audio al motor de voz: ${err.message}`, 'VOICE_ENGINE_ERROR'));
    }
  });
}

/**
 * Transcribe un WAV (Buffer) en local.
 * @param {Buffer} buffer
 * @param {{language?: string}} [options]
 * @returns {Promise<{text:string, language:string, seconds:number, engine:string, ms:number}>}
 */
export async function transcribeWav(buffer, { language = 'es' } = {}) {
  const started = Date.now();

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw voiceError('El audio está vacío o no es un Buffer válido.', 'AUDIO_INVALID');
  }
  const info = readWavInfo(buffer);
  if (!info) {
    throw voiceError(
      'El audio debe ser un WAV PCM válido (RIFF/WAVE, PCM o float). No se pudo leer la cabecera.',
      'AUDIO_INVALID',
    );
  }
  if (info.seconds < 0.2) {
    throw voiceError('El audio es demasiado corto para transcribir (mínimo 0,2 s).', 'AUDIO_INVALID');
  }
  if (info.seconds > 300) {
    throw voiceError('El audio es demasiado largo (máximo 5 minutos por transcripción).', 'AUDIO_INVALID');
  }

  const status = await voiceStatus();
  if (!status.available) {
    throw voiceError(status.reason || 'El motor de voz local no está disponible.', 'VOICE_UNAVAILABLE');
  }

  if (queueSize >= MAX_QUEUE) {
    throw voiceError('Hay demasiadas transcripciones en cola; inténtalo de nuevo en unos segundos.', 'VOICE_BUSY');
  }

  const lang = String(language || 'es').toLowerCase().split(/[-_]/)[0];

  // Cola FIFO: una sola transcripción simultánea en todo el proceso.
  queueSize++;
  const run = queueTail.then(async () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const wavPath = path.join(
      TMP_DIR,
      `nexo-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
    );
    try {
      fs.writeFileSync(wavPath, buffer);
      const res = await requestWorker(wavPath, lang);
      return {
        text: res.text ?? '',
        language: res.language ?? lang,
        seconds: res.seconds ?? info.seconds,
        engine: res.engine || ENGINE,
        ms: Date.now() - started,
      };
    } finally {
      try {
        fs.rmSync(wavPath, { force: true });
      } catch {
        /* ignorado */
      }
    }
  });

  // La cola sigue aunque esta petición falle (no envenenar las siguientes).
  queueTail = run.catch(() => {});
  try {
    return await run;
  } finally {
    queueSize--;
  }
}

/** Solo para pruebas/cierre ordenado: cierra el proceso hijo cálido. */
export function shutdownVoice() {
  killWorker('cierre solicitado');
}

export default { voiceStatus, transcribeWav, readWavInfo };
