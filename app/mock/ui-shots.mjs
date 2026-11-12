#!/usr/bin/env node
/**
 * Capturas de la PWA compilada servida por el mock, usando Chrome headless
 * vía CDP (sin dependencias). Sirve para revisar el diseño en tamaño móvil.
 *
 *   node mock/server.mjs           # terminal 1
 *   node mock/ui-shots.mjs         # terminal 2
 *
 * Salida: mock/shots/*.png y resumen de errores de consola / overflow.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const BASE = process.env.SMOKE_URL || 'http://127.0.0.1:8791'
const PORT = 9333
const WIDTH = 390
const HEIGHT = 844

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
if (!chromePath) {
  console.error('No encuentro Chrome/Edge. Define CHROME_PATH.')
  process.exit(1)
}

const shotsDir = join(import.meta.dirname, 'shots')
mkdirSync(shotsDir, { recursive: true })
const profileDir = mkdtempSync(join(tmpdir(), 'nexo-chrome-'))
const sampleDocument = join(profileDir, 'notas-nexo.txt')
writeFileSync(sampleDocument, 'Notas de prueba para Nexo.\nRevisa este documento, por favor.\n')

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

process.on('exit', () => {
  try {
    chrome.kill()
  } catch {
    // ya terminado
  }
})

async function getTarget() {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      // Chrome todavía arrancando
    }
    await sleep(200)
  }
  throw new Error('Chrome no expuso el endpoint de depuración')
}

/* ------------------------------ Cliente CDP ------------------------------ */

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.id = 0
    this.pending = new Map()
    this.events = new Map()
    this.exceptions = []
    this.consoleErrors = []
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined) {
        const handler = this.pending.get(message.id)
        if (!handler) return
        this.pending.delete(message.id)
        if (message.error) handler.reject(new Error(`${message.error.code}: ${message.error.message}`))
        else handler.resolve(message.result)
        return
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params?.exceptionDetails?.text ?? 'excepción')
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        this.consoleErrors.push(
          (message.params.args || [])
            .map((arg) => arg.value ?? arg.description ?? '')
            .join(' ')
            .slice(0, 300),
        )
      }
      const listeners = this.events.get(message.method)
      if (listeners) {
        this.events.delete(message.method)
        for (const resolve of listeners) resolve(message.params)
      }
    }
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.onopen = resolve
      socket.onerror = () => reject(new Error('No se pudo abrir el WebSocket CDP'))
    })
    return new Cdp(socket)
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      this.id += 1
      this.pending.set(this.id, { resolve, reject })
      this.socket.send(JSON.stringify({ id: this.id, method, params }))
    })
  }

  waitFor(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const list = this.events.get(method) ?? []
      list.push(resolve)
      this.events.set(method, list)
      setTimeout(() => reject(new Error(`Timeout esperando ${method}`)), timeoutMs)
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      throw new Error(
        `Error JS: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      )
    }
    return result.result?.value
  }

  async waitForSelector(selector, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = await this.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
      if (found) return
      await sleep(150)
    }
    throw new Error(`Timeout esperando el selector ${selector}`)
  }

  async screenshot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    const file = join(shotsDir, name)
    writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(`  · ${name}`)
    return file
  }

  async setFileInput(selector, filePath) {
    const { root } = await this.send('DOM.getDocument', { depth: -1 })
    const { nodeId } = await this.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector,
    })
    if (!nodeId) throw new Error(`No se encontró el input de archivo ${selector}`)
    await this.send('DOM.setFileInputFiles', { nodeId, files: [filePath] })
  }
}

/* ------------------------------ Interacción ------------------------------ */

const setInput = (selector, value) => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return false;
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(element, ${JSON.stringify(value)});
  element.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`

const clickText = (selector, text) => `(() => {
  const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find((candidate) => (candidate.textContent || '').includes(${JSON.stringify(text)}));
  if (!element) return false;
  element.click();
  return true;
})()`

/** SpeechRecognition falso para poder verificar el dictado en headless. */
const FAKE_SPEECH = `(() => {
  class FakeSpeechRecognition {
    constructor() {
      this.lang = '';
      this.interimResults = false;
      this.continuous = false;
      this.maxAlternatives = 1;
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
      this._timer = null;
    }
    start() {
      this._timer = setTimeout(() => {
        if (this.onresult) {
          this.onresult({
            resultIndex: 0,
            results: [{ 0: { transcript: 'revisa el login del panel' }, isFinal: true, length: 1 }],
          });
        }
        this._timer = setTimeout(() => {
          if (this.onend) this.onend();
        }, 1200);
      }, 900);
    }
    stop() {
      if (this._timer) clearTimeout(this._timer);
      if (this.onend) this.onend();
    }
    abort() {
      this.stop();
    }
  }
  window.SpeechRecognition = FakeSpeechRecognition;
  window.webkitSpeechRecognition = FakeSpeechRecognition;
})()`

/* --------------------------------- Flujo --------------------------------- */

const wsUrl = await getTarget()
const cdp = await Cdp.connect(wsUrl)

try {
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  await cdp.send('DOM.enable')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_SPEECH })
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 2,
    mobile: true,
  })
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

  await cdp.send('Page.navigate', { url: `${BASE}/` })
  await sleep(400)

  // 1. Emparejamiento
  await cdp.waitForSelector('.pair__form')
  await sleep(900) // dejar respirar el orbe antes de la foto
  await cdp.screenshot('01-emparejar.png')

  const paired = await cdp.evaluate(`
    (async () => {
      const input = document.querySelector('#pair-code');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '123456');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.pair__form button[type="submit"]').click();
      return true;
    })()
  `)
  if (!paired) throw new Error('No se pudo emparejar desde la UI')
  await cdp.waitForSelector('.ws-card', 15000)
  await sleep(800)
  await cdp.screenshot('02-proyectos.png')

  // 2b. Navegador de carpetas (Añadir proyecto)
  await cdp.evaluate(`document.querySelector('.add-card').click()`)
  await cdp.waitForSelector('.browse__row')
  await sleep(700)
  await cdp.screenshot('02b-anadir-proyecto.png')
  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(500)

  // 2c. Pantalla del agente + actividad
  await cdp.evaluate(`document.querySelector('.agent-btn').click()`)
  await cdp.waitForSelector('.agent-activity')
  await cdp.waitForSelector('.activity-row')
  await sleep(900)
  const agentAudit = await cdp.evaluate(`({
    rows: document.querySelectorAll('.activity-row').length,
    tools: document.querySelectorAll('.activity-row .tool-chip').length,
    facts: document.querySelector('.agent-facts')?.textContent ?? '',
    mode: document.querySelector('.agent-facts')?.textContent?.includes('Modo') ?? false,
  })`)
  await cdp.screenshot('02c-agente.png')
  await cdp.evaluate(`document.querySelector('.activity-row').click()`)
  await cdp.waitForSelector('.screen--chat')
  await sleep(900)
  await cdp.screenshot('02c2-actividad-chat.png')
  await cdp.evaluate(`document.querySelector('button[aria-label="Volver"]').click()`)
  await cdp.waitForSelector('.agent-activity')
  await sleep(300)
  await cdp.evaluate(`document.querySelector('button[aria-label="Volver"]').click()`)
  await cdp.waitForSelector('.ws-card')
  await sleep(400)

  // 2d. Drawer de proyectos (canales)
  await cdp.evaluate(`document.querySelector('.topbar__hamburger').click()`)
  await cdp.waitForSelector('.drawer__panel')
  await sleep(500)
  const drawerAudit = await cdp.evaluate(`({
    projects: document.querySelectorAll('.drawer__project').length,
    dots: document.querySelectorAll('.drawer__dot').length,
    footer: [...document.querySelectorAll('.drawer__action')].map((button) => button.textContent.trim()),
    current: document.querySelectorAll('.drawer__project.is-current').length,
  })`)
  await cdp.screenshot('02d-drawer.png')
  await cdp.evaluate(`document.querySelector('.drawer__project').click()`)
  await cdp.waitForSelector('.new-chat')
  await sleep(600)
  await cdp.screenshot('02e-drawer-navegacion.png')
  await cdp.evaluate(`document.querySelector('.topbar__hamburger').click()`)
  await cdp.waitForSelector('.drawer__panel')
  await sleep(400)
  const drawerCurrent = await cdp.evaluate(
    `document.querySelectorAll('.drawer__project.is-current').length`,
  )
  await cdp.evaluate(`document.querySelector('.drawer__overlay').click()`)
  await sleep(400)
  await cdp.evaluate(`document.querySelector('button[aria-label="Volver"]').click()`)
  await cdp.waitForSelector('.ws-card')
  await sleep(300)

  // 3. Conversaciones
  await cdp.evaluate(`document.querySelector('.ws-card').click()`)
  await cdp.waitForSelector('.new-chat')
  await sleep(600)
  await cdp.screenshot('03-conversaciones.png')

  // 3b. Chat creado en el escritorio: solo lectura
  let readonlyAudit = null
  const openedReadOnly = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('.chat-row')]
      .find((candidate) => candidate.textContent.includes('solo lectura'));
    if (!row) return false;
    row.click();
    return true;
  })()`)
  if (openedReadOnly) {
    await cdp.waitForSelector('.chat__readonly')
    await cdp.waitForSelector('.msg__attachments')
    await sleep(900)
    await cdp.screenshot('03b-chat-solo-lectura.png')
    readonlyAudit = await cdp.evaluate(`({
      hasComposer: Boolean(document.querySelector('.composer')),
      hasNewChatButton: Boolean(document.querySelector('.chat__readonly button')),
      subtitle: document.querySelector('.topbar__subtitle')?.textContent,
      historyThumbs: document.querySelectorAll('.msg__attachments .thumb').length,
      attachmentChips: document.querySelectorAll('.msg__attachments .attachment-chip').length,
    })`)
    await cdp.evaluate(`document.querySelector('button[aria-label="Volver"]').click()`)
    await cdp.waitForSelector('.new-chat')
    await sleep(400)
  }

  // 4. Chat vacío
  await cdp.evaluate(`document.querySelector('.new-chat').click()`)
  await cdp.waitForSelector('.empty-chat')
  await sleep(500)
  await cdp.screenshot('04-chat-vacio.png')

  // 4b. Dictado por voz (SpeechRecognition simulado)
  const voiceButtonVisible = await cdp.evaluate(
    `Boolean(document.querySelector('.composer__tool[aria-label="Dictar por voz"]'))`,
  )
  let listeningVisible = false
  if (voiceButtonVisible) {
    await cdp.evaluate(
      `document.querySelector('.composer__tool[aria-label="Dictar por voz"]').click()`,
    )
    await sleep(450)
    listeningVisible = await cdp.evaluate(`Boolean(document.querySelector('.voice-state'))`)
    await cdp.screenshot('04b-dictando.png')
    const voiceDeadline = Date.now() + 6000
    while (Date.now() < voiceDeadline) {
      const text = await cdp.evaluate(
        `document.querySelector('.composer textarea')?.value ?? ''`,
      )
      if (text.trim()) break
      await sleep(150)
    }
  }
  const dictatedText = await cdp.evaluate(
    `document.querySelector('.composer textarea')?.value ?? ''`,
  )
  if (!dictatedText.trim()) {
    await cdp.evaluate(setInput('.composer textarea', 'Revisa el login del panel'))
  }

  // 4c. Adjuntar imagen (el cliente comprime y sube con /api/uploads)
  await cdp.setFileInput(
    '.composer input[type="file"]',
    join(import.meta.dirname, '..', 'public', 'icons', 'icon-192.png'),
  )
  await cdp.waitForSelector('.composer__attachment img')
  await sleep(1500)
  const attachmentReady = await cdp.evaluate(
    `Boolean(document.querySelector('.composer__attachment:not(.is-uploading) img'))`,
  )
  await cdp.screenshot('04c-adjunto.png')

  // 4c2. Adjuntar un documento (chip con nombre y tamaño)
  await cdp.setFileInput('.composer__file-input--doc', sampleDocument)
  await cdp.waitForSelector('.composer__doc')
  await sleep(1300)
  const documentReady = await cdp.evaluate(
    `Boolean(document.querySelector('.composer__doc:not(.is-uploading)'))`,
  )
  const documentChip = await cdp.evaluate(
    `document.querySelector('.composer__doc')?.textContent?.trim() ?? null`,
  )
  await cdp.screenshot('04c2-documento.png')

  // 4d. Cambiar de modelo antes de enviar
  await cdp.evaluate(`document.querySelector('.model-chip').click()`)
  await cdp.waitForSelector('.sheet__panel .model-list')
  await sleep(500)
  await cdp.screenshot('04d-modelo.png')
  const modelSheetOpened = await cdp.evaluate(
    `Boolean(document.querySelector('.sheet__panel .model-list'))`,
  )
  await cdp.evaluate(clickText('.sheet__panel .model-row', 'DeepSeek V4 Pro'))
  await sleep(500)
  const modelAfterSelect = await cdp.evaluate(`({
    chip: document.querySelector('.model-chip strong')?.textContent ?? null,
    subtitle: document.querySelector('.topbar__subtitle')?.textContent ?? null,
  })`)

  // 4e. Enviar mensaje con el texto dictado y la imagen
  await cdp.evaluate(`document.querySelector('.send').click()`)
  await sleep(2600)
  await cdp.screenshot('05-chat-pensando.png')
  await sleep(3500)
  await cdp.screenshot('06-chat-streaming.png')

  // 5. Esperar a que termine el turno
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const busy = await cdp.evaluate(`Boolean(document.querySelector('.send--stop'))`)
    if (!busy) break
    await sleep(400)
  }
  await sleep(700)
  await cdp.screenshot('07-chat-respuesta.png')

  const chatAudit = await cdp.evaluate(`({
    ariaLive: document.querySelector('.messages')?.getAttribute('aria-live'),
    messages: document.querySelectorAll('.msg').length,
    assistantBubbles: document.querySelectorAll('.msg--assistant').length,
    stopVisible: Boolean(document.querySelector('.send--stop')),
    historyThumbs: document.querySelectorAll('.msg__attachments .thumb').length,
    docChips: document.querySelectorAll('.msg__attachments .attachment-chip--doc').length,
    pendingAttachments: document.querySelectorAll('.composer__attachment').length,
    pendingDocs: document.querySelectorAll('.composer__doc').length,
    modelChip: document.querySelector('.model-chip strong')?.textContent ?? null,
    modelSubtitle: document.querySelector('.topbar__subtitle')?.textContent ?? null,
    daySeparators: document.querySelectorAll('.day-separator').length,
    firstSeparator: document.querySelector('.day-separator')?.textContent?.trim() ?? null,
  })`)

  // 5b. Enlaces en la respuesta (tarjetas)
  await cdp.evaluate(setInput('.composer textarea', 'Dame un enlace a la documentación'))
  await sleep(120)
  await cdp.evaluate(`document.querySelector('.send').click()`)
  const linkDeadline = Date.now() + 25000
  while (Date.now() < linkDeadline) {
    const busy = await cdp.evaluate(`Boolean(document.querySelector('.send--stop'))`)
    if (!busy) break
    await sleep(300)
  }
  await sleep(700)
  const linkAudit = await cdp.evaluate(`({
    cards: document.querySelectorAll('.link-card').length,
    domains: [...document.querySelectorAll('.link-card__main small')].map((node) => node.textContent),
    titles: [...document.querySelectorAll('.link-card__main strong')].map((node) => node.textContent),
  })`)
  await cdp.screenshot('07b-enlaces.png')

  // 6. Error legible: turn_end con status error
  await cdp.evaluate(setInput('.composer textarea', 'Fuerza un error para probar'))
  await sleep(100)
  await cdp.evaluate(`document.querySelector('.send').click()`)
  const errorDeadline = Date.now() + 25000
  let errorVisible = false
  while (Date.now() < errorDeadline) {
    errorVisible = await cdp.evaluate(`Boolean(document.querySelector('.msg--error'))`)
    if (errorVisible) break
    await sleep(300)
  }
  await sleep(500)
  const retryVisible = errorVisible
    ? await cdp.evaluate(`Boolean(document.querySelector('.retry-row button'))`)
    : false
  await cdp.screenshot('08-chat-error.png')

  // 6b. Notificación local de tarea larga con la app "oculta".
  await cdp.evaluate(`(() => {
    window.__nexoNotifications = []
    class FakeNotification {
      static permission = 'granted'
      static requestPermission = async () => 'granted'
      constructor(title, options) {
        window.__nexoNotifications.push({ title, body: options?.body ?? '' })
      }
    }
    try { window.Notification = FakeNotification } catch {
      Object.defineProperty(window, 'Notification', { configurable: true, value: FakeNotification })
    }
    try {
      Object.defineProperty(navigator.serviceWorker, 'getRegistration', {
        configurable: true,
        value: async () => null,
      })
    } catch {}
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
  })()`)
  await cdp.evaluate(
    setInput('.composer textarea', 'Tarea larga: revisa el README y propón mejoras'),
  )
  await sleep(120)
  await cdp.evaluate(`document.querySelector('.send').click()`)
  const notificationDeadline = Date.now() + 50000
  while (Date.now() < notificationDeadline) {
    const busy = await cdp.evaluate(`Boolean(document.querySelector('.send--stop'))`)
    if (!busy) break
    await sleep(400)
  }
  await sleep(900)
  const notifications = await cdp.evaluate(`window.__nexoNotifications ?? []`)
  await cdp.screenshot('08b-tarea-larga.png')
  await cdp.evaluate(`Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  })`)

  // 7. Ajustes: modelo por defecto, dictado y notificaciones
  await cdp.evaluate(`document.querySelector('button[aria-label="Ajustes"]').click()`)
  await cdp.waitForSelector('.sheet__panel')
  await sleep(600)
  await cdp.screenshot('09-ajustes.png')
  const settingsModelRow = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('.sheet__panel .settings-row--button')]
      .find((candidate) => candidate.textContent.includes('Modelo por defecto'));
    return button ? button.textContent.trim() : null;
  })()`)
  await cdp.evaluate(clickText('.sheet__panel .settings-row--button', 'Modelo por defecto'))
  await sleep(400)
  const defaultModelOptions = await cdp.evaluate(
    `Boolean(document.querySelector('.sheet__panel .model-list'))`,
  )
  await cdp.screenshot('09b-modelo-defecto.png')

  const settingsVoiceRow = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('.sheet__panel .settings-row--button')]
      .find((candidate) => candidate.textContent.includes('Dictado'));
    return button ? button.textContent.trim() : null;
  })()`)
  await cdp.evaluate(clickText('.sheet__panel .settings-row--button', 'Dictado'))
  await sleep(400)
  const voiceOptionsCount = await cdp.evaluate(
    `document.querySelectorAll('.sheet__panel .model-list .model-row').length`,
  )
  await cdp.evaluate(`document.querySelector('.sheet__body').scrollTop = 9999`)
  await sleep(350)
  await cdp.screenshot('09c-dictado.png')

  const notificationSwitch = await cdp.evaluate(`(() => {
    const button = document.querySelector('.sheet__panel .switch');
    return button ? { present: true, checked: button.getAttribute('aria-checked') } : { present: false, checked: null };
  })()`)
  const notificationNote = await cdp.evaluate(`(() => {
    const note = [...document.querySelectorAll('.sheet__panel .settings-note')]
      .find((candidate) => candidate.textContent?.includes('Permiso'));
    return note ? note.textContent.trim() : null;
  })()`)
  await cdp.screenshot('09d-notificaciones.png')

  // 8. Cerrar ajustes y volver
  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(400)
  await cdp.evaluate(`document.querySelector('button[aria-label="Volver"]').click()`)
  await sleep(700)
  await cdp.screenshot('10-vuelta-conversaciones.png')

  // 9. Comprobaciones de layout
  const audit = await cdp.evaluate(`(async () => {
    const doc = document.documentElement;
    const overflowX = doc.scrollWidth - window.innerWidth;
    const targets = [...document.querySelectorAll('button, a, input, textarea')]
      .filter((element) => element.offsetParent !== null)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { label: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 30) || element.tagName, w: Math.round(rect.width), h: Math.round(rect.height) };
      });
    const smallTargets = targets.filter((target) => target.w > 0 && target.h > 0 && target.h < 44);
    let serviceWorkers = 0;
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      serviceWorkers = registrations.length;
    } catch { serviceWorkers = -1; }
    return {
      overflowX,
      viewport: window.innerWidth + 'x' + window.innerHeight,
      theme: document.querySelector('meta[name="theme-color"]')?.content,
      manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href'),
      title: document.title,
      smallTargets,
      serviceWorkers,
    };
  })()`)

  console.log('\n  Auditoría de layout:')
  console.log(`   viewport:       ${audit.viewport}`)
  console.log(`   overflow-x:     ${audit.overflowX}px`)
  console.log(`   theme-color:    ${audit.theme}`)
  console.log(`   manifest:       ${audit.manifest}`)
  console.log(`   title:          ${audit.title}`)
  console.log(`   service worker: ${audit.serviceWorkers} registrado(s)`)
  console.log(`   targets < 44px: ${audit.smallTargets.length}`)
  for (const target of audit.smallTargets.slice(0, 8)) {
    console.log(`     · ${target.label} (${target.w}×${target.h})`)
  }

  console.log('\n  Auditoría del chat:')
  console.log(`   aria-live:      ${chatAudit.ariaLive}`)
  console.log(`   burbujas:       ${chatAudit.messages} (${chatAudit.assistantBubbles} del agente)`)
  console.log(`   error visible:  ${errorVisible}`)
  console.log(`   reintentar:     ${retryVisible}`)
  console.log(
    `   solo lectura:   ${
      readonlyAudit
        ? `composer=${readonlyAudit.hasComposer} botón=${readonlyAudit.hasNewChatButton} subtítulo="${readonlyAudit.subtitle}"`
        : 'no encontrado'
    }`,
  )
  if (readonlyAudit) {
    console.log(
      `   adjuntos solo-lectura: thumbs=${readonlyAudit.historyThumbs} chips=${readonlyAudit.attachmentChips}`,
    )
  }

  console.log('\n  Auditoría de modelo, adjuntos, voz y notificaciones:')
  console.log(`   botón de voz:         ${voiceButtonVisible}`)
  console.log(`   estado escuchando:    ${listeningVisible}`)
  console.log(`   adjunto imagen:       ${attachmentReady}`)
  console.log(`   adjunto documento:    ${documentReady} · ${documentChip}`)
  console.log(`   hoja de modelo:       ${modelSheetOpened}`)
  console.log(`   modelo en chip:       ${modelAfterSelect.chip}`)
  console.log(`   modelo en subtítulo:  ${chatAudit.modelSubtitle}`)
  console.log(`   miniaturas historial: ${chatAudit.historyThumbs}`)
  console.log(`   documentos historial: ${chatAudit.docChips}`)
  console.log(`   pendientes tras envío:${chatAudit.pendingAttachments}/${chatAudit.pendingDocs}`)
  console.log(`   modelo por defecto:   ${settingsModelRow}`)
  console.log(`   opciones por defecto: ${defaultModelOptions}`)
  console.log(`   fila dictado:         ${settingsVoiceRow}`)
  console.log(`   opciones dictado:     ${voiceOptionsCount}`)
  console.log(`   switch notificaciones:${JSON.stringify(notificationSwitch)}`)
  console.log(`   permiso:              ${notificationNote}`)
  console.log(
    `   notificación tarea:  ${notifications.length} · ${
      notifications[0]?.title ?? 'ninguna'
    }`,
  )

  console.log('\n  Auditoría del panel del agente y drawer:')
  console.log(`   filas actividad:     ${agentAudit.rows}`)
  console.log(`   chips herramientas:  ${agentAudit.tools}`)
  console.log(`   modo en ficha:       ${agentAudit.mode}`)
  console.log(`   proyectos drawer:    ${drawerAudit.projects}`)
  console.log(`   puntos actividad:    ${drawerAudit.dots}`)
  console.log(`   pie drawer:          ${drawerAudit.footer.join(' · ')}`)
  console.log(`   proyecto resaltado:  ${drawerCurrent}`)

  console.log('\n  Auditoría de fechas y enlaces:')
  console.log(`   separadores de día:  ${chatAudit.daySeparators} (${chatAudit.firstSeparator})`)
  console.log(`   tarjetas de enlace:  ${linkAudit.cards} (${linkAudit.domains.join(', ')})`)

  console.log(`\n  Excepciones JS: ${cdp.exceptions.length}`)
  for (const exception of cdp.exceptions.slice(0, 8)) console.log(`   ! ${exception}`)
  console.log(`  Errores de consola: ${cdp.consoleErrors.length}`)
  for (const error of cdp.consoleErrors.slice(0, 8)) console.log(`   ! ${error}`)

  if (!voiceButtonVisible) {
    console.error('\n✗ El botón de dictado no aparece con SpeechRecognition disponible')
    process.exitCode = 1
  }
  if (!listeningVisible) {
    console.error('\n✗ No se muestra el estado «escuchando…»')
    process.exitCode = 1
  }
  if (!attachmentReady) {
    console.error('\n✗ La imagen adjunta no llegó a estado listo (compresión/upload)')
    process.exitCode = 1
  }
  if (!documentReady) {
    console.error('\n✗ El documento adjunto no llegó a estado listo (upload)')
    process.exitCode = 1
  }
  if (chatAudit.docChips < 1) {
    console.error('\n✗ El histórico no muestra el chip del documento')
    process.exitCode = 1
  }
  if (chatAudit.pendingDocs !== 0) {
    console.error('\n✗ El compositor conserva documentos después de enviar')
    process.exitCode = 1
  }
  if (!Array.isArray(notifications) || notifications.length < 1) {
    console.error('\n✗ No se disparó la notificación local de tarea larga')
    process.exitCode = 1
  } else if (!String(notifications[0]?.title ?? '').includes('Nexo ·')) {
    console.error('\n✗ La notificación no lleva el título «Nexo · <proyecto>»')
    process.exitCode = 1
  }
  if (!settingsVoiceRow || !settingsVoiceRow.includes('Dictado')) {
    console.error('\n✗ Ajustes no muestra la fila de dictado')
    process.exitCode = 1
  }
  if (voiceOptionsCount < 2) {
    console.error('\n✗ No se despliegan los dos motores de dictado')
    process.exitCode = 1
  }
  if (!notificationSwitch.present) {
    console.error('\n✗ Ajustes no muestra el interruptor de notificaciones')
    process.exitCode = 1
  }
  if (!notificationNote || !notificationNote.includes('Permiso')) {
    console.error('\n✗ Ajustes no muestra el estado del permiso de notificaciones')
    process.exitCode = 1
  }
  if (agentAudit.rows < 1) {
    console.error('\n✗ La pantalla del agente no muestra actividad')
    process.exitCode = 1
  }
  if (agentAudit.tools < 1) {
    console.error('\n✗ La actividad no muestra chips de herramientas')
    process.exitCode = 1
  }
  if (!agentAudit.mode) {
    console.error('\n✗ La ficha del agente no muestra el modo de conexión')
    process.exitCode = 1
  }
  if (drawerAudit.projects < 2) {
    console.error('\n✗ El drawer no lista los proyectos')
    process.exitCode = 1
  }
  if (drawerAudit.dots < 1) {
    console.error('\n✗ El drawer no marca actividad reciente')
    process.exitCode = 1
  }
  if (
    !drawerAudit.footer.some((label) => label.includes('Todos los proyectos')) ||
    !drawerAudit.footer.some((label) => label.includes('Añadir proyecto')) ||
    !drawerAudit.footer.some((label) => label.includes('Ajustes'))
  ) {
    console.error('\n✗ El pie del drawer no tiene las acciones esperadas')
    process.exitCode = 1
  }
  if (drawerCurrent < 1) {
    console.error('\n✗ El proyecto actual no aparece resaltado en el drawer')
    process.exitCode = 1
  }
  if (chatAudit.daySeparators < 1 || !String(chatAudit.firstSeparator ?? '').startsWith('Hoy')) {
    console.error('\n✗ Faltan los separadores de día en el chat')
    process.exitCode = 1
  }
  if (linkAudit.cards < 2) {
    console.error('\n✗ La respuesta con URLs no genera tarjetas de enlace')
    process.exitCode = 1
  }
  if (!linkAudit.domains.some((domain) => domain.includes('api-docs.deepseek.com'))) {
    console.error('\n✗ Las tarjetas no muestran el dominio del enlace')
    process.exitCode = 1
  }
  if (!modelSheetOpened) {
    console.error('\n✗ No se abrió la hoja de selección de modelo')
    process.exitCode = 1
  }
  if (modelAfterSelect.chip !== 'DeepSeek V4 Pro') {
    console.error(`\n✗ El chip no muestra el modelo elegido: ${modelAfterSelect.chip}`)
    process.exitCode = 1
  }
  if (!String(modelAfterSelect.subtitle ?? '').includes('DeepSeek V4 Pro')) {
    console.error('\n✗ La cabecera no muestra el modelo en el subtítulo')
    process.exitCode = 1
  }
  if (chatAudit.historyThumbs < 1) {
    console.error('\n✗ La miniatura no aparece en el historial del mensaje enviado')
    process.exitCode = 1
  }
  if (chatAudit.pendingAttachments !== 0) {
    console.error('\n✗ El compositor conserva adjuntos después de enviar')
    process.exitCode = 1
  }
  if (!settingsModelRow || !settingsModelRow.includes('Modelo por defecto')) {
    console.error('\n✗ Ajustes no muestra el modelo por defecto')
    process.exitCode = 1
  }
  if (!defaultModelOptions) {
    console.error('\n✗ La lista de modelos no se despliega en Ajustes')
    process.exitCode = 1
  }
  if (!readonlyAudit || readonlyAudit.historyThumbs < 1) {
    console.error('\n✗ El histórico de solo lectura no muestra la miniatura del adjunto')
    process.exitCode = 1
  }

  if (audit.overflowX > 1) {
    console.error('\n✗ Hay scroll horizontal')
    process.exitCode = 1
  }
  if (chatAudit.ariaLive !== 'polite') {
    console.error('\n✗ La lista de mensajes no tiene aria-live="polite"')
    process.exitCode = 1
  }
  if (!errorVisible) {
    console.error('\n✗ No se mostró el error del turno')
    process.exitCode = 1
  }
  if (!retryVisible) {
    console.error('\n✗ El error no ofrece botón «Reintentar»')
    process.exitCode = 1
  }
  if (!readonlyAudit) {
    console.error('\n✗ No se encontró el chat de solo lectura en la lista')
    process.exitCode = 1
  } else if (readonlyAudit.hasComposer || !readonlyAudit.hasNewChatButton) {
    console.error('\n✗ El chat de solo lectura permite composer o no ofrece «Nueva conversación»')
    process.exitCode = 1
  }
  if (audit.serviceWorkers < 1) {
    console.error('\n✗ El service worker no se registró')
    process.exitCode = 1
  }
  if (cdp.exceptions.length > 0) {
    console.error('\n✗ Hay excepciones JS')
    process.exitCode = 1
  }

  // 10. Shell nativo simulado: dentro del APK el origen es http://localhost
  //     y la API vive en el PC (aquí, el mock por 127.0.0.1).
  const nativeOrigin = new URL(BASE)
  nativeOrigin.hostname = 'localhost'
  const pcAddress = BASE

  await cdp.send('Page.navigate', { url: `${nativeOrigin.origin}/` })
  await sleep(500)
  await cdp.waitForSelector('#pair-server', 12000)
  await cdp.waitForSelector('#pair-code')
  await sleep(700)
  const remoteDefault = await cdp.evaluate(
    `document.querySelector('#pair-server')?.value ?? null`,
  )
  const localLinkVisible = await cdp.evaluate(
    `[...document.querySelectorAll('.pair__link')].some((button) => button.textContent.includes('IP local'))`,
  )
  await cdp.screenshot('11-apk-direccion-pc.png')

  // Validación de una dirección incorrecta: el envío la rechaza con error claro.
  await cdp.evaluate(setInput('#pair-server', 'no-es-una-url'))
  await cdp.evaluate(setInput('#pair-code', '123456'))
  await sleep(120)
  await cdp.evaluate(`document.querySelector('.pair__form button[type="submit"]').click()`)
  await sleep(300)
  const invalidServerVisible = await cdp.evaluate(`Boolean(document.querySelector('.field-error'))`)
  await cdp.screenshot('11b-apk-direccion-invalida.png')

  // IP local + "Probar conexión" contra el PC.
  await cdp.evaluate(clickText('.pair__link', 'IP local'))
  await sleep(300)
  const localFieldVisible = await cdp.evaluate(
    `Boolean(document.querySelector('#pair-server-local'))`,
  )
  await cdp.evaluate(setInput('#pair-server-local', pcAddress))
  await sleep(200)
  await cdp.evaluate(`document.querySelector('.connection-test').click()`)
  await sleep(1600)
  const connectionTestResult = await cdp.evaluate(
    `document.querySelector('.connection-test__result')?.textContent?.trim() ?? null`,
  )
  await cdp.screenshot('11c-apk-probar-conexion.png')

  // Emparejar contra el PC por su IP (origen distinto al del shell).
  await cdp.evaluate(setInput('#pair-server', pcAddress))
  await sleep(120)
  await cdp.evaluate(`document.querySelector('.pair__form button[type="submit"]').click()`)
  await cdp.waitForSelector('.ws-card', 15000)
  await sleep(700)
  const storedBase = await cdp.evaluate(`localStorage.getItem('nexo.server.v1')`)
  await cdp.screenshot('12-apk-proyectos.png')

  // Ajustes: dirección actual, modo de conexión y botón para cambiarla.
  await cdp.evaluate(`document.querySelector('button[aria-label="Ajustes"]').click()`)
  await cdp.waitForSelector('.sheet__panel')
  await sleep(600)
  await cdp.screenshot('13-apk-ajustes.png')
  const nativeSettings = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.settings-row')];
    const addressRow = rows.find((row) => row.textContent.includes('Dirección del PC'));
    const modeRow = rows.find((row) => row.textContent.includes('Modo de conexión'));
    const change = [...document.querySelectorAll('.sheet__panel button')]
      .some((button) => button.textContent.includes('Cambiar dirección del PC'));
    return {
      address: addressRow?.querySelector('.settings-row__value')?.textContent ?? null,
      mode: modeRow?.querySelector('.settings-row__value')?.textContent ?? null,
      change,
    };
  })()`)

  // Cambiar dirección → desconecta y vuelve al emparejamiento prefijado.
  await cdp.evaluate(clickText('.sheet__panel button', 'Cambiar dirección del PC'))
  await cdp.waitForSelector('#pair-server', 12000)
  await sleep(500)
  const prefilledAddress = await cdp.evaluate(
    `document.querySelector('#pair-server')?.value ?? null`,
  )
  await cdp.screenshot('14-apk-cambiar-direccion.png')

  console.log('\n  Auditoría shell nativo simulado (APK):')
  console.log(`   campo dirección:     sí`)
  console.log(`   remota por defecto:  ${remoteDefault}`)
  console.log(`   enlace IP local:     ${localLinkVisible}`)
  console.log(`   campo IP local:      ${localFieldVisible}`)
  console.log(`   probar conexión:     ${connectionTestResult}`)
  console.log(`   validación inválida: ${invalidServerVisible}`)
  console.log(`   guardada en storage: ${storedBase}`)
  console.log(`   ajustes dirección:   ${nativeSettings.address}`)
  console.log(`   ajustes modo:        ${nativeSettings.mode}`)
  console.log(`   botón cambiar:       ${nativeSettings.change}`)
  console.log(`   prefijado al volver: ${prefilledAddress}`)

  if (!invalidServerVisible) {
    console.error('\n✗ La dirección inválida no muestra error')
    process.exitCode = 1
  }
  if (remoteDefault !== process.env.NEXO_TEST_REMOTE_URL ?? 'https://equipo.tailnet.ts.net:8443') {
    console.error(`\n✗ La dirección remota por defecto no es la esperada: ${remoteDefault}`)
    process.exitCode = 1
  }
  if (!localLinkVisible || !localFieldVisible) {
    console.error('\n✗ No aparece el enlace/campo de IP local')
    process.exitCode = 1
  }
  if (!String(connectionTestResult ?? '').startsWith('✓')) {
    console.error(`\n✗ «Probar conexión» no muestra éxito: ${connectionTestResult}`)
    process.exitCode = 1
  }
  if (storedBase !== pcAddress) {
    console.error('\n✗ La dirección del PC no se guardó al emparejar')
    process.exitCode = 1
  }
  if (nativeSettings.address !== pcAddress || !nativeSettings.change) {
    console.error('\n✗ Ajustes no muestra la dirección del PC o el botón para cambiarla')
    process.exitCode = 1
  }
  if (!nativeSettings.mode || !nativeSettings.mode.includes('Red local')) {
    console.error(`\n✗ Ajustes no infiere el modo de conexión: ${nativeSettings.mode}`)
    process.exitCode = 1
  }
  if (prefilledAddress !== pcAddress) {
    console.error('\n✗ El campo no aparece prefijado con la última dirección')
    process.exitCode = 1
  }

  console.log(`\nCapturas en ${shotsDir}\n`)
} catch (error) {
  console.error('✗', error.message)
  try {
    await cdp.screenshot('99-error.png')
  } catch {
    // sin captura
  }
  process.exitCode = 1
} finally {
  try {
    cdp.socket.close()
  } catch {
    // ya cerrado
  }
  chrome.kill()
  await sleep(300)
  try {
    rmSync(profileDir, { recursive: true, force: true })
  } catch {
    // perfil bloqueado en Windows: se deja en temp
  }
}
