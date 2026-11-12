import type { ModelInfo } from '../types'

const STORAGE_KEY = 'nexo.model.v1'

/** Fallback si el puente es antiguo y no expone GET /api/models. */
export const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'deepseek-flash', name: 'DeepSeek Flash', hint: 'rápido', isDefault: true },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    hint: 'máximo razonamiento',
    isDefault: false,
  },
]

export function getStoredDefaultModelId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function setStoredDefaultModelId(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // almacenamiento no disponible
  }
}

export function defaultModelId(models: ModelInfo[]): string {
  return models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? 'deepseek-flash'
}

/** Devuelve el id si existe en el catálogo; si no, el modelo por defecto. */
export function resolveModelId(models: ModelInfo[], id: string | null | undefined): string {
  if (id && models.some((model) => model.id === id)) return id
  return defaultModelId(models)
}

export function modelName(models: ModelInfo[], id: string | null | undefined): string {
  if (!id) return 'Modelo por defecto'
  return models.find((model) => model.id === id)?.name ?? id
}
