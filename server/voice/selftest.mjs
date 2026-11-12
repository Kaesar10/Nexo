#!/usr/bin/env node
/**
 * selftest.mjs — verificación de aceptación del dictado local.
 *
 * Comprueba, de verdad y con audio real:
 *   1. voiceStatus() / readWavInfo() devuelven la forma congelada.
 *   2. transcripción de dos WAV de voz en español (SAPI de Windows) con las
 *      palabras esperadas.
 *   3. latencia de la primera transcripción (carga del modelo) vs. las siguientes.
 *   4. MODO OFFLINE: transcripción con `fetch` y los sockets de red envenenados
 *      (offline-guard.mjs) -> si funciona, no necesita internet.
 *   5. errores: AUDIO_INVALID y VOICE_UNAVAILABLE (con code estable).
 *
 * Uso:  node selftest.mjs        (desde server/voice)
 * Sale con código 0 si todo pasa; 1 si algo falla.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transcribeWav, voiceStatus, readWavInfo } from '../src/transcribe.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = [
  { file: path.join(HERE, 'fixtures', 'voz-es-codigo.wav'), must: ['nexo'] },
  { file: path.join(HERE, 'fixtures', 'voz-es-larga.wav'), must: ['marta', 'informe', 'trimestral'] },
];

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function norm(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function run(cmd, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: HERE, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
  });
}

async function main() {
  console.log(`\n== Selftest dictado local (Node ${process.version}, ${process.platform}) ==\n`);

  // 1) Estado del motor
  console.log('[1] voiceStatus / readWavInfo');
  const st = await voiceStatus();
  check('voiceStatus.available', st.available === true, JSON.stringify(st));
  check('voiceStatus.engine', st.engine === 'whisper-onnx', st.engine);
  check('voiceStatus.model', typeof st.model === 'string' && st.model.includes('whisper'), st.model);

  const fixtureBuf = fs.readFileSync(FIXTURES[0].file);
  const info = readWavInfo(fixtureBuf);
  check(
    'readWavInfo',
    !!info && info.sampleRate === 22050 && info.channels === 1 && info.bitsPerSample === 16 && info.seconds > 2,
    JSON.stringify(info),
  );
  check('readWavInfo(basura) === null', readWavInfo(Buffer.from('no soy un wav')) === null);

  // 2) Transcripción real con audio SAPI, midiendo frío/caliente
  console.log('\n[2] Transcripción real (WAV de SAPI, voz es-ES)');
  const tCold = Date.now();
  const r1 = await transcribeWav(fixtureBuf, { language: 'es' });
  const coldMs = Date.now() - tCold;
  check(
    'audio 1: contiene "NEXO"',
    FIXTURES[0].must.every((w) => norm(r1.text).includes(w)),
    `"${r1.text}" (${r1.ms} ms)`,
  );
  check('audio 1: forma del retorno', typeof r1.text === 'string' && r1.language === 'es' && r1.seconds > 0 && typeof r1.ms === 'number' && r1.engine === 'whisper-onnx', JSON.stringify({ ...r1, text: '…' }));

  const tWarm = Date.now();
  const r2 = await transcribeWav(fixtureBuf, { language: 'es' });
  const warmMs = Date.now() - tWarm;
  check('audio 1 repetido (caliente) devuelve lo mismo', norm(r2.text) === norm(r1.text), `${r2.ms} ms`);

  const r3 = await transcribeWav(fs.readFileSync(FIXTURES[1].file), { language: 'es' });
  check(
    'audio 2 (8,3 s): palabras esperadas',
    FIXTURES[1].must.every((w) => norm(r3.text).includes(w)),
    `"${r3.text}" (${r3.ms} ms)`,
  );

  console.log(`  INFO  primera transcripción (incluye carga del modelo): ${coldMs} ms`);
  console.log(`  INFO  siguientes transcripciones: ${r2.ms} ms / ${r3.ms} ms`);
  check('transcripción caliente más rápida que la primera', r2.ms < coldMs, `${r2.ms} ms < ${coldMs} ms`);

  // 3) Prueba offline: worker con fetch y sockets envenenados
  console.log('\n[3] Modo offline (fetch y net.Socket.connect bloqueados en el proceso del motor)');
  const offline = await run(process.execPath, [
    '--import',
    pathToFileURL(path.join(HERE, 'offline-guard.mjs')).href,
    path.join(HERE, 'worker.mjs'),
    FIXTURES[0].file,
    '--language',
    'es',
  ]);
  let offlineOk = false;
  let offlineText = '';
  try {
    const j = JSON.parse(offline.out.split('\n').filter(Boolean).pop());
    offlineText = j.text || '';
    offlineOk = offline.code === 0 && norm(offlineText).includes('nexo');
  } catch {
    offlineText = offline.out || offline.err;
  }
  check('transcribe sin red (red envenenada)', offlineOk, `"${offlineText}"`);

  // 4) Errores con code estable
  console.log('\n[4] Errores');
  let audioInvalid = false;
  try {
    await transcribeWav(Buffer.from('basura'), { language: 'es' });
  } catch (e) {
    audioInvalid = e.code === 'AUDIO_INVALID';
  }
  check('audio inválido -> AUDIO_INVALID', audioInvalid);

  const marker = path.join(HERE, 'models', '.installed.json');
  fs.renameSync(marker, `${marker}.selftest-bak`);
  try {
    const off = await voiceStatus();
    let unavailable = false;
    try {
      await transcribeWav(fixtureBuf, { language: 'es' });
    } catch (e) {
      unavailable = e.code === 'VOICE_UNAVAILABLE';
    }
    check('sin motor instalado -> available:false + VOICE_UNAVAILABLE', off.available === false && unavailable, off.reason);
  } finally {
    fs.renameSync(`${marker}.selftest-bak`, marker);
  }

  const st2 = await voiceStatus();
  check('motor recuperado tras restaurar el modelo', st2.available === true);

  console.log(`\n== RESULTADO: ${pass} OK, ${fail} fallos ==\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nFALLO GRAVE en el selftest: ${err?.stack || err}`);
  process.exit(1);
});
