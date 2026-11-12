#!/usr/bin/env node
/**
 * Smoke test del mock del puente: recorre el contrato de docs/API.md
 * (REST + SSE con streaming) y falla con código 1 si algo no cuadra.
 *
 *   node mock/server.mjs          # terminal 1
 *   node mock/smoke.mjs           # terminal 2  (o npm run smoke)
 *   node mock/smoke.mjs http://127.0.0.1:8790
 */
import http from 'node:http'
import https from 'node:https'

const base = (process.argv[2] || process.env.MOCK_URL || 'http://127.0.0.1:8791').replace(
  /\/+$/,
  '',
)
const PIN = process.env.PIN || '123456'

let token = ''
let passed = 0
let failed = 0
let firstWorkspace = null
let uploadedId = ''
let uploadedDocId = ''
const createdWorkspaceIds = []

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function ok(name, detail = '') {
  passed += 1
  console.log(`  ✓ ${name}${detail ? `  — ${detail}` : ''}`)
}

function fail(name, error) {
  failed += 1
  console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : error}`)
  if (process.env.SMOKE_DEBUG) {
    console.log(`[FAIL] ${name}`)
  }
}

async function check(name, run) {
  if (process.env.SMOKE_DEBUG) console.log(`[test] ${name}`)
  try {
    const detail = await run()
    ok(name, typeof detail === 'string' ? detail : '')
  } catch (error) {
    fail(name, error)
  }
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra }
}

async function api(path, options = {}) {
  const headers = authHeaders({ ...(options.body ? { 'Content-Type': 'application/json' } : {}) })
  const response = await fetch(`${base}${path}`, { ...options, headers })
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  return { response, body, text }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/* --------------------------------- SSE ---------------------------------- */

/** SSE con node:http. El consumo es por sondeo del buffer (sin waiters),
 *  que es mucho más robusto para el test que coordinar promesas. */
function openSse() {
  const url = new URL(`${base}/api/events?token=${encodeURIComponent(token)}`)
  const transport = url.protocol === 'https:' ? https : http
  const queue = []
  let closed = false

  const next = async (predicate, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const index = queue.findIndex(predicate)
      if (index >= 0) return queue.splice(index, 1)[0]
      if (closed) throw new Error('SSE cerrado antes de recibir el evento esperado')
      if (Date.now() > deadline) throw new Error('Timeout esperando un evento SSE')
      await sleep(20)
    }
  }

  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: 'GET',
        agent: false,
        headers: { Accept: 'text/event-stream', Connection: 'close' },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`SSE respondió ${response.statusCode}`))
          return
        }
        const contentType = String(response.headers['content-type'] || '')
        if (!contentType.includes('text/event-stream')) {
          response.resume()
          reject(new Error('SSE sin content-type text/event-stream'))
          return
        }

        const decoder = new TextDecoder()
        let buffer = ''
        response.on('data', (chunk) => {
          if (process.env.SMOKE_DEBUG) console.log('[sse] chunk', chunk.length)
          buffer += decoder.decode(chunk, { stream: true })
          let index = buffer.indexOf('\n\n')
          while (index >= 0) {
            const raw = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            const data = raw
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('\n')
            if (data) {
              try {
                const parsed = JSON.parse(data)
                if (process.env.SMOKE_DEBUG) console.log('[sse] event', parsed.type, parsed.status ?? '')
                queue.push(parsed)
              } catch {
                // evento no JSON: ignorar
              }
            }
            index = buffer.indexOf('\n\n')
          }
        })

        const markClosed = () => {
          closed = true
        }
        response.on('end', markClosed)
        response.on('error', markClosed)
        request.on('error', markClosed)

        const close = () => {
          closed = true
          response.destroy()
          request.destroy()
        }

        next((event) => event.type === 'hello', 5000)
          .then(() => resolve({ next, close }))
          .catch((error) => {
            close()
            reject(new Error(`SSE abierto pero no llegó hello: ${error.message}`))
          })
      },
    )

    request.on('error', (error) => {
      if (!closed) reject(error)
    })
    request.end()
  })
}

async function collectTurn(sse, chatId, timeoutMs = 45000) {
  const events = []
  let text = ''
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = deadline - Date.now()
    assert(remaining > 0, `El turno no terminó a tiempo (eventos: ${events.map((event) => event.type).join(', ') || 'ninguno'})`)
    let event
    try {
      event = await sse.next(
        (candidate) => candidate.chatId === chatId && candidate.type !== 'heartbeat',
        remaining,
      )
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} · chat=${chatId} · recibidos: ${
          events.map((item) => item.type).join(', ') || 'ninguno'
        }`,
      )
    }
    events.push(event)
    if (event.type === 'delta') text += event.text
    if (event.type === 'turn_end') return { events, text, end: event }
  }
}

