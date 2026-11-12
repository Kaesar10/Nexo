import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { api, errorText, loadAttachmentObjectUrl } from '../api'
import { bus } from '../eventBus'
import {
  AlertCircle,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  FileText,
  ImageIcon,
  Lock,
  Mic,
  Paperclip,
  Plus,
  Refresh,
  Sparkles,
  StopIcon,
  X,
} from '../components/Icons'
import { ModelSheet } from '../components/ModelSheet'
import { Orb } from '../components/Orb'
import { TopBar } from '../components/TopBar'
import { attachmentBaseName, isImageAttachment, splitMessageText } from '../lib/attachments'
import { dayKey, daySeparatorLabel } from '../lib/format'
import {
  blobToBase64,
  FILE_ACCEPT,
  formatBytes,
  PHOTO_ACCEPT,
  prepareAttachment,
} from '../lib/files'
import { openExternal, parseAssistantContent } from '../lib/links'
import { getStoredDefaultModelId, modelName, resolveModelId } from '../lib/models'
import { getNotificationsEnabled, notifyTaskFinished } from '../lib/notifications'
import {
  getNotificationPermission,
  requestNotificationPermission,
} from '../lib/notifications'
import { isAppActive } from '../lib/appState'
import { createPcSpeechSession, createSpeechSession, detectSpeech } from '../lib/speech'
import type { SpeechKind, SpeechSession } from '../lib/speech'
import { getVoiceEngine } from '../lib/voice'
import type {
  Attachment,
  ConnStatus,
  Message,
  MessageAttachmentRef,
  ModelInfo,
  ServerEvent,
  UploadResult,
  VoiceStatus,
  Workspace,
} from '../types'

interface ChatScreenProps {
  workspace: Workspace
  chatId: string | null
  initialTitle?: string
  initialModel?: string | null
  models: ModelInfo[]
  voiceStatus: VoiceStatus | null
  status: ConnStatus
  onBack: () => void
  onOpenSettings: () => void
  onOpenDrawer: () => void
  onOpenAgent: () => void
  onNewChat: () => void
  onForked?: (chatId: string) => void
}

interface LiveTurn {
  userText: string
  userAttachments: Attachment[]
  assistantText: string
  running: boolean
  stopping: boolean
  activity: string | null
  error: string | null
}

interface PendingAttachment {
  localId: string
  name: string
  mime: string
  size: number
  kind: 'image' | 'file'
  previewUrl: string
  status: 'uploading' | 'ready'
  remote?: UploadResult
}

interface RetryState {
  text: string
  attachments: Attachment[]
  refs: MessageAttachmentRef[]
}

interface PreviewState {
  url: string
  name: string
}

const MAX_ATTACHMENTS = 4

const IDLE_TURN: LiveTurn = {
  userText: '',
  userAttachments: [],
  assistantText: '',
  running: false,
  stopping: false,
  activity: null,
  error: null,
}

