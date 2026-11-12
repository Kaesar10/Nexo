/**
 * Dictado por voz con dos capas:
 * - APK: plugin nativo `@capacitor-community/speech-recognition`, accesible en
 *   `window.Capacitor.Plugins.SpeechRecognition` (sin importarlo aquí).
 * - Web: `SpeechRecognition` / `webkitSpeechRecognition` del navegador.
 *
 * El texto se inserta en el compositor; nunca se envía solo.
 */
import { api, errorText } from '../api'
import { isNativeShell } from './server'

export type SpeechKind = 'native' | 'web' | 'pc'

export interface SpeechCallbacks {
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  onError: (message: string) => void
  onEnd: () => void
  /** Solo motor del PC: la grabación terminó y se está transcribiendo. */
  onTranscribing?: () => void
}

export interface SpeechSession {
  readonly kind: SpeechKind
  start: () => Promise<void>
  stop: () => void
}

/* --------------------------- Plugin nativo ------------------------------ */

interface NativeSpeechPlugin {
  available?: () => Promise<unknown> | unknown
  requestPermissions?: () => Promise<unknown> | unknown
  start?: (options: Record<string, unknown>) => Promise<void> | void
  stop?: () => Promise<void> | void
  getPartialResults?: () => Promise<unknown> | unknown
  addListener?: (eventName: string, listener: (data: unknown) => void) => unknown
}

function nativePlugin(): NativeSpeechPlugin | null {
  const plugins = window.Capacitor?.Plugins
  if (!plugins || typeof plugins !== 'object') return null
  const plugin = (plugins as Record<string, unknown>)['SpeechRecognition']
  return plugin && typeof plugin === 'object' ? (plugin as NativeSpeechPlugin) : null
}

function readRecord(data: unknown): Record<string, unknown> | null {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : null
}

function readMatches(data: unknown): string[] {
  const record = readRecord(data)
  const matches = record?.['matches']
  if (!Array.isArray(matches)) return []
  return matches.filter((match): match is string => typeof match === 'string')
}

function readPermission(data: unknown): string | null {
  const record = readRecord(data)
  const status = record?.['speechRecognition']
  return typeof status === 'string' ? status : null
}

function readListeningState(data: unknown): string | null {
  const record = readRecord(data)
  for (const key of ['state', 'status', 'listeningState']) {
    const value = record?.[key]
    if (typeof value === 'string') return value
  }
  return null
}

/* ---------------------------- Speech web -------------------------------- */

interface WebSpeechAlternative {
  transcript: string
}

interface WebSpeechResult {
  readonly isFinal: boolean
  readonly length: number
  readonly [index: number]: WebSpeechAlternative
}

interface WebSpeechResultList {
  readonly length: number
  readonly [index: number]: WebSpeechResult
}

interface WebSpeechResultEvent {
  readonly resultIndex: number
  readonly results: WebSpeechResultList
}

interface WebSpeechErrorEvent {
  readonly error?: string
}

interface WebSpeechRecognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  maxAlternatives: number
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((event: WebSpeechResultEvent) => void) | null
  onerror: ((event: WebSpeechErrorEvent) => void) | null
  onend: (() => void) | null
}

type WebSpeechCtor = new () => WebSpeechRecognition

function webSpeechCtor(): WebSpeechCtor | null {
  const scope = window as unknown as {
    SpeechRecognition?: WebSpeechCtor
    webkitSpeechRecognition?: WebSpeechCtor
  }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

function speechErrorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Permiso de micrófono denegado. Actívalo en los ajustes del dispositivo.'
    case 'no-speech':
      return 'No se ha detectado voz. Prueba otra vez.'
    case 'audio-capture':
      return 'No se encontró ningún micrófono.'
    case 'network':
      return 'El dictado necesita conexión.'
    case 'language-not-supported':
      return 'El idioma del dictado no está disponible.'
    default:
      return 'No se pudo dictar. Prueba otra vez.'
  }
}