async function postNewChat(workspaceId, text) {
  return postNewChatPayload(workspaceId, { text })
}

async function postNewChatPayload(workspaceId, payload) {
  const { response, body } = await api(`/api/workspaces/${workspaceId}/messages`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  assert(response.status === 200, `POST mensaje nuevo → ${response.status}`)
  assert(typeof body?.chatId === 'string' && body.chatId.startsWith('session-'), 'chatId inválido')
  assert(typeof body?.turnId === 'string', 'turnId inválido')
  return body
}

async function continueChat(chatId, text) {
  const { response, body } = await api(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
  assert(response.status === 200, `POST continuar → ${response.status}`)
  return body
}

/* ------------------------------- Pruebas -------------------------------- */

console.log(`\nSmoke test del mock en ${base}\n`)

await check('GET /api/health (sin token)', async () => {
  const response = await fetch(`${base}/api/health`)
  assert(response.status === 200, `status ${response.status}`)
  const body = await response.json()
  assert(body.ok === true, 'ok !== true')
  assert(typeof body.version === 'string', 'falta version')
  assert(body.dsh?.ok === true && typeof body.dsh?.profile === 'string', 'falta dsh')
  return `v${body.version} · perfil ${body.dsh.profile}`
})

await check('POST /api/pair con código incorrecto → 401 UNAUTHORIZED', async () => {
  const response = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: '000000', deviceName: 'Smoke' }),
  })
  assert(response.status === 401, `status ${response.status}`)
  const body = await response.json()
  assert(body.error?.code === 'UNAUTHORIZED', 'falta error.code')
  assert(typeof body.error?.message === 'string', 'falta error.message')
})

await check('POST /api/pair correcto', async () => {
  const response = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: PIN, deviceName: 'Smoke test' }),
  })
  assert(response.status === 200, `status ${response.status}`)
  const body = await response.json()
  assert(typeof body.token === 'string' && /^[0-9a-f]{64}$/.test(body.token), 'token no es hex64')
  assert(typeof body.deviceId === 'string' && body.deviceId.startsWith('dev_'), 'deviceId inválido')
  token = body.token
  return `${body.deviceId} · ${body.deviceName}`
})

await check('GET /api/me', async () => {
  const { response, body } = await api('/api/me')
  assert(response.status === 200, `status ${response.status}`)
  assert(body.deviceName === 'Smoke test', 'deviceName inesperado')
  assert(typeof body.serverVersion === 'string', 'falta serverVersion')
})

await check('GET /api/models', async () => {
  const { response, body } = await api('/api/models')
  assert(response.status === 200, `status ${response.status}`)
  assert(Array.isArray(body.models) && body.models.length === 2, 'catálogo inesperado')
  const flash = body.models.find((model) => model.id === 'deepseek-flash')
  const pro = body.models.find((model) => model.id === 'deepseek-v4-pro')
  assert(flash?.isDefault === true, 'deepseek-flash no es el modelo por defecto')
  assert(pro?.name === 'DeepSeek V4 Pro', 'falta deepseek-v4-pro')
  assert(typeof flash.hint === 'string', 'falta hint')
  return body.models.map((model) => model.id).join(', ')
})

