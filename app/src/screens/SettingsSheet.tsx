import { useEffect, useState } from 'react'
import { APP_VERSION, BRAND } from '../brand'
import { Check, ChevronDown } from '../components/Icons'
import { ModelList } from '../components/ModelSheet'
import { Orb } from '../components/Orb'
import { Sheet } from '../components/Sheet'
import {
  getStoredDefaultModelId,
  modelName,
  resolveModelId,
  setStoredDefaultModelId,
} from '../lib/models'
import {
  getNotificationPermission,
  notificationsSupported,
  requestNotificationPermission,
  setNotificationsEnabled,
  getNotificationsEnabled,
} from '../lib/notifications'
import { getServerBase, isNativeShell, serverModeLabel } from '../lib/server'
import { getVoiceEngine, setVoiceEngine, VOICE_ENGINE_LABEL } from '../lib/voice'
import type { VoiceEngine } from '../lib/voice'
import type { ConnStatus, DeviceSession, ModelInfo, VoiceStatus } from '../types'

interface SettingsSheetProps {
  open: boolean
  onClose: () => void
  device: DeviceSession | null
  serverVersion: string | null
  dshProfile: string | null
  status: ConnStatus
  models: ModelInfo[]
  voiceStatus: VoiceStatus | null
  onDisconnect: () => void
  /** APK: desconecta y vuelve a emparejar mostrando la dirección del PC. */
  onChangeServer: () => void
}

type PermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported'

const STATUS_LABEL: Record<ConnStatus, string> = {
  connecting: 'Conectando…',
  open: 'Conectado',
  reconnecting: 'Reconectando…',
  offline: 'Sin conexión',
}

const PERMISSION_LABEL: Record<PermissionState, string> = {
  granted: 'Permiso concedido',
  denied: 'Permiso denegado: actívalo en los ajustes del sistema',
  prompt: 'Todavía no has dado permiso',
  unsupported: 'Las notificaciones no están disponibles en este dispositivo',
}

