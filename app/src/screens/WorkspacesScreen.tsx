import { useCallback, useEffect, useState } from 'react'
import { api, errorText } from '../api'
import { ChevronRight, GitBranch, Plus } from '../components/Icons'
import { Orb } from '../components/Orb'
import { TopBar } from '../components/TopBar'
import { greeting, relativeTime, truncateMiddle } from '../lib/format'
import type { ConnStatus, Workspace } from '../types'
import { BrowseSheet } from './BrowseSheet'

interface WorkspacesScreenProps {
  status: ConnStatus
  initialBrowsing?: boolean
  onOpenWorkspace: (workspace: Workspace) => void
  onOpenSettings: () => void
  onOpenDrawer: () => void
  onOpenAgent: () => void
}

interface LoadState {
  loading: boolean
  error: string | null
  items: Workspace[]
}

export function WorkspacesScreen({
  status,
  initialBrowsing = false,
  onOpenWorkspace,
  onOpenSettings,
  onOpenDrawer,
  onOpenAgent,
}: WorkspacesScreenProps) {
  const [state, setState] = useState<LoadState>({ loading: true, error: null, items: [] })
  const [browsing, setBrowsing] = useState(initialBrowsing)

  const load = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }))
    try {
      const items = await api.workspaces()
      setState({ loading: false, error: null, items })
    } catch (error) {
      setState({ loading: false, error: errorText(error), items: [] })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleAdded = useCallback(() => {
    void load()
  }, [load])

  const showEmpty = !state.loading && !state.error && state.items.length === 0

  return (
    <div className="screen">
      <TopBar
        status={status}
        onOpenSettings={onOpenSettings}
        onOpenDrawer={onOpenDrawer}
        onOpenAgent={onOpenAgent}
      />

      <div className="screen__body">
        <div className="page-head">
          <p className="eyebrow">{greeting()}</p>
          <h2>Tus proyectos</h2>
          <p>Elige una carpeta y habla con tu agente.</p>
        </div>

        <div className="ws-list" aria-busy={state.loading}>
          {state.loading
            ? [0, 1, 2].map((index) => <div key={index} className="skeleton skeleton--card" />)
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
            ? state.items.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  className="ws-card"
                  onClick={() => onOpenWorkspace(workspace)}
                >
                  <span className="ws-card__top">
                    <span className="ws-card__name">{workspace.name}</span>
                    {workspace.isGit ? (
                      <span className="badge badge--git">
                        <GitBranch size={12} />
                        git
                      </span>
                    ) : null}
                  </span>
                  <span className="ws-card__path" title={workspace.path}>
                    {truncateMiddle(workspace.path, 46)}
                  </span>
                  <span className="ws-card__meta">
                    <span>
                      {workspace.chatsCount === 1
                        ? '1 conversación'
                        : `${workspace.chatsCount} conversaciones`}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{relativeTime(workspace.lastActiveAt)}</span>
                  </span>
                  <ChevronRight size={18} className="ws-card__chevron" />
                </button>
              ))
            : null}

          {showEmpty ? (
            <div className="empty" role="status">
              <Orb size={84} />
              <h3>Aún no hay proyectos</h3>
              <p>Añade una carpeta de tu PC para empezar.</p>
            </div>
          ) : null}
        </div>

        {!state.loading && !state.error ? (
          <button type="button" className="add-card" onClick={() => setBrowsing(true)}>
            <span className="add-card__icon">
              <Plus size={20} />
            </span>
            <span>
              <strong>Añadir proyecto</strong>
              <small>Elige una carpeta de tu PC</small>
            </span>
          </button>
        ) : null}
      </div>

      <BrowseSheet open={browsing} onClose={() => setBrowsing(false)} onAdded={handleAdded} />
    </div>
  )
}
