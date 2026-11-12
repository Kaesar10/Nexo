#!/usr/bin/env node
/**
 * Mock del puente DSH — Node puro, sin dependencias.
 *
 * Implementa TODO docs/API.md (REST + SSE con streaming palabra a palabra)
 * y sirve `app/dist` si existe (para probar la PWA instalable sin el PC).
 *
 *   node mock/server.mjs                 # http://127.0.0.1:8791
 *   PORT=8792 node mock/server.mjs       # si 8791 está ocupado
 *   MOCK_RESET=1 node mock/server.mjs    # olvida tokens/proyectos guardados
 *
 * Prueba de errores: envía un mensaje que contenga "error" o "fallo".
 */
import http from 'node:http'
import os from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import {
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, normalize, parse, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(__dirname, '..')
const DIST_DIR = join(APP_ROOT, 'dist')
const DATA_FILE = join(__dirname, 'data.json')

const PORT = Number(process.env.PORT || 8791)
const HOST = process.env.HOST || '127.0.0.1'
const PIN = process.env.PIN || '123456'
const SERVER_VERSION = '1.0.0-mock'
const HEARTBEAT_MS = 20_000

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
}

const ERROR_TEXT =
  'El proveedor rechazó la petición: la credencial DEEPSEEK_API_KEY ha caducado. ' +
  'Vuelve a iniciar sesión en el PC y reinténtalo.'

/* ------------------------------ Modelos --------------------------------- */

const MODELS = [
  { id: 'deepseek-flash', name: 'DeepSeek Flash', hint: 'rápido', isDefault: true },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    hint: 'máximo razonamiento',
    isDefault: false,
  },
]
const MODEL_IDS = new Set(MODELS.map((model) => model.id))
const DEFAULT_MODEL = MODELS.find((model) => model.isDefault)?.id ?? 'deepseek-flash'
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const MAX_BODY_BYTES = 40 * 1024 * 1024
const MAX_AUDIO_BYTES = 20 * 1024 * 1024

const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'md', 'csv', 'json'])
const DOCUMENT_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'text/json',
])

function isAllowedUpload(name, mime) {
  if (mime.toLowerCase().startsWith('image/')) return true
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  return DOCUMENT_EXTENSIONS.has(extension) || DOCUMENT_MIMES.has(mime.toLowerCase())
}

/* ---------------------- Imagen de prueba generada ------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** Degradado ámbar→violeta con un orbe, para ver adjuntos en el historial. */
function createDemoImage() {
  const width = 320
  const height = 200
  const pixels = Buffer.alloc(width * height * 4)
  const centerX = width / 2
  const centerY = height / 2
  const radius = 64
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - centerX
      const dy = y - centerY
      const distance = Math.hypot(dx, dy)
      const t = Math.min(1, distance / radius)
      let r = 12
      let g = 12
      let b = 16
      if (distance < radius) {
        if (t < 0.55) {
          const k = t / 0.55
          r = Math.round(255 * (1 - k) + 232 * k)
          g = Math.round(236 * (1 - k) + 179 * k)
          b = Math.round(210 * (1 - k) + 107 * k)
        } else {
          const k = (t - 0.55) / 0.45
          r = Math.round(232 * (1 - k) + 139 * k)
          g = Math.round(179 * (1 - k) + 124 * k)
          b = Math.round(107 * (1 - k) + 246 * k)
        }
      } else {
        const glow = Math.exp(-Math.pow((distance - radius) / 46, 2)) * 0.35
        r = Math.round(r + glow * 150)
        g = Math.round(g + glow * 110)
        b = Math.round(b + glow * 190)
      }
      const offset = (y * width + x) * 4
      pixels[offset] = Math.min(255, r)
      pixels[offset + 1] = Math.min(255, g)
      pixels[offset + 2] = Math.min(255, b)
      pixels[offset + 3] = 255
    }
  }
  return encodePng(width, height, pixels)
}

const uploads = new Map()

function registerUpload({ id, name, mime, buffer }) {
  const upload = {
    id,
    name,
    mime,
    size: buffer.length,
    buffer,
    url: `/api/attachments/${id}`,
    createdAt: Date.now(),
  }
  uploads.set(id, upload)
  return upload
}

const demoUpload = registerUpload({
  id: 'att_demo',
  name: 'captura-demo.png',
  mime: 'image/png',
  buffer: createDemoImage(),
})

/** Adjunto resuelto tal y como viaja en el histórico. */
function attachmentPayload(upload) {
  return { id: upload.id, name: upload.name, mime: upload.mime, size: upload.size, url: upload.url }
}

/** Línea que el puente real añade al texto del mensaje. */
function attachmentMarker(name) {
  return `[Adjunto: C:\\Users\\demo\\Desktop\\${name}]`
}

