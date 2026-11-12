import { useCallback, useEffect, useState } from 'react'
import { api, errorText } from '../api'
import { ChatBubble, Lock, Plus } from '../components/Icons'
import { Orb } from '../components/Orb'
import { TopBar } from '../components/TopBar'
import { relativeTime, tailPath } from '../lib/format'
import type { ChatSummary, ConnStatus, Workspace } from '../types'

interface ChatsScreenProps {
  workspace: Workspace
  status: ConnStatus
  onBack: () => void
  onOpenSettings: () => void
  onOpenDrawer: () => void
  onOpenAgent: () => void
  onOpenChat: (chat: ChatSummary) => void
  onNewChat: () => void
}

interface LoadState {
  loading: boolean
  error: string | null
  items: ChatSummary[]
}

export function ChatsScreen({
  workspace,
  status,
  onBack,
  onOpenSettings,
  onOpenDrawer,
  onOpenAgent,
  onOpenChat,
  onNewChat,
}: ChatsScreenProps) {
  const [state, setState] = useState<LoadState>({ loading: true, error: null, items: [] })

  const load = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }))
    try {
      const items = await api.chats(workspace.id)
      setState({ loading: false, error: null, items })
    } catch (error) {
      setState({ loading: false, error: errorText(error), items: [] })
    }
  }, [workspace.id])

  useEffect(() => {
    void load()
  }, [load])

  const showEmpty = !state.loading && !state.error && state.items.length === 0

  return (
    <div className="screen">
      <TopBar
        onBack={onBack}
        title={workspace.name}
        subtitle={tailPath(workspace.path, 34)}
        status={status}
        onOpenSettings={onOpenSettings}
        onOpenDrawer={onOpenDrawer}
        onOpenAgent={onOpenAgent}
      />

      <div className="screen__body">
        <div className="page-head">
          <p className="eyebrow">Proyecto</p>
          <h2>Conversaciones</h2>
          <p>Cada chat es una sesión de tu agente en este proyecto.</p>
        </div>

        <button type="button" className="new-chat" onClick={onNewChat}>
          <Plus size={19} />
          Nueva conversación
        </button>

        <div className="chat-list" aria-busy={state.loading}>
          {state.loading
            ? [0, 1, 2, 3].map((index) => (
                <div key={index} className="skeleton skeleton--row" />
              ))
            : null}

          {!state.loading && state.error ? (
            <div className="inline-error" role="alert">
              <p>{state.error}</p>
              <button type="button" className="btn btn--ghost" onClick={() => void load()}>
                Reintentar
              </button>
            </div>
          ) : null}

          {!state.loading && !state.error
            ? state.items.map((chat) => {
                const readOnly = chat.adoptable === false
                const hasCount = typeof chat.messageCount === 'number'
                return (
                  <button
                    key={chat.id}
                    type="button"
                    className="chat-row"
                    onClick={() => onOpenChat(chat)}
                  >
                    <span className="chat-row__title">
                      {chat.title || 'Conversación sin título'}
                    </span>
                    {chat.preview ? (
                      <span className="chat-row__preview">{chat.preview}</span>
                    ) : null}
                    <span className="chat-row__meta">
                      {hasCount ? (
                        <span>
                          {chat.messageCount === 1
                            ? '1 mensaje'
                            : `${chat.messageCount} mensajes`}
                        </span>
                      ) : null}
                      {hasCount && readOnly ? <span aria-hidden="true">·</span> : null}
                      {readOnly ? (
                        <span className="chat-row__readonly">
                          <Lock size={11} aria-hidden="true" />
                          creada en el escritorio · solo lectura
                        </span>
                      ) : null}
                    </span>
                    <span className="chat-row__time">{relativeTime(chat.updatedAt)}</span>
                  </button>
                )
              })
            : null}

          {showEmpty ? (
            <div className="empty" role="status">
              <Orb size={84} />
              <h3>Aún no hay conversaciones</h3>
              <p>Empieza la primera y aparecerá también en DSH.</p>
            </div>
          ) : null}
        </div>

        {state.items.length > 0 && !state.loading && !state.error ? (
          <p className="list-note">
            <ChatBubble size={14} aria-hidden="true" />
            Lo que hables aquí queda en la misma sesión que en tu PC.
          </p>
        ) : null}
      </div>
    </div>
  )
}