function createWebSession(Ctor: WebSpeechCtor, callbacks: SpeechCallbacks): SpeechSession {
  const recognition = new Ctor()
  let latest = ''
  let ended = false

  const finish = () => {
    if (ended) return
    ended = true
    callbacks.onFinal(latest.trim())
    callbacks.onEnd()
  }

  recognition.lang = 'es-ES'
  recognition.interimResults = true
  recognition.continuous = false
  recognition.maxAlternatives = 1

  recognition.onresult = (event) => {
    let text = ''
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const alternative = event.results[index]?.[0]
      if (alternative?.transcript) text += `${alternative.transcript} `
    }
    const clean = text.trim()
    if (!clean) return
    latest = clean
    callbacks.onPartial(clean)
  }

  recognition.onerror = (event) => {
    const code = event.error ?? ''
    if (code === 'aborted') return
    callbacks.onError(speechErrorMessage(code))
  }

  recognition.onend = finish

  return {
    kind: 'web',
    async start() {
      recognition.start()
    },
    stop() {
      try {
        recognition.stop()
      } catch {
        finish()
      }
      // Red de seguridad por si el motor no dispara onend.
      window.setTimeout(finish, 1500)
    },
  }
}

/* --------------------------- Sesión nativa ------------------------------ */

function createNativeSession(
  plugin: NativeSpeechPlugin,
  callbacks: SpeechCallbacks,
): SpeechSession {
  let latest = ''
  let ended = false
  let pollTimer: number | null = null
  let hasPartialListener = false

  const finish = () => {
    if (ended) return
    ended = true
    if (pollTimer !== null) {
      window.clearInterval(pollTimer)
      pollTimer = null
    }
    callbacks.onFinal(latest.trim())
    callbacks.onEnd()
  }

  const applyMatches = (data: unknown) => {
    const matches = readMatches(data)
    const candidate = matches[matches.length - 1]
    if (!candidate) return
    latest = candidate
    callbacks.onPartial(candidate)
  }

  return {
    kind: 'native',
    async start() {
      if (typeof plugin.requestPermissions === 'function') {
        const permissions = await plugin.requestPermissions()
        const status = readPermission(permissions)
        if (status && status !== 'granted') {
          throw new Error('Permiso de micrófono denegado. Actívalo en los ajustes del dispositivo.')
        }
      }

      if (typeof plugin.addListener === 'function') {
        try {
          const partialListener = plugin.addListener('partialResults', applyMatches)
          hasPartialListener = Boolean(partialListener)
          plugin.addListener('listeningState', (data) => {
            if (readListeningState(data) === 'stopped') finish()
          })
        } catch {
          // Plugin sin eventos: se usa sondeo de getPartialResults.
        }
      }

      await plugin.start?.({ language: 'es-ES', partialResults: true, popup: false })

      if (!hasPartialListener && typeof plugin.getPartialResults === 'function') {
        pollTimer = window.setInterval(() => {
          void Promise.resolve(plugin.getPartialResults?.())
            .then(applyMatches)
            .catch(() => {})
        }, 600)
      }
    },
    stop() {
      try {
        void plugin.stop?.()
      } catch {
        // el plugin puede no tener stop disponible
      }
      finish()
    },
  }
}

/** Devuelve el backend disponible o null si no hay dictado. */
export async function detectSpeech(): Promise<SpeechKind | null> {
  if (isNativeShell()) {
    const plugin = nativePlugin()
    if (!plugin) return null
    try {
      if (typeof plugin.available === 'function') {
        const result = await plugin.available()
        if (typeof result === 'boolean') return result ? 'native' : null
        const record = readRecord(result)
        if (record?.['available'] === false) return null
      }
      return 'native'
    } catch {
      return null
    }
  }
  return webSpeechCtor() ? 'web' : null
}

export function createSpeechSession(callbacks: SpeechCallbacks): SpeechSession {
  const native = isNativeShell() ? nativePlugin() : null
  if (native) return createNativeSession(native, callbacks)
  const Ctor = webSpeechCtor()
  if (!Ctor) throw new Error('El dictado no está disponible en este dispositivo.')
  return createWebSession(Ctor, callbacks)
}

/* --------------------- Motor "En el PC": WAV 16 kHz --------------------- */

function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
  return candidates.find((type) => MediaRecorder.isTypeSupported(type))
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index))
  }
}

