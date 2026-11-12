import { Check } from './Icons'
import { Sheet } from './Sheet'
import type { ModelInfo } from '../types'

interface ModelListProps {
  models: ModelInfo[]
  selectedId: string
  onSelect: (id: string) => void
}

/** Lista de modelos reutilizable (hoja del chat y ajustes). */
export function ModelList({ models, selectedId, onSelect }: ModelListProps) {
  return (
    <div className="model-list" role="radiogroup" aria-label="Modelo del agente">
      {models.map((model) => {
        const selected = model.id === selectedId
        return (
          <button
            key={model.id}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`model-row${selected ? ' is-selected' : ''}`}
            onClick={() => onSelect(model.id)}
          >
            <span className="model-row__text">
              <strong>{model.name}</strong>
              <small>{model.hint}</small>
            </span>
            {selected ? (
              <span className="model-row__check">
                <Check size={18} />
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

interface ModelSheetProps {
  open: boolean
  onClose: () => void
  models: ModelInfo[]
  selectedId: string
  onSelect: (id: string) => void
  title?: string
  description?: string
}

export function ModelSheet({
  open,
  onClose,
  models,
  selectedId,
  onSelect,
  title = 'Modelo',
  description = 'El modelo se aplica al siguiente mensaje de esta conversación.',
}: ModelSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <ModelList
        models={models}
        selectedId={selectedId}
        onSelect={(id) => {
          onSelect(id)
          onClose()
        }}
      />
      <p className="settings-note">{description}</p>
    </Sheet>
  )
}
