import { getServerBase } from './lib/server'
import type {
  ActivityEntry,
  BrowseResult,
  ChatDetail,
  ChatSummary,
  DeviceSession,
  Health,
  Me,
  MessageAttachmentRef,
  ModelInfo,
  SendResult,
  TranscribeResult,
  UploadResult,
  VoiceStatus,
  Workspace,
} from './types'

const rawBase = (import.meta.env.VITE_API_BASE ?? '').trim()
/** Base de build (VITE_API_BASE). Vacía = mismo origen (la sirve el puente). */
export const API_BASE = rawBase.replace(/\/+$/, '')

/**
 * Base efectiva de la API: la dirección del PC guardada por el shell nativo
 * (APK) tiene prioridad; si no hay ninguna, se usa la de build / mismo origen.
 */
export function getApiBase(): string {
  return getServerBase() || API_BASE
}

let authToken: string | null = null
let unauthorizedHandler: (() => void) | null = null

export function setAuthToken(token: string | null): void {
  authToken = token
}

export function getAuthToken(): string | null {
  return authToken
}

/** Se invoca cuando una petición autenticada devuelve 401 (token revocado). */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE'
  body?: unknown
  auth?: boolean
}

function extractError(payload: unknown): { code: string; message: string } {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const nested = record['error']
    if (nested && typeof nested === 'object') {
      const error = nested as Record<string, unknown>
      const code = typeof error['code'] === 'string' ? error['code'] : 'INTERNAL'
      const message = typeof error['message'] === 'string' ? error['message'] : ''
      return { code, message }
    }
    if (typeof record['message'] === 'string') {
      return { code: 'INTERNAL', message: record['message'] }
    }
  }
  return { code: 'INTERNAL', message: '' }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true } = options
  const headers = new Headers({ Accept: 'application/json' })
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  if (auth && authToken) headers.set('Authorization', `Bearer ${authToken}`)

  let response: Response
  try {
    response = await fetch(getApiBase() + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'NETWORK', 'No se pudo conectar con el PC.')
  }

  const raw = await response.text()
  let payload: unknown = null
  if (raw) {
    try {
      payload = JSON.parse(raw)
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    const { code, message } = extractError(payload)
    if (response.status === 401 && auth && authToken) unauthorizedHandler?.()
    throw new ApiError(response.status, code, message)
  }

  return payload as T
}

/** Traduce cualquier error del cliente a un texto legible en español. */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'NETWORK' || error.status === 0) {
      return 'No se pudo conectar con el PC. Comprueba que el puente esté encendido y que ambos estéis en la misma red.'
    }
    if (error.message) return error.message
    switch (error.code) {
      case 'UNAUTHORIZED':
        return 'Tu dispositivo ya no está autorizado. Vuelve a emparejarlo.'
      case 'CONFLICT':
        return 'Ya hay una respuesta en marcha en este chat.'
      case 'NOT_FOUND':
        return 'No se ha encontrado lo que buscabas.'
      case 'BAD_REQUEST':
        return 'La petición no es válida.'
      case 'VOICE_UNAVAILABLE':
        return 'El dictado en el PC no está disponible en este puente. Cambia a «Nativo del móvil» en Ajustes.'
      default:
        return 'El puente devolvió un error inesperado.'
    }
  }
  if (error instanceof Error && error.message) return error.message
  return 'Ha ocurrido un error inesperado.'
}

function browseQuery(path?: string): string {
  return path ? `?path=${encodeURIComponent(path)}` : ''
}