function readMessagePayload(body) {
  const text = typeof body.text === 'string' ? body.text.trim() : ''

  let model = null
  if (typeof body.model === 'string' && body.model) {
    if (!MODEL_IDS.has(body.model)) {
      throw new HttpError(400, 'BAD_REQUEST', 'Modelo no válido.')
    }
    model = body.model
  }

  const attachments = []
  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : []
  for (const item of rawAttachments.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue
    const upload = uploads.get(typeof item.id === 'string' ? item.id : '')
    if (upload) attachments.push(attachmentPayload(upload))
  }

  if (!text && attachments.length === 0) {
    throw new HttpError(400, 'BAD_REQUEST', 'El mensaje está vacío.')
  }

  const storedText = [
    text,
    ...attachments.map((attachment) => attachmentMarker(attachment.name)),
  ]
    .filter(Boolean)
    .join('\n')

  return { text, model, attachments, storedText }
}

/* ------------------------------ Utilidades ------------------------------ */

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1))
const latency = () => sleep(rand(70, 280))

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/* ------------------------------- Estado --------------------------------- */

function seedState() {
  const now = Date.now()
  const home = os.homedir()
  const workspaceSeeds = [
    { id: 'ws_demo_nexo', name: 'nexo-app', path: join(home, 'Proyectos', 'nexo-app'), isGit: true },
    { id: 'ws_demo_landing', name: 'landing', path: join(home, 'Proyectos', 'landing'), isGit: false },
    { id: 'ws_demo_api', name: 'api-gateway', path: join(home, 'Desktop', 'api-gateway'), isGit: true },
  ]
  const workspaceAges = [2, 130, 240]

  const chatId = `session-${randomUUID()}`
  const readOnlyChatId = `session-${randomUUID()}`
  const chats = {
    [chatId]: {
      id: chatId,
      workspaceId: workspaceSeeds[0].id,
      title: 'Revisar la estructura del proyecto',
      updatedAt: now - 1000 * 60 * 42,
      model: DEFAULT_MODEL,
      messages: [
        {
          id: 'm_seed_1',
          role: 'user',
          text: '¿Qué te parece la estructura del proyecto?',
          at: now - 1000 * 60 * 60,
        },
        {
          id: 'm_seed_2',
          role: 'assistant',
          text:
            'La base está bien organizada: pocos módulos, nombres claros y la configuración agrupada.\n\n' +
            'Lo que más me chirría es la falta de scripts de desarrollo. Añadiría dos: uno para levantar ' +
            'todo en local y otro para pasar las comprobaciones antes de dar algo por terminado.\n\n' +
            'Si quieres, empiezo por ahí.',
          at: now - 1000 * 60 * 42,
        },
      ],
    },
    // Sesión creada en el escritorio: el móvil puede leerla, no continuarla.
    [readOnlyChatId]: {
      id: readOnlyChatId,
      workspaceId: workspaceSeeds[0].id,
      title: 'Refactor del módulo de auth',
      updatedAt: now - 1000 * 60 * 12,
      adoptable: false,
      omitMessageCount: true,
      model: null,
      messages: [
        {
          id: 'm_seed_ro_1',
          role: 'user',
          text: `Adjunto la captura del error que te comentaba.\n${attachmentMarker(demoUpload.name)}`,
          at: now - 1000 * 60 * 40,
          attachments: [attachmentPayload(demoUpload)],
        },
        {
          id: 'm_seed_ro_2',
          role: 'user',
          text: 'Refactoriza el módulo de auth para separar la validación del transporte.',
          at: now - 1000 * 60 * 30,
        },
        {
          id: 'm_seed_ro_3',
          role: 'assistant',
          text:
            'Hecho desde el escritorio: extraje la validación a un módulo propio y dejé el transporte ' +
            'con una única responsabilidad.\n\n' +
            'Los tests del módulo siguen en verde. Si quieres seguir con esto, ábreme una conversación ' +
            'nueva desde el móvil.',
          at: now - 1000 * 60 * 12,
        },
      ],
    },
  }

  return {
    devices: {},
    workspaces: workspaceSeeds.map((workspace, index) => ({
      ...workspace,
      lastActiveAt: now - 1000 * 60 * workspaceAges[index],
    })),
    chats,
    activity: [
      {
        id: 'act_seed_1',
        chatId,
        title: 'Revisar la estructura del proyecto',
        workspaceName: 'nexo-app',
        status: 'completed',
        durationMs: 18_300,
        tools: ['read', 'pwsh', 'write'],
        model: DEFAULT_MODEL,
        at: now - 1000 * 60 * 14,
      },
      {
        id: 'act_seed_2',
        chatId: readOnlyChatId,
        title: 'Refactor del módulo de auth',
        workspaceName: 'nexo-app',
        status: 'error',
        durationMs: 4200,
        tools: ['read', 'edit'],
        model: null,
        at: now - 1000 * 60 * 55,
      },
      {
        id: 'act_seed_3',
        chatId,
        title: 'Consulta rápida sobre el proyecto',
        workspaceName: 'nexo-app',
        status: 'completed',
        durationMs: 3000,
        tools: [],
        model: 'deepseek-v4-pro',
        at: now - 1000 * 60 * 60 * 5,
      },
    ],
  }
}

