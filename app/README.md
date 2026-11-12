# Nexo · app móvil del agente DSH

PWA instalable (React + Vite + TypeScript) para hablar con el agente de
DeepSeek Harness que corre en tu PC. Muestra **solo las respuestas del
asistente**, nunca tool calls crudas ni razonamiento.

Flujo: **Emparejar** (código de 6 dígitos) → **Proyectos** → **Conversaciones** → **Chat**.

- Fondo casi negro cálido, orbe de presencia animado (idle / pensando / respondiendo).
- Streaming token a token por SSE, botón *stop*, reconexión con backoff exponencial.
- **Modelo por conversación** (`deepseek-flash` / `deepseek-v4-pro`) con selector bajo el
  compositor, modelo visible en la cabecera y modelo por defecto en Ajustes.
- **Adjuntos de cualquier tipo**: fotos (miniatura) y documentos PDF/DOCX/XLSX/TXT/CSV/JSON/MD
  (chip con nombre y tamaño). Compresión de imágenes (1600 px, JPEG 0.85), límite 25 MB,
  visor a pantalla completa para imágenes.
- **Dictado con dos motores** (Ajustes → Dictado): nativo del móvil (SpeechRecognition) o
  **en el PC sin internet** (graba WAV mono 16 kHz y usa `POST /api/transcribe`).
- **Notificaciones locales** al terminar tareas de más de 8 s con la app en segundo plano,
  con interruptor en Ajustes y permiso gestionado.
- Chats creados en el escritorio (`adoptable: false`) se pueden leer pero no continuar:
  se marcan en la lista y el composer se sustituye por un aviso con “Nueva conversación”.
- Si un turno acaba en error, se muestra el `text` del `turn_end` y un botón **Reintentar**
  que reenvía el último mensaje del usuario.
- **Pantalla del agente** (avatar de la barra superior): orbe, modo de conexión,
  versión/perfil/dispositivo/modelo por defecto y **actividad reciente** con duración,
  herramientas y resultado; al tocar una entrada se abre ese chat.
- **Chat más rico**: separadores de día (“Hoy · 11:45”, “Ayer · 09:12”, “10 nov · 11:45”)
  y **tarjetas de enlace** para URLs y markdown `[texto](url)` (abren con el plugin
  Browser del APK o pestaña del navegador; nunca se interpretan dentro de código).
- **Drawer de proyectos** (hamburguesa): lista tipo canales con proyecto actual resaltado,
  punto de actividad reciente y pie con Todos los proyectos / Añadir proyecto / Ajustes.
- Español en toda la UI, fechas relativas (“hace 2 h”), tema oscuro, safe-area y `100dvh`.
- Cliente tipado del contrato congelado [`docs/API.md`](../docs/API.md), mismo origen por defecto.
- También se puede empaquetar como **APK de Android** con Capacitor (ver más abajo):
  en ese caso la app pide la dirección del PC en el emparejamiento y propone por defecto
  la dirección pública (Tailscale Funnel), con opción de IP local y botón “Probar conexión”.

## Requisitos

- Node 20.19+ (probado con Node 24) y npm.
- Para el modo mock no hace falta nada más.

## Instalación

```powershell
cd app
npm install
```

## Desarrollo con el mock (sin el PC/DSH)

Dos terminales:

```powershell
# Terminal 1 — mock del puente (Node puro, sin dependencias)
npm run mock                 # http://127.0.0.1:8791 · PIN 123456

# Terminal 2 — Vite con proxy a la API mock
npm run dev:mock             # http://localhost:5173
```

La app usa base `''` (mismo origen) y en desarrollo Vite proxifica `/api` al
puente. `npm run dev:mock` apunta el proxy a `8791`; `npm run dev` lo apunta al
puente real en `8790`.

Si el puerto `8791` está ocupado, usa otro y pásalo al proxy:

```powershell
$env:PORT=8792; npm run mock                                  # terminal 1
$env:VITE_API_PROXY='http://127.0.0.1:8792'; npm run dev:mock # terminal 2
```

Para abrirlo desde el móvil en la misma red, Vite escucha en todas las
interfaces: `http://<IP-del-PC>:5173`.

### Mock: detalles útiles

- Implementa **todas** las rutas de `docs/API.md`, incluido SSE con deltas
  simulados palabra a palabra, latencia, `heartbeat` cada 20 s, `409 CONFLICT`
  y `stop`.
