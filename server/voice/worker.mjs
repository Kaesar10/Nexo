#!/usr/bin/env node
/**
 * worker.mjs — proceso hijo que transcribe UN WAV con Whisper (ONNX) en local.
 *
 * Dos modos:
 *   1) Un tiro (el descrito en la tarea):
 *        node worker.mjs <ruta.wav> [--language es]
 *      Escribe UNA línea JSON en stdout y sale:
 *        {"text":"...","language":"es","seconds":2.6,"engine":"whisper-onnx","ms":1234}
 *      Si falla: {"error":"mensaje","code":"..."} en stdout y code de salida 1.
 *
 *   2) Servicio cálido (lo usa la fachada para que la 2ª transcripción no vuelva
 *      a cargar el modelo):
 *        node worker.mjs --serve [--idle-ms 300000]
 *      Lee líneas JSON {"id":1,"wav":"C:\\...\\a.wav","language":"es"} por stdin y
 *      responde una línea JSON por petición: {"id":1,"ok":true,...} | {"id":1,"ok":false,"error":"..."}.
 *      Sale solo al cerrar stdin, al pasarse del idle o al recibir SIGTERM.
 *
 * Nunca toca la red: arranca con `allowRemoteModels=false`; el modelo debe estar
 * ya en `server/voice/models/` (lo deja install.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.join(HERE, 'models');
const MARKER = path.join(MODELS_DIR, '.installed.json');
const SAMPLE_RATE = 16000; // Whisper trabaja a 16 kHz mono float32

const LANGUAGE_NAMES = {
  es: 'spanish',
  en: 'english',
  fr: 'french',
  de: 'german',
  it: 'italian',
  pt: 'portuguese',
  ca: 'catalan',
  gl: 'galician',
  eu: 'basque',
  nl: 'dutch',
  ru: 'russian',
  zh: 'chinese',
  ja: 'japanese',
  ko: 'korean',
  ar: 'arabic',
  hi: 'hindi',
  pl: 'polish',
  tr: 'turkish',
  sv: 'swedish',
  uk: 'ukrainian',
};

export function voiceError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Lee la cabecera RIFF/WAVE y devuelve los datos PCM. null si no es un WAV válido. */
function parseWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > buffer.length) break;
    if (id === 'fmt ' && size >= 16) {
      let format = buffer.readUInt16LE(body);
      const channels = buffer.readUInt16LE(body + 2);
      const sampleRate = buffer.readUInt32LE(body + 4);
      const bitsPerSample = buffer.readUInt16LE(body + 14);
      if (format === 0xfffe && size >= 26) {
        // WAVE_FORMAT_EXTENSIBLE: el formato real va en los 2 primeros bytes del GUID
        format = buffer.readUInt16LE(body + 24);
      }
      fmt = { format, channels, sampleRate, bitsPerSample };
    } else if (id === 'data') {
      data = buffer.subarray(body, body + size);
    }
    offset = body + size + (size % 2); // los chunks van alineados a 2 bytes
  }
  if (!fmt || !data || !fmt.channels || !fmt.sampleRate) return null;
  if (![1, 2, 3].includes(fmt.format)) return null;
  if (![8, 16, 24, 32].includes(fmt.bitsPerSample)) return null;
  return { ...fmt, data };
}

/** Convierte PCM (8/16/24/32 int o 32 float) de N canales a mono float32 a 16 kHz. */
function decodeToMono16k(wav) {
  const { format, channels, sampleRate, bitsPerSample, data } = wav;
  const bytes = bitsPerSample / 8;
  const frameCount = Math.floor(data.length / (bytes * channels));
  const mono = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const p = (i * channels + c) * bytes;
      let v;
      if (format === 3) {
        v = data.readFloatLE(p);
      } else if (bitsPerSample === 8) {
        v = (data[p] - 128) / 128;
      } else if (bitsPerSample === 16) {
        v = data.readInt16LE(p) / 32768;
      } else if (bitsPerSample === 24) {
        const raw = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16);
        v = ((raw << 8) >> 8) / 8388608;
      } else {
        v = data.readInt32LE(p) / 2147483648;
      }
      acc += v;
    }
    mono[i] = acc / channels;
  }

  if (sampleRate === SAMPLE_RATE) return mono;
  // Remuestreo lineal (suficiente y sin dependencias nativas para voz)
  const outLen = Math.max(1, Math.round((frameCount * SAMPLE_RATE) / sampleRate));
  const out = new Float32Array(outLen);
  const ratio = sampleRate / SAMPLE_RATE;
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, frameCount - 1);
    const t = src - i0;
    out[i] = mono[i0] * (1 - t) + mono[i1] * t;
  }
  return out;
}

/** Cabecera + duración de un WAV, sin decodificar el audio. null si no es WAV válido. */
export function readWavHeader(buffer) {
  const wav = parseWav(buffer);
  if (!wav) return null;
  const seconds = wav.data.length / (wav.channels * (wav.bitsPerSample / 8) * wav.sampleRate);
  return {
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    bitsPerSample: wav.bitsPerSample,
    seconds: +seconds.toFixed(2),
  };
}

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(MARKER, 'utf8'));
  } catch {
    return null;
  }
}

