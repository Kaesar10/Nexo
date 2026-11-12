# Dictado por voz local (Whisper ONNX) — paquete `server/voice`

Motor de **dictado 100 % local en el PC**, en español y **sin nube**, para el modo
alternativo de dictado de Nexo. El móvil graba un WAV y el PC lo transcribe aquí;
nada sale del ordenador y **después de instalar no hace falta internet**.

```
móvil (graba WAV)  ->  puente Nexo  ->  server/src/transcribe.js  ->  server/voice/worker.mjs  ->  Whisper ONNX
```

> El endpoint HTTP (`/api/transcribe`) lo conecta el Lead en `server/src/index.js`.
> Este paquete solo expone la fachada `server/src/transcribe.js`.

---

## Motor elegido

| Pieza | Detalle |
|---|---|
| Runtime | [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) **3.8.1** + `onnxruntime-node` **1.21.0** (una sola copia, deduplicada) |
| Modelo | **`Xenova/whisper-base`** multilingual, export ONNX cuantizado **q8** |
| Tamaño en disco | **76,0 MB** (`models/Xenova/whisper-base/`: encoder 22,1 MB + decoder 51,2 MB + tokenizer 2,4 MB + configs) |
| Idioma | Español (`language: 'es'`); también vale en/fr/de/it/pt/ca/gl/eu… |
| Red | Descarga inicial desde **`hf-mirror.com`** (espejo; si falla reintenta `huggingface.co`). Después, **cero red** |
| Requisitos | Node ≥ 22 en Windows. Sin administrador. ~1 GB de RAM libre durante la transcripción. En disco: **76 MB** de modelo + **~408 MB** de dependencias en `server/voice/node_modules/` |

También se puede instalar `Xenova/whisper-small` (316 MB) si se prefiere algo más
de precisión a costa de velocidad (`-Modelo Xenova/whisper-small`). En las pruebas
con voz de SAPI ambos fallan palabras sueltas; `base` fue más rápido y algo más
fiable con nombres propios ("Nexo"), así que es el valor por defecto.

## Instalación / reinstalación

```powershell
# Normal (idempotente: si ya está, no descarga nada)
.\scripts\instalar-voz.ps1

# Con prueba completa al final (transcribe audio real de SAPI)
.\scripts\instalar-voz.ps1 -Probar

# Forzar de nuevo la descarga del modelo
.\scripts\instalar-voz.ps1 -Force

# Otro modelo
.\scripts\instalar-voz.ps1 -Modelo Xenova/whisper-small
```

El script hace: comprobar Node → `npm install` en `server/voice` (solo si faltan
dependencias) → `node install.mjs` (descarga a `server/voice/models/`) → verificar
`voiceStatus()`. No pide permisos de administrador.

## Uso desde el puente

```js
import { voiceStatus, transcribeWav, readWavInfo } from './src/transcribe.js';

const st = await voiceStatus();
// { available: true, engine: 'whisper-onnx', model: 'Xenova/whisper-base' }

const wav = req.body;                       // Buffer con el WAV del móvil (PCM)
const info = readWavInfo(wav);
// { sampleRate: 22050, channels: 1, bitsPerSample: 16, seconds: 2.61 } | null

const r = await transcribeWav(wav, { language: 'es' });
// { text: 'El código secreto es nexo 7.', language: 'es', seconds: 2.61,
//   engine: 'whisper-onnx', ms: 1099 }
```

### Interfaz congelada

```js
export async function voiceStatus()    // { available, engine, model, reason? }
export async function transcribeWav(buffer, { language = 'es' } = {})
                                       // { text, language, seconds, engine, ms }
export function readWavInfo(buffer)    // { sampleRate, channels, bitsPerSample, seconds } | null
```

### Comportamiento

- **Una transcripción a la vez** (cola FIFO; más de 8 en espera → error `VOICE_BUSY`).
- **Timeout duro de 90 s** por transcripción (`NEXO_VOICE_TIMEOUT_MS` lo cambia).
  Al expirar se mata el worker y la siguiente petición arranca uno limpio.
- **Sin procesos huérfanos**: el hijo cálido muere al cerrarse su stdin (padre
  terminado), tras 5 min inactivo (`NEXO_VOICE_IDLE_MS`) o al expirar un timeout.
