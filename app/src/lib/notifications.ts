/**
 * Notificaciones locales al terminar tareas largas.
 * - APK: plugin `@capacitor/local-notifications` vía window.Capacitor.Plugins.
 * - PWA: Notification API / service worker.
 */
const PREF_KEY = 'nexo.notify.v1'

import { getPushStatus } from './push'

type NotificationPermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported'

interface LocalNotificationsPlugin {
  checkPermissions?: () => Promise<unknown> | unknown
  requestPermissions?: () => Promise<unknown> | unknown
  schedule?: (options: unknown) => Promise<void> | void
  addListener?: (event: string, listener: (data: unknown) => void) => unknown
}

const openedHandlers = new Set<(chatId: string | null) => void>()

function nativePlugin(): LocalNotificationsPlugin | null {
  const plugins = window.Capacitor?.Plugins
  if (!plugins || typeof plugins !== 'object') return null
  const plugin = (plugins as Record<string, unknown>)['LocalNotifications']
  return plugin && typeof plugin === 'object' ? (plugin as LocalNotificationsPlugin) : null
}

function readRecord(data: unknown): Record<string, unknown> | null {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : null
}

function readDisplay(data: unknown): string | null {
  const record = readRecord(data)
  for (const key of ['display', 'permission', 'status', 'state']) {
    const value = record?.[key]
    if (typeof value === 'string') return value
  }
  return null
}

function mapPermission(value: string | null): NotificationPermissionState {
  switch (value) {
    case 'granted':
      return 'granted'
    case 'denied':
      return 'denied'
    case 'prompt':
    case 'prompt-with-rationale':
    case 'default':
      return 'prompt'
    default:
      return 'unsupported'
  }
}

export function notificationsSupported(): boolean {
  return Boolean(nativePlugin()) || (typeof window !== 'undefined' && 'Notification' in window)
}

export function getNotificationsEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(PREF_KEY)
    return raw === null ? true : raw === '1'
  } catch {
    return true
  }
}

export function setNotificationsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(PREF_KEY, enabled ? '1' : '0')
  } catch {
    // almacenamiento no disponible
  }
}

export async function getNotificationPermission(): Promise<NotificationPermissionState> {
  const plugin = nativePlugin()
  if (plugin?.checkPermissions) {
    try {
      return mapPermission(readDisplay(await plugin.checkPermissions()))
    } catch {
      return 'unsupported'
    }
  }
  if (typeof Notification === 'undefined') return 'unsupported'
  return mapPermission(Notification.permission)
}

export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  const plugin = nativePlugin()
  if (plugin?.requestPermissions) {
    try {
      return mapPermission(readDisplay(await plugin.requestPermissions()))
    } catch {
      return 'denied'
    }
  }
  if (typeof Notification === 'undefined') return 'unsupported'
  try {
    return mapPermission(await Notification.requestPermission())
  } catch {
    return 'denied'
  }
}

function emitOpened(chatId: string | null): void {
  for (const handler of [...openedHandlers]) {
    try {
      handler(chatId)
    } catch {
      // aislar suscriptores
    }
  }
}

function chatIdFromNativeAction(data: unknown): string | null {
  const record = readRecord(data)
  const notification = readRecord(record?.['notification'])
  const extra = readRecord(notification?.['extra'])
  const chatId = extra?.['chatId']
  return typeof chatId === 'string' ? chatId : null
}

/** Registra el handler que abre el chat al tocar una notificación. */
export function onNotificationOpened(handler: (chatId: string | null) => void): () => void {
  openedHandlers.add(handler)

  let nativeOff: (() => void) | null = null
  const plugin = nativePlugin()
  if (plugin?.addListener) {
    try {
      const listener = plugin.addListener('localNotificationActionPerformed', (data) => {
        emitOpened(chatIdFromNativeAction(data))
      })
      if (listener && typeof (listener as { remove?: unknown }).remove === 'function') {
        nativeOff = () => {
          void (listener as { remove: () => Promise<void> }).remove()
        }
      }
    } catch {
      // plugin sin eventos
    }
  }

  const onMessage = (event: MessageEvent) => {
    const data = readRecord(event.data)
    if (data?.['type'] === 'nexo:open-chat') {
      const chatId = data['chatId']
      emitOpened(typeof chatId === 'string' ? chatId : null)
    }
  }
  const hasServiceWorker = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
  if (hasServiceWorker) navigator.serviceWorker.addEventListener('message', onMessage)

  return () => {
    openedHandlers.delete(handler)
    if (hasServiceWorker) navigator.serviceWorker.removeEventListener('message', onMessage)
    nativeOff?.()
  }
}

/** Muestra la notificación de fin de tarea si hay permiso y está activada. */
export async function notifyTaskFinished(
  title: string,
  body: string,
  chatId: string | null,
): Promise<boolean> {
  if (!getNotificationsEnabled()) return false
  // En el APK el servicio en primer plano es quien avisa (llega aunque la app
  // esté cerrada). Evitamos así la notificación duplicada.
  const push = await getPushStatus()
  if (push?.configured) return false
  const permission = await getNotificationPermission()
  if (permission !== 'granted') return false

  const plugin = nativePlugin()
  if (plugin?.schedule) {
    try {
      await plugin.schedule({
        notifications: [
          {
            id: Math.floor(Date.now() % 2_147_483_647),
            title,
            body,
            schedule: { at: new Date(Date.now() + 200) },
            extra: chatId ? { chatId } : {},
          },
        ],
      })
      return true
    } catch {
      return false
    }
  }

  if (typeof Notification === 'undefined') return false
  try {
    const registration = await navigator.serviceWorker?.getRegistration?.()
    if (registration) {
      await registration.showNotification(title, {
        body,
        icon: '/icons/icon-192.png',
        tag: chatId ? `nexo-${chatId}` : 'nexo-turn',
        data: chatId ? { chatId } : {},
      })
      return true
    }
    const notification = new Notification(title, {
      body,
      icon: '/icons/icon-192.png',
      tag: chatId ? `nexo-${chatId}` : 'nexo-turn',
      data: chatId ? { chatId } : {},
    })
    notification.onclick = () => {
      window.focus()
      emitOpened(chatId)
      notification.close()
    }
    return true
  } catch {
    return false
  }
}
