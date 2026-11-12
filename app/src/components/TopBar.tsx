import type { ReactNode } from 'react'
import { BRAND } from '../brand'
import type { ConnStatus } from '../types'
import { ChevronLeft, Gear, Menu } from './Icons'
import { Orb } from './Orb'

interface TopBarProps {
  onBack?: () => void
  title?: string
  subtitle?: string
  onOpenSettings?: () => void
  onOpenDrawer?: () => void
  /** Avatar del agente: abre estado y actividad. */
  onOpenAgent?: () => void
  status?: ConnStatus
  /** Contenido opcional a la derecha, antes del engranaje. */
  trailing?: ReactNode
}

export const CONN_LABEL: Record<ConnStatus, string> = {
  connecting: 'Conectando',
  open: 'Conectado',
  reconnecting: 'Reconectando',
  offline: 'Sin conexión',
}

export function TopBar({
  onBack,
  title,
  subtitle,
  onOpenSettings,
  onOpenDrawer,
  onOpenAgent,
  status,
  trailing,
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar__side">
        {onOpenDrawer ? (
          <button
            type="button"
            className="icon-btn topbar__hamburger"
            onClick={onOpenDrawer}
            aria-label="Proyectos"
          >
            <Menu size={22} />
          </button>
        ) : null}
        {onBack ? (
          <button type="button" className="icon-btn" onClick={onBack} aria-label="Volver">
            <ChevronLeft size={22} />
          </button>
        ) : (
          <div className="brandmark">
            <Orb size={26} state="idle" />
            <span className="brandmark__name">{BRAND.name}</span>
          </div>
        )}
      </div>
      <div className="topbar__center">
        {title ? <h1 className="topbar__title">{title}</h1> : null}
        {subtitle ? <p className="topbar__subtitle">{subtitle}</p> : null}
      </div>
      <div className="topbar__side topbar__side--right">
        {status && !onOpenAgent ? (
          <span
            className={`conn conn--${status}`}
            role="status"
            aria-label={`Conexión: ${CONN_LABEL[status]}`}
            title={CONN_LABEL[status]}
          />
        ) : null}
        {onOpenAgent ? (
          <button
            type="button"
            className="agent-btn"
            onClick={onOpenAgent}
            aria-label="Nexo: estado y actividad"
            title="Nexo: estado y actividad"
          >
            <Orb size={26} state="idle" />
            {status ? (
              <span
                className={`conn agent-btn__status conn--${status}`}
                role="status"
                aria-label={`Conexión: ${CONN_LABEL[status]}`}
              />
            ) : null}
          </button>
        ) : null}
        {trailing}
        {onOpenSettings ? (
          <button type="button" className="icon-btn" onClick={onOpenSettings} aria-label="Ajustes">
            <Gear size={21} />
          </button>
        ) : null}
      </div>
    </header>
  )
}
