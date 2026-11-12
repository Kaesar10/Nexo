# Arquitectura

```
┌──────────────────────────────┐
│  Móvil (PWA instalable)      │
│  React + Vite + TS           │
│  · orbe de presencia         │
│  · selector de workspace     │
│  · chat (solo respuestas)    │
└──────────────┬───────────────┘
               │ HTTPS/WSS (LAN, Tailscale o túnel Cloudflare)
               ▼
┌──────────────────────────────────────────────┐
│  Puente DSH Móvil  (Node 24, sin deps)       │
│  server/                                     │
│  · PIN de emparejamiento → tokens de device  │
│  · registro de workspaces + navegador de FS  │
│  · lanzador de turnos (spawn dsh headless)   │
│  · traductor NDJSON → eventos SSE            │
│  · sirve la PWA compilada (mismo origen)     │
└──────────────┬───────────────────────────────┘
               │ child_process.spawn (cwd = workspace)
               ▼
┌──────────────────────────────────────────────┐
│  dsh --profile headless --json "…"           │
│  · mismas herramientas, skills y sandbox     │
│  · sesiones persistidas en ~/.dsh/sessions   │
└──────────────┬───────────────────────────────┘
               ▼
   ~/.dsh/sessions/<workspace>/session-<uuid>/session.v4.jsonl.zstd
   ↑ el GUI de DSH lee el mismo almacén → sincronización real
```

## Por qué así

- **`dsh headless --json` es una API oficial y estable**, no hay que
  reimplementar RPC internos ni pelearse con el *trust fence* del servidor web.
  Ya validado: crea sesión con `cwd` = workspace, emite eventos NDJSON
  (`thinking`, `tool_call`, `tool_result`, `text`, `status`, `final`), acepta
  `--session-id` para continuar con memoria y `--approval-policy never` para no
  bloquearse esperando aprobación.
- **Sincronización bidireccional gratis**: las sesiones viven en el almacén de
  DSH. Un chat abierto en el móvil aparece en la lista de sesiones del escritorio
  y viceversa. El móvil lee el histórico del mismo `session.v4.jsonl.zstd`.
- **La PWA se sirve desde el propio puente** → mismo origen, sin CORS, y se
  puede instalar en la pantalla de inicio (Android e iOS) abriendo la URL.
- **Un turno = un proceso**. Aísla fallos, permite `stop` con kill y evita
  fugas de memoria. Coste: ~1-2 s de arranque por mensaje (aceptable).

## Seguridad

El puente es, por definición, **ejecución remota de código en tu PC**. Por eso:

1. PIN de 6 dígitos solo para emparejar; después token de dispositivo de 256 bits.
2. Tokens guardados con hash, revocables, y se puede rotar el PIN.
3. Por defecto el sandbox es `workspace-write`: el agente solo escribe dentro del
   proyecto elegido y no puede salir de él.
4. Nunca exponer el puerto a Internet sin túnel con TLS (Cloudflare) o Tailscale.
5. El PIN se imprime solo en la consola del PC, nunca se sirve por HTTP.

## Estado de un turno

`idle → turn_start → thinking/tool*/delta* → turn_end`.

El `turn_end` con `status:"error"` siempre lleva `text` con el mensaje de error
de DSH (p. ej. credencial caducada) para que la app lo muestre tal cual.

## Limitación conocida: sesiones del escritorio

Las sesiones que crea el escritorio de DSH llevan `agentPreset` en su cabecera.
El runner de un solo turno (`dsh headless`) **rechaza por diseño** adoptarlas:

> session "…" runs under agent preset "standard", which the one-shot runner does
> not compose — `assertAdoptable()` en `@deepseek-ai/dsh-headless`

Por eso:

- Los chats **creados desde el móvil** son sesiones sin preset: se pueden
  continuar desde el móvil y también se ven (y se pueden continuar) en el
  escritorio. Este es el flujo principal.
- Los chats **creados en el escritorio** se pueden leer desde el móvil, pero no
  continuar: la app los marca como solo lectura (`adoptable: false`) y ofrece
  empezar una conversación nueva.

No es un fallo del puente: es cómo DSH compone presets. Si en el futuro DSH
expone una opción para que el runner componga un preset, el puente podrá
adoptarlas sin cambios de interfaz.

## Credenciales del LLM

`dsh --profile headless` necesita la clave del proveedor. El puente la resuelve
en este orden: variable de entorno `DEEPSEEK_API_KEY` → `~/.dsh/.credentials.yaml`
(campo `refs.DEEPSEEK_API_KEY`) → error explicativo. No se guarda ninguna copia
en el proyecto.