await check('GET /api/voice-status', async () => {
  const { response, body } = await api('/api/voice-status')
  assert(response.status === 200, `status ${response.status}`)
  assert(body.available === true, 'el motor local no está disponible')
  assert(typeof body.engine === 'string', 'falta engine')
  assert(typeof body.model === 'string', 'falta model')
  return `${body.engine} · ${body.model}`
})

await check('POST /api/transcribe con WAV PCM', async () => {
  const samples = 3200
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF', 0, 'ascii')
  wav.writeUInt32LE(36 + samples * 2, 4)
  wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24)
  wav.writeUInt32LE(32000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36, 'ascii')
  wav.writeUInt32LE(samples * 2, 40)
  const { response, body } = await api('/api/transcribe', {
    method: 'POST',
    body: JSON.stringify({ audio: wav.toString('base64'), language: 'es' }),
  })
  assert(response.status === 200, `status ${response.status}`)
  assert(typeof body.text === 'string' && body.text.length > 0, 'respuesta sin text')
  return body.text
})

await check('POST /api/transcribe sin audio → 400', async () => {
  const { response, body } = await api('/api/transcribe', {
    method: 'POST',
    body: JSON.stringify({ audio: '', language: 'es' }),
  })
  assert(response.status === 400, `status ${response.status}`)
  assert(body.error?.code === 'BAD_REQUEST', 'falta error.code BAD_REQUEST')
})

await check('GET /api/activity con datos variados', async () => {
  const { response, body } = await api('/api/activity?limit=30')
  assert(response.status === 200, `status ${response.status}`)
  assert(Array.isArray(body.activity), 'falta activity')
  assert(body.activity.length >= 3, `solo ${body.activity.length} entradas`)
  for (const entry of body.activity) {
    assert(typeof entry.id === 'string' && entry.id.startsWith('act_'), 'id inválido')
    assert(typeof entry.chatId === 'string' && entry.chatId.startsWith('session-'), 'chatId inválido')
    assert(typeof entry.title === 'string', 'falta title')
    assert(typeof entry.workspaceName === 'string', 'falta workspaceName')
    assert(
      ['completed', 'error', 'aborted'].includes(entry.status),
      `status inválido: ${entry.status}`,
    )
    assert(typeof entry.durationMs === 'number' && entry.durationMs >= 0, 'durationMs inválido')
    assert(Array.isArray(entry.tools), 'tools no es array')
    assert(typeof entry.at === 'number', 'falta at')
  }
  const statuses = new Set(body.activity.map((entry) => entry.status))
  assert(statuses.has('completed') && statuses.has('error'), 'faltan estados variados')
  assert(
    body.activity.some((entry) => entry.tools.length === 0),
    'falta una entrada sin herramientas',
  )
  for (let index = 1; index < body.activity.length; index += 1) {
    assert(
      body.activity[index - 1].at >= body.activity[index].at,
      'la actividad no está ordenada por fecha',
    )
  }
  const limited = await api('/api/activity?limit=2')
  assert(limited.body.activity.length === 2, 'el parámetro limit no se aplica')
  return `${body.activity.length} entradas`
})

await check('GET /api/activity sin token → 401', async () => {
  const response = await fetch(`${base}/api/activity?limit=5`)
  assert(response.status === 401, `status ${response.status}`)
})

await check('POST /api/uploads exige workspaceId → 400', async () => {
  const pixelPng =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const { response, body } = await api('/api/uploads', {
    method: 'POST',
    body: JSON.stringify({ name: 'pixel.png', mime: 'image/png', data: pixelPng }),
  })
  assert(response.status === 400, `status ${response.status}`)
  assert(body.error?.code === 'BAD_REQUEST', 'falta error.code BAD_REQUEST')
  assert(
    String(body.error?.message || '').includes('workspaceId'),
    'el mensaje no explica que falta workspaceId',
  )
})

