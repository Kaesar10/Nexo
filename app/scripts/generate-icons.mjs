#!/usr/bin/env node
/**
 * Genera los iconos PNG de la PWA sin dependencias externas.
 * Dibuja el orbe de Nexo píxel a píxel y codifica el PNG con zlib.
 *
 * Uso: npm run icons
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(appRoot, 'public', 'icons')

/* ------------------------------- PNG ----------------------------------- */

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filtro "None"
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------ Dibujo ---------------------------------- */

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value))
const mix = (a, b, t) => a + (b - a) * t
const mixColor = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)]

function renderOrbIcon(size, { maskable = false } = {}) {
  const pixels = Buffer.alloc(size * size * 4)
  const cx = size / 2
  const cy = size / 2
  const radius = size * (maskable ? 0.285 : 0.335)
  const inner = [255, 244, 222]
  const amber = [232, 179, 107]
  const violet = [139, 124, 246]
  const white = [255, 251, 244]
  const background = [10, 10, 12]

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const distance = Math.hypot(dx, dy)
      const angle = Math.atan2(dy, dx)

      let color = [...background]

      // Ambiente: violeta arriba a la derecha, ámbar abajo a la izquierda.
      const violetAmbience = Math.exp(
        -Math.pow(Math.hypot(dx - size * 0.3, dy + size * 0.32) / (size * 0.66), 2),
      )
      const amberAmbience = Math.exp(
        -Math.pow(Math.hypot(dx + size * 0.32, dy - size * 0.34) / (size * 0.62), 2),
      )
      color = mixColor(color, violet, violetAmbience * 0.1)
      color = mixColor(color, amber, amberAmbience * 0.08)

      // Halo suave alrededor del orbe.
      const halo = Math.exp(-Math.pow(distance / (radius * 2.05), 2)) * 0.7
      color = mixColor(color, amber, halo * 0.16)

      // Anillo tenue con degradado.
      const ringDistance = Math.abs(distance - radius * 1.3)
      const ring =
        Math.exp(-Math.pow(ringDistance / (size * 0.009), 2)) *
        0.5 *
        (0.5 + 0.5 * Math.sin(angle * 1.2 + 0.9))
      color = mixColor(color, violet, ring * 0.35)
      color = mixColor(color, amber, ring * 0.12)

      // Orbe.
      if (distance < radius * 1.05) {
        const t = clamp(distance / radius)
        let orbColor =
          t < 0.52 ? mixColor(inner, amber, t / 0.52) : mixColor(amber, violet, (t - 0.52) / 0.48)

        // Luz interior.
        const highlightDistance = Math.hypot(dx + radius * 0.3, dy + radius * 0.34)
        const highlight = Math.exp(-Math.pow(highlightDistance / (radius * 0.52), 2)) * 0.5
        orbColor = mixColor(orbColor, white, highlight)

        // Borde suave (antialias).
        const coverage = clamp((radius - distance) / 1.4 + 0.5)
        color = mixColor(color, orbColor, coverage)

        // Chispa especular.
        const sparkDistance = Math.hypot(dx + radius * 0.32, dy + radius * 0.38)
        const spark = Math.exp(-Math.pow(sparkDistance / (radius * 0.18), 2)) * 0.55 * coverage
        color = mixColor(color, white, spark)
      }

      const offset = (y * size + x) * 4
      pixels[offset] = Math.round(clamp(color[0], 0, 255))
      pixels[offset + 1] = Math.round(clamp(color[1], 0, 255))
      pixels[offset + 2] = Math.round(clamp(color[2], 0, 255))
      pixels[offset + 3] = 255
    }
  }

  return encodePng(size, size, pixels)
}

/* ------------------------------ Salida ---------------------------------- */

mkdirSync(outDir, { recursive: true })

const targets = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-512-maskable.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: false },
]

for (const target of targets) {
  const png = renderOrbIcon(target.size, { maskable: target.maskable })
  writeFileSync(join(outDir, target.file), png)
  console.log(`✓ icons/${target.file} (${target.size}×${target.size}, ${Math.round(png.length / 1024)} KB)`)
}

console.log('Iconos generados en public/icons')
