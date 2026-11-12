/** Fechas y textos en español, sin dependencias. */

/** "ahora mismo", "hace 5 min", "hace 2 h", "ayer", "hace 3 días", "12 nov". */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - timestamp)
  const seconds = Math.round(diffMs / 1000)
  if (seconds < 45) return 'ahora mismo'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return minutes <= 1 ? 'hace 1 min' : `hace ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours <= 1 ? 'hace 1 h' : `hace ${hours} h`
  const days = Math.round(hours / 24)
  if (days === 1) return 'ayer'
  if (days < 7) return `hace ${days} días`
  return shortDate(timestamp, now)
}

/** "12 nov" o "12 nov 2025" si no es el año actual. */
export function shortDate(timestamp: number, now: number = Date.now()): string {
  const date = new Date(timestamp)
  const current = new Date(now)
  const sameYear = date.getFullYear() === current.getFullYear()
  try {
    return new Intl.DateTimeFormat('es-ES', {
      day: 'numeric',
      month: 'short',
      ...(sameYear ? {} : { year: 'numeric' }),
    }).format(date)
  } catch {
    return date.toLocaleDateString()
  }
}

/** Hora corta "14:05". */
export function clockTime(timestamp: number): string {
  const date = new Date(timestamp)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/** "3 s", "18 s", "1 min 12 s", "1 h 4 min". */
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000))
  if (totalSeconds < 60) return `${totalSeconds} s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Clave local del día (para agrupar mensajes). */
export function dayKey(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

/** "Hoy · 11:45", "Ayer · 09:12", "10 nov · 11:45". */
export function daySeparatorLabel(timestamp: number, now: number = Date.now()): string {
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(timestamp)) / 86_400_000)
  const time = clockTime(timestamp)
  if (days === 0) return `Hoy · ${time}`
  if (days === 1) return `Ayer · ${time}`
  return `${shortDate(timestamp, now)} · ${time}`
}

/** Recorta por el medio respetando rutas: C:\Users\...\proyecto. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max || max < 8) return text
  const head = Math.ceil((max - 1) * 0.62)
  const tail = max - 1 - head
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/** Conserva el final de la ruta (lo útil): …\Proyectos\nexo-app. */
export function tailPath(path: string, max: number): string {
  if (path.length <= max) return path
  const separator = path.includes('\\') ? '\\' : '/'
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  let result = parts[parts.length - 1] ?? path
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    const next = `${parts[index]}${separator}${result}`
    if (next.length + 1 > max) break
    result = next
  }
  return `…${separator}${result}`.replace(/([\\/])\1+/g, '$1')
}

/** Último segmento de una ruta Windows o POSIX. */
export function baseName(path: string): string {
  const clean = path.replace(/[\\/]+$/, '')
  const parts = clean.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** Saludo según la hora del dispositivo. */
export function greeting(now: Date = new Date()): string {
  const hour = now.getHours()
  if (hour < 6) return 'Buenas noches'
  if (hour < 12) return 'Buenos días'
  if (hour < 20) return 'Buenas tardes'
  return 'Buenas noches'
}