await check('POST /api/uploads + GET /api/attachments', async () => {
  const workspaceList = await api('/api/workspaces')
  firstWorkspace = workspaceList.body.workspaces[0]
  assert(firstWorkspace?.id, 'no hay proyecto para subir la imagen')
  const pixelPng =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const { response, body } = await api('/api/uploads', {
    method: 'POST',
    body: JSON.stringify({
      workspaceId: firstWorkspace.id,
      name: 'pixel.png',
      mime: 'image/png',
      data: pixelPng,
    }),
  })
  assert(response.status === 201, `status ${response.status}`)
  assert(typeof body.id === 'string' && body.id.startsWith('att_'), 'id de adjunto inválido')
  assert(body.url === `/api/attachments/${body.id}`, 'url de adjunto inválida')
  assert(body.size > 0, 'tamaño inválido')

  const image = await fetch(`${base}${body.url}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert(image.status === 200, `GET adjunto → ${image.status}`)
  assert((image.headers.get('content-type') || '').includes('image/png'), 'content-type inesperado')

  uploadedId = body.id
  return `${body.id} · ${body.size} bytes`
})

await check('POST /api/uploads de documento + GET adjunto', async () => {
  const pdf = Buffer.from('%PDF-1.4\n% documento de prueba para Nexo\n%%EOF\n', 'utf8')
  const { response, body } = await api('/api/uploads', {
    method: 'POST',
    body: JSON.stringify({
      workspaceId: firstWorkspace.id,
      name: 'informe.pdf',
      mime: 'application/pdf',
      data: pdf.toString('base64'),
    }),
  })
  assert(response.status === 201, `status ${response.status}`)
  assert(body.name === 'informe.pdf' && body.mime === 'application/pdf', 'metadatos del documento')
  assert(body.size === pdf.length, 'tamaño del documento inesperado')
  const document = await fetch(`${base}${body.url}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert(document.status === 200, `GET documento → ${document.status}`)
  assert((document.headers.get('content-type') || '').includes('application/pdf'), 'content-type')
  uploadedDocId = body.id
  return `${body.id} · ${body.size} bytes`
})

await check('POST /api/uploads rechaza formatos no admitidos', async () => {
  const { response, body } = await api('/api/uploads', {
    method: 'POST',
    body: JSON.stringify({
      workspaceId: firstWorkspace.id,
      name: 'programa.exe',
      mime: 'application/x-msdownload',
      data: Buffer.from('MZ').toString('base64'),
    }),
  })
  assert(response.status === 400, `status ${response.status}`)
  assert(body.error?.code === 'BAD_REQUEST', 'falta error.code BAD_REQUEST')
})

await check('POST /api/uploads rechaza archivos > 25 MB', async () => {
  const tooBig = Buffer.alloc(25 * 1024 * 1024 + 1).toString('base64')
  const { response, body } = await api('/api/uploads', {
    method: 'POST',
    body: JSON.stringify({
      workspaceId: firstWorkspace.id,
      name: 'grande.pdf',
      mime: 'application/pdf',
      data: tooBig,
    }),
  })
  assert(response.status === 400, `status ${response.status}`)
  assert(body.error?.code === 'BAD_REQUEST', 'falta error.code BAD_REQUEST')
  assert(String(body.error?.message || '').includes('25 MB'), 'el mensaje no menciona el límite')
})

await check('GET / api/workspaces', async () => {
  const { response, body } = await api('/api/workspaces')
  assert(response.status === 200, `status ${response.status}`)
  assert(Array.isArray(body.workspaces) && body.workspaces.length > 0, 'lista vacía')
  const workspace = body.workspaces[0]
  assert(typeof workspace.id === 'string', 'falta id')
  assert(typeof workspace.path === 'string', 'falta path')
  assert(typeof workspace.lastActiveAt === 'number', 'falta lastActiveAt')
  assert(typeof workspace.chatsCount === 'number', 'falta chatsCount')
  firstWorkspace = workspace
  return `${workspace.name} (${workspace.chatsCount} chats)`
})

await check('datos para el drawer: proyecto con actividad reciente', async () => {
  const { body } = await api('/api/workspaces')
  const recent = body.workspaces.some(
    (workspace) => Date.now() - workspace.lastActiveAt < 10 * 60 * 1000,
  )
  assert(recent, 'ningún proyecto con lastActiveAt en los últimos 10 min')
  return `${body.workspaces.length} proyectos`
})

await check('GET /api/workspaces sin token → 401', async () => {
  const response = await fetch(`${base}/api/workspaces`)
  assert(response.status === 401, `status ${response.status}`)
})

await check('GET /api/browse raíz', async () => {
  const { response, body } = await api('/api/browse')
  assert(response.status === 200, `status ${response.status}`)
  assert(typeof body.path === 'string' && body.path.length > 0, 'falta path')
  assert(Array.isArray(body.entries), 'falta entries')
  assert(body.entries.every((entry) => typeof entry.isDir === 'boolean'), 'entry.isDir inválido')
  return `${body.entries.length} entradas en ${body.path}`
})

await check('GET /api/browse de una subcarpeta', async () => {
  const root = await api('/api/browse')
  const folder = root.body.entries.find((entry) => entry.isDir)
  assert(folder, 'no hay subcarpetas para probar')
  const { response, body } = await api(`/api/browse?path=${encodeURIComponent(folder.path)}`)
  assert(response.status === 200, `status ${response.status}`)
  assert(body.path === folder.path, 'path inesperado')
  assert(body.parent !== null, 'falta parent')
})

await check('POST /api/workspaces + DELETE', async () => {
  const root = await api('/api/browse')
  const targetPath = root.body.path
  const payload = { path: targetPath, name: 'Smoke workspace' }
  let created = await api('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  if (created.response.status === 409) {
    const list = await api('/api/workspaces')
    const existing = list.body.workspaces.find(
      (workspace) => workspace.path.toLowerCase() === targetPath.toLowerCase(),
    )
    if (existing) {
      await api(`/api/workspaces/${existing.id}`, { method: 'DELETE' })
      created = await api('/api/workspaces', { method: 'POST', body: JSON.stringify(payload) })
    }
  }
  assert(created.response.status === 201, `POST → ${created.response.status}`)
  const workspace = created.body.workspace
  assert(workspace.name === 'Smoke workspace', 'nombre inesperado')
  createdWorkspaceIds.push(workspace.id)

  const deleted = await api(`/api/workspaces/${workspace.id}`, { method: 'DELETE' })
  assert(deleted.response.status === 200 && deleted.body.ok === true, 'DELETE falló')
  createdWorkspaceIds.pop()

  const after = await api('/api/workspaces')
  assert(!after.body.workspaces.some((item) => item.id === workspace.id), 'sigue en la lista')
})

await check('GET /api/workspaces/:id/chats', async () => {
  const { response, body } = await api(`/api/workspaces/${firstWorkspace.id}/chats`)
  assert(response.status === 200, `status ${response.status}`)
  assert(Array.isArray(body.chats), 'falta chats')
  for (const chat of body.chats) {
    assert(typeof chat.id === 'string', 'chat sin id')
    assert(typeof chat.preview === 'string', 'chat sin preview')
    assert(typeof chat.adoptable === 'boolean', 'chat sin adoptable')
    assert('model' in chat, 'chat sin campo model')
    assert(
      chat.model === null || typeof chat.model === 'string',
      'model con tipo inesperado',
    )
    assert(
      chat.messageCount === undefined ||
        chat.messageCount === null ||
        typeof chat.messageCount === 'number',
      'messageCount con tipo inesperado',
    )
  }
  assert(
    body.chats.some((chat) => typeof chat.messageCount === 'number'),
    'ningún chat trae messageCount (el campo debe aparecer a veces)',
  )
  return `${body.chats.length} conversaciones`
})

await check('chat de solo lectura (adoptable=false, sin messageCount)', async () => {
  const list = await api(`/api/workspaces/${firstWorkspace.id}/chats`)
  const readOnly = list.body.chats.find((chat) => chat.adoptable === false)
  assert(readOnly, 'el mock no expone ningún chat de solo lectura')
  assert(readOnly.messageCount === undefined, 'el chat de solo lectura no debe traer messageCount')

  const detail = await api(`/api/chats/${readOnly.id}`)
  assert(detail.response.status === 200, `GET /api/chats/:id → ${detail.response.status}`)
  assert(detail.body.adoptable === false, 'el detalle no marca adoptable=false')
  assert(detail.body.model === null, 'el chat de escritorio debería tener model null')
  assert(detail.body.messages.length >= 2, 'histórico del chat de solo lectura incompleto')

  const withImage = detail.body.messages.find(
    (message) => message.role === 'user' && Array.isArray(message.attachments) && message.attachments.length > 0,
  )
  assert(withImage, 'el histórico no incluye el mensaje con adjunto')
  const attachment = withImage.attachments[0]
  assert(
    typeof attachment.url === 'string' && attachment.url.startsWith('/api/attachments/'),
    'adjunto del histórico sin url',
  )
  assert(typeof withImage.text === 'string' && withImage.text.includes('[Adjunto:'), 'falta [Adjunto: …]')
  assert(withImage.text.includes('captura-demo.png'), 'nombre de adjunto inesperado')
  const image = await fetch(`${base}${attachment.url}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert(image.status === 200, `GET adjunto del histórico → ${image.status}`)

  const attempt = await api(`/api/chats/${readOnly.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: 'Intento continuar desde el móvil' }),
  })
  assert(attempt.response.status === 409, `continuar read-only → ${attempt.response.status}`)
  assert(attempt.body.error?.code === 'CONFLICT', 'falta error.code CONFLICT')
  return `${readOnly.title} (${detail.body.messages.length} mensajes)`
})

