import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, errorText } from '../api'
import { Folder, Gear, Plus, X } from './Icons'
import { Orb } from './Orb'
import { baseName, tailPath } from '../lib/format'
import type { Workspace } from '../types'

interface ProjectsDrawerProps {
  open: boolean
  onClose: () => void
  currentWorkspaceId?: string | null
  serverVersion: string | null
  onSelectWorkspace: (workspace: Workspace) => void
  onAllProjects: () => void
  onAddProject: () => void
  onOpenSettings: () => void
}

const CLOSE_ANIMATION_MS = 240
const RECENT_MS = 10 * 60 * 1000

export function ProjectsDrawer({
  open,
  onClose,
  currentWorkspaceId,
  serverVersion,
  onSelectWorkspace,
  onAllProjects,
  onAddProject,
  onOpenSettings,
}: ProjectsDrawerProps) {
  const [rendered, setRendered] = useState(open)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const touchStartX = useRef<number | null>(null)
  const titleId = useId()

  useEffect(() => {
    if (open) {
      setRendered(true)
      return
    }
    const timer = window.setTimeout(() => setRendered(false), CLOSE_ANIMATION_MS)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setError(null)
    api
      .workspaces()
      .then((items) => {
        if (alive) setWorkspaces(items)
      })
      .catch((err) => {
        if (alive) setError(errorText(err))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    document.body.classList.add('no-scroll')
    const timer = window.setTimeout(() => closeButtonRef.current?.focus(), 80)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', onKeyDown)
      document.body.classList.remove('no-scroll')
    }
  }, [open, onClose])

  if (!rendered) return null

  const handleTouchStart = (event: React.TouchEvent) => {
    touchStartX.current = event.touches[0]?.clientX ?? null
  }

  const handleTouchEnd = (event: React.TouchEvent) => {
    const start = touchStartX.current
    touchStartX.current = null
    const end = event.changedTouches[0]?.clientX
    if (start !== null && typeof end === 'number' && start - end > 60) onClose()
  }

  const selectWorkspace = (workspace: Workspace) => {
    onClose()
    onSelectWorkspace(workspace)
  }

  const now = Date.now()

  return createPortal(
    <div className={`drawer${open ? ' is-open' : ' is-closing'}`}>
      <div className="drawer__overlay" onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <div className="drawer__head">
          <div className="drawer__brand">
            <Orb size={30} state="idle" />
            <span id={titleId}>Nexo</span>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Cerrar proyectos"
          >
            <X size={20} />
          </button>
        </div>

        <div className="drawer__body">
          <p className="eyebrow">Proyectos</p>

          {loading ? (
            <div className="drawer__list" aria-hidden="true">
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className="skeleton skeleton--row" />
              ))}
            </div>
          ) : error ? (
            <div className="inline-error" role="alert">
              <p>{error}</p>
            </div>
          ) : workspaces.length === 0 ? (
            <div className="drawer__empty">
              <p>Aún no hay proyectos.</p>
            </div>
          ) : (
            <div className="drawer__list">
              {workspaces.map((workspace) => {
                const current = workspace.id === currentWorkspaceId
                const recent = now - workspace.lastActiveAt < RECENT_MS
                return (
                  <button
                    key={workspace.id}
                    type="button"
                    className={`drawer__project${current ? ' is-current' : ''}`}
                    onClick={() => selectWorkspace(workspace)}
                    aria-current={current ? 'page' : undefined}
                  >
                    <span className="drawer__project-main">
                      <strong>{workspace.name || baseName(workspace.path)}</strong>
                      <small>{tailPath(workspace.path, 34)}</small>
                    </span>
                    {recent ? (
                      <span
                        className="drawer__dot"
                        role="img"
                        aria-label="Actividad reciente"
                        title="Actividad reciente"
                      />
                    ) : null}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="drawer__footer">
          <button
            type="button"
            className="drawer__action"
            onClick={() => {
              onClose()
              onAllProjects()
            }}
          >
            <Folder size={18} />
            Todos los proyectos
          </button>
          <button
            type="button"
            className="drawer__action"
            onClick={() => {
              onClose()
              onAddProject()
            }}
          >
            <Plus size={18} />
            Añadir proyecto
          </button>
          <button
            type="button"
            className="drawer__action"
            onClick={() => {
              onClose()
              onOpenSettings()
            }}
          >
            <Gear size={18} />
            Ajustes
          </button>
          <p className="drawer__version">Puente v{serverVersion ?? '—'}</p>
        </div>
      </aside>
    </div>,
    document.body,
  )
}
