import type { ServerEvent } from './types'

type Listener = (event: ServerEvent) => void

const listeners = new Set<Listener>()

/**
 * Bus interno de eventos SSE. App conecta el `EventStream` y reemite aquí;
 * las pantallas se suscriben sin conocer detalles de la conexión.
 */
export const bus = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  emit(event: ServerEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // un suscriptor roto no debe tumbar el flujo de eventos
      }
    }
  },
}
