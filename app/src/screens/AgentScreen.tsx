import { useCallback, useEffect, useState } from 'react'
import { api, errorText } from '../api'
import {
  AlertCircle,
  Check,
  ChevronRight,
  Refresh,
  X,
} from '../components/Icons'
import { Orb } from '../components/Orb'
import { TopBar } from '../components/TopBar'
import {
  formatDuration,
  relativeTime,
  truncateMiddle,
} from '../lib/format'
import {
  getStoredDefaultModelId,
  modelName,
  resolveModelId,
} from '../lib/models'
import { getServerBase, serverModeLabel } from '../lib/server'
import type {
  ActivityEntry,
  ChatDetail,
  ConnStatus,
  DeviceSession,
  ModelInfo,
} from '../types'

interface AgentScreenProps {
  status: ConnStatus
  serverVersion: string | null
  dshProfile: string | null
  device: DeviceSession | null
  models: ModelInfo[]
  onBack: () => void
  onOpenSettings: () => void
  onOpenDrawer: () => void
  /** Abre un chat desde una entrada de actividad. */
  onOpenChat: (chat: ChatDetail) => void
}

const TOOL_LABELS: Record<string, string> = {
  read: 'leer',
  read_file: 'leer',
  write: 'escribir',
  edit: 'editar',
  bash: 'terminal',
  shell: 'terminal',
  pwsh: 'terminal',
  execute: 'terminal',
  search: 'buscar',
  grep: 'buscar',
  web_search: 'web',
  fetch: 'web',
}

function toolLabel(tool: string): string {
  return TOOL_LABELS[tool.toLowerCase()] ?? tool
}

function ActivityStatusIcon({ status }: { status: ActivityEntry['status'] }) {
  if (status === 'completed') {
    return (
      <span className="activity-row__status activity-row__status--ok" title="Completada">
        <Check size={15} />
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="activity-row__status activity-row__status--error" title="Error">
        <AlertCircle size={15} />
      </span>
    )
  }
  return (
    <span className="activity-row__status activity-row__status--aborted" title="Detenida">
      <X size={15} />
    </span>
  )
}

export function AgentScreen({
  status,
  serverVersion,
  dshProfile,
  device,
  models,
  onBack,
  onOpenSettings,
  onOpenDrawer,
  onOpenChat,
}: AgentScreenProps) {
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const serverBase = getServerBase()
  const modeLabel = serverModeLabel(serverBase)
  const defaultModel = resolveModelId(models, getStoredDefaultModelId())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const entries = await api.activity(30)
      setActivity(entries)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openEntry = async (entry: ActivityEntry) => {
    if (openingId) return
    setOpeningId(entry.id)
    setActionError(null)
    try {
      const chat = await api.chat(entry.chatId)
      onOpenChat(chat)
    } catch (err) {
      setActionError(errorText(err))
    } finally {
      setOpeningId(null)
    }
  }

  return (
    <div className="screen screen--agent">
      <TopBar
        onBack={onBack}
        onOpenDrawer={onOpenDrawer}
        onOpenAgent={undefined}
        title="Nexo"
        subtitle={modeLabel}
        status={status}
        onOpenSettings={onOpenSettings}
      />

      <div className="screen__body agent">
        <section className="agent-hero">
          <Orb size={84} state={status === 'open' ? 'idle' : 'thinking'} />
          <div className="agent-hero__text">
            <h2>Nexo</h2>
            <p>
              Tu agente
              {status === 'open' ? ' está en línea' : ' no está conectado'}.
            </p>
          </div>
        </section>

        <dl className="settings-list agent-facts">
          <div className="settings-row">
            <dt className="settings-row__label">Conexión</dt>
            <dd className="settings-row__value">
              {status === 'open' ? 'Conectado' : 'Sin conexión'}
            </dd>
          </div>
          <div className="settings-row">
            <dt className="settings-row__label">Modo</dt>
            <dd className="settings-row__value">{modeLabel}</dd>
          </div>
          <div className="settings-row">
            <dt className="settings-row__label">Dirección</dt>
            <dd className="settings-row__value settings-row__value--mono">
              {serverBase ? truncateMiddle(serverBase, 34) : 'Mismo origen'}
            </dd>
          </div>
          <div className="settings-row">
            <dt className="settings-row__label">Versión del puente</dt>
            <dd className="settings-row__value">{serverVersion ?? '—'}</dd>
          </div>
          <div className="settings-row">
            <dt className="settings-row__label">Perfil DSH</dt>
            <dd className="settings-row__value">{dshProfile ?? '—'}</dd>
          </div>
          <div className="settings-row">
            <dt className="settings-row__label">Dispositivo</dt>
            <dd className="settings-row__value">{device?.deviceName ?? 'Sin emparejar'}</dd>
          </div>
          <div className="settings-row">
            <dt className="settings-row__label">Modelo por defecto</dt>
            <dd className="settings-row__value">{modelName(models, defaultModel)}</dd>
          </div>
        </dl>

        <section className="agent-activity">
          <div className="section-head">
            <p className="eyebrow">Actividad reciente</p>
            <button
              type="button"
              className="icon-btn icon-btn--small"
              onClick={() => void load()}
              aria-label="Actualizar actividad"
              disabled={loading}
            >
              {loading ? <span className="spinner" aria-hidden="true" /> : <Refresh size={17} />}
            </button>
          </div>

          {actionError ? (
            <div className="inline-error" role="alert">
              <p>{actionError}</p>
            </div>
          ) : null}

          {loading ? (
            <div className="activity-list" aria-hidden="true">
              {[0, 1, 2].map((index) => (
                <div key={index} className="skeleton skeleton--row" />
              ))}
            </div>
          ) : error ? (
            <div className="inline-error" role="alert">
              <p>{error}</p>
              <button type="button" className="btn btn--ghost" onClick={() => void load()}>
                Reintentar
              </button>
            </div>
          ) : activity.length === 0 ? (
            <div className="empty">
              <Orb size={64} />
              <h3>Sin actividad todavía</h3>
              <p>Cuando el agente termine una tarea, aparecerá aquí con su duración y herramientas.</p>
            </div>
          ) : (
            <div className="activity-list" aria-live="polite">
              {activity.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="activity-row"
                  onClick={() => void openEntry(entry)}
                  disabled={openingId === entry.id}
                >
                  <ActivityStatusIcon status={entry.status} />
                  <span className="activity-row__main">
                    <span className="activity-row__top">
                      <strong>{entry.title || 'Conversación'}</strong>
                      <small>{relativeTime(entry.at)}</small>
                    </span>
                    <small className="activity-row__workspace">{entry.workspaceName}</small>
                    <span className="activity-row__meta">
                      <span className="activity-row__duration">
                        {formatDuration(entry.durationMs)}
                      </span>
                      {entry.tools.slice(0, 4).map((tool) => (
                        <span key={`${entry.id}-${tool}`} className="tool-chip" title={tool}>
                          {toolLabel(tool)}
                        </span>
                      ))}
                      {entry.tools.length > 4 ? (
                        <span className="tool-chip">+{entry.tools.length - 4}</span>
                      ) : null}
                      {entry.model ? (
                        <span className="activity-row__model">{modelName(models, entry.model)}</span>
                      ) : null}
                    </span>
                  </span>
                  <ChevronRight size={16} className="activity-row__chevron" />
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
