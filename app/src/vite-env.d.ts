/// <reference types="vite/client" />

declare const __APP_VERSION__: string

interface ImportMetaEnv {
  /** Base de la API. En producción (mismo origen) se deja vacía. */
  readonly VITE_API_BASE?: string
  /** Token de dispositivo hornado en el APK (aprovisionamiento local). */
  readonly VITE_DEVICE_TOKEN?: string
  readonly VITE_DEVICE_ID?: string
  readonly VITE_BOOTSTRAP_SERVER?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Puente inyectado por Capacitor en el APK. */
interface Window {
  Capacitor?: {
    isNativePlatform?: () => boolean
    /** Plugins nativos instalados en `apk/` (p. ej. SpeechRecognition). */
    Plugins?: Record<string, unknown>
  }
}
