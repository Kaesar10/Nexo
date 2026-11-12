/**
 * Dirección del PC (puente DSH) cuando la app corre dentro de un shell nativo
 * (Capacitor/APK), donde `http://localhost` no es el puente sino el contenedor.
 *
 * En la PWA servida por el propio puente no hay nada guardado y la base es ''
 * (mismo origen), igual que siempre.
 */
const KEY = 'nexo.server.v1'

function safeStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * Valida y normaliza una dirección del PC.
 * Acepta solo `http(s)://host[:port]` (sin ruta, credenciales, query ni hash)
 * y devuelve la URL sin barra final. `null` si no es válida.
 */
export function normalizeServer(url: string): string | null {
  const value = url.trim()
  if (!value) return null

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null
  if (parsed.search || parsed.hash) return null
  if (parsed.pathname !== '/' && parsed.pathname !== '') return null
  if (!parsed.hostname) return null

  return `${parsed.protocol}//${parsed.host}`
}

/** Base de la API guardada. `''` = mismo origen (PWA servida por el puente). */
export function getServerBase(): string {
  const storage = safeStorage()
  if (!storage) return ''
  try {
    const stored = storage.getItem(KEY)
    if (!stored) return ''
    return normalizeServer(stored) ?? ''
  } catch {
    return ''
  }
}

/** Guarda la base de la API. Ignora valores no válidos. */
export function setServerBase(url: string): void {
  const normalized = normalizeServer(url)
  if (!normalized) return
  const storage = safeStorage()
  if (!storage) return
  try {
    storage.setItem(KEY, normalized)
  } catch {
    // almacenamiento no disponible: la dirección dura lo que la pestaña
  }
}

/**
 * True dentro de un shell nativo (Capacitor) o en el `http://localhost`
 * que sirve el contenedor. En la PWA del puente siempre es false.
 */
export function isNativeShell(): boolean {
  if (typeof window === 'undefined') return false
  if (window.Capacitor?.isNativePlatform?.() === true) return true
  return window.location.hostname === 'localhost' && window.location.protocol === 'http:'
}

function isPrivateIpv4(hostname: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false
  const [a, b] = hostname.split('.').map(Number)
  if (a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return a === 192 && b === 168
}

function isTailscaleIpv4(hostname: string): boolean {
  if (!/^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false
  const second = Number(hostname.split('.')[1])
  return second >= 64 && second <= 127
}

/** Etiqueta legible del modo de conexión inferida de la URL. */
export function serverModeLabel(base: string): string {
  if (!base) return 'Mismo origen'
  try {
    const url = new URL(base)
    const hostname = url.hostname.toLowerCase()
    if (hostname === 'localhost' || hostname.endsWith('.local') || isPrivateIpv4(hostname)) {
      return 'Red local'
    }
    if (isTailscaleIpv4(hostname)) return 'Tailscale'
    if (url.protocol === 'https:') {
      return hostname.endsWith('.ts.net')
        ? 'Internet (HTTPS) · Tailscale Funnel'
        : 'Internet (HTTPS)'
    }
    if (hostname.endsWith('.ts.net')) return 'Tailscale'
    return 'Internet (HTTP)'
  } catch {
    return 'Mismo origen'
  }
}
