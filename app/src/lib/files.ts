/**
 * Adjuntos: imágenes (comprimidas a JPEG) y documentos que el agente puede
 * leer por sí mismo (PDF, Word, Excel, texto). Límite del puente: 25 MB.
 */
import { blobToBase64, MAX_UPLOAD_BYTES, prepareImage } from './images'

export { blobToBase64, MAX_UPLOAD_BYTES }

export type AttachmentKind = 'image' | 'file'

export interface PreparedAttachment {
  blob: Blob
  name: string
  mime: string
  size: number
  kind: AttachmentKind
}

export const PHOTO_ACCEPT = 'image/*'

export const FILE_ACCEPT = [
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.txt',
  '.md',
  '.csv',
  '.json',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
].join(',')

const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'md', 'csv', 'json'])

const DOCUMENT_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'text/json',
])

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
}

export function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name)
  return match?.[1]?.toLowerCase() ?? ''
}

export function mimeForName(name: string): string {
  return MIME_BY_EXTENSION[extensionOf(name)] ?? 'application/octet-stream'
}

export function isAllowedDocument(file: File): boolean {
  const extension = extensionOf(file.name)
  if (DOCUMENT_EXTENSIONS.has(extension)) return true
  return DOCUMENT_MIMES.has((file.type || '').toLowerCase())
}

/** "1,2 MB", "340 KB", "12 B" */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const formatter = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 })
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${formatter.format(bytes / 1024)} KB`
  return `${formatter.format(bytes / (1024 * 1024))} MB`
}

export async function prepareAttachment(file: File): Promise<PreparedAttachment> {
  if (file.type.startsWith('image/')) {
    const prepared = await prepareImage(file)
    return {
      blob: prepared.blob,
      name: prepared.name,
      mime: prepared.mime,
      size: prepared.blob.size,
      kind: 'image',
    }
  }

  if (!isAllowedDocument(file)) {
    throw new Error(
      'Formato no compatible. Adjunta PDF, DOC/DOCX, XLS/XLSX, TXT, MD, CSV o JSON.',
    )
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error('El archivo es demasiado grande (máximo 25 MB).')
  }

  return {
    blob: file,
    name: file.name || 'archivo',
    mime: file.type || mimeForName(file.name),
    size: file.size,
    kind: 'file',
  }
}