await check('chat nuevo con imagen, texto vacío y modelo', async () => {
  const sse = await openSse()
  try {
    const { chatId } = await postNewChatPayload(firstWorkspace.id, {
      text: '',
      model: 'deepseek-v4-pro',
      attachments: [{ id: uploadedId, name: 'pixel.png' }],
    })
    const { text, end } = await collectTurn(sse, chatId)
    assert(end.status === 'completed', `turn_end.status=${end.status}`)
    assert(text.length > 20, 'respuesta del mock demasiado corta')

    const detail = await api(`/api/chats/${chatId}`)
    assert(detail.response.status === 200, 'GET chat falló')
    assert(detail.body.model === 'deepseek-v4-pro', `model=${detail.body.model}`)
    const userMessage = detail.body.messages.find((message) => message.role === 'user')
    assert(Array.isArray(userMessage?.attachments) && userMessage.attachments.length === 1, 'falta adjunto resuelto')
    assert(typeof userMessage.attachments[0].url === 'string', 'adjunto sin url')
    assert(userMessage.text.includes('[Adjunto:'), 'falta el marcador en el histórico')

    const list = await api(`/api/workspaces/${firstWorkspace.id}/chats`)
    const summary = list.body.chats.find((chat) => chat.id === chatId)
    assert(summary?.model === 'deepseek-v4-pro', 'la lista no expone el modelo')
    return `${chatId} · ${text.length} caracteres`
  } finally {
    sse.close()
    await sleep(120)
  }
})