/** Mezcla a mono, remuestrea a 16 kHz y devuelve un WAV PCM 16-bit. */
export function encodeWavMono16k(
  channels: Float32Array[],
  sampleRate: number,
  targetRate = 16000,
): ArrayBuffer {
  const sampleCount = channels[0]?.length ?? 0
  const ratio = Math.max(1, sampleRate / targetRate)
  const length = Math.max(1, Math.floor(sampleCount / ratio))
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + length * 2, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, targetRate, true)
  view.setUint32(28, targetRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, length * 2, true)

  const channelCount = channels.length || 1
  for (let index = 0; index < length; index += 1) {
    const sourceIndex = Math.min(sampleCount - 1, Math.floor(index * ratio))
    let sum = 0
    for (const channel of channels) sum += channel[sourceIndex] ?? 0
    const sample = Math.max(-1, Math.min(1, sum / channelCount))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return buffer
}

async function decodeToChannels(blob: Blob): Promise<{
  channels: Float32Array[]
  sampleRate: number
}> {
  const arrayBuffer = await blob.arrayBuffer()
  const scope = window as unknown as {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }
  const Context = scope.AudioContext ?? scope.webkitAudioContext
  if (!Context) throw new Error('Este dispositivo no puede procesar audio.')
  const context = new Context()
  try {
    const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0))
    const channels: Float32Array[] = []
    for (let index = 0; index < audioBuffer.numberOfChannels; index += 1) {
      channels.push(audioBuffer.getChannelData(index).slice())
    }
    return { channels, sampleRate: audioBuffer.sampleRate }
  } catch {
    throw new Error('No se pudo procesar el audio. Prueba a dictar de nuevo.')
  } finally {
    void context.close()
  }
}

function wavToBase64(buffer: ArrayBuffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(new Error('No se pudo preparar el audio.'))
    reader.readAsDataURL(new Blob([buffer], { type: 'audio/wav' }))
  })
}

/**
 * Graba con getUserMedia + MediaRecorder y, al parar, decodifica con
 * AudioContext y envía WAV mono 16 kHz a POST /api/transcribe.
 */
export function createPcSpeechSession(
  callbacks: SpeechCallbacks,
  language = 'es',
): SpeechSession {
  let stream: MediaStream | null = null
  let recorder: MediaRecorder | null = null
  let chunks: Blob[] = []
  let finished = false
  let stopping = false

  const cleanup = () => {
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
    recorder = null
  }

  const fail = (message: string) => {
    if (finished) return
    finished = true
    cleanup()
    callbacks.onError(message)
    callbacks.onEnd()
  }

  const finish = (text: string) => {
    if (finished) return
    finished = true
    cleanup()
    callbacks.onFinal(text)
    callbacks.onEnd()
  }

  const transcribe = async (blob: Blob) => {
    try {
      callbacks.onTranscribing?.()
      const { channels, sampleRate } = await decodeToChannels(blob)
      if (channels.length === 0 || channels[0].length === 0) {
        throw new Error('No se grabó audio.')
      }
      const wav = encodeWavMono16k(channels, sampleRate)
      const base64 = await wavToBase64(wav)
      const result = await api.transcribe(base64, language)
      finish((result.text ?? '').trim())
    } catch (error) {
      fail(errorText(error))
    }
  }

  return {
    kind: 'pc',
    async start() {
      if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('Este dispositivo no puede grabar audio.')
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        })
      } catch {
        throw new Error('Permiso de micrófono denegado. Actívalo en los ajustes del dispositivo.')
      }
      chunks = []
      const mimeType = pickRecorderMime()
      try {
        recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      } catch {
        cleanup()
        throw new Error('Este dispositivo no puede grabar audio.')
      }
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      }
      recorder.onerror = () => fail('La grabación falló. Prueba otra vez.')
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' })
        void transcribe(blob)
      }
      recorder.start(250)
    },
    stop() {
      if (stopping || finished) return
      stopping = true
      const active = recorder
      if (!active || active.state === 'inactive') {
        fail('No se grabó audio.')
        return
      }
      try {
        active.stop()
      } catch {
        fail('No se pudo detener la grabación.')
      }
    },
  }
}
