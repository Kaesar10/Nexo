/** Tipos del contrato del puente. Fuente: docs/API.md (congelado). */

export interface DeviceSession {
  token: string
  deviceId: string
  deviceName: string
}

export interface Health {
  ok: boolean
  version: string
  dsh: { ok: boolean; profile: string }
}

export interface Me {
  deviceId: string
  deviceName: string
  serverVersion: string
}

/** Modelo del agente disponible en el puente. */
export interface ModelInfo {
  id: string
  name: string
  hint: string
  isDefault: boolean
}

/** Adjunto resuelto que devuelve el puente en un mensaje. */
export interface Attachment {
  id: string
  name: string
  mime?: string
  url?: string
  /** Tamaño en bytes (puede faltar en históricos antiguos). */
  size?: number
}

/** Referencia mínima que se manda al publicar un mensaje con adjuntos. */
export interface MessageAttachmentRef {
  id: string
  name: string
}

/** Respuesta de POST /api/uploads. */
export interface UploadResult {
  id: string
  name: string
  mime: string
  size: number
  url: string
}

/** Estado del motor de dictado local del PC. */
export interface VoiceStatus {
  available: boolean
  engine?: string | null
  model?: string | null
  reason?: string | null
}

/** Respuesta de POST /api/transcribe. */
export interface TranscribeResult {
  text: string
}

export type ActivityStatus = 'completed' | 'error' | 'aborted'

/** Entrada del registro de actividad del puente. */
export interface ActivityEntry {
  id: string
  chatId: string
  title: string
  workspaceName: string
  status: ActivityStatus
  durationMs: number
  tools: string[]
  model?: string | null
  at: number
}

export interface Workspace {
  id: string
  name: string
  path: string
  isGit: boolean
  lastActiveAt: number
  chatsCount: number
}

export interface ChatSummary {
  id: string
  title: string
  updatedAt: number
  preview: string
  /** Puede faltar en chats grandes (el puente lo calcula solo a veces). */
  messageCount?: number | null
  /** `false` = sesión creada en el escritorio: solo lectura desde el móvil. */
  adoptable?: boolean
  /** Modelo de la sesión (null en sesiones antiguas/de escritorio). */
  model?: string | null
}

export type MessageRole = 'user' | 'assistant'

export interface Message {
  id: string
  role: MessageRole
  text: string
  at: number
  /** Solo en el cliente: mensaje de error legible pintado como burbuja del agente. */
  error?: boolean
  /** Solo en el cliente: la respuesta se está escribiendo ahora mismo. */
  streaming?: boolean
  /** Imágenes adjuntas resueltas por el puente (o locales, en el mensaje optimista). */
  attachments?: Attachment[]
}

export interface ChatDetail {
  id: string
  title: string
  workspaceId: string
  workspacePath: string
  messages: Message[]
  /** `false` = sesión creada en el escritorio: solo lectura desde el móvil. */
  adoptable?: boolean
  /** Modelo de la sesión (null en sesiones antiguas/de escritorio). */
  model?: string | null
}

export interface BrowseEntry {
  name: string
  path: string
  isDir: boolean
}

export interface BrowseResult {
  path: string
  parent: string | null
  entries: BrowseEntry[]
}

export interface SendResult {
  chatId: string
  turnId: string
}

export interface TurnEndEvent {
  type: 'turn_end'
  chatId: string
  status: 'completed' | 'error' | 'aborted'
  text?: string
}

export type ServerEvent =
  | { type: 'hello'; serverVersion: string }
  | { type: 'turn_start'; chatId: string; turnId: string }
  | { type: 'thinking'; chatId: string }
  | { type: 'tool'; chatId: string; tool: string; status: 'start' | 'done'; label?: string }
  | { type: 'delta'; chatId: string; text: string }
  | { type: 'title'; chatId: string; title: string }
  | TurnEndEvent
  | { type: 'error'; chatId?: string; message: string }
  | { type: 'heartbeat' }

/** Estado de la conexión SSE con el puente. */
export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'offline'

/** Estado visual del orbe de presencia. */
export type OrbState = 'idle' | 'thinking' | 'responding'
