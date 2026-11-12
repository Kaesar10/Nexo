import type { CSSProperties } from 'react'
import type { OrbState } from '../types'

interface OrbProps {
  state?: OrbState
  /** Diámetro en px. */
  size?: number
  className?: string
}

/**
 * Orbe de presencia: respira en reposo, ondula al pensar y pulsa al responder.
 * Puro CSS (capas con gradientes radiales), sin canvas ni dependencias.
 */
export function Orb({ state = 'idle', size = 120, className = '' }: OrbProps) {
  const tiny = size <= 32
  const classes = ['orb', `orb--${state}`, tiny ? 'orb--tiny' : '', className].filter(Boolean).join(' ')
  const style = { '--orb-size': `${size}px` } as CSSProperties

  return (
    <div className={classes} style={style} aria-hidden="true">
      <span className="orb__halo" />
      <span className="orb__ring" />
      <span className="orb__blob orb__blob--a" />
      <span className="orb__blob orb__blob--b" />
      <span className="orb__core" />
      <span className="orb__spark" />
    </div>
  )
}