/** Estado del motor, sin cargarlo (barato; lo usa la fachada para voiceStatus). */
export function engineStatus() {
  const marker = readMarker();
  if (!marker) {
    return {
      available: false,
      engine: null,
      model: null,
      reason: 'El motor de voz local no está instalado. Ejecuta scripts\\instalar-voz.ps1 (o `npm install` + `node install.mjs` dentro de server\\voice).',
    };
  }
  const modelDir = path.join(MODELS_DIR, marker.model.replace(/\//g, path.sep));
  if (!fs.existsSync(modelDir)) {
    return {
      available: false,
      engine: null,
      model: null,
      reason: `Faltan los ficheros del modelo ${marker.model}. Vuelve a ejecutar scripts\\instalar-voz.ps1.`,
    };
  }
  return {
    available: true,
    engine: marker.engine || 'whisper-onnx',
    model: marker.model,
    dtype: marker.dtype || 'q8',
    bytes: marker.bytes,
    installedAt: marker.installedAt,
  };
}

let pipePromise = null;
let pipe = null;

async function loadPipeline() {
  const status = engineStatus();
  if (!status.available) throw voiceError(status.reason, 'VOICE_UNAVAILABLE');
  if (!pipePromise) {
    pipePromise = (async () => {
      // Extraer la configuración de la librería AQUÍ, ya que los imports de
      // @huggingface/transformers son estáticos.
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = MODELS_DIR;
      env.localModelPath = MODELS_DIR;
      env.allowLocalModels = true;
      env.allowRemoteModels = false; // <-- garantía de funcionamiento sin red
      env.useFSCache = true;
      const marker = readMarker();
      return pipeline('automatic-speech-recognition', marker.model, {
        dtype: marker.dtype || 'q8',
        progress_callback: undefined,
      });
    })();
  }
  pipe = await pipePromise;
  return pipe;
}

/** Transcribe un WAV en disco. Devuelve {text, language, seconds, engine, model, loadMs, transcribeMs}. */
export async function transcribeFile(wavPath, { language = 'es' } = {}) {
  const t0 = Date.now();
  let buffer;
  try {
    buffer = fs.readFileSync(wavPath);
  } catch (err) {
    throw voiceError(`No se pudo leer el audio (${wavPath}): ${err.message}`, 'AUDIO_READ_FAILED');
  }
  const wav = parseWav(buffer);
  if (!wav) throw voiceError('El audio no es un WAV PCM válido.', 'AUDIO_INVALID');
  const seconds = +(wav.data.length / (wav.channels * (wav.bitsPerSample / 8) * wav.sampleRate)).toFixed(2);

  const pipelineInstance = await loadPipeline();
  const loadMs = Date.now() - t0;

  const audio = decodeToMono16k(wav);
  const langName = LANGUAGE_NAMES[String(language).toLowerCase()] || 'spanish';

  const t1 = Date.now();
  let result;
  try {
    result = await pipelineInstance(audio, {
      language: langName,
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
      // Evita que un silencio largo dispare decodificaciones absurdas
      return_timestamps: false,
    });
  } catch (err) {
    throw voiceError(`Fallo del motor de voz al transcribir: ${err.message}`, 'VOICE_ENGINE_ERROR');
  }
  const transcribeMs = Date.now() - t1;

  const text = String(result?.text ?? '').replace(/\s+/g, ' ').trim();
  return {
    text,
    language: String(language).toLowerCase(),
    seconds,
    engine: 'whisper-onnx',
    model: readMarker()?.model || null,
    loadMs,
    transcribeMs,
    ms: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function parseWorkerArgs(argv) {
  const out = { wav: null, language: 'es', serve: false, idleMs: 300000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--serve') out.serve = true;
    else if (a === '--language') out.language = argv[++i] || out.language;
    else if (a === '--idle-ms') out.idleMs = Number(argv[++i]) || out.idleMs;
    else if (!a.startsWith('--')) out.wav = a;
  }
  return out;
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const args = parseWorkerArgs(process.argv.slice(2));

  if (args.serve) {
    // ---- Modo servicio cálido: 1 línea JSON de entrada -> 1 de salida ----
    let idleTimer;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => process.exit(0), args.idleMs);
      idleTimer.unref?.();
    };
    // Red de seguridad extra: si el proceso padre (el puente) desaparece de golpe,
    // este worker se cierra en <= 5 s. Nunca debe quedar un proceso huérfano.
    const parentPid = process.ppid;
    const parentWatch = setInterval(() => {
      try {
        process.kill(parentPid, 0); // signal 0 = solo comprobar existencia
      } catch {
        process.exit(0);
      }
    }, 5000);
    parentWatch.unref?.();
    const onLine = async (line) => {
      resetIdle();
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        emit({ id: null, ok: false, error: 'Petición JSON inválida.', code: 'BAD_REQUEST' });
        return;
      }
      try {
        const r = await transcribeFile(req.wav, { language: req.language || args.language });
        emit({ id: req.id, ok: true, ...r });
      } catch (err) {
        emit({ id: req.id, ok: false, error: err.message, code: err.code || 'VOICE_ENGINE_ERROR' });
      }
    };

    let buf = '';
    let chain = Promise.resolve();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) chain = chain.then(() => onLine(line));
      }
    });
    process.stdin.on('end', () => {
      chain.finally(() => process.exit(0));
    });
    // Si el padre muere, este proceso debe morir también (nada de huérfanos).
    process.on('SIGTERM', () => process.exit(0));
    process.on('SIGINT', () => process.exit(0));
    process.stdin.resume();
    resetIdle();
    // Calienta el modelo de fondo para que la primera petición sea rápida.
    loadPipeline().catch(() => {});
  } else {
    // ---- Modo de un tiro (argv + stdout + salir) ----
    if (!args.wav) {
      emit({ error: 'Falta la ruta del WAV. Uso: node worker.mjs <audio.wav> [--language es]', code: 'BAD_USAGE' });
      process.exit(2);
    }
    transcribeFile(args.wav, { language: args.language })
      .then((r) => {
        emit(r);
        process.exit(0);
      })
      .catch((err) => {
        emit({ error: err.message, code: err.code || 'VOICE_ENGINE_ERROR' });
        process.exit(1);
      });
  }
}
