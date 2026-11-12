import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, errorText, getApiBase, setAuthToken, setUnauthorizedHandler } from './api'
import { BRAND } from './brand'
import { Orb } from './components/Orb'
import { Refresh, WifiOff } from './components/Icons'
import { ProjectsDrawer } from './components/ProjectsDrawer'
import { bus } from './eventBus'
import { baseName } from './lib/format'
import { onNotificationOpened } from './lib/notifications'
import { clearSession, loadSession, saveSession } from './lib/session'
import { getServerBase, isNativeShell, setServerBase } from './lib/server'
import { clearTaskPush, startTaskPush } from './lib/push'
import { FALLBACK_MODELS } from './lib/models'
import { AgentScreen } from './screens/AgentScreen'
import { ChatScreen } from './screens/ChatScreen'
import { ChatsScreen } from './screens/ChatsScreen'
import { PairScreen } from './screens/PairScreen'
import { SettingsSheet } from './screens/SettingsSheet'
import { WorkspacesScreen } from './screens/WorkspacesScreen'
import { EventStream } from './sse'
import type {
  ChatDetail,
  ConnStatus,
  DeviceSession,
  ModelInfo,
  VoiceStatus,
  Workspace,
} from './types'

type Phase = 'boot' | 'pair' | 'ready' | 'unreachable'

type Screen =
  | { name: 'workspaces'; openBrowse?: boolean }
  | { name: 'chats'; workspace: Workspace }
  | {
      name: 'chat'
      workspace: Workspace
      chatId: string | null
      title?: string
      model?: string | null
    }
  | { name: 'agent' }

function workspaceFromChat(chat: ChatDetail): Workspace {
  return {
    id: chat.workspaceId,
    name: baseName(chat.workspacePath || 'Proyecto'),
    path: chat.workspacePath || '',
    isGit: false,
    lastActiveAt: Date.now(),
    chatsCount: 1,
  }
}

