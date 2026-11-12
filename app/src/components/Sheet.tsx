import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from './Icons'

interface SheetProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
}

const CLOSE_ANIMATION_MS = 240
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Bottom sheet accesible: foco atrapado, Escape para cerrar, animación de salida. */
export function Sheet({ open, onClose, title, children, footer }: SheetProps) {
  const [rendered, setRendered] = useState(open)
  const panelRef = useRef<HTMLDivElement>(null)
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
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.body.classList.add('no-scroll')
    const panel = panelRef.current

    const focusables = (): HTMLElement[] =>
      panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)) : []

    const first = focusables()[0]
    first?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const list = focusables()
      if (list.length === 0) return
      const firstItem = list[0]
      const lastItem = list[list.length - 1]
      if (!firstItem || !lastItem) return
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault()
        lastItem.focus()
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault()
        firstItem.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.classList.remove('no-scroll')
      previous?.focus()
    }
  }, [open, onClose])

  if (!rendered) return null

  return createPortal(
    <div className={`sheet${open ? ' is-open' : ' is-closing'}`}>
      <div className="sheet__backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className="sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
      >
        <div className="sheet__handle" aria-hidden="true" />
        <div className="sheet__head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <X size={20} />
          </button>
        </div>
        <div className="sheet__body">{children}</div>
        {footer ? <div className="sheet__footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  )
}
