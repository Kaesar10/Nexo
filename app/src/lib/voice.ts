/** Preferencia de motor de dictado: nativo del móvil o transcripción en el PC. */
export type VoiceEngine = 'native' | 'pc'

const KEY = 'nexo.voice.v1'

export const VOICE_ENGINE_LABEL: Record<VoiceEngine, string> = {
  native: 'Nativo del móvil',
  pc: 'En el PC (sin internet)',
}

export function getVoiceEngine(): VoiceEngine {
  try {
    return window.localStorage.getItem(KEY) === 'pc' ? 'pc' : 'native'
  } catch {
    return 'native'
  }
}

export function setVoiceEngine(engine: VoiceEngine): void {
  try {
    window.localStorage.setItem(KEY, engine)
  } catch {
    // almacenamiento no disponible
  }
}