function loadState() {
  if (process.env.MOCK_RESET === '1') {
    try {
      unlinkSync(DATA_FILE)
    } catch {
      // no había estado guardado
    }
  }
  try {
    const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8'))
    if (parsed && parsed.devices && parsed.workspaces && parsed.chats) {
      if (!Object.isExtensible(parsed.devices)) parsed.devices = {}
      if (!Array.isArray(parsed.activity)) parsed.activity = []
      return parsed
    }
  } catch {
    // sin estado previo: semilla nueva
  }
  return seedState()
}

const state = loadState()
let saveTimer = null

function persist() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      writeFileSync(DATA_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    } catch (error) {
      console.warn('[mock] no se pudo guardar data.json:', error.message)
    }
  }, 120)
}

/* ------------------------------- HTTP ----------------------------------- */

function addCors(res) {
  for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value)
}

function sendJson(res, status, payload) {
  addCors(res)
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
  })
  res.end(body)
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } })
}

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'BAD_REQUEST', 'El cuerpo de la petición es demasiado grande.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolveBody({})
        return
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new HttpError(400, 'BAD_REQUEST', 'El cuerpo no es JSON válido.'))
      }
    })
    req.on('error', () => reject(new HttpError(400, 'BAD_REQUEST', 'No se pudo leer el cuerpo.')))
  })
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'BAD_REQUEST', `Falta el campo «${field}».`)
  }
  return value.trim()
}

function authenticate(req, url) {
  const header = req.headers.authorization || ''
  let token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
  if (
    !token &&
    (url.pathname === '/api/events' || url.pathname.startsWith('/api/attachments/'))
  ) {
    token = url.searchParams.get('token') || ''
  }
  if (!token) return null
  const device = state.devices[token]
  if (!device) return null
  device.lastSeenAt = Date.now()
  return { token, device }
}

/* ---------------------------- Workspaces -------------------------------- */

function workspacePayload(workspace) {
  const chats = Object.values(state.chats).filter((chat) => chat.workspaceId === workspace.id)
  return {
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    isGit: Boolean(workspace.isGit),
    lastActiveAt: workspace.lastActiveAt,
    chatsCount: chats.length,
  }
}

function findWorkspace(id) {
  return state.workspaces.find((workspace) => workspace.id === id) ?? null
}

function chatSummary(chat) {
  const last = chat.messages[chat.messages.length - 1]
  const preview = last ? last.text.replace(/\s+/g, ' ').slice(0, 160) : ''
  const summary = {
    id: chat.id,
    title: chat.title,
    updatedAt: chat.updatedAt,
    preview,
    adoptable: chat.adoptable !== false,
    model: chat.model ?? null,
  }
  // El puente real omite el contador en proyectos grandes; el mock lo simula
  // en el chat de solo lectura para probar la UI sin él.
  if (!chat.omitMessageCount) summary.messageCount = chat.messages.length
  return summary
}

/* ------------------------- Simulación de turnos ------------------------- */

const activeTurns = new Map()
let turnSeq = 0
let messageSeq = 0
const sseClients = new Set()

function nextTurnId() {
  turnSeq += 1
  return `turn_${turnSeq}`
}

function nextMessageId() {
  messageSeq += 1
  return `m_${Date.now().toString(36)}_${messageSeq}`
}

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const client of sseClients) {
    try {
      const flushed = client.res.write(payload)
      if (process.env.MOCK_DEBUG && event.type === 'turn_end') {
        console.log(
          `[mock] turn_end chat=${event.chatId} write=${flushed} destroyed=${client.res.destroyed} closed=${client.res.writableEnded}`,
        )
      }
    } catch (error) {
      if (process.env.MOCK_DEBUG && event.type === 'turn_end') {
        console.log(`[mock] turn_end write error: ${error.message}`)
      }
      sseClients.delete(client)
    }
  }
}

const TOOL_PRESETS = [
  { name: 'read', label: 'leyendo archivos…' },
  { name: 'search', label: 'buscando en el proyecto…' },
  { name: 'edit', label: 'editando archivos…' },
]

function pickTools(text) {
  const lower = text.toLowerCase()
  if (/(readme|revisa|revisar|lee|leer|estructura|archivo)/.test(lower)) {
    return [TOOL_PRESETS[0], TOOL_PRESETS[1]]
  }
  if (/(arregla|corrige|edita|cambia|implementa|añade|crea)/.test(lower)) {
    return [TOOL_PRESETS[0], TOOL_PRESETS[2]]
  }
  if (/(hola|buenas|qué tal|hey)/.test(lower)) return []
  return [TOOL_PRESETS[0]]
}

function buildTitle(text, attachments = []) {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) {
    if (attachments.length === 1) return `Imagen: ${attachments[0].name}`
    if (attachments.length > 1) return `${attachments.length} imágenes`
    return 'Nueva conversación'
  }
  const clipped = clean.length > 52 ? `${clean.slice(0, 52).trimEnd()}…` : clean
  return clipped.charAt(0).toUpperCase() + clipped.slice(1)
}