- Persiste emparejamientos/proyectos/chats en `mock/data.json` (ignorado por git)
  para no tener que emparejar en cada reinicio. Bórralo o usa `MOCK_RESET=1`.
- Si hay build en `app/dist`, el mock también sirve la PWA en la misma URL.
- Un mensaje que contenga **“error”** o **“fallo”** hace que el turno acabe con
  `turn_end.status = "error"` y un `text` legible: sirve para probar el estado de
  error en la UI.
- Incluye un chat con `adoptable: false` (creado en el escritorio) y otro sin
  `messageCount`, para probar el modo solo lectura y la lista sin contador.
- Implementa también `GET /api/models`, `GET /api/voice-status`, `POST /api/transcribe`,
  `GET /api/activity?limit=30`, `POST /api/uploads` (imágenes y documentos, tope de 25 MB)
  y `GET /api/attachments/:id`, además de `model` y `attachments` en mensajes y listas.
  Genera una imagen de prueba propia (`att_demo`) y un histórico de actividad variado
  (completado, error y sin herramientas).
- Un mensaje que contenga **“enlace”** o **“documentación”** responde con un enlace markdown
  y una URL suelta, para probar las tarjetas del chat.
- El dictado en la PWA usa `webkitSpeechRecognition`; en el APK usa el plugin nativo (ver
  sección de Capacitor). El motor “En el PC” del mock devuelve un texto de prueba.
- Un mensaje que contenga **“tarea larga”** añade ~3,5 s al turno para poder probar las
  notificaciones de tareas largas (la notificación local se simula en `npm run shots`).
- Variables: `PORT`, `HOST`, `PIN`, `MOCK_RESET`.

Pruebas automáticas del contrato (REST + SSE):

```powershell
npm run smoke                # 34 comprobaciones contra http://127.0.0.1:8791
```

Capturas de la UI real con Chrome headless (diseño móvil 390×844, sin Puppeteer):

```powershell
npm run shots                # deja PNG en mock/shots/ y audita layout/errores
```

## Desarrollo contra el puente real

Arranca el puente (`server/`) en el PC y después:

```powershell
npm run dev                  # proxy por defecto → http://127.0.0.1:8790
```

## Build y PWA

```powershell
npm run build                # tsc --noEmit && vite build → dist/
npm run preview              # sirve dist (sin proxy de API)
npm run typecheck            # solo TypeScript
npm run icons                # regenera los PNG de public/icons
```

En producción el puente sirve `dist/` desde el **mismo origen** que la API, así
que no hay CORS ni configuración extra: copia/compila y abre la URL del puente.

La PWA incluye `manifest.webmanifest` (`display: standalone`, tema `#0a0a0c`,
iconos 192/512 + maskable), `theme-color`, safe-area y un service worker mínimo
que cachea el shell (nunca `/api`). El service worker solo se registra en el
build de producción.

> Para instalar la PWA el navegador exige contexto seguro: `localhost` o HTTPS.
> En el móvil, usa Tailscale/Cloudflare o el túnel HTTPS del puente; por HTTP en
> LAN la app funciona, pero el navegador puede no ofrecer “Añadir a pantalla de
> inicio”.

## Apuntar a otro host (Tailscale, dominio, túnel)

Por defecto `VITE_API_BASE` está vacío (mismo origen). Para compilar contra otro
host:

```powershell
$env:VITE_API_BASE='https://mi-pc.tailnet.ts.net'; npm run build
```

El cliente normaliza la base sin barra final y la usa también para el SSE
(`GET /api/events?token=…`). En desarrollo puedes usar `VITE_API_PROXY` para
cambiar el destino del proxy sin tocar la base.

## APK de Android (Capacitor)

La app detecta si corre dentro de un shell nativo (`window.Capacitor` o el
`http://localhost` del contenedor). En ese caso **no** asume mismo origen: el
puente vive en el PC y la dirección se pide en la pantalla de emparejamiento.

- Campo **“Dirección del PC”** encima del PIN (solo en el APK), **prefijado con la
  dirección pública** `DEFAULT_REMOTE_URL` (`src/brand.ts`), con enlace
  “Usar la IP local (más rápido en casa)”, botón **“Probar conexión”** (`GET /api/health`)
  y validación `http(s)://host[:port]`. Se guarda en `localStorage` (`nexo.server.v1`).
