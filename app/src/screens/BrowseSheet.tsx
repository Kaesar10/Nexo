import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorText } from '../api'
import { ChevronLeft, ChevronRight, Folder } from '../components/Icons'
import { Sheet } from '../components/Sheet'
import { baseName } from '../lib/format'
import type { BrowseResult, Workspace } from '../types'

interface BrowseSheetProps {
  open: boolean
  onClose: () => void
  onAdded: (workspace: Workspace) => void
}

type Step = 'browse' | 'name'

export function BrowseSheet({ open, onClose, onAdded }: BrowseSheetProps) {
  const [result, setResult] = useState<BrowseResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<Step>('browse')
  const [name, setName] = useState('')
  const [adding, setAdding] = useState(false)
  const requestId = useRef(0)

  const load = useCallback(async (path?: string) => {
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      const data = await api.browse(path)
      if (id !== requestId.current) return
      setResult(data)
      setLoading(false)
    } catch (err) {
      if (id !== requestId.current) return
      setError(errorText(err))
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setStep('browse')
    setName('')
    setError(null)
    setResult(null)
    void load(undefined)
  }, [open, load])

  const chooseFolder = () => {
    if (!result) return
    setName(baseName(result.path))
    setError(null)
    setStep('name')
  }

  const addProject = async () => {
    if (!result) return
    const cleanName = name.trim()
    if (!cleanName) return
    setAdding(true)
    setError(null)
    try {
      const workspace = await api.addWorkspace(result.path, cleanName)
      onAdded(workspace)
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setAdding(false)
    }
  }

  const directories = (result?.entries ?? []).filter((entry) => entry.isDir)

  const footer =
    step === 'browse' ? (
      <>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void load(undefined)}
          disabled={loading}
        >
          Inicio
        </button>
        <button
          type="button"
          className="btn btn--primary btn--grow"
          onClick={chooseFolder}
          disabled={!result || loading}
        >
          Usar esta carpeta
        </button>
      </>
    ) : (
      <>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => setStep('browse')}
          disabled={adding}
        >
          Volver
        </button>
        <button
          type="button"
          className="btn btn--primary btn--grow"
          onClick={() => void addProject()}
          disabled={adding || !name.trim()}
        >
          {adding ? 'Añadiendo…' : 'Añadir proyecto'}
        </button>
      </>
    )

  return (
    <Sheet open={open} onClose={onClose} title="Añadir proyecto" footer={footer}>
      {step === 'browse' ? (
        <>
          <div className="browse__path" aria-live="polite">
            {result?.path ?? 'Cargando…'}
          </div>

          {error ? (
            <div className="inline-error" role="alert">
              <p>{error}</p>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => void load(result?.path)}
              >
                Reintentar
              </button>
            </div>
          ) : null}

          {loading ? (
            <div className="browse__list" aria-hidden="true">
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className="skeleton skeleton--row" />
              ))}
            </div>
          ) : result ? (
            <div className="browse__list">
              {result.parent !== null ? (
                <button
                  type="button"
                  className="browse__row browse__row--up"
                  onClick={() => void load(result.parent ?? undefined)}
                >
                  <ChevronLeft size={18} />
                  <span>Carpeta superior</span>
                </button>
              ) : null}

              {directories.length === 0 ? (
                <p className="browse__empty">Esta carpeta no tiene subcarpetas.</p>
              ) : (
                directories.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    className="browse__row"
                    onClick={() => void load(entry.path)}
                  >
                    <Folder size={18} />
                    <span>{entry.name}</span>
                    <ChevronRight size={16} />
                  </button>
                ))
              )}
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="browse__path">{result?.path}</div>
          <div className="field">
            <label htmlFor="project-name">Nombre del proyecto</label>
            <input
              id="project-name"
              className="text-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={60}
              autoFocus
            />
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      )}
    </Sheet>
  )
}