function buildReply(text, attachments = []) {
  const lower = text.toLowerCase()
  if (attachments.length > 0) {
    const names = attachments.map((attachment) => `«${attachment.name}»`).join(', ')
    const intro =
      attachments.length === 1
        ? `He recibido la imagen ${names}.`
        : `He recibido ${attachments.length} imágenes: ${names}.`
    const short = text.replace(/\s+/g, ' ').trim().slice(0, 90)
    return (
      `${intro}\n\n` +
      (short
        ? `Sobre lo que me pides («${short}»): puedo tomar la imagen como referencia y trabajar con ` +
          'el proyecto a partir de ahí.'
        : 'Puedo usarla como referencia para lo que necesites.') +
      '\n\nDime si quieres que la analice en detalle o que haga algún cambio en el proyecto.'
    )
  }
  if (/\bpong\b/.test(lower)) return 'PONG'
  if (/(enlace|link|url|documentaci)/i.test(lower)) {
    return (
      'Claro. Aquí tienes la documentación y las novedades del proyecto:\n\n' +
      '[Guía de DeepSeek Harness](https://api-docs.deepseek.com/guides/harness)\n\n' +
      'Novedades: https://api-docs.deepseek.com/news\n\n' +
      'Si quieres, te resumo lo importante en tres puntos.'
    )
  }
  if (/(^|\s)(hola|buenas|hey|qué tal)(\s|$|[.!?])/.test(lower)) {
    return (
      'Hola. Estoy aquí, conectado a tu proyecto.\n\n' +
      'Dime qué quieres que revise o cambie y me pongo con ello. Si prefieres, puedo empezar ' +
      'leyendo el README y proponerte los siguientes pasos.'
    )
  }
  if (/readme/.test(lower)) {
    return (
      'He leído el README del proyecto. Está bien encaminado, pero hay tres cosas que mejorarían ' +
      'bastante la experiencia.\n\n' +
      'Primero, el arranque: conviene dejar en la primera pantalla los pasos mínimos para tener la ' +
      'app corriendo, sin obligar a saltar entre secciones.\n\n' +
      'Segundo, los ejemplos. Un par de casos reales de uso valen más que una lista de comandos, ' +
      'sobre todo para quien llega sin contexto.\n\n' +
      'Tercero, la configuración: mejor explicar qué pasa si falta una variable y cómo comprobarlo ' +
      'en un minuto.\n\n' +
      'Puedo preparar una propuesta de README reescrito si te parece bien.'
    )
  }
  if (/(estructura|proyecto|qué hay|carpeta)/.test(lower)) {
    return (
      'Estoy dentro del proyecto. Antes de tocar nada he revisado la estructura y los archivos ' +
      'principales.\n\n' +
      'Lo que veo: una base pequeña y ordenada, con el grueso del código en unos pocos módulos y ' +
      'poca configuración repartida. Es un buen punto de partida para crecer sin fricción.\n\n' +
      'Si quieres, el siguiente paso más útil sería fijar una convención de nombres y unos scripts ' +
      'de desarrollo claros. Dime si tiro por ahí.'
    )
  }
  const short = text.replace(/\s+/g, ' ').trim().slice(0, 90)
  return (
    `Entendido. Voy a centrarme en esto: «${short}».` +
    '\n\n' +
    'Trabajo directamente sobre el proyecto abierto, así que puedo leer archivos, proponer cambios ' +
    'y dejarlos listos. Cuando termine te cuento el resultado aquí, sin ruido intermedio.' +
    '\n\n' +
    '¿Quieres que lo aborde de una vez o prefieres que primero te proponga el plan?'
  )
}

function finishTurn(turn, status, text = '') {
  if (turn.finished) return
  turn.finished = true
  const chat = state.chats[turn.chatId]
  if (chat) {
    if (status !== 'error' && text) {
      chat.messages.push({
        id: nextMessageId(),
        role: 'assistant',
        text,
        at: Date.now(),
      })
      chat.updatedAt = Date.now()
    }
    const workspace = findWorkspace(chat.workspaceId)
    const entry = {
      id: `act_${randomBytes(3).toString('hex')}`,
      chatId: chat.id,
      title: chat.title,
      workspaceName: workspace ? workspace.name : '',
      status,
      durationMs: Math.max(0, Date.now() - (turn.startedAt ?? Date.now())),
      tools: Array.isArray(turn.tools) ? turn.tools : [],
      model: chat.model ?? null,
      at: Date.now(),
    }
    state.activity = [entry, ...(Array.isArray(state.activity) ? state.activity : [])].slice(
      0,
      100,
    )
    persist()
  }
  if (activeTurns.get(turn.chatId) === turn) activeTurns.delete(turn.chatId)
  broadcast({
    type: 'turn_end',
    chatId: turn.chatId,
    status,
    ...(status === 'error' ? { text } : {}),
  })
}