const SUGGESTIONS = [
  'Revisa el README y propón mejoras',
  '¿Qué hay en este proyecto?',
  '¿Por dónde empezamos?',
]

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `local-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function safeName(name: string): string {
  return name.trim() || 'archivo'
}

function toolActivity(event: Extract<ServerEvent, { type: 'tool' }>): string {
  if (event.label) return event.label
  switch (event.tool) {
    case 'read':
    case 'read_file':
      return 'Leyendo archivos…'
    case 'write':
    case 'edit':
      return 'Editando archivos…'
    case 'bash':
    case 'shell':
    case 'execute':
      return 'Ejecutando en tu PC…'
    case 'search':
    case 'grep':
      return 'Buscando en el proyecto…'
    default:
      return 'Trabajando…'
  }
}

function joinSpeech(base: string, text: string): string {
  const clean = text.trim()
  if (!base) return clean
  return `${base}${clean ? ' ' : ''}${clean}`
}

function AttachmentThumb({
  attachment,
  onOpen,
}: {
  attachment: Attachment
  onOpen: (preview: PreviewState) => void
}) {
  const directUrl = attachment.url && /^(blob:|data:)/i.test(attachment.url) ? attachment.url : null
  const [src, setSrc] = useState<string | null>(directUrl)
  const [broken, setBroken] = useState(false)

  useEffect(() => {
    if (directUrl) {
      setSrc(directUrl)
      return
    }
    if (!attachment.url) {
      setBroken(true)
      return
    }
    let alive = true
    loadAttachmentObjectUrl(attachment.url)
      .then((loaded) => {
        if (alive) setSrc(loaded)
      })
      .catch(() => {
        if (alive) setBroken(true)
      })
    return () => {
      alive = false
    }
  }, [attachment.url, directUrl])

  if (broken || !src) {
    return (
      <span className="attachment-chip attachment-chip--doc">
        <FileText size={14} />
        <span>{attachment.name}</span>
        {attachment.size ? <em>{formatBytes(attachment.size)}</em> : null}
      </span>
    )
  }

  return (
    <button
      type="button"
      className="thumb"
      onClick={() => onOpen({ url: src, name: attachment.name })}
      aria-label={`Ver ${attachment.name}`}
    >
      <img src={src} alt={attachment.name} loading="lazy" onError={() => setBroken(true)} />
    </button>
  )
}

function MessageAttachments({
  message,
  onOpen,
}: {
  message: Message
  onOpen: (preview: PreviewState) => void
}) {
  const { paths } = splitMessageText(message.text)
  const attachments = message.attachments ?? []
  if (attachments.length === 0 && paths.length === 0) return null

  return (
    <div className="msg__attachments">
      {attachments.map((attachment) =>
        isImageAttachment(attachment) ? (
          <AttachmentThumb key={attachment.id || attachment.name} attachment={attachment} onOpen={onOpen} />
        ) : (
          <span
            key={attachment.id || attachment.name}
            className="attachment-chip attachment-chip--doc"
          >
            <FileText size={14} />
            <span>{attachment.name}</span>
            {attachment.size ? <em>{formatBytes(attachment.size)}</em> : null}
          </span>
        ),
      )}
      {attachments.length === 0
        ? paths.map((path) => (
            <span key={path} className="attachment-chip attachment-chip--doc">
              <FileText size={14} />
              <span>{attachmentBaseName(path)}</span>
            </span>
          ))
        : null}
    </div>
  )
}

function MessageBubble({
  message,
  onOpen,
}: {
  message: Message
  onOpen: (preview: PreviewState) => void
}) {
  if (message.role === 'user') {
    const { text } = splitMessageText(message.text)
    return (
      <div className="msg msg--user">
        <div className="bubble-stack bubble-stack--user">
          <MessageAttachments message={message} onOpen={onOpen} />
          {text ? <p className="bubble bubble--user">{text}</p> : null}
        </div>
      </div>
    )
  }

  const { text, links } = parseAssistantContent(message.text)

  return (
    <div className={`msg msg--assistant${message.error ? ' msg--error' : ''}`}>
      <span className="msg__avatar">
        <Orb size={20} state={message.streaming ? 'responding' : 'idle'} />
      </span>
      <div className="bubble bubble--assistant">
        {message.error ? (
          <span className="msg__error-label">
            <AlertCircle size={13} />
            Error del agente
          </span>
        ) : null}
        {text || message.streaming ? (
          <p>
            {text}
            {message.streaming ? <span className="caret" aria-hidden="true" /> : null}
          </p>
        ) : null}
        {links.length > 0 ? (
          <div className="link-cards">
            {links.map((link) => (
              <button
                key={link.url}
                type="button"
                className="link-card"
                onClick={() => openExternal(link.url)}
                aria-label={`Abrir ${link.title}`}
              >
                <span className="link-card__main">
                  <small>{link.domain}</small>
                  <strong>{link.title}</strong>
                </span>
                <span className="link-card__open">
                  Abrir
                  <ChevronRight size={14} />
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function ChatScreen({
  workspace,
  chatId: initialChatId,
  initialTitle,
  initialModel,
  models,
  voiceStatus,
  status,
  onBack,
  onOpenSettings,
  onOpenDrawer,
  onOpenAgent,
  onNewChat,
  onForked,
}: ChatScreenProps) {
  const chatIdRef = useRef<string | null>(initialChatId)
  const [title, setTitle] = useState(initialTitle ?? '')
  const [adoptable, setAdoptable] = useState(true)
  const [modelId, setModelId] = useState(() =>
    resolveModelId(models, initialModel ?? getStoredDefaultModelId()),
  )
  const [history, setHistory] = useState<Message[]>([])
  const [loading, setLoading] = useState(initialChatId !== null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [turn, setTurn] = useState<LiveTurn>(IDLE_TURN)
  const turnRef = useRef<LiveTurn>(IDLE_TURN)
  const [draft, setDraft] = useState('')
  const [retry, setRetry] = useState<RetryState | null>(null)
  const [pinned, setPinned] = useState(true)
  const [pending, setPending] = useState<PendingAttachment[]>([])
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [voiceState, setVoiceState] = useState<'idle' | 'listening' | 'transcribing'>('idle')
  const [speechKind, setSpeechKind] = useState<SpeechKind | null>(null)
  const [modelSheetOpen, setModelSheetOpen] = useState(false)
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const documentInputRef = useRef<HTMLInputElement>(null)
  const bufferedEvents = useRef<ServerEvent[]>([])
  const pendingRef = useRef<PendingAttachment[]>([])
  const createdUrls = useRef<Set<string>>(new Set())
  const speechSessionRef = useRef<SpeechSession | null>(null)
  const speechBaseRef = useRef('')
  const turnStartedAtRef = useRef<number | null>(null)

  const preferredVoiceEngine = getVoiceEngine()
  const pcVoiceAvailable = voiceStatus?.available === true
  const voiceKind: 'native' | 'web' | 'pc' | null =
    preferredVoiceEngine === 'pc'
      ? pcVoiceAvailable
        ? 'pc'
        : speechKind
      : (speechKind ?? (pcVoiceAvailable ? 'pc' : null))

  const currentModelName = modelName(models, modelId)

  useEffect(() => {
    pendingRef.current = pending
  }, [pending])

  useEffect(() => {
    setModelId((current) => resolveModelId(models, current))
  }, [models])

  const updateTurn = useCallback((updater: (current: LiveTurn) => LiveTurn) => {
    const next = updater(turnRef.current)
    turnRef.current = next
    setTurn(next)
  }, [])

  const finishTurn = useCallback(
    (event: Extract<ServerEvent, { type: 'turn_end' }>) => {
      const current = turnRef.current
      const at = Date.now()
      const completed: Message[] = []
      if (current.userText || current.userAttachments.length > 0) {
        completed.push({
          id: makeId(),
          role: 'user',
          text: current.userText,
          at,
          attachments: current.userAttachments.length > 0 ? current.userAttachments : undefined,
        })
      }
      if (current.assistantText) {
        completed.push({ id: makeId(), role: 'assistant', text: current.assistantText, at })
      }
      if (event.status === 'error') {
        const message = event.text?.trim() || 'El agente no pudo completar la respuesta.'
        completed.push({ id: makeId(), role: 'assistant', text: message, at, error: true })
      }
      if (completed.length > 0) {
        setHistory((previous) => [...previous, ...completed])
      }
      if (event.status === 'error' && (current.userText || current.userAttachments.length > 0)) {
        setRetry({
          text: current.userText,
          attachments: current.userAttachments,
          refs: current.userAttachments.map((attachment) => ({
            id: attachment.id,
            name: attachment.name,
          })),
        })
      } else {
        setRetry(null)
      }

      // Notificación local si el turno fue largo y la app no estaba visible.
      const startedAt = turnStartedAtRef.current
      turnStartedAtRef.current = null
      if (
        event.status !== 'aborted' &&
        startedAt !== null &&
        Date.now() - startedAt > 8000 &&
        !isAppActive() &&
        getNotificationsEnabled()
      ) {
        const body =
          event.status === 'error'
            ? event.text?.trim() || 'El turno falló'
            : current.assistantText.trim() || 'Tarea terminada'
        void notifyTaskFinished(
          `Nexo · ${workspace.name}`,
          body.slice(0, 120),
          chatIdRef.current,
        )
      }

      updateTurn((value) => ({ ...IDLE_TURN, error: value.error }))
    },
    [updateTurn, workspace.name],
  )

  const handleEvent = useCallback(
    (event: ServerEvent) => {
      const activeChat = chatIdRef.current
      const eventChat = 'chatId' in event ? event.chatId : undefined

      // Chat nuevo: aún no sabemos su id hasta que responde el POST. Guardamos
      // los eventos y los reproducimos al adoptar el chatId.
      if (!activeChat) {
        if (eventChat) {
          bufferedEvents.current.push(event)
          if (bufferedEvents.current.length > 300) bufferedEvents.current.shift()
        }
        return
      }
      if (eventChat && eventChat !== activeChat) return

      switch (event.type) {
        case 'turn_start':
          turnStartedAtRef.current = turnStartedAtRef.current ?? Date.now()
          updateTurn((current) => ({
            ...current,
            running: true,
            stopping: false,
            activity: 'Pensando…',
            error: null,
          }))
          break
        case 'thinking':
          updateTurn((current) =>
            current.running ? { ...current, activity: 'Pensando…' } : current,
          )
          break
        case 'tool':
          updateTurn((current) => {
            if (!current.running) return current
            return {
              ...current,
              activity: event.status === 'start' ? toolActivity(event) : 'Pensando…',
            }
          })
          break
        case 'delta':
          updateTurn((current) => ({
            ...current,
            running: true,
            stopping: false,
            activity: null,
            assistantText: current.assistantText + event.text,
          }))
          break
        case 'title':
          setTitle(event.title)
          break
        case 'turn_end':
          finishTurn(event)
          break
        case 'error':
          updateTurn((current) => ({ ...current, error: event.message }))
          break
        case 'hello':
        case 'heartbeat':
          break
      }
    },
    [finishTurn, updateTurn],
  )

  useEffect(() => {
    const unsubscribe = bus.subscribe((event) => {
      if (event.type === 'hello' || event.type === 'heartbeat') return
      handleEvent(event)
    })
    return unsubscribe
  }, [handleEvent])

  // Carga del histórico al abrir un chat existente.
  useEffect(() => {
    if (!initialChatId) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    api
      .chat(initialChatId)
      .then((chat) => {
        if (cancelled) return
        setHistory(chat.messages)
        if (chat.title) setTitle(chat.title)
        setAdoptable(chat.adoptable !== false)
        if (chat.model) setModelId(resolveModelId(models, chat.model))
        setLoading(false)
      })
      .catch((error) => {
        if (cancelled) return
        setLoadError(errorText(error))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [initialChatId, reloadKey, models])

  // Dictado disponible (APK nativo o Web Speech).
  useEffect(() => {
    if (!adoptable) {
      setSpeechKind(null)
      return
    }
    let alive = true
    detectSpeech()
      .then((kind) => {
        if (alive) setSpeechKind(kind)
      })
      .catch(() => {
        if (alive) setSpeechKind(null)
      })
    return () => {
      alive = false
    }
  }, [adoptable])

  useEffect(
    () => () => {
      speechSessionRef.current?.stop()
      speechSessionRef.current = null
    },
    [],
  )

  useEffect(
    () => () => {
      for (const url of createdUrls.current) URL.revokeObjectURL(url)
      createdUrls.current.clear()
    },
    [],
  )

  useEffect(() => {
    if (!preview) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreview(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [preview])

  useEffect(() => {
    if (!attachMenuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('.attach-menu, .composer__tool--attach')) {
        return
      }
      setAttachMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [attachMenuOpen])

  // Composer que crece.
  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 140)}px`
  }, [draft])

  const scrollToBottom = useCallback((smooth = false) => {
    const element = scrollerRef.current
    if (!element) return
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  const handleScroll = useCallback(() => {
    const element = scrollerRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    setPinned(distance < 90)
  }, [])

  // Autoscroll solo si el usuario está abajo.
  useEffect(() => {
    if (!pinned) return
    scrollToBottom()
  }, [
    pinned,
    history,
    turn.assistantText,
    turn.userText,
    turn.activity,
    turn.running,
    scrollToBottom,
  ])

  const startUpload = useCallback(
    async (file: File) => {
      const localId = makeId()
      const isImage = file.type.startsWith('image/')
      const previewUrl = isImage ? URL.createObjectURL(file) : ''
      if (previewUrl) createdUrls.current.add(previewUrl)
      const item: PendingAttachment = {
        localId,
        name: safeName(file.name),
        mime: file.type,
        size: file.size,
        kind: isImage ? 'image' : 'file',
        previewUrl,
        status: 'uploading',
      }
      setPending((current) => [...current, item])

      try {
        const prepared = await prepareAttachment(file)
        const data = await blobToBase64(prepared.blob)
        const uploaded = await api.upload(workspace.id, {
          name: prepared.name,
          mime: prepared.mime,
          data,
        })
        setPending((current) =>
          current.map((candidate) =>
            candidate.localId === localId
              ? {
                  ...candidate,
                  name: uploaded.name,
                  mime: uploaded.mime,
                  size: uploaded.size,
                  kind: prepared.kind,
                  status: 'ready',
                  remote: uploaded,
                }
              : candidate,
          ),
        )
      } catch (error) {
        setPending((current) => current.filter((candidate) => candidate.localId !== localId))
        if (previewUrl) {
          URL.revokeObjectURL(previewUrl)
          createdUrls.current.delete(previewUrl)
        }
        setUploadError(errorText(error))
      }
    },
    [workspace.id],
  )

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const list = Array.from(files ?? [])
      if (list.length === 0) return
      setUploadError(null)
      const room = MAX_ATTACHMENTS - pendingRef.current.length
      if (list.length > room) {
        setUploadError(`Puedes adjuntar hasta ${MAX_ATTACHMENTS} archivos por mensaje.`)
      }
      for (const file of list.slice(0, Math.max(0, room))) {
        void startUpload(file)
      }
    },
    [startUpload],
  )

  const removePending = useCallback((localId: string) => {
    const item = pendingRef.current.find((candidate) => candidate.localId === localId)
    if (item) {
      URL.revokeObjectURL(item.previewUrl)
      createdUrls.current.delete(item.previewUrl)
    }
    setPending((current) => current.filter((candidate) => candidate.localId !== localId))
  }, [])

  const submitText = useCallback(
    async (
      rawText: string,
      options: {
        restoreDraft?: boolean
        pending?: PendingAttachment[]
        attachments?: Attachment[]
        refs?: MessageAttachmentRef[]
        model?: string
      } = {},
    ) => {
      const text = rawText.trim()
      const pendingItems = options.pending ?? []
      const displayAttachments =
        options.attachments ??
        pendingItems
          .filter((item) => item.status === 'ready' && item.remote)
          .map<Attachment>((item) => ({
            id: item.remote?.id ?? item.localId,
            name: item.remote?.name ?? item.name,
            mime: item.remote?.mime ?? item.mime,
            size: item.remote?.size ?? item.size,
            url: item.kind === 'image' ? item.previewUrl : undefined,
          }))
      const refs =
        options.refs ??
        pendingItems
          .filter((item) => item.status === 'ready' && item.remote)
          .map<MessageAttachmentRef>((item) => ({
            id: item.remote?.id ?? '',
            name: item.remote?.name ?? item.name,
          }))
          .filter((ref) => ref.id !== '')

      if ((!text && refs.length === 0) || turnRef.current.running) return
      const activeChat = chatIdRef.current
      const model = options.model ?? modelId
      turnStartedAtRef.current = Date.now()

      setRetry(null)
      setUploadError(null)
      updateTurn(() => ({
        ...IDLE_TURN,
        userText: text,
        userAttachments: displayAttachments,
        running: true,
        activity: 'Pensando…',
      }))
      setPinned(true)

      try {
        // Conversación del escritorio: se abre una sesión nueva con su contexto.
        if (activeChat && !adoptable && onForked) {
          const forked = await api.forkChat(activeChat, text, { model, attachments: refs })
          onForked(forked.chatId)
          return
        }
        const result = activeChat
          ? await api.sendToChat(activeChat, text, { model, attachments: refs })
          : await api.sendToWorkspace(workspace.id, text, { model, attachments: refs })

        if (!activeChat) {
          chatIdRef.current = result.chatId
          const pendingEvents = bufferedEvents.current
          bufferedEvents.current = []
          for (const pendingEvent of pendingEvents) {
            if ('chatId' in pendingEvent && pendingEvent.chatId === result.chatId) {
              handleEvent(pendingEvent)
            }
          }
        }
      } catch (error) {
        updateTurn((current) => ({
          ...current,
          running: false,
          stopping: false,
          activity: null,
          error: errorText(error),
        }))
        setRetry({ text, attachments: displayAttachments, refs })
        if (options.restoreDraft) {
          setDraft(text)
          if (pendingItems.length > 0) {
            setPending((current) => [
              ...pendingItems.filter((item) => item.status === 'ready'),
              ...current,
            ])
          }
        }
      }
      textareaRef.current?.focus()
    },
    [adoptable, handleEvent, modelId, onForked, updateTurn, workspace.id],
  )

  const send = useCallback(() => {
    const text = draft.trim()
    const ready = pending.filter((item) => item.status === 'ready' && item.remote)
    const uploading = pending.some((item) => item.status === 'uploading')
    if (uploading || voiceState !== 'idle' || (!text && ready.length === 0)) return
    // Pide permiso de notificaciones la primera vez que hace falta, para que el
    // aviso de "tarea terminada" no se quede bloqueado en silencio.
    if (getNotificationsEnabled()) {
      void (async () => {
        if ((await getNotificationPermission()) === 'prompt') {
          await requestNotificationPermission()
        }
      })()
    }
    setDraft('')
    setPending([])
    void submitText(text, { restoreDraft: true, pending: ready })
  }, [draft, pending, submitText, voiceState])

  const stop = useCallback(async () => {
    const activeChat = chatIdRef.current
    if (!activeChat) return
    updateTurn((current) => ({ ...current, stopping: true }))
    try {
      await api.stop(activeChat)
      // Red de seguridad por si el turn_end no llega.
      window.setTimeout(() => {
        if (turnRef.current.running) {
          updateTurn((current) => ({
            ...current,
            running: false,
            stopping: false,
            activity: null,
          }))
        }
      }, 4000)
    } catch (error) {
      updateTurn((current) => ({
        ...current,
        stopping: false,
        error: errorText(error),
      }))
    }
  }, [updateTurn])

  const toggleDictation = useCallback(async () => {
    if (voiceState === 'listening') {
      speechSessionRef.current?.stop()
      return
    }
    if (voiceState === 'transcribing' || !voiceKind) return
    setVoiceError(null)
    try {
      const session =
        voiceKind === 'pc'
          ? createPcSpeechSession({
              onPartial: (text) => setDraft(joinSpeech(speechBaseRef.current, text)),
              onFinal: (text) => setDraft(joinSpeech(speechBaseRef.current, text)),
              onError: (message) => setVoiceError(message),
              onTranscribing: () => setVoiceState('transcribing'),
              onEnd: () => {
                setVoiceState('idle')
                speechSessionRef.current = null
              },
            })
          : createSpeechSession({
              onPartial: (text) => setDraft(joinSpeech(speechBaseRef.current, text)),
              onFinal: (text) => setDraft(joinSpeech(speechBaseRef.current, text)),
              onError: (message) => setVoiceError(message),
              onEnd: () => {
                setVoiceState('idle')
                speechSessionRef.current = null
              },
            })
      speechBaseRef.current = draft.trim()
      setVoiceState('listening')
      await session.start()
      speechSessionRef.current = session
    } catch (error) {
      setVoiceState('idle')
      speechSessionRef.current = null
      setVoiceError(error instanceof Error ? error.message : 'No se pudo iniciar el dictado.')
    }
  }, [draft, voiceKind, voiceState])

  const readyAttachments = pending.filter((item) => item.status === 'ready' && item.remote)
  const uploading = pending.some((item) => item.status === 'uploading')
  const canSend =
    (draft.trim() !== '' || readyAttachments.length > 0) &&
    !uploading &&
    voiceState === 'idle'

  const liveMessages: Message[] = []
  if (turn.userText || turn.userAttachments.length > 0) {
    liveMessages.push({
      id: 'live-user',
      role: 'user',
      text: turn.userText,
      at: Date.now(),
      attachments: turn.userAttachments.length > 0 ? turn.userAttachments : undefined,
    })
  }
  if (turn.assistantText) {
    liveMessages.push({
      id: 'live-assistant',
      role: 'assistant',
      text: turn.assistantText,
      at: Date.now(),
      streaming: turn.running,
    })
  }
  const messages = [...history, ...liveMessages]
  const showEmpty = !loading && !loadError && messages.length === 0
  const headerTitle = title || 'Nueva conversación'
  const subtitle = [currentModelName, workspace.name, adoptable ? null : 'continúa aquí']
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="screen screen--chat">
      <TopBar
        onBack={onBack}
        onOpenDrawer={onOpenDrawer}
        onOpenAgent={onOpenAgent}
        title={headerTitle}
        subtitle={subtitle}
        status={status}
        onOpenSettings={onOpenSettings}
      />

      {status !== 'open' ? (
        <div className="chat__notices">
          <div className="notice notice--warn" role="status">
            <span className={`conn conn--${status}`} aria-hidden="true" />
            {status === 'connecting'
              ? 'Conectando con tu PC…'
              : status === 'reconnecting'
                ? 'Reconectando con el PC…'
                : 'Sin conexión con el PC.'}
          </div>
        </div>
      ) : null}

      {turn.error ? (
        <div className="chat__notices">
          <div className="notice notice--error" role="alert">
            <AlertCircle size={16} />
            <span>{turn.error}</span>
            <button
              type="button"
              className="notice__close"
              onClick={() => updateTurn((current) => ({ ...current, error: null }))}
              aria-label="Descartar aviso"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      ) : null}

      <div className="chat__scroller" ref={scrollerRef} onScroll={handleScroll}>
        {loading ? (
          <div className="messages" aria-hidden="true">
            <div className="skeleton skeleton--bubble skeleton--bubble-user" />
            <div className="skeleton skeleton--bubble skeleton--bubble-assistant" />
            <div className="skeleton skeleton--bubble skeleton--bubble-assistant skeleton--bubble-short" />
          </div>
        ) : loadError ? (
          <div className="inline-error" role="alert">
            <p>{loadError}</p>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              <Refresh size={16} />
              Reintentar
            </button>
          </div>
        ) : showEmpty ? (
          <div className="empty-chat">
            <Orb size={96} state="idle" />
            <h2>¿En qué trabajamos?</h2>
            <p>{workspace.name}</p>
            <div className="chips">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="chip"
                  onClick={() => {
                    setDraft(suggestion)
                    textareaRef.current?.focus()
                  }}
                >
                  <Sparkles size={15} />
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="messages" aria-live="polite" aria-relevant="additions text">
            {messages.map((message, index) => {
              const previous = messages[index - 1]
              const showSeparator = !previous || dayKey(previous.at) !== dayKey(message.at)
              return (
                <Fragment key={message.id}>
                  {showSeparator ? (
                    <div
                      className="day-separator"
                      role="separator"
                      aria-label={daySeparatorLabel(message.at)}
                    >
                      <span>{daySeparatorLabel(message.at)}</span>
                    </div>
                  ) : null}
                  <MessageBubble message={message} onOpen={setPreview} />
                </Fragment>
              )
            })}
            {turn.running && !turn.assistantText ? (
              <div className="activity" role="status">
                <span className="activity__dot" aria-hidden="true" />
                <span>{turn.activity ?? 'Pensando…'}</span>
              </div>
            ) : null}
            {retry && !turn.running ? (
              <div className="retry-row">
                <button
                  type="button"
                  className="btn btn--ghost btn--compact"
                  onClick={() =>
                    void submitText(retry.text, {
                      attachments: retry.attachments,
                      refs: retry.refs,
                    })
                  }
                >
                  <Refresh size={16} />
                  Reintentar
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {!pinned && messages.length > 0 && !loading && !loadError ? (
        <button
          type="button"
          className="scroll-down"
          onClick={() => {
            setPinned(true)
            scrollToBottom(true)
          }}
          aria-label="Ir al final de la conversación"
        >
          <ChevronDown size={20} />
        </button>
      ) : null}

      {!adoptable && !loading && !loadError ? (
        <div className="chat__readonly" role="note">
          <p>
            <Lock size={15} aria-hidden="true" />
            <span>
              Conversación creada en el escritorio. Si escribes aquí se abre una conversación
              nueva con su contexto, para que sigas donde lo dejaste.
            </span>
          </p>
          <button type="button" className="btn btn--ghost" onClick={onNewChat}>
            <Plus size={18} />
            Empezar de cero
          </button>
        </div>
      ) : null}

      {!loading && !loadError ? (
        <div className="composer">
          {pending.length > 0 ? (
            <div className="composer__attachments">
              {pending.map((item) =>
                item.kind === 'image' ? (
                  <div
                    key={item.localId}
                    className={`composer__attachment${item.status === 'uploading' ? ' is-uploading' : ''}`}
                  >
                    <img src={item.previewUrl} alt={item.name} />
                    {item.status === 'uploading' ? (
                      <span className="composer__attachment-spinner" aria-hidden="true" />
                    ) : null}
                    <button
                      type="button"
                      className="composer__attachment-remove"
                      onClick={() => removePending(item.localId)}
                      aria-label={`Quitar ${item.name}`}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ) : (
                  <div
                    key={item.localId}
                    className={`composer__doc${item.status === 'uploading' ? ' is-uploading' : ''}`}
                  >
                    <span className="composer__doc-icon" aria-hidden="true">
                      <FileText size={18} />
                    </span>
                    <span className="composer__doc-text">
                      <strong>{item.name}</strong>
                      <small>
                        {formatBytes(item.size)}
                        {item.status === 'uploading' ? ' · subiendo…' : ''}
                      </small>
                    </span>
                    <button
                      type="button"
                      className="composer__attachment-remove composer__attachment-remove--inline"
                      onClick={() => removePending(item.localId)}
                      aria-label={`Quitar ${item.name}`}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ),
              )}
            </div>
          ) : null}

          <div className="composer__meta">
            <button
              type="button"
              className="model-chip"
              onClick={() => setModelSheetOpen(true)}
              aria-label={`Modelo: ${currentModelName}. Cambiar modelo`}
            >
              <span>Modelo</span>
              <strong>{currentModelName}</strong>
              <ChevronDown size={14} />
            </button>
          </div>

          {voiceState !== 'idle' ? (
            <div className="voice-state" role="status">
              <Orb size={18} state={voiceState === 'listening' ? 'responding' : 'thinking'} />
              <span>
                {voiceState === 'listening' ? 'Escuchando…' : 'Transcribiendo en el PC…'}
              </span>
            </div>
          ) : null}

          {voiceError ? (
            <div className="notice notice--error" role="alert">
              <AlertCircle size={15} />
              <span>{voiceError}</span>
              <button
                type="button"
                className="notice__close"
                onClick={() => setVoiceError(null)}
                aria-label="Descartar aviso de voz"
              >
                <X size={15} />
              </button>
            </div>
          ) : null}

          {uploadError ? (
            <div className="notice notice--error" role="alert">
              <AlertCircle size={15} />
              <span>{uploadError}</span>
              <button
                type="button"
                className="notice__close"
                onClick={() => setUploadError(null)}
                aria-label="Descartar aviso de adjunto"
              >
                <X size={15} />
              </button>
            </div>
          ) : null}

          {attachMenuOpen ? (
            <div className="attach-menu" role="menu" aria-label="Adjuntar archivo">
              <button
                type="button"
                role="menuitem"
                className="attach-menu__item"
                onClick={() => {
                  setAttachMenuOpen(false)
                  photoInputRef.current?.click()
                }}
              >
                <ImageIcon size={18} />
                <span>
                  <strong>Foto</strong>
                  <small>Cámara o galería</small>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="attach-menu__item"
                onClick={() => {
                  setAttachMenuOpen(false)
                  documentInputRef.current?.click()
                }}
              >
                <FileText size={18} />
                <span>
                  <strong>Archivo</strong>
                  <small>PDF, Word, Excel, texto…</small>
                </span>
              </button>
            </div>
          ) : null}

          <div className="composer__field">
            <button
              type="button"
              className="composer__tool composer__tool--attach"
              onClick={() => setAttachMenuOpen((current) => !current)}
              aria-label="Adjuntar imagen o archivo"
              aria-expanded={attachMenuOpen}
            >
              <Paperclip size={20} />
            </button>
            <input
              ref={photoInputRef}
              className="composer__file-input"
              type="file"
              accept={PHOTO_ACCEPT}
              multiple
              hidden
              onChange={(event) => {
                handleFiles(event.target.files)
                event.target.value = ''
              }}
            />
            <input
              ref={documentInputRef}
              className="composer__file-input composer__file-input--doc"
              type="file"
              accept={FILE_ACCEPT}
              multiple
              hidden
              onChange={(event) => {
                handleFiles(event.target.files)
                event.target.value = ''
              }}
            />
            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  if (canSend) send()
                }
              }}
              placeholder={
                voiceState === 'transcribing'
                  ? 'Transcribiendo en el PC…'
                  : adoptable
                    ? 'Escribe un mensaje…'
                    : 'Continúa esta conversación…'
              }
              aria-label="Mensaje para el agente"
              enterKeyHint="send"
            />
            {voiceKind ? (
              <button
                type="button"
                className={`composer__tool${voiceState === 'listening' ? ' is-listening' : ''}`}
                onClick={() => void toggleDictation()}
                disabled={voiceState === 'transcribing'}
                aria-label={
                  voiceState === 'listening'
                    ? 'Detener dictado'
                    : voiceState === 'transcribing'
                      ? 'Transcribiendo audio'
                      : 'Dictar por voz'
                }
                aria-pressed={voiceState === 'listening'}
              >
                <Mic size={20} />
              </button>
            ) : null}
            {turn.running ? (
              <button
                type="button"
                className="send send--stop"
                onClick={() => void stop()}
                disabled={turn.stopping}
                aria-label={turn.stopping ? 'Deteniendo respuesta' : 'Detener respuesta'}
              >
                <StopIcon size={18} />
              </button>
            ) : (
              <button
                type="button"
                className="send"
                onClick={send}
                disabled={!canSend}
                aria-label="Enviar mensaje"
              >
                <ArrowUp size={20} />
              </button>
            )}
          </div>
        </div>
      ) : null}

      {preview ? (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={preview.name}
          onClick={() => setPreview(null)}
        >
          <button
            type="button"
            className="lightbox__close"
            onClick={() => setPreview(null)}
            aria-label="Cerrar imagen"
          >
            <X size={22} />
          </button>
          <img
            src={preview.url}
            alt={preview.name}
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      ) : null}

      <ModelSheet
        open={modelSheetOpen}
        onClose={() => setModelSheetOpen(false)}
        models={models}
        selectedId={modelId}
        onSelect={setModelId}
        title="Modelo del chat"
      />
    </div>
  )
}
