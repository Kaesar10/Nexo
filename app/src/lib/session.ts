import type { DeviceSession } from '../types'

const STORAGE_KEY = 'nexo.device.v1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function loadSession(): DeviceSession | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const data: unknown = JSON.parse(raw)
    if (!isRecord(data)) return null
    const { token, deviceId, deviceName } = data
    if (typeof token !== 'string' || !token) return null
    if (typeof deviceId !== 'string' || !deviceId) return null
    if (typeof deviceName !== 'string') return null
    return { token, deviceId, deviceName }
  } catch {
    return null
  }
}

export function saveSession(session: DeviceSession): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
  } catch {
    // almacenamiento no disponible (modo privado): la sesión dura lo que la pestaña
  }
}

export function clearSession(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // nada que limpiar
  }
}
