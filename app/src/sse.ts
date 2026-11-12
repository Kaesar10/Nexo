import { ApiError, api, getApiBase } from './api'
import type { ConnStatus, ServerEvent } from './types'

type EventListener = (event: ServerEvent) => void
type StatusListener = (status: ConnStatus) => void

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000]
const KNOWN_EVENTS = new Set<ServerEvent['type']>([
  'hello',
  'turn_start',
  'thinking',
  'tool',
  'delta',
  'title',
  'turn_end',
  'error',
  'heartbeat',
])

function parseEvent(raw: string): ServerEvent | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const type = (data as { type?: unknown }).type
  if (typeof type !== 'string' || !KNOWN_EVENTS.has(type as ServerEvent['type'])) return null
  return data as ServerEvent
}

/**
 * Conexión SSE con reconexión manual y backoff exponencial.
 * EventSource no permite cabeceras: el token viaja en `?token=`.
 */
export class EventStream {
  private readonly token: string
  private readonly onFatal: (() => void) | undefined
  private source: EventSource | null = null
  private reconnectTimer: number | null = null
  private stableTimer: number | null = null
  private attempts = 0
  private stopped = false
  private status: ConnStatus = 'connecting'
  private readonly eventListeners = new Set<EventListener>()
  private readonly statusListeners = new Set<StatusListener>()

  constructor(token: string, onFatal?: () => void) {
    this.token = token
    this.onFatal = onFatal
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    listener(this.status)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  start(): void {
    if (this.source) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.closeSource()
    this.setStatus('offline')
  }

  private setStatus(status: ConnStatus): void {
    if (this.status === status) return
    this.status = status
    for (const listener of this.statusListeners) listener(status)
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event)
      } catch {
        // aislar suscriptores
      }
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.stableTimer !== null) {
      window.clearTimeout(this.stableTimer)
      this.stableTimer = null
    }
  }

  private closeSource(): void {
    if (!this.source) return
    this.source.onopen = null
    this.source.onmessage = null
    this.source.onerror = null
    this.source.close()
    this.source = null
  }

  private connect(): void {
    if (this.stopped) return
    this.closeSource()
    this.setStatus(this.attempts === 0 ? 'connecting' : 'reconnecting')

    const url = `${getApiBase()}/api/events?token=${encodeURIComponent(this.token)}`
    const source = new EventSource(url)
    this.source = source

    source.onopen = () => {
      this.setStatus('open')
      // Si la conexión aguanta, reiniciamos el contador de backoff.
      if (this.stableTimer !== null) window.clearTimeout(this.stableTimer)
      this.stableTimer = window.setTimeout(() => {
        this.attempts = 0
        this.stableTimer = null
      }, 5000)
    }

    source.onmessage = (message: MessageEvent<string>) => {
      const event = parseEvent(message.data)
      if (event) this.emit(event)
    }

    source.onerror = () => {
      this.closeSource()
      if (this.stopped) return
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    this.attempts += 1
    this.setStatus('reconnecting')
    const base = BACKOFF_MS[Math.min(this.attempts - 1, BACKOFF_MS.length - 1)] ?? 30000
    const delay = base + Math.round(Math.random() * 400)
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      void this.probeThenReconnect()
    }, delay)
  }

  private async probeThenReconnect(): Promise<void> {
    if (this.stopped) return
    // Tras varios fallos, comprobamos si el token sigue siendo válido.
    if (this.attempts >= 3) {
      try {
        await api.me()
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          this.stop()
          this.onFatal?.()
          return
        }
      }
      if (this.stopped) return
    }
    this.connect()
  }
}