- Tras emparejar, **Ajustes** muestra la dirección actual, el **modo de conexión**
  (Internet/HTTPS, Red local o Tailscale, inferido de la URL) y el botón
  “Cambiar dirección del PC”, que desconecta y vuelve al emparejamiento.
- **Dictado nativo**: si el APK incluye `@capacitor-community/speech-recognition`,
  la app lo usa desde `window.Capacitor.Plugins.SpeechRecognition` (sin importarlo
  aquí). Pide permiso de micrófono, escucha en `es-ES` y muestra resultados parciales.
  La alternativa “En el PC” graba WAV mono 16 kHz con `getUserMedia` + `MediaRecorder`
  y llama a `POST /api/transcribe`.
- **Notificaciones**: si el APK incluye `@capacitor/local-notifications`, se usa
  `window.Capacitor.Plugins.LocalNotifications` (permiso con `requestPermissions()` y
  `schedule` al terminar); al tocar la notificación se abre el chat. En PWA se usa
  `Notification`/service worker. El interruptor está en Ajustes.
- Para empaquetar: compila con `npm run build` y configura Capacitor con
  `webDir: 'dist'` (el APK, el icono y los plugins los prepara el equipo del puente).

> Truco de desarrollo: cualquier app servida en `http://localhost` se considera
> shell nativo. Para probar el flujo APK contra el mock abre
> `http://localhost:8791` y usa `http://127.0.0.1:8791` como dirección del PC;
> para ver el modo PWA normal usa `http://127.0.0.1:5173` (Vite) o la IP del
> puente. `npm run shots` recorre ambos modos y deja capturas 11–14, además de
> panel del agente, drawer de proyectos, separadores, enlaces, adjuntos, dictado,
> modelo y notificaciones simuladas.

## Estructura

```
app/
├─ src/
│  ├─ api.ts            # cliente tipado REST + errores (docs/API.md)
│  ├─ sse.ts            # EventSource con reconexión y backoff
│  ├─ types.ts          # tipos del contrato
│  ├─ brand.ts          # nombre del producto y tagline (renombrar aquí)
│  ├─ App.tsx           # fases (boot/pair/ready), navegación y sesión
│  ├─ screens/          # Pair, Workspaces, Chats, Chat, Agent, Browse y Ajustes
│  ├─ components/       # Orb, TopBar, Sheet, ProjectsDrawer, iconos SVG
│  ├─ lib/              # fechas, sesión, dirección del PC (server.ts), modelos,
│  │                    # adjuntos (files.ts), enlaces (links.ts), dictado
│  │                    # (speech.ts/voice.ts) y notificaciones (notifications.ts)
│  └─ styles/global.css # sistema visual completo (CSS propio, sin frameworks)
├─ mock/                # servidor mock + smoke test + capturas CDP
├─ public/              # manifest, service worker, iconos, favicon
└─ scripts/             # generador de iconos PNG sin dependencias
```

### Decisiones

- **Sin router ni librerías de UI**: navegación propia con pila + `history`
  (botón atrás del móvil incluido), CSS propio y SVG a mano. Menos peso y cero
  dependencias de diseño.
- **Un solo EventSource global** en `App`, reemitido por un bus interno; el chat
  filtra por `chatId` y bufferea eventos del chat recién creado hasta que el POST
  devuelve su id (evita perder los primeros deltas).
- **El orbe** es CSS puro (capas de gradientes animadas) y respeta
  `prefers-reduced-motion`.
- **Persistencia**: token de dispositivo en `localStorage`
  (`nexo.device.v1`); cualquier `401` autenticado desconecta y vuelve a
  emparejar.
- **Solo respuestas**: de `thinking`/`tool` únicamente se deriva una línea de
  actividad (“pensando…”, “leyendo archivos…”), nunca el contenido de la tool.
- **`adoptable` opcional**: `!== false` se trata como adoptable, así que la app
  funciona igual con puentes antiguos. `messageCount` se pinta solo si llega
  numérico; si falta, no se escribe “N mensajes”.
- **Reintentar** reenvía exactamente el último texto del usuario que falló y
  desaparece al lanzar un mensaje nuevo.

## Renombrar

El nombre visible vive en `src/brand.ts`, `index.html` y
`public/manifest.webmanifest`. El `title` de cada pantalla se compone en
`App.tsx`.