async function runTurn(turn, userText, attachments = []) {
  const chatId = turn.chatId
  const chat = state.chats[chatId]
  if (!chat) return
  const emit = (event) => {
    if (turn.finished) return
    broadcast({ chatId, ...event })
  }
  const interrupted = () => turn.stopped || turn.finished

  try {
    await sleep(rand(160, 300))
    if (interrupted()) return
    emit({ type: 'turn_start', turnId: turn.turnId })

    await sleep(rand(340, 620))
    if (interrupted()) return
    emit({ type: 'thinking' })

    const tools = pickTools(userText)
    turn.tools = tools.map((tool) => tool.name)
    for (const tool of tools) {
      await sleep(rand(420, 780))
      if (interrupted()) return
      emit({ type: 'tool', tool: tool.name, status: 'start', label: tool.label })
      await sleep(rand(650, 1200))
      if (interrupted()) return
      emit({ type: 'tool', tool: tool.name, status: 'done', label: tool.label })
    }

    const wantsError = /(error|fallo|falla)/i.test(userText)
    if (wantsError) {
      await sleep(rand(500, 900))
      if (interrupted()) return
      finishTurn(turn, 'error', ERROR_TEXT)
      return
    }

    // Palabra clave para probar notificaciones de tareas largas (> 8 s).
    if (/tarea larga/i.test(userText)) {
      await sleep(3500)
      if (interrupted()) return
    }

    const reply = buildReply(userText, attachments)
    const title = buildTitle(userText, attachments)
    chat.title = title
    chat.updatedAt = Date.now()
    const workspace = findWorkspace(chat.workspaceId)
    if (workspace) workspace.lastActiveAt = Date.now()
    emit({ type: 'title', title })
    persist()

    const chunks = reply.match(/\S+\s*/g) ?? [reply]
    let streamed = ''
    for (const chunk of chunks) {
      await sleep(chunk.length > 40 ? rand(40, 70) : rand(26, 48))
      if (interrupted()) return
      streamed += chunk
      emit({ type: 'delta', text: chunk })
    }

    await sleep(rand(240, 420))
    if (interrupted()) return
    finishTurn(turn, 'completed', streamed)
  } catch (error) {
    console.error('[mock] turno roto:', error)
    finishTurn(turn, 'error', `Error interno del mock: ${error.message}`)
  }
}

function startTurn(chatId, userText, turnId, attachments = []) {
  const turn = {
    chatId,
    turnId,
    stopped: false,
    finished: false,
    startedAt: Date.now(),
    tools: [],
  }
  activeTurns.set(chatId, turn)
  setTimeout(() => {
    void runTurn(turn, userText, attachments)
  }, 80)
  return turn
}

/* ----------------------------- Navegador FS ----------------------------- */

async function browsePath(requested) {
  const target = requested && requested.trim() ? resolve(requested.trim()) : os.homedir()

  let info
  try {
    info = await stat(target)
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', `La carpeta no existe en el PC: ${target}`)
  }
  if (!info.isDirectory()) {
    throw new HttpError(400, 'BAD_REQUEST', `No es una carpeta: ${target}`)
  }

  let dirents
  try {
    dirents = await readdir(target, { withFileTypes: true })
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', `No se puede leer la carpeta: ${target}`)
  }

  const entries = dirents
    .filter((entry) => !entry.name.startsWith('.'))
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => ({
      name: entry.name,
      path: join(target, entry.name),
      isDir: entry.isDirectory(),
    }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, 'es'))

  const root = parse(target).root
  return {
    path: target,
    parent: target === root ? null : dirname(target),
    entries,
  }
}

/* ------------------------------ API ------------------------------------- */