await check('chat nuevo con documento PDF (solo adjunto)', async () => {
  const sse = await openSse()
  try {
    const { chatId } = await postNewChatPayload(firstWorkspace.id, {
      text: '',
      attachments: [{ id: uploadedDocId, name: 'informe.pdf' }],
    })
    const { text, end } = await collectTurn(sse, chatId)
    assert(end.status === 'completed', `turn_end.status=${end.status}`)
    assert(text.includes('informe.pdf'), 'la respuesta no cita el documento')

    const detail = await api(`/api/chats/${chatId}`)
    const userMessage = detail.body.messages.find((message) => message.role === 'user')
    assert(Array.isArray(userMessage?.attachments) && userMessage.attachments.length === 1, 'falta el documento')
    const attachment = userMessage.attachments[0]
    assert(attachment.name === 'informe.pdf', 'nombre inesperado')
    assert(attachment.mime === 'application/pdf', 'mime inesperado')
    assert(typeof attachment.size === 'number' && attachment.size > 0, 'falta size')
    assert(userMessage.text.includes('[Adjunto:'), 'falta el marcador de adjunto')
    return `${chatId} · ${attachment.size} bytes`
  } finally {
    sse.close()
    await sleep(120)
  }
})

await check('mensaje vacío sin adjuntos → 400', async () => {
  const { response, body } = await api(`/api/workspaces/${firstWorkspace.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: '   ' }),
  })
  assert(response.status === 400, `status ${response.status}`)
  assert(body.error?.code === 'BAD_REQUEST', 'falta error.code BAD_REQUEST')
})

await check('POST nuevo chat + SSE con deltas palabra a palabra', async () => {
  const sse = await openSse()
  try {
    const { chatId } = await postNewChat(firstWorkspace.id, 'Hola, ¿puedes revisar el README?')
    const { events, text, end } = await collectTurn(sse, chatId)
    const types = new Set(events.map((event) => event.type))
    assert(types.has('turn_start'), 'no llegó turn_start')
    assert(types.has('thinking'), 'no llegó thinking')
    assert(types.has('tool'), 'no llegó tool')
    assert(types.has('title'), 'no llegó title')
    const deltas = events.filter((event) => event.type === 'delta')
    assert(deltas.length >= 5, `solo ${deltas.length} deltas`)
    assert(end.status === 'completed', `turn_end.status=${end.status}`)
    assert(text.length > 80, 'respuesta demasiado corta')
    const toolEvents = events.filter((event) => event.type === 'tool')
    assert(toolEvents.every((event) => ['start', 'done'].includes(event.status)), 'tool.status inválido')

    const detail = await api(`/api/chats/${chatId}`)
    assert(detail.response.status === 200, 'GET chat falló')
    assert(detail.body.messages.length >= 2, 'histórico incompleto')
    return `${deltas.length} deltas · ${text.length} caracteres`
  } finally {
    sse.close()
    await sleep(120)
  }
})

await check('la actividad registra el turno recién completado', async () => {
  const { body } = await api('/api/activity?limit=5')
  const entry = body.activity[0]
  assert(entry, 'la actividad está vacía')
  assert(entry.status === 'completed', `status ${entry.status}`)
  assert(entry.chatId.startsWith('session-'), 'chatId inválido')
  assert(typeof entry.durationMs === 'number' && entry.durationMs >= 0, 'durationMs inválido')
  assert(Array.isArray(entry.tools), 'tools inválido')
  assert(entry.tools.length > 0, 'el turno usó herramientas pero no se registraron')
  return `${entry.durationMs} ms · ${entry.tools.join(', ')}`
})

await check('continuar chat + turn_end con status error y text', async () => {
  const sse = await openSse()
  try {
    const list = await api(`/api/workspaces/${firstWorkspace.id}/chats`)
    const chat = list.body.chats.find((candidate) => candidate.adoptable !== false)
    assert(chat, 'no hay chats adoptables')
    const { chatId } = await continueChat(chat.id, 'Fuerza un error para probar')
    const { end } = await collectTurn(sse, chatId)
    assert(end.status === 'error', `turn_end.status=${end.status}`)
    assert(typeof end.text === 'string' && end.text.length > 10, 'turn_end.error sin text')
    return end.text.slice(0, 44) + '…'
  } finally {
    sse.close()
    await sleep(120)
  }
})

await check('409 CONFLICT si ya hay un turno en marcha', async () => {
  const sse = await openSse()
  try {
    const first = await postNewChat(firstWorkspace.id, 'Hola')
    const second = await api(`/api/chats/${first.chatId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: 'Otro mensaje a la vez' }),
    })
    assert(second.response.status === 409, `status ${second.response.status}`)
    assert(second.body.error?.code === 'CONFLICT', 'falta error.code CONFLICT')
    await api(`/api/chats/${first.chatId}/stop`, { method: 'POST' })
    await collectTurn(sse, first.chatId, 10000)
  } finally {
    sse.close()
    await sleep(120)
  }
})

