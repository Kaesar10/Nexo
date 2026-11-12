/**
 * Identidad de la app. Cambiar el nombre del producto aquí (y en
 * index.html / public/manifest.webmanifest) es todo lo necesario.
 */
export const BRAND = {
  name: 'Nexo',
  tagline: 'Tu agente, en el bolsillo.',
  pairingHint: 'El código de 6 dígitos aparece en la consola del PC donde corre el puente.',
  footerNote:
    'Solo ves las respuestas del agente. Las herramientas y el razonamiento nunca salen del PC.',
} as const

/** Versión de la app, inyectada en build por Vite (package.json). */
export const APP_VERSION: string = __APP_VERSION__

/**
 * Dirección pública del puente (Tailscale Funnel). La rellena el aprovisionamiento
 * (`VITE_BOOTSTRAP_SERVER`, ver scripts/provisionar.mjs); en el repo queda vacía.
 */
export const DEFAULT_REMOTE_URL = (import.meta.env.VITE_BOOTSTRAP_SERVER ?? '').trim()