async function handleApi(req, res, url, segments) {
  const method = req.method || 'GET'
  const [, resource, first, second] = segments

  if (resource === 'health' && segments.length === 2 && method === 'GET') {
    await sleep(rand(10, 40))
    return sendJson(res, 200, {
      ok: true,
      version: SERVER_VERSION,
      dsh: { ok: true, profile: 'headless' },
    })
  }

  if (resource === 'pair' && segments.length === 2 && method === 'POST') {
    await latency()
    const body = await readJson(req)
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    const deviceName = requireString(body.deviceName, 'deviceName')
    if (code !== PIN) {
      throw new HttpError(401, 'UNAUTHORIZED', 'El código de emparejamiento no es correcto.')
    }
    const token = randomBytes(32).toString('hex')
    const device = {
      id: `dev_${randomBytes(2).toString('hex')}`,
      name: deviceName,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    }
    state.devices[token] = device
    persist()
    console.log(`[mock] emparejado «${device.name}» (${device.id})`)
    return sendJson(res, 200, { token, deviceId: device.id, deviceName: device.name })
  }

  // A partir de aquí todo requiere token.
  const auth = authenticate(req, url)
  if (!auth) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Token de dispositivo no válido o ausente.')
  }

  if (resource === 'me' && segments.length === 2 && method === 'GET') {
    await latency()
    return sendJson(res, 200, {
      deviceId: auth.device.id,
      deviceName: auth.device.name,
      serverVersion: SERVER_VERSION,
    })
  }

  if (resource === 'models' && segments.length === 2 && method === 'GET') {
    await latency()
    return sendJson(res, 200, { models: MODELS })
  }

  if (resource === 'activity' && segments.length === 2 && method === 'GET') {
    await latency()
    const rawLimit = Number(url.searchParams.get('limit') ?? '30')
    const limit = Number.isFinite(rawLimit)
      ? Math.min(100, Math.max(1, Math.floor(rawLimit)))
      : 30
    const activity = [...(Array.isArray(state.activity) ? state.activity : [])]
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
    return sendJson(res, 200, { activity })
  }

  if (resource === 'voice-status' && segments.length === 2 && method === 'GET') {
    await latency()
    if (process.env.MOCK_VOICE_UNAVAILABLE === '1') {
      return sendJson(res, 200, {
        available: false,
        engine: null,
        model: null,
        reason: 'whisper.cpp no está instalado en el PC',
      })
    }
    return sendJson(res, 200, {
      available: true,
      engine: 'whisper.cpp',
      model: 'small',
      reason: null,
    })
  }

  if (resource === 'transcribe' && segments.length === 2 && method === 'POST') {
    await latency()
    if (process.env.MOCK_VOICE_UNAVAILABLE === '1') {
      throw new HttpError(
        503,
        'VOICE_UNAVAILABLE',
        'El dictado en el PC no está disponible en este puente.',
      )
    }
    const body = await readJson(req)
    const audio = typeof body.audio === 'string' ? body.audio : ''
    if (!audio) throw new HttpError(400, 'BAD_REQUEST', 'Falta el audio.')
    const buffer = Buffer.from(audio, 'base64')
    if (buffer.length < 44 || buffer.subarray(0, 4).toString('ascii') !== 'RIFF') {
      throw new HttpError(400, 'BAD_REQUEST', 'El audio debe ser un WAV PCM.')
    }
    if (buffer.length > MAX_AUDIO_BYTES) {
      throw new HttpError(400, 'BAD_REQUEST', 'El audio es demasiado largo.')
    }
    return sendJson(res, 200, { text: 'Texto transcrito de prueba desde el PC.' })
  }

  if (resource === 'uploads' && segments.length === 2 && method === 'POST') {
    await latency()
    const body = await readJson(req)
    if (typeof body.workspaceId !== 'string' || body.workspaceId.trim() === '') {
      throw new HttpError(
        400,
        'BAD_REQUEST',
        'Falta workspaceId: la imagen debe subirse dentro de un proyecto.',
      )
    }
    const workspace = findWorkspace(body.workspaceId.trim())
    if (!workspace) throw new HttpError(404, 'NOT_FOUND', 'Ese proyecto no existe.')
    const name = requireString(body.name, 'name')
    const mime = requireString(body.mime, 'mime')
    if (!isAllowedUpload(name, mime)) {
      throw new HttpError(
        400,
        'BAD_REQUEST',
        'Formato no compatible. Se admiten imágenes, PDF, DOC/DOCX, XLS/XLSX, TXT, MD, CSV y JSON.',
      )
    }
    if (typeof body.data !== 'string' || body.data === '') {
      throw new HttpError(400, 'BAD_REQUEST', 'Falta el contenido del archivo.')
    }
    const buffer = Buffer.from(body.data, 'base64')
    if (buffer.length === 0) {
      throw new HttpError(400, 'BAD_REQUEST', 'El archivo está vacío.')
    }
    if (buffer.length > MAX_UPLOAD_BYTES) {
      throw new HttpError(400, 'BAD_REQUEST', 'El archivo supera el máximo de 25 MB.')
    }
    const upload = registerUpload({
      id: `att_${randomBytes(3).toString('hex')}`,
      name,
      mime,
      buffer,
    })
    return sendJson(res, 201, {
      id: upload.id,
      name: upload.name,
      mime: upload.mime,
      size: upload.size,
      url: upload.url,
    })
  }

  if (resource === 'attachments' && segments.length === 3 && method === 'GET') {
    const upload = uploads.get(first)
    if (!upload) throw new HttpError(404, 'NOT_FOUND', 'Ese adjunto no existe.')
    addCors(res)
    res.writeHead(200, {
      'Content-Type': upload.mime,
      'Content-Length': upload.size,
      'Cache-Control': 'private, max-age=31536000, immutable',
      ...CORS_HEADERS,
    })
    res.end(upload.buffer)
    return
  }

  if (resource === 'workspaces') {
    if (segments.length === 2 && method === 'GET') {
      await latency()
      const workspaces = [...state.workspaces]
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .map(workspacePayload)
      return sendJson(res, 200, { workspaces })
    }

    if (segments.length === 2 && method === 'POST') {
      await latency()
      const body = await readJson(req)
      const workspacePath = requireString(body.path, 'path')
      const absolute = resolve(workspacePath)
      let info
      try {
        info = statSync(absolute)
      } catch {
        throw new HttpError(400, 'BAD_REQUEST', `La carpeta no existe en el PC: ${absolute}`)
      }
      if (!info.isDirectory()) {
        throw new HttpError(400, 'BAD_REQUEST', `No es una carpeta: ${absolute}`)
      }
      if (state.workspaces.some((workspace) => resolve(workspace.path) === absolute)) {
        throw new HttpError(409, 'CONFLICT', 'Ese proyecto ya está en la lista.')
      }
      const name =
        typeof body.name === 'string' && body.name.trim() ? body.name.trim() : basename(absolute)
      const workspace = {
        id: `ws_${randomBytes(3).toString('hex')}`,
        name,
        path: absolute,
        isGit: existsSync(join(absolute, '.git')),
        lastActiveAt: Date.now(),
      }
      state.workspaces.push(workspace)
      persist()
      return sendJson(res, 201, { workspace: workspacePayload(workspace) })
    }

    if (segments.length === 3 && method === 'DELETE') {
      await latency()
      const workspace = findWorkspace(first)
      if (!workspace) throw new HttpError(404, 'NOT_FOUND', 'Ese proyecto no existe.')
      state.workspaces = state.workspaces.filter((item) => item.id !== workspace.id)
      for (const [chatId, chat] of Object.entries(state.chats)) {
        if (chat.workspaceId === workspace.id) delete state.chats[chatId]
      }
      persist()
      return sendJson(res, 200, { ok: true })
    }

    if (segments.length === 4 && first && second === 'chats' && method === 'GET') {
      await latency()
      const workspace = findWorkspace(first)
      if (!workspace) throw new HttpError(404, 'NOT_FOUND', 'Ese proyecto no existe.')
      const chats = Object.values(state.chats)
        .filter((chat) => chat.workspaceId === workspace.id)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(chatSummary)
      return sendJson(res, 200, { chats })
    }

    if (segments.length === 4 && first && second === 'messages' && method === 'POST') {
      await latency()
      const workspace = findWorkspace(first)
      if (!workspace) throw new HttpError(404, 'NOT_FOUND', 'Ese proyecto no existe.')
      const payload = readMessagePayload(await readJson(req))

      const chatId = `session-${randomUUID()}`
      const chat = {
        id: chatId,
        workspaceId: workspace.id,
        title: buildTitle(payload.text, payload.attachments),
        model: payload.model ?? DEFAULT_MODEL,
        updatedAt: Date.now(),
        messages: [
          {
            id: nextMessageId(),
            role: 'user',
            text: payload.storedText,
            at: Date.now(),
            attachments: payload.attachments,
          },
        ],
      }
      state.chats[chatId] = chat
      workspace.lastActiveAt = Date.now()
      persist()

      const turnId = nextTurnId()
      sendJson(res, 200, { chatId, turnId })
      startTurn(chatId, payload.text, turnId, payload.attachments)
      return
    }
  }

  if (resource === 'browse' && segments.length === 2 && method === 'GET') {
    await latency()
    const result = await browsePath(url.searchParams.get('path') ?? '')
    return sendJson(res, 200, result)
  }

  if (resource === 'chats' && segments.length >= 3) {
    const chatId = first
    const chat = chatId ? state.chats[chatId] : undefined

    if (segments.length === 3 && method === 'GET') {
      await latency()
      if (!chat) throw new HttpError(404, 'NOT_FOUND', 'Ese chat no existe.')
      const workspace = findWorkspace(chat.workspaceId)
      return sendJson(res, 200, {
        id: chat.id,
        title: chat.title,
        workspaceId: chat.workspaceId,
        workspacePath: workspace ? workspace.path : '',
        messages: chat.messages,
        adoptable: chat.adoptable !== false,
        model: chat.model ?? null,
      })
    }

    if (segments.length === 4 && second === 'messages' && method === 'POST') {
      await latency()
      if (!chat) throw new HttpError(404, 'NOT_FOUND', 'Ese chat no existe.')
      if (chat.adoptable === false) {
        throw new HttpError(
          409,
          'CONFLICT',
          'Esta conversación se creó en el escritorio y no se puede continuar desde aquí.',
        )
      }
      if (activeTurns.has(chat.id)) {
        throw new HttpError(409, 'CONFLICT', 'Ya hay un turno en marcha en este chat.')
      }
      const payload = readMessagePayload(await readJson(req))
      if (payload.model) chat.model = payload.model
      chat.messages.push({
        id: nextMessageId(),
        role: 'user',
        text: payload.storedText,
        at: Date.now(),
        attachments: payload.attachments,
      })
      chat.updatedAt = Date.now()
      const workspace = findWorkspace(chat.workspaceId)
      if (workspace) workspace.lastActiveAt = Date.now()
      persist()
      const turnId = nextTurnId()
      sendJson(res, 200, { chatId: chat.id, turnId })
      startTurn(chat.id, payload.text, turnId, payload.attachments)
      return
    }

    if (segments.length === 4 && second === 'stop' && method === 'POST') {
      await latency()
      if (!chat) throw new HttpError(404, 'NOT_FOUND', 'Ese chat no existe.')
      const turn = activeTurns.get(chat.id)
      if (turn) {
        turn.stopped = true
        finishTurn(turn, 'aborted')
      }
      return sendJson(res, 200, { ok: true })
    }
  }

  if (resource === 'events' && segments.length === 2 && method === 'GET') {
    return openEventStream(req, res)
  }

  throw new HttpError(404, 'NOT_FOUND', `Ruta no encontrada: ${url.pathname}`)
}

