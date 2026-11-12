import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { api, errorText } from '../api'
import { BRAND, DEFAULT_REMOTE_URL } from '../brand'
import { ArrowRight, Lock, Refresh } from '../components/Icons'
import { Orb } from '../components/Orb'
import {
  getServerBase,
  isNativeShell,
  normalizeServer,
  serverModeLabel,
  setServerBase,
} from '../lib/server'
import type { DeviceSession } from '../types'

interface PairScreenProps {
  onPaired: (session: DeviceSession) => void
  serverVersion: string | null
  initialError: string | null
}

type TestState = 'idle' | 'testing' | 'ok' | 'error'

function defaultDeviceName(): string {
  const ua = navigator.userAgent
  if (/iPhone/i.test(ua)) return 'iPhone'
  if (/iPad/i.test(ua)) return 'iPad'
  if (/Android/i.test(ua)) return 'Android'
  return 'Este dispositivo'
}

export function PairScreen({ onPaired, serverVersion, initialError }: PairScreenProps) {
  const native = isNativeShell()
  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState(defaultDeviceName)
  const [serverAddress, setServerAddress] = useState(() => getServerBase() || DEFAULT_REMOTE_URL)
  const [localMode, setLocalMode] = useState(false)
  const [localAddress, setLocalAddress] = useState('')
  const [serverTouched, setServerTouched] = useState(false)
  const [testState, setTestState] = useState<TestState>('idle')
  const [testDetail, setTestDetail] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(initialError)
  const [onlineVersion, setOnlineVersion] = useState<string | null>(serverVersion)
  const codeRef = useRef<HTMLInputElement>(null)
  const serverRef = useRef<HTMLInputElement>(null)
  const localRef = useRef<HTMLInputElement>(null)

  const savedBase = getServerBase()
  const effectiveAddress = localMode && localAddress.trim() ? localAddress : serverAddress
  const normalizedServer = normalizeServer(effectiveAddress)
  const modeLabel = normalizedServer ? serverModeLabel(normalizedServer) : null
  const showServerError =
    native && serverTouched && effectiveAddress.trim() !== '' && normalizedServer === null

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (native && !getServerBase()) serverRef.current?.focus()
      else codeRef.current?.focus()
    }, 450)
    return () => window.clearTimeout(timer)
  }, [native])

  useEffect(() => {
    setOnlineVersion(serverVersion)
  }, [serverVersion])

  // Si al arrancar no había puente, seguimos buscándolo en segundo plano.
  // En el shell nativo, primero hace falta una dirección del PC.
  useEffect(() => {
    if (onlineVersion) return
    if (native && !savedBase) return
    let alive = true
    let timer: number | null = null
    const check = async () => {
      try {
        const health = await api.health()
        if (alive) setOnlineVersion(health.version)
      } catch {
        if (alive) {
          timer = window.setTimeout(() => {
            void check()
          }, 4000)
        }
      }
    }
    void check()
    return () => {
      alive = false
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [onlineVersion, native, savedBase])

  const digits = code.replace(/\D/g, '').slice(0, 6)
  // La dirección del PC se valida al enviar: así el error aparece si no vale
  // en vez de dejar el botón deshabilitado sin explicación.
  const canSubmit = digits.length === 6 && deviceName.trim().length > 0 && !busy

  const testConnection = async () => {
    setServerTouched(true)
    if (!normalizedServer) {
      setTestState('error')
      setTestDetail('Escribe una dirección válida antes de probar.')
      return
    }
    setTestState('testing')
    setTestDetail(null)
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch(`${normalizedServer}/api/health`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`el puente respondió HTTP ${response.status}`)
      const health = (await response.json()) as {
        version?: string
        dsh?: { ok?: boolean; profile?: string }
      }
      setTestState('ok')
      setTestDetail(
        `Conectado · v${health.version ?? '?'}${
          health.dsh?.profile ? ` · DSH ${health.dsh.profile}` : ''
        }`,
      )
    } catch (err) {
      setTestState('error')
      if (err instanceof Error && err.name === 'AbortError') {
        setTestDetail('Sin respuesta tras 8 s. Revisa la dirección y la conexión.')
      } else {
        setTestDetail(
          `No se pudo conectar: ${err instanceof Error ? err.message : 'error desconocido'}`,
        )
      }
    } finally {
      window.clearTimeout(timer)
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit) return
    if (native && !normalizedServer) {
      setServerTouched(true)
      serverRef.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    try {
      // La petición de emparejamiento debe salir ya hacia la dirección elegida.
      if (native && normalizedServer) setServerBase(normalizedServer)
      const session = await api.pair(digits, deviceName.trim())
      if (native && normalizedServer) setServerBase(normalizedServer)
      onPaired(session)
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
      codeRef.current?.focus()
      codeRef.current?.select()
    }
  }

  return (
    <div className="screen screen--pair">
      <main className="pair">
        <div className="pair__orb">
          <Orb state={busy ? 'thinking' : 'idle'} size={132} />
        </div>

        <div className="pair__brand">
          <h1>{BRAND.name}</h1>
          <p>{BRAND.tagline}</p>
        </div>

        <form className="pair__form" noValidate onSubmit={(event) => void submit(event)}>
          {native ? (
            <div className="field">
              <label htmlFor="pair-server">Dirección del PC</label>
              <input
                ref={serverRef}
                id="pair-server"
                className="text-input"
                type="url"
                value={serverAddress}
                onChange={(event) => setServerAddress(event.target.value)}
                onBlur={() => setServerTouched(true)}
                placeholder={DEFAULT_REMOTE_URL}
                inputMode="url"
                autoComplete="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-describedby="pair-server-hint"
                aria-invalid={showServerError || undefined}
                disabled={busy}
              />
              <p id="pair-server-hint" className="hint">
                Viene la dirección pública para usarla fuera de casa. En casa puedes usar la IP
                local, que es más rápida.
              </p>

              {modeLabel && !localMode ? (
                <p className="pair__mode">
                  <span className={`conn conn--${testState === 'ok' ? 'open' : 'connecting'}`} aria-hidden="true" />
                  {modeLabel}
                </p>
              ) : null}

              {!localMode ? (
                <button
                  type="button"
                  className="pair__link"
                  onClick={() => {
                    setLocalMode(true)
                    window.setTimeout(() => localRef.current?.focus(), 50)
                  }}
                >
                  Usar la IP local (más rápido en casa)
                </button>
              ) : (
                <div className="pair__local">
                  <label htmlFor="pair-server-local">Dirección local (LAN)</label>
                  <input
                    ref={localRef}
                    id="pair-server-local"
                    className="text-input"
                    type="url"
                    value={localAddress}
                    onChange={(event) => setLocalAddress(event.target.value)}
                    onBlur={() => setServerTouched(true)}
                    placeholder="http://192.168.0.202:8790"
                    inputMode="url"
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={busy}
                  />
                  <p className="hint">Si la dejas vacía se usará la dirección de Internet.</p>
                  <button
                    type="button"
                    className="pair__link"
                    onClick={() => {
                      setLocalMode(false)
                      setLocalAddress('')
                    }}
                  >
                    Usar la dirección de Internet
                  </button>
                </div>
              )}

              {showServerError ? (
                <p className="field-error" role="alert">
                  Dirección no válida. Usa el formato http://192.168.0.202:8790.
                </p>
              ) : null}

              <div className="pair__test">
                <button
                  type="button"
                  className="btn btn--ghost btn--compact connection-test"
                  onClick={() => void testConnection()}
                  disabled={busy || testState === 'testing'}
                >
                  {testState === 'testing' ? (
                    <span className="spinner" aria-hidden="true" />
                  ) : (
                    <Refresh size={15} />
                  )}
                  Probar conexión
                </button>
                {testState !== 'idle' && testState !== 'testing' ? (
                  <p
                    className={`connection-test__result${testState === 'error' ? ' is-error' : ' is-ok'}`}
                    role="status"
                  >
                    {testState === 'ok' ? '✓ ' : '✗ '}
                    {testDetail}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="pair-code">Código de emparejamiento</label>
            <input
              ref={codeRef}
              id="pair-code"
              className="code-input"
              value={digits}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="••••••"
              aria-describedby="pair-code-hint"
              disabled={busy}
            />
            <p id="pair-code-hint" className="hint">
              {BRAND.pairingHint}
            </p>
          </div>

          <div className="field">
            <label htmlFor="pair-name">Nombre de este dispositivo</label>
            <input
              id="pair-name"
              className="text-input"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value.slice(0, 40))}
              autoComplete="off"
              maxLength={40}
              disabled={busy}
            />
          </div>

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" className="btn btn--primary btn--wide" disabled={!canSubmit}>
            {busy ? (
              <>
                <span className="spinner spinner--dark" aria-hidden="true" />
                Emparejando…
              </>
            ) : (
              <>
                Emparejar
                <ArrowRight size={18} />
              </>
            )}
          </button>
        </form>

        <p className="pair__status" role="status">
          <span
            className={`conn conn--${onlineVersion ? 'open' : 'reconnecting'}`}
            aria-hidden="true"
          />
          {native && !savedBase
            ? 'Escribe la dirección del PC o prueba la conexión.'
            : onlineVersion
              ? `Puente conectado · v${onlineVersion}`
              : 'Buscando el puente en tu red…'}
        </p>

        <p className="pair__privacy">
          <Lock size={13} aria-hidden="true" />
          {BRAND.footerNote}
        </p>
      </main>
    </div>
  )
}
