/**
 * Estado de primer plano de la app.
 *
 * En el APK el WebView se mantiene vivo en segundo plano (para no perder el SSE
 * ni el aviso de tareas largas), así que `document.visibilityState` no es fiable:
 * el código nativo avisa con los eventos `nexo:background` / `nexo:foreground`.
 * En navegador se usa `visibilitychange` como siempre.
 */

let active = true
let installed = false

function readInitial(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState !== 'hidden'
}

function ensure(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  active = readInitial()

  window.addEventListener('nexo:background', () => {
    active = false
  })
  window.addEventListener('nexo:foreground', () => {
    active = true
  })

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      // En nativo, el evento del sistema manda: visibilitychange puede quedarse
      // en "visible" aunque la app esté en segundo plano.
      if (!window.Capacitor?.isNativePlatform?.()) {
        active = document.visibilityState !== 'hidden'
      } else if (document.visibilityState === 'visible') {
        active = true
      }
    })
  }
}

/** ¿Está la app en primer plano y con el usuario mirándola? */
export function isAppActive(): boolean {
  ensure()
  return active
}