/* ------------------------------- SSE ------------------------------------ */

function openEventStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...CORS_HEADERS,
  })
  res.write(': conectado\n\n')
  res.write(`data: ${JSON.stringify({ type: 'hello', serverVersion: SERVER_VERSION })}\n\n`)

  const client = { res }
  sseClients.add(client)
  console.log(`[mock] SSE conectado (${sseClients.size} cliente/s)`)

  req.on('close', () => {
    sseClients.delete(client)
    console.log(`[mock] SSE desconectado (${sseClients.size} cliente/s)`)
  })
}

setInterval(() => {
  for (const client of sseClients) {
    try {
      client.res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`)
    } catch {
      sseClients.delete(client)
    }
  }
}, HEARTBEAT_MS).unref()

/* ------------------------------ Estático -------------------------------- */

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function noBuildPage() {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0a0a0c">
<title>Nexo · mock sin build</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0c;color:#f2f0ed;
    font-family:ui-sans-serif,system-ui,sans-serif;padding:24px}
  main{max-width:520px}
  h1{font-size:26px;letter-spacing:-.03em;margin:0 0 8px}
  p{color:#a3a1a9;line-height:1.6}
  code{font-family:ui-monospace,Consolas,monospace;background:rgba(255,255,255,.06);
    border:1px solid rgba(255,255,255,.08);border-radius:6px;padding:2px 6px;font-size:13px}
  ul{color:#a3a1a9;line-height:1.9}
  a{color:#e8b36b}
</style></head>
<body><main>
  <h1>Mock del puente DSH</h1>
  <p>La API está viva en este puerto, pero todavía no hay build de la app en
  <code>app/dist</code>. Construye la PWA y recarga:</p>
  <p><code>cd app &amp;&amp; npm install &amp;&amp; npm run build</code></p>
  <p>Endpoints útiles:</p>
  <ul>
    <li><a href="/api/health">/api/health</a> (sin token)</li>
    <li><code>GET /api/workspaces</code> (con Bearer token)</li>
    <li><code>GET /api/events?token=…</code> (SSE)</li>
  </ul>
  <p>PIN de emparejamiento por defecto: <code>123456</code></p>
</main></body></html>`
}

async function serveStatic(req, res, url) {
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Ruta no válida')
    return
  }

  if (!existsSync(DIST_DIR)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(noBuildPage())
    return
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const candidate = normalize(join(DIST_DIR, relative))
  if (candidate !== DIST_DIR && !candidate.startsWith(DIST_DIR + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Prohibido')
    return
  }

  let filePath = candidate
  try {
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('no es un archivo')
  } catch {
    if (!extname(relative)) {
      filePath = join(DIST_DIR, 'index.html')
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Recurso no encontrado')
      return
    }
  }

  try {
    const body = await readFile(filePath)
    const extension = extname(filePath).toLowerCase()
    const immutable = relative.startsWith('assets/')
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extension] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Recurso no encontrado')
  }
}

/* ------------------------------ Servidor -------------------------------- */

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET'
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (method === 'OPTIONS') {
    addCors(res)
    res.writeHead(204)
    res.end()
    return
  }

  const segments = url.pathname.split('/').filter(Boolean)

  if (segments[0] !== 'api') {
    if (method === 'GET' || method === 'HEAD') {
      await serveStatic(req, res, url)
      return
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Método no permitido')
    return
  }

  try {
    await handleApi(req, res, url, segments)
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.status, error.code, error.message)
    } else {
      console.error('[mock] error inesperado:', error)
      sendError(res, 500, 'INTERNAL', 'Error interno del mock.')
    }
  }
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `[mock] El puerto ${PORT} está ocupado. Prueba con otro:\n` +
        `  $env:PORT=8792; node mock/server.mjs\n` +
        `y arranca Vite con VITE_API_PROXY=http://127.0.0.1:8792`,
    )
  } else {
    console.error('[mock] error del servidor:', error)
  }
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  const distReady = existsSync(join(DIST_DIR, 'index.html'))
  console.log('')
  console.log('  ┌─────────────────────────────────────────────────┐')
  console.log('  │  Nexo · mock del puente DSH                     │')
  console.log('  └─────────────────────────────────────────────────┘')
  console.log(`   URL:      http://${HOST}:${PORT}`)
  console.log(`   PIN:      ${PIN}`)
  console.log(`   Build:    ${distReady ? 'app/dist encontrado (PWA servida)' : 'sin build todavía (npm run build)'}`)
  console.log(`   SSE:      GET /api/events?token=<token>`)
  console.log(`   Estado:   ${DATA_FILE}${process.env.MOCK_RESET === '1' ? ' (reiniciado)' : ''}`)
  console.log('')
  console.log('   Truco: un mensaje con "error" simula un turno fallido.')
  console.log('')
})

function shutdown() {
  console.log('\n[mock] cerrando…')
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
    try {
      writeFileSync(DATA_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    } catch {
      // sin persistencia final
    }
  }
  for (const client of sseClients) {
    try {
      client.res.end()
    } catch {
      // ya cerrado
    }
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
