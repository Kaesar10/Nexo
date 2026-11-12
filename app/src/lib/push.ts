/**
 * Push propio de Nexo: lo sirve el servicio en primer plano del APK.
 *
 * No usa FCM ni cuenta de Google. El servicio mantiene un long-poll contra
 * `/api/push` y publica la notificación nativa aunque la app esté cerrada.
 * En PWA no hay servicio: estas funciones no hacen nada.
 */

interface NexoPushPlugin {
  start?: (options: { serverUrl: string; token: string }) => Promise<unknown> | unknown
  stop?: () => Promise<unknown> | unknown
  clear?: () => Promise<unknown> | unknown
  status?: () => Promise<unknown> | unknown
}

function plugin(): NexoPushPlugin | null {
  const plugins = window.Capacitor?.Plugins
  if (!plugins || typeof plugins !== 'object') return null
  const candidate = (plugins as Record<string, unknown>)['NexoPush']
  return candidate && typeof candidate === 'object' ? (candidate as NexoPushPlugin) : null
}

export function pushSupported(): boolean {
  return Boolean(plugin()?.start)
}

export async function startTaskPush(serverUrl: string, token: string): Promise<boolean> {
  const target = plugin()
  if (!target?.start || !serverUrl || !token) return false
  try {
    await target.start({ serverUrl, token })
    return true
  } catch {
    return false
  }
}

export async function stopTaskPush(): Promise<void> {
  const target = plugin()
  if (!target?.stop) return
  try {
    await target.stop()
  } catch {
    // servicio no disponible
  }
}

export async function clearTaskPush(): Promise<void> {
  const target = plugin()
  if (!target?.clear) return
  try {
    await target.clear()
  } catch {
    // nada que limpiar
  }
}

export async function getPushStatus(): Promise<{ running: boolean; configured: boolean } | null> {
  const target = plugin()
  if (!target?.status) return null
  try {
    const result = await target.status()
    if (result && typeof result === 'object') {
      const record = result as Record<string, unknown>
      return {
        running: record['running'] === true,
        configured: record['configured'] === true,
      }
    }
    return null
  } catch {
    return null
  }
}