/** Convierte una ruta de API en URL absoluta (necesario dentro del APK). */
export function resolveApiUrl(url: string): string {
  if (!url) return url
  if (/^(https?:|blob:|data:)/i.test(url)) return url
  const base = getApiBase()
  if (!base) return url.startsWith('/') ? url : `/${url}`
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`
}

/* Las imágenes no pueden llevar la cabecera Authorization desde un <img>,
   así que las descargamos con fetch autenticado y las servimos como blob URL. */
const attachmentObjectUrls = new Map<string, string>()
const attachmentRequests = new Map<string, Promise<string>>()

export function loadAttachmentObjectUrl(url: string): Promise<string> {
  if (!url || /^(blob:|data:)/i.test(url)) return Promise.resolve(url)
  const resolved = resolveApiUrl(url)
  const cached = attachmentObjectUrls.get(resolved)
  if (cached) return Promise.resolve(cached)
  const pending = attachmentRequests.get(resolved)
  if (pending) return pending

  const request = (async () => {
    const headers = new Headers()
    if (authToken) headers.set('Authorization', `Bearer ${authToken}`)
    const response = await fetch(resolved, { headers })
    if (!response.ok) {
      throw new ApiError(response.status, 'INTERNAL', 'No se pudo cargar la imagen adjunta.')
    }
    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    attachmentObjectUrls.set(resolved, objectUrl)
    return objectUrl
  })().finally(() => {
    attachmentRequests.delete(resolved)
  })

  attachmentRequests.set(resolved, request)
  return request
}

export interface SendOptions {
  model?: string | null
  attachments?: MessageAttachmentRef[]
}

function messageBody(text: string, options: SendOptions = {}): Record<string, unknown> {
  return {
    text,
    ...(options.model ? { model: options.model } : {}),
    ...(options.attachments && options.attachments.length > 0
      ? { attachments: options.attachments }
      : {}),
  }
}

/** Cliente tipado del contrato docs/API.md. */
export const api = {
  pair(code: string, deviceName: string): Promise<DeviceSession> {
    return request<DeviceSession>('/api/pair', {
      method: 'POST',
      body: { code, deviceName },
      auth: false,
    })
  },

  health(): Promise<Health> {
    return request<Health>('/api/health', { auth: false })
  },

  me(): Promise<Me> {
    return request<Me>('/api/me')
  },

  async workspaces(): Promise<Workspace[]> {
    const data = await request<{ workspaces: Workspace[] }>('/api/workspaces')
    return data.workspaces
  },

  async addWorkspace(path: string, name: string): Promise<Workspace> {
    const data = await request<{ workspace: Workspace }>('/api/workspaces', {
      method: 'POST',
      body: { path, name },
    })
    return data.workspace
  },

  deleteWorkspace(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/workspaces/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },

  browse(path?: string): Promise<BrowseResult> {
    return request<BrowseResult>(`/api/browse${browseQuery(path)}`)
  },

  async chats(workspaceId: string): Promise<ChatSummary[]> {
    const data = await request<{ chats: ChatSummary[] }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/chats`,
    )
    return data.chats
  },

  chat(chatId: string): Promise<ChatDetail> {
    return request<ChatDetail>(`/api/chats/${encodeURIComponent(chatId)}`)
  },

  async models(): Promise<ModelInfo[]> {
    const data = await request<{ models: ModelInfo[] }>('/api/models')
    return data.models
  },

  voiceStatus(): Promise<VoiceStatus> {
    return request<VoiceStatus>('/api/voice-status')
  },

  async activity(limit = 30): Promise<ActivityEntry[]> {
    const data = await request<{ activity: ActivityEntry[] }>(`/api/activity?limit=${limit}`)
    return data.activity
  },

  transcribe(audio: string, language = 'es'): Promise<TranscribeResult> {
    return request<TranscribeResult>('/api/transcribe', {
      method: 'POST',
      body: { audio, language },
    })
  },

  upload(
    workspaceId: string,
    payload: { name: string; mime: string; data: string },
  ): Promise<UploadResult> {
    return request<UploadResult>('/api/uploads', {
      method: 'POST',
      body: { workspaceId, ...payload },
    })
  },

  sendToWorkspace(workspaceId: string, text: string, options: SendOptions = {}): Promise<SendResult> {
    return request<SendResult>(`/api/workspaces/${encodeURIComponent(workspaceId)}/messages`, {
      method: 'POST',
      body: messageBody(text, options),
    })
  },

  sendToChat(chatId: string, text: string, options: SendOptions = {}): Promise<SendResult> {
    return request<SendResult>(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      body: messageBody(text, options),
    })
  },

  /** Continúa una conversación no adoptable en una sesión nueva con su contexto. */
  forkChat(chatId: string, text: string, options: SendOptions = {}): Promise<SendResult> {
    return request<SendResult>(`/api/chats/${encodeURIComponent(chatId)}/fork`, {
      method: 'POST',
      body: messageBody(text, options),
    })
  },

  stop(chatId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/chats/${encodeURIComponent(chatId)}/stop`, {
      method: 'POST',
    })
  },
}