await check('POST stop aborta el turno', async () => {
  const sse = await openSse()
  try {
    const { chatId } = await postNewChat(firstWorkspace.id, 'Cuéntame qué ves en el proyecto')
    await sse.next(
      (event) => event.chatId === chatId && event.type === 'turn_start',
      10000,
    )
    const stopped = await api(`/api/chats/${chatId}/stop`, { method: 'POST' })
    assert(stopped.response.status === 200 && stopped.body.ok === true, 'stop falló')
    const end = await sse.next(
      (event) => event.chatId === chatId && event.type === 'turn_end',
      10000,
    )
    assert(end.status === 'aborted', `turn_end.status=${end.status}`)
  } finally {
    sse.close()
    await sleep(120)
  }
})

await check('SSE con token inválido → 401', async () => {
  const response = await fetch(`${base}/api/events?token=token_invalido`)
  assert(response.status === 401, `status ${response.status}`)
})

await check('GET /api/ruta-inexistente → 404 NOT_FOUND', async () => {
  const { response, body } = await api('/api/no-existe')
  assert(response.status === 404, `status ${response.status}`)
  assert(body.error?.code === 'NOT_FOUND', 'falta error.code NOT_FOUND')
})

await check('estático: PWA servida desde el mock', async () => {
  const index = await fetch(`${base}/`)
  assert(index.status === 200, `GET / → ${index.status}`)
  assert((index.headers.get('content-type') || '').includes('text/html'), 'content-type')
  const html = await index.text()
  assert(html.includes('Nexo'), 'el HTML no menciona Nexo')

  const manifest = await fetch(`${base}/manifest.webmanifest`)
  assert(manifest.status === 200, `manifest → ${manifest.status}`)
  const manifestBody = await manifest.json()
  assert(manifestBody.display === 'standalone', 'display no es standalone')
  assert(Array.isArray(manifestBody.icons) && manifestBody.icons.length >= 2, 'faltan iconos')

  const icon = await fetch(`${base}/icons/icon-192.png`)
  assert(icon.status === 200, `icono → ${icon.status}`)
  assert((icon.headers.get('content-type') || '').includes('image/png'), 'icono no es png')

  const sw = await fetch(`${base}/sw.js`)
  assert(sw.status === 200, `sw.js → ${sw.status}`)
})

await sleep(200)

// Limpieza de robustez: si algo quedó a medias, intenta abortar turnos abiertos.
for (const workspaceId of createdWorkspaceIds) {
  await api(`/api/workspaces/${workspaceId}`, { method: 'DELETE' }).catch(() => {})
}

console.log('')
if (failed > 0) {
  console.error(`✗ ${failed} prueba(s) fallida(s), ${passed} correcta(s)\n`)
  process.exit(1)
}
console.log(`✓ ${passed} pruebas correctas. El contrato del mock responde.\n`)
