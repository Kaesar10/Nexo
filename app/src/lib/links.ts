/**
 * Enlaces en respuestas del asistente: markdown `[texto](url)`, URLs sueltas y
 * tarjetas de enlace. Nunca interpreta URLs dentro de bloques de código.
 */
export interface LinkCard {
  url: string
  title: string
  domain: string
}

export interface ParsedAssistantContent {
  text: string
  links: LinkCard[]
}

const CODE_FENCE = /```[\s\S]*?```/g
const INLINE_CODE = /`[^`\n]*`/g
const MARKDOWN_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g
const BARE_URL = /https?:\/\/[^\s<>"'`]+/g

function safeUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

export function domainOf(url: string): string {
  const parsed = safeUrl(url)
  return parsed ? parsed.hostname.replace(/^www\./, '') : url
}

/** Título legible: último segmento de la URL o el dominio. */
export function deriveLinkTitle(url: string): string {
  const parsed = safeUrl(url)
  if (!parsed) return url
  const segments = parsed.pathname.split('/').filter(Boolean)
  const last = segments[segments.length - 1]
  if (last) {
    let clean = last
    try {
      clean = decodeURIComponent(last)
    } catch {
      // segmento no decodificable: se deja tal cual
    }
    clean = clean
      .replace(/\.(html?|php|aspx?|md)$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim()
    if (clean) {
      return clean.charAt(0).toUpperCase() + clean.slice(1)
    }
  }
  return parsed.hostname.replace(/^www\./, '')
}

function collectLinks(
  plain: string,
  links: LinkCard[],
  seen: Set<string>,
  maxLinks: number,
): string {
  let result = plain.replace(
    MARKDOWN_LINK,
    (_match: string, label: string, url: string) => {
      if (seen.has(url) || links.length >= maxLinks) return label
      seen.add(url)
      links.push({
        url,
        title: label.trim() || deriveLinkTitle(url),
        domain: domainOf(url),
      })
      return label
    },
  )

  result = result.replace(BARE_URL, (url: string) => {
    if (seen.has(url) || links.length >= maxLinks) return url
    seen.add(url)
    links.push({ url, title: deriveLinkTitle(url), domain: domainOf(url) })
    return ''
  })

  return result
}

function processPlainText(
  plain: string,
  links: LinkCard[],
  seen: Set<string>,
  maxLinks: number,
): string {
  const parts: string[] = []
  let index = 0
  for (const match of plain.matchAll(INLINE_CODE)) {
    const start = match.index ?? 0
    parts.push(collectLinks(plain.slice(index, start), links, seen, maxLinks))
    parts.push(match[0])
    index = start + match[0].length
  }
  parts.push(collectLinks(plain.slice(index), links, seen, maxLinks))
  return parts.join('')
}

/** Separa el texto visible de las tarjetas de enlace (máx. 3 por mensaje). */
export function parseAssistantContent(
  text: string,
  maxLinks = 3,
): ParsedAssistantContent {
  const links: LinkCard[] = []
  const seen = new Set<string>()
  const parts: string[] = []
  let index = 0

  for (const match of text.matchAll(CODE_FENCE)) {
    const start = match.index ?? 0
    parts.push(processPlainText(text.slice(index, start), links, seen, maxLinks))
    parts.push(match[0])
    index = start + match[0].length
  }
  parts.push(processPlainText(text.slice(index), links, seen, maxLinks))

  const visible = parts
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\(\s*\)/g, '')
    .trim()

  return { text: visible, links }
}

interface BrowserPlugin {
  open?: (options: { url: string; presentationStyle?: string }) => Promise<void> | void
}

/** Abre un enlace con el plugin Browser de Capacitor si existe; si no, pestaña web. */
export function openExternal(url: string): void {
  const plugins = window.Capacitor?.Plugins
  const browser = plugins?.['Browser'] as BrowserPlugin | undefined
  if (browser && typeof browser.open === 'function') {
    try {
      void browser.open({ url })
      return
    } catch {
      // cae al window.open
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