export function SettingsSheet({
  open,
  onClose,
  device,
  serverVersion,
  dshProfile,
  status,
  models,
  voiceStatus,
  onDisconnect,
  onChangeServer,
}: SettingsSheetProps) {
  const [confirming, setConfirming] = useState(false)
  const [modelExpanded, setModelExpanded] = useState(false)
  const [defaultModel, setDefaultModel] = useState(() =>
    resolveModelId(models, getStoredDefaultModelId()),
  )
  const [voiceEngine, setVoiceEngineState] = useState<VoiceEngine>(() => getVoiceEngine())
  const [voiceExpanded, setVoiceExpanded] = useState(false)
  const [notifyEnabled, setNotifyEnabled] = useState(() => getNotificationsEnabled())
  const [permission, setPermission] = useState<PermissionState>('prompt')
  const [requestingPermission, setRequestingPermission] = useState(false)
  const native = isNativeShell()
  const serverBase = getServerBase()
  const showServer = native || serverBase !== ''
  const notificationsAvailable = notificationsSupported()

  useEffect(() => {
    if (!open) {
      setConfirming(false)
      setModelExpanded(false)
      setVoiceExpanded(false)
    }
  }, [open])

  useEffect(() => {
    setDefaultModel((current) => resolveModelId(models, current))
  }, [models])

  useEffect(() => {
    if (!open) return
    setNotifyEnabled(getNotificationsEnabled())
    setVoiceEngineState(getVoiceEngine())
    let alive = true
    void getNotificationPermission().then((state) => {
      if (alive) setPermission(state)
    })
    return () => {
      alive = false
    }
  }, [open])

  const selectDefaultModel = (id: string) => {
    setStoredDefaultModelId(id)
    setDefaultModel(id)
    setModelExpanded(false)
  }

  const selectVoiceEngine = (engine: VoiceEngine) => {
    setVoiceEngine(engine)
    setVoiceEngineState(engine)
    setVoiceExpanded(false)
  }

  const toggleNotifications = async () => {
    const next = !notifyEnabled
    setNotifyEnabled(next)
    setNotificationsEnabled(next)
    if (next && notificationsAvailable && permission !== 'granted') {
      setRequestingPermission(true)
      const state = await requestNotificationPermission()
      setPermission(state)
      setRequestingPermission(false)
    }
  }

  const askPermission = async () => {
    setRequestingPermission(true)
    const state = await requestNotificationPermission()
    setPermission(state)
    setRequestingPermission(false)
  }

  const voiceOptions: Array<{ id: VoiceEngine; name: string; hint: string }> = [
    {
      id: 'native',
      name: VOICE_ENGINE_LABEL.native,
      hint: 'Reconocimiento del sistema, sin enviar audio',
    },
    {
      id: 'pc',
      name: VOICE_ENGINE_LABEL.pc,
      hint: voiceStatus?.available
        ? `Motor local listo${voiceStatus.engine ? ` · ${voiceStatus.engine}` : ''}${
            voiceStatus.model ? ` · ${voiceStatus.model}` : ''
          }`
        : `No disponible${voiceStatus?.reason ? `: ${voiceStatus.reason}` : ''}`,
    },
  ]

  return (
    <Sheet open={open} onClose={onClose} title="Ajustes">
      <div className="settings-card">
        <Orb size={44} state={status === 'open' ? 'idle' : 'thinking'} />
        <div className="settings-card__meta">
          <strong>{device?.deviceName ?? 'Este dispositivo'}</strong>
          <span>{device?.deviceId ?? 'sin emparejar'}</span>
        </div>
      </div>

      <dl className="settings-list">
        {showServer ? (
          <div className="settings-row">
            <dt className="settings-row__label">Dirección del PC</dt>
            <dd className="settings-row__value settings-row__value--mono">
              {serverBase || 'Sin configurar'}
            </dd>
          </div>
        ) : null}
        {showServer ? (
          <div className="settings-row">
            <dt className="settings-row__label">Modo de conexión</dt>
            <dd className="settings-row__value">{serverModeLabel(serverBase)}</dd>
          </div>
        ) : null}
        <div className="settings-row">
          <dt className="settings-row__label">Conexión</dt>
          <dd className="settings-row__value">{STATUS_LABEL[status]}</dd>
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
          <dt className="settings-row__label">Versión de la app</dt>
          <dd className="settings-row__value">v{APP_VERSION}</dd>
        </div>
      </dl>

      <button
        type="button"
        className="settings-row settings-row--button"
        aria-expanded={modelExpanded}
        onClick={() => setModelExpanded((current) => !current)}
      >
        <span className="settings-row__label">Modelo por defecto</span>
        <span className="settings-row__value settings-row__value--with-icon">
          {modelName(models, defaultModel)}
          <ChevronDown size={16} />
        </span>
      </button>
      {modelExpanded ? (
        <div className="model-list model-list--inline">
          <ModelList
            models={models}
            selectedId={defaultModel}
            onSelect={selectDefaultModel}
          />
          <p className="settings-note">Se usa al empezar conversaciones nuevas.</p>
        </div>
      ) : null}

      <button
        type="button"
        className="settings-row settings-row--button"
        aria-expanded={voiceExpanded}
        onClick={() => setVoiceExpanded((current) => !current)}
      >
        <span className="settings-row__label">Dictado</span>
        <span className="settings-row__value settings-row__value--with-icon">
          {VOICE_ENGINE_LABEL[voiceEngine]}
          <ChevronDown size={16} />
        </span>
      </button>
      {voiceExpanded ? (
        <div className="model-list model-list--inline" role="radiogroup" aria-label="Motor de dictado">
          {voiceOptions.map((option) => {
            const selected = option.id === voiceEngine
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`model-row${selected ? ' is-selected' : ''}`}
                onClick={() => selectVoiceEngine(option.id)}
              >
                <span className="model-row__text">
                  <strong>{option.name}</strong>
                  <small>{option.hint}</small>
                </span>
                {selected ? (
                  <span className="model-row__check">
                    <Check size={18} />
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}

      <div className="settings-toggle">
        <div className="settings-toggle__text">
          <strong>Avisarme al terminar</strong>
          <small>Tareas de más de 8 s con la app en segundo plano.</small>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={notifyEnabled}
          aria-label="Avisarme al terminar"
          className={`switch${notifyEnabled ? ' is-on' : ''}`}
          onClick={() => void toggleNotifications()}
          disabled={!notificationsAvailable}
        >
          <span className="switch__knob" />
        </button>
      </div>
      <p className="settings-note">
        {PERMISSION_LABEL[permission]}
        {notificationsAvailable && permission === 'prompt' ? (
          <>
            {' · '}
            <button
              type="button"
              className="settings-inline-link"
              onClick={() => void askPermission()}
              disabled={requestingPermission}
            >
              {requestingPermission ? 'Pidiendo permiso…' : 'Pedir permiso'}
            </button>
          </>
        ) : null}
      </p>

      <p className="settings-note">{BRAND.footerNote}</p>

      {native ? (
        <button type="button" className="btn btn--ghost btn--wide" onClick={onChangeServer}>
          Cambiar dirección del PC
        </button>
      ) : null}

      {confirming ? (
        <div className="settings-confirm">
          <p>¿Seguro? Tendrás que volver a introducir el código de 6 dígitos del PC.</p>
          <div className="settings-confirm__actions">
            <button type="button" className="btn btn--ghost" onClick={() => setConfirming(false)}>
              Cancelar
            </button>
            <button type="button" className="btn btn--danger" onClick={onDisconnect}>
              Desconectar
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn--danger btn--wide" onClick={() => setConfirming(true)}>
          Desconectar este dispositivo
        </button>
      )}
    </Sheet>
  )
}
