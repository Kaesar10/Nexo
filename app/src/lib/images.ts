/** Preparación de imágenes en el cliente: máx. 1600 px de lado y JPEG 0.85. */

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const MAX_SIDE = 1600
const JPEG_QUALITY = 0.85

export interface PreparedImage {
  blob: Blob
  name: string
  mime: string
  width: number
  height: number
}

function loadImage(file: File): Promise<{ image: HTMLImageElement; objectUrl: string }> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => resolve({ image, objectUrl })
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('No se pudo leer la imagen. Prueba con otra foto.'))
    }
    image.src = objectUrl
  })
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('No se pudo procesar la imagen.'))
      },
      'image/jpeg',
      JPEG_QUALITY,
    )
  })
}

function jpegName(originalName: string): string {
  const base = originalName.replace(/\.[^./\\]+$/, '').trim() || 'imagen'
  return `${base}.jpg`
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Solo se pueden adjuntar imágenes.')
  }

  const { image, objectUrl } = await loadImage(file)
  try {
    const longestSide = Math.max(image.naturalWidth, image.naturalHeight)
    if (longestSide === 0) throw new Error('La imagen está vacía.')

    const scale = Math.min(1, MAX_SIDE / longestSide)
    const width = Math.max(1, Math.round(image.naturalWidth * scale))
    const height = Math.max(1, Math.round(image.naturalHeight * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No se pudo procesar la imagen.')
    // Fondo oscuro para PNG con transparencia (se guarda como JPEG).
    context.fillStyle = '#0a0a0c'
    context.fillRect(0, 0, width, height)
    context.drawImage(image, 0, 0, width, height)

    const blob = await canvasToBlob(canvas)
    if (blob.size > MAX_UPLOAD_BYTES) {
      throw new Error('La imagen es demasiado grande (máximo 25 MB).')
    }

    return { blob, name: jpegName(file.name), mime: 'image/jpeg', width, height }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(new Error('No se pudo leer la imagen.'))
    reader.readAsDataURL(blob)
  })
}
