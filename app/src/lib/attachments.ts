import type { Attachment } from '../types'

const ATTACHMENT_LINE = /^\s*\[Adjunto:\s*(.+?)\]\s*$/i

/**
 * Separa el texto visible de las líneas `[Adjunto: ruta]` que añade el puente
 * al histórico. Devuelve las rutas por si no hay attachments resueltos.
 */
export function splitMessageText(text: string): { text: string; paths: string[] } {
  if (!text) return { text: '', paths: [] }
  const paths: string[] = []
  const lines: string[] = []
  for (const line of text.split('\n')) {
    const match = line.match(ATTACHMENT_LINE)
    if (match?.[1]) {
      paths.push(match[1].trim())
      continue
    }
    lines.push(line)
  }
  return { text: lines.join('\n').trim(), paths }
}

/** Último segmento de una ruta Windows o POSIX. */
export function attachmentBaseName(path: string): string {
  const clean = path.replace(/[\\/]+$/, '')
  const parts = clean.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export function isImageMime(mime?: string | null): boolean {
  return typeof mime === 'string' && mime.toLowerCase().startsWith('image/')
}

export function isImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(name)
}

export function isImageAttachment(attachment: Attachment): boolean {
  return isImageMime(attachment.mime) || isImageName(attachment.name || '')
}