- **Arranque en caliente**: el modelo se carga una sola vez por proceso hijo; la
  primera transcripción paga la carga (~1,1 s), las siguientes no.
- **Errores en español con `code` estable**:
  `VOICE_UNAVAILABLE` (motor sin instalar) · `VOICE_TIMEOUT` · `VOICE_BUSY` ·
  `AUDIO_INVALID` (no es WAV PCM, < 0,2 s o > 5 min) · `VOICE_ENGINE_ERROR`.
- Acepta WAV PCM 8/16/24/32 bits y float32, mono o estéreo, cualquier sample rate
  (remuestrea a 16 kHz interno sin dependencias nativas).

## ¿Sin internet de verdad?

Sí, y está demostrado, no "debería":

- `worker.mjs` arranca con `env.allowRemoteModels = false`: si faltase un fichero,
  la librería **lanzaría un error en vez de descargarlo**.
- `selftest.mjs` ejecuta una transcripción con `offline-guard.mjs`, que **envenena
  `fetch`, `net.Socket.prototype.connect` y `tls.connect`** en el proceso del
  motor. La transcripción funciona con la red interceptada.

```powershell
node --import ./offline-guard.mjs worker.mjs fixtures\voz-es-codigo.wav --language es
```

## Prueba de aceptación

```powershell
cd server\voice
node selftest.mjs
```

Genera (o usa) WAV reales de la voz de Windows con `fixtures/generar.ps1`
(`Add-Type System.Speech`, voz es-ES si está instalada) y comprueba estado,
transcripción con palabras esperadas, latencias, modo offline y errores.

### Medidas en este PC (Windows 11, Node 24.21, CPU)

| Medida | whisper-base (q8) | whisper-small (q8) |
|---|---|---|
| Descarga del modelo | 76,0 MB (~3 s) | 316,2 MB (~6 s) |
| Carga del modelo (una vez) | ~1,1–1,3 s | ~1,7–2,2 s |
| Transcripción 2,6 s de voz | ~1,1–2,0 s | ~2,5–3,0 s |
| Transcripción 8,3 s de voz | ~2,0–4,3 s | ~4,3 s |
| Primera llamada completa (carga+transcribe) | ~2,3–2,9 s | ~5,1 s |

Texto obtenido con SAPI/es-ES: `"El código secreto es nexo 7."` (la tarea pedía
que contuviera «NEXO»: ✔), `"Nexo, apunta una reunión con el equipo de Madrid el
jueves a las 5 de la tarde."`, `"Recuérdame comprar pan y llamar al doctor García
antes del viernes."`.

## Ficheros

```
server/voice/
  package.json        deps aisladas (no toca las de server/)
  install.mjs         instala/descarga el modelo (idempotente, --force, --model, --dtype)
  worker.mjs          proceso hijo: --serve (cálido) o un tiro (wav por argv)
  offline-guard.mjs   prueba: bloquea la red dentro del proceso del motor
  selftest.mjs        aceptación: audio real, latencias, offline, errores
  fixtures/           WAV de prueba + generar.ps1 (SAPI)
  models/             modelo descargado (NO se versiona; lo crea install.mjs)
```

## Se instala solo en `server/voice`

`server/voice/node_modules/` es independiente del `server/package.json` del
puente: el motor se puede reinstalar, actualizar o borrar sin tocar la app.
Lo único fuera de esta carpeta es `server/src/transcribe.js` (fachada) y
`scripts/instalar-voz.ps1` (instalador).

## Problemas típicos

| Síntoma | Solución |
|---|---|
| `VOICE_UNAVAILABLE` | Falta el modelo: `.\scripts\instalar-voz.ps1` |
| La descarga falla por red | Reintenta: el script es idempotente. Puedes forzar espejo con `$env:NEXO_VOICE_MIRROR = 'https://hf-mirror.com'` |
| Va lento | Usa `whisper-base` (por defecto) y audios < 30 s. Cierra otras apps que coman CPU |
| Quiero liberar los 76 MB | Borra `server/voice/models/` (la app seguirá funcionando con el dictado nativo del móvil) |
| Quiero un modelo más preciso | `.\scripts\instalar-voz.ps1 -Modelo Xenova/whisper-small` |