export function App() {
  const [phase, setPhase] = useState<Phase>('boot')
  const [device, setDevice] = useState<DeviceSession | null>(null)
  const [serverVersion, setServerVersion] = useState<string | null>(null)
  const [dshProfile, setDshProfile] = useState<string | null>(null)
  const [conn, setConn] = useState<ConnStatus>('connecting')
  const [bootError, setBootError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>(FALLBACK_MODELS)
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [stack, setStack] = useState<Screen[]>([{ name: 'workspaces' }])
  const streamRef = useRef<EventStream | null>(null)
  const stackRef = useRef<Screen[]>(stack)

  useEffect(() => {
    stackRef.current = stack
  }, [stack])

  const resetNavigation = useCallback(() => {
    setStack([{ name: 'workspaces' }])
    window.history.replaceState({ nexoDepth: 0 }, '')
  }, [])

  const handleUnauthorized = useCallback(() => {
    streamRef.current?.stop()
    streamRef.current = null
    void clearTaskPush()
    setAuthToken(null)
    clearSession()
    setDevice(null)
    setSettingsOpen(false)
    setDrawerOpen(false)
    setConn('offline')
    setBootError('Tu dispositivo ya no está autorizado. Vuelve a emparejarlo.')
    resetNavigation()
    setPhase('pair')
  }, [resetNavigation])

  useEffect(() => {
    setUnauthorizedHandler(handleUnauthorized)
    return () => setUnauthorizedHandler(null)
  }, [handleUnauthorized])

  const boot = useCallback(async () => {
    setPhase('boot')
    setBootError(null)
    // Aprovisionado: el APK puede traer token y servidor ya hornados en la
    // build, así se entra directo sin escribir ningún código.
    const bakedToken = (import.meta.env.VITE_DEVICE_TOKEN ?? '').trim()
    const bakedServer = (import.meta.env.VITE_BOOTSTRAP_SERVER ?? '').trim()
    const bakedDeviceId = (import.meta.env.VITE_DEVICE_ID ?? '').trim()
    if (bakedServer && !getServerBase()) setServerBase(bakedServer)
    if (bakedToken && !loadSession()) {
      saveSession({
        token: bakedToken,
        deviceId: bakedDeviceId || 'dev_preinstalado',
        deviceName: 'Móvil',
      })
    }
    const saved = loadSession()

    // En el APK (shell nativo) aún no sabemos dónde está el PC: primero hay
    // que configurar la dirección en la pantalla de emparejamiento.
    if (isNativeShell() && !getServerBase()) {
      setPhase('pair')
      return
    }

    try {
      const health = await api.health()
      setServerVersion(health.version)
      setDshProfile(health.dsh?.profile ?? null)
    } catch (error) {
      if (saved) {
        setDevice(saved)
        setAuthToken(saved.token)
        setBootError(errorText(error))
        setPhase('unreachable')
      } else {
        setBootError(errorText(error))
        setPhase('pair')
      }
      return
    }

    if (!saved) {
      setPhase('pair')
      return
    }

    setDevice(saved)
    setAuthToken(saved.token)
    try {
      const me = await api.me()
      const session: DeviceSession = {
        token: saved.token,
        deviceId: me.deviceId,
        deviceName: me.deviceName,
      }
      setDevice(session)
      saveSession(session)
      setServerVersion(me.serverVersion)
      setPhase('ready')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        handleUnauthorized()
      } else {
        setBootError(errorText(error))
        setPhase('unreachable')
      }
    }
  }, [handleUnauthorized])

  useEffect(() => {
    void boot()
  }, [boot])

  // Conexión SSE única mientras haya sesión.
  useEffect(() => {
    if (phase !== 'ready' || !device) return
    const stream = new EventStream(device.token, handleUnauthorized)
    streamRef.current = stream
    const offStatus = stream.onStatus(setConn)
    const offEvent = stream.onEvent((event) => {
      if (event.type === 'hello') setServerVersion(event.serverVersion)
      bus.emit(event)
    })
    stream.start()
    return () => {
      offStatus()
      offEvent()
      stream.stop()
      if (streamRef.current === stream) streamRef.current = null
    }
  }, [phase, device, handleUnauthorized])

  // Push propio: arranca el servicio en primer plano del APK con la sesión.
  // Así el aviso de "tarea terminada" llega aunque la app esté cerrada.
  useEffect(() => {
    if (phase !== 'ready' || !device) return
    void startTaskPush(getApiBase(), device.token)
  }, [phase, device])

  // Catálogo de modelos (si el puente no lo expone, se usa el fallback local).
  useEffect(() => {
    if (phase !== 'ready') return
    let alive = true
    api
      .models()
      .then((list) => {
        if (alive) setModels(list.length > 0 ? list : FALLBACK_MODELS)
      })
      .catch(() => {
        if (alive) setModels(FALLBACK_MODELS)
      })
    return () => {
      alive = false
    }
  }, [phase])

  // Estado del motor de dictado local (whisper u otro) del puente.
  useEffect(() => {
    if (phase !== 'ready') {
      setVoiceStatus(null)
      return
    }
    let alive = true
    api
      .voiceStatus()
      .then((status) => {
        if (alive) setVoiceStatus(status)
      })
      .catch(() => {
        if (alive) setVoiceStatus(null)
      })
    return () => {
      alive = false
    }
  }, [phase])

  const openChatFromNotification = useCallback(async (chatId: string) => {
    try {
      const chat = await api.chat(chatId)
      const workspace: Workspace = {
        id: chat.workspaceId,
        name: baseName(chat.workspacePath || 'Proyecto'),
        path: chat.workspacePath || '',
        isGit: false,
        lastActiveAt: Date.now(),
        chatsCount: 1,
      }
      setStack([
        { name: 'workspaces' },
        {
          name: 'chat',
          workspace,
          chatId,
          title: chat.title,
          model: chat.model ?? null,
        },
      ])
      window.history.pushState({ nexoDepth: 2 }, '')
    } catch {
      // notificación de un chat que ya no existe
    }
  }, [])

  // Al tocar una notificación local, abrir su conversación.
  useEffect(() => {
    if (phase !== 'ready') return
    return onNotificationOpened((chatId) => {
      if (chatId) void openChatFromNotification(chatId)
    })
  }, [phase, openChatFromNotification])

  const go = useCallback((screen: Screen) => {
    setStack((previous) => {
      window.history.pushState({ nexoDepth: previous.length }, '')
      return [...previous, screen]
    })
  }, [])

  /** Sustituye la pantalla actual sin añadir entrada al historial. */
  const replaceTop = useCallback((screen: Screen) => {
    setStack((previous) => {
      if (previous.length === 0) return [screen]
      return [...previous.slice(0, -1), screen]
    })
  }, [])

  /** Abre un chat concreto (desde la actividad del agente, por ejemplo). */
  const openChatDetail = useCallback(
    (chat: ChatDetail) => {
      go({
        name: 'chat',
        workspace: workspaceFromChat(chat),
        chatId: chat.id,
        title: chat.title,
        model: chat.model ?? null,
      })
    },
    [go],
  )

  const navigateToWorkspace = useCallback((workspace: Workspace) => {
    setStack([{ name: 'workspaces' }, { name: 'chats', workspace }])
    // Entrada de historial propia para que el botón atrás vuelva a Proyectos.
    window.history.pushState({ nexoDepth: 2 }, '')
  }, [])

  const navigateAllProjects = useCallback(() => {
    setStack([{ name: 'workspaces' }])
    window.history.replaceState({ nexoDepth: 0 }, '')
  }, [])

  const navigateAddProject = useCallback(() => {
    setStack([{ name: 'workspaces', openBrowse: true }])
    window.history.replaceState({ nexoDepth: 0 }, '')
  }, [])

  const back = useCallback(() => {
    if (stackRef.current.length > 1) window.history.back()
  }, [])

  useEffect(() => {
    const onPopState = () => {
      setStack((previous) => (previous.length > 1 ? previous.slice(0, -1) : previous))
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const handlePaired = useCallback(
    (session: DeviceSession) => {
      streamRef.current?.stop()
      streamRef.current = null
      saveSession(session)
      setAuthToken(session.token)
      setDevice(session)
      setConn('connecting')
      setBootError(null)
      resetNavigation()
      setPhase('ready')
      void api
        .health()
        .then((health) => {
          setServerVersion(health.version)
          setDshProfile(health.dsh?.profile ?? null)
        })
        .catch(() => {
          // la versión se actualizará con el evento hello del SSE
        })
    },
    [resetNavigation],
  )

  const handleDisconnect = useCallback(() => {
    streamRef.current?.stop()
    streamRef.current = null
    void clearTaskPush()
    setAuthToken(null)
    clearSession()
    setDevice(null)
    setServerVersion(null)
    setDshProfile(null)
    setConn('offline')
    setSettingsOpen(false)
    setDrawerOpen(false)
    setBootError(null)
    resetNavigation()
    setPhase('pair')
  }, [resetNavigation])

  const current = stack[stack.length - 1] ?? { name: 'workspaces' as const }

  useEffect(() => {
    if (phase !== 'ready') {
      document.title = BRAND.name
      return
    }
    const screenTitle =
      current.name === 'workspaces'
        ? 'Proyectos'
        : current.name === 'chats'
          ? current.workspace.name
          : current.name === 'agent'
            ? 'Nexo'
            : current.title || 'Conversación'
    document.title = `${screenTitle} · ${BRAND.name}`
  }, [phase, current])

  if (phase === 'boot') {
    return (
      <div className="app">
        <div className="ambient" aria-hidden="true" />
        <div className="center-screen">
          <Orb state="thinking" size={104} />
          <p className="center-screen__caption" role="status">
            Buscando tu PC…
          </p>
        </div>
      </div>
    )
  }

  if (phase === 'unreachable') {
    return (
      <div className="app">
        <div className="ambient" aria-hidden="true" />
        <div className="center-screen">
          <Orb state="idle" size={104} />
          <h1 className="center-screen__title">No encuentro tu PC</h1>
          <p className="center-screen__caption">
            {bootError ??
              'Comprueba que el puente esté encendido y que ambos estéis en la misma red.'}
          </p>
          <div className="center-screen__actions">
            <button type="button" className="btn btn--primary" onClick={() => void boot()}>
              <Refresh size={18} />
              Reintentar
            </button>
            <button type="button" className="btn btn--ghost" onClick={handleDisconnect}>
              <WifiOff size={17} />
              Emparejar otro dispositivo
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'pair') {
    return (
      <div className="app">
        <div className="ambient" aria-hidden="true" />
        <PairScreen onPaired={handlePaired} serverVersion={serverVersion} initialError={bootError} />
      </div>
    )
  }

  return (
    <div className="app">
      <div className="ambient" aria-hidden="true" />

      {current.name === 'workspaces' ? (
        <WorkspacesScreen
          status={conn}
          initialBrowsing={current.openBrowse === true}
          onOpenWorkspace={navigateToWorkspace}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenDrawer={() => setDrawerOpen(true)}
          onOpenAgent={() => go({ name: 'agent' })}
        />
      ) : null}

      {current.name === 'chats' ? (
        <ChatsScreen
          workspace={current.workspace}
          status={conn}
          onBack={back}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenDrawer={() => setDrawerOpen(true)}
          onOpenAgent={() => go({ name: 'agent' })}
          onOpenChat={(chat) =>
            go({
              name: 'chat',
              workspace: current.workspace,
              chatId: chat.id,
              title: chat.title,
              model: chat.model ?? null,
            })
          }
          onNewChat={() =>
            go({ name: 'chat', workspace: current.workspace, chatId: null })
          }
        />
      ) : null}

      {current.name === 'chat' ? (
        <ChatScreen
          key={current.chatId ?? 'nuevo'}
          workspace={current.workspace}
          chatId={current.chatId}
          initialTitle={current.title}
          initialModel={current.model}
          models={models}
          voiceStatus={voiceStatus}
          status={conn}
          onBack={back}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenDrawer={() => setDrawerOpen(true)}
          onOpenAgent={() => go({ name: 'agent' })}
          onForked={(chatId) =>
            replaceTop({ name: 'chat', workspace: current.workspace, chatId })
          }
          onNewChat={() =>
            replaceTop({ name: 'chat', workspace: current.workspace, chatId: null })
          }
        />
      ) : null}

      {current.name === 'agent' ? (
        <AgentScreen
          status={conn}
          serverVersion={serverVersion}
          dshProfile={dshProfile}
          device={device}
          models={models}
          onBack={back}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenDrawer={() => setDrawerOpen(true)}
          onOpenChat={openChatDetail}
        />
      ) : null}

      <ProjectsDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        currentWorkspaceId={
          current.name === 'chats' || current.name === 'chat'
            ? current.workspace.id
            : null
        }
        serverVersion={serverVersion}
        onSelectWorkspace={navigateToWorkspace}
        onAllProjects={navigateAllProjects}
        onAddProject={navigateAddProject}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        device={device}
        serverVersion={serverVersion}
        dshProfile={dshProfile}
        status={conn}
        models={models}
        voiceStatus={voiceStatus}
        onDisconnect={handleDisconnect}
        onChangeServer={handleDisconnect}
      />
    </div>
  )
}
