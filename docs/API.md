# API del puente DSH ⇄ Móvil

Contrato **congelado**. El servidor (`server/`) lo implementa y la app (`app/`) lo consume.
Cualquier cambio requiere tocar este archivo primero y avisar al equipo.

- Base: `http://<host>:8790`
- Formato: JSON UTF-8. Errores: `{ "error": { "code": "STRING", "message": "texto" } }`
- Autenticación: `Authorization: Bearer <deviceToken>` en todas las rutas `/api/*`
  salvo `/api/pair` y `/api/health`. Para SSE se admite `?token=<deviceToken>`.
- Códigos de error: `UNAUTHORIZED` (401), `BAD_REQUEST` (400), `NOT_FOUND` (404),
  `CONFLICT` (409, ya hay un turno en marcha), `INTERNAL` (500).

## Emparejamiento

### POST /api/pair
```json
{ "code": "123456", "deviceName": "Pixel 8" }
```
→ `200`
```json
{ "token": "<hex 64>", "deviceId": "dev_ab12", "deviceName": "Pixel 8" }
```
El `token` se guarda en el móvil y no se vuelve a pedir. La app lo envía en cada
petición y en la URL del SSE.

### GET /api/health
Sin auth. → `200`
```json
{ "ok": true, "version": "1.0.0", "dsh": { "ok": true, "profile": "headless" } }
```

### GET /api/me
→ `200` `{ "deviceId": "dev_ab12", "deviceName": "Pixel 8", "serverVersion": "1.0.0" }`

## Workspaces (proyectos)

### GET /api/workspaces
```json
{ "workspaces": [
  { "id": "ws_1", "name": "proyecto-a", "path": "C:\\Users\\demo\\Desktop\\App\\proyecto-a",
    "isGit": true, "lastActiveAt": 1794489520120, "chatsCount": 4 }
] }
```

### POST /api/workspaces
```json
{ "path": "C:\\Users\\demo\\Desktop\\App\\proyecto-b", "name": "proyecto-b" }
```
→ `201` `{ "workspace": { ...igual que arriba } }`

### DELETE /api/workspaces/:id → `{ "ok": true }`
No borra archivos, solo deja de listar el proyecto.

### GET /api/browse?path=C%3A%5CUsers%5Cdemo%5CDesktop
Navegador de carpetas del PC para elegir workspace desde el móvil.
→ `200`
```json
{ "path": "C:\\Users\\demo\\Desktop",
  "parent": "C:\\Users\\demo",
  "entries": [ { "name": "App", "path": "C:\\Users\\demo\\Desktop\\App", "isDir": true } ] }
```

## Chats (sesiones DSH)

Un **chat** es una sesión de DSH. Su `id` es el `sessionId` de DSH
(`session-<uuid>`), por lo que lo que hables en el móvil aparece también en DSH.

### Modelos: GET /api/models
```json
{ "models": [
    { "id": "deepseek-flash", "name": "DeepSeek Flash", "hint": "rápido, para el día a día", "isDefault": true },
    { "id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro", "hint": "máximo razonamiento", "isDefault": false }
  ],
  "maxUploadBytes": 8388608 }
```
El modelo se elige por conversación: `POST .../messages` acepta `model`. El puente
lo aplica con un overlay `--patch` del perfil `headless` (DSH no tiene `--model`).

### Imágenes: POST /api/uploads
```json
{ "workspaceId": "ws_1", "name": "foto.jpg", "mime": "image/jpeg", "data": "<base64 sin prefijo>" }
```
→ `201`
```json
{ "id": "att_ab12", "name": "foto.jpg", "mime": "image/jpeg", "size": 12345,
  "url": "/api/attachments/att_ab12",
  "path": "C:\\...\\proyecto\\.nexo\\adjuntos\\1794-att_ab12.jpg" }
```
Máximo 8 MB (`413` si se pasa). El archivo se guarda **dentro del workspace**
(`<proyecto>/.nexo/adjuntos/`) porque el sandbox del agente solo puede leer ahí;
el agente lo abre con su herramienta `read_image`.

### GET /api/attachments/:id?token=…
Devuelve la imagen (`image/*`). Acepta el token por query porque lo consume un
`<img>`, que no puede enviar cabeceras.

### GET /api/workspaces/:id/chats
```json
{ "chats": [ { "id": "session-564b...", "title": "Responder exactamente PONG",
  "updatedAt": 1794489535579, "messageCount": 4, "preview": "PONG",
  "adoptable": true, "model": "deepseek-flash" } ] }
```

`adoptable: false` = la sesión se creó en el escritorio de DSH bajo un *agent
preset*, y el runner del puente no puede continuarla (limitación de DSH: el
runner de un solo turno se niega a componer presets). La app debe mostrar el
histórico pero deshabilitar el composer y ofrecer "Nueva conversación".
Si el campo falta, se asume `true`.

### GET /api/chats/:chatId
```json
{ "id": "session-564b...", "title": "...", "workspaceId": "ws_1",
  "workspacePath": "C:\\...\\_probe_ws", "adoptable": true, "model": "deepseek-v4-pro",
  "messages": [
    { "id": "m1", "role": "user", "text": "Responde PONG", "at": 1794489520152 },
    { "id": "m2", "role": "assistant", "text": "PONG", "at": 1794489522937 },
    { "id": "m3", "role": "user", "text": "Mira esto\n\n[Adjunto: C:\\...\\foto.jpg]",
      "at": 1794489600000,
      "attachments": [ { "id": "att_ab12", "name": "foto.jpg", "mime": "image/jpeg",
        "url": "/api/attachments/att_ab12" } ] }
  ] }
```

### POST /api/workspaces/:id/messages  — chat nuevo
```json
{ "text": "Revisa el README y propón mejoras",
  "model": "deepseek-v4-pro",
  "attachments": [ { "id": "att_ab12", "name": "foto.jpg" } ] }
```
`text` puede ir vacío si hay al menos un adjunto. → `200` (responde en cuanto DSH
crea la sesión, el resto llega por SSE)
```json
{ "chatId": "session-9f3...", "turnId": "turn_1", "model": "deepseek-v4-pro" }
```

### POST /api/chats/:chatId/messages — continuar chat
Mismo cuerpo. `409 CONFLICT` si ya hay un turno en marcha. `model` cambia el
modelo para ese turno (y siguientes) si se envía.

### POST /api/chats/:chatId/stop → `{ "ok": true }`
Aborta el turno en curso.

## SSE: GET /api/events?token=…

`Content-Type: text/event-stream`. Cada mensaje es un evento `data:` con un JSON.
El cliente filtra por `chatId`. Eventos:

| type | payload | significado |
|---|---|---|
| `hello` | `{ serverVersion }` | conexión establecida |
| `turn_start` | `{ chatId, turnId }` | empieza un turno |
| `thinking` | `{ chatId }` | el agente razona; mostrar "pensando…" |
| `tool` | `{ chatId, tool, status: "start"\|"done", label }` | actividad (no mostrar tool calls crudas) |
| `delta` | `{ chatId, text }` | trozo de respuesta del asistente |
| `title` | `{ chatId, title }` | título generado por DSH |
| `turn_end` | `{ chatId, status: "completed"\|"error"\|"aborted", text? }` | fin del turno |
| `error` | `{ chatId?, message }` | error no fatal |
| `heartbeat` | `{}` | cada 20 s, mantiene viva la conexión |

Orden garantizado por chat. Los `delta` se concatenan en orden.

## Push propio (servicio en primer plano)

Sin FCM: el servicio Android mantiene un *long-poll* con el puente y recibe los
avisos de tareas terminadas aunque la app esté cerrada.

### GET /api/push?token=…&wait=1
`wait=1` (por defecto): mantiene la petición hasta 25 s esperando avisos; si no
llega ninguno responde `{ "notifications": [] }`. `wait=0`: responde al instante.

```json
{ "notifications": [
    { "id": "push_12", "chatId": "session-…",
      "title": "Nexo · Agente Movil",
      "body": "Revisión terminada: 3 mejoras propuestas…",
      "kind": "turn_end", "at": 1794500000000 }
  ],
  "serverVersion": "1.0.0" }
```

Los avisos se encolan cuando un turno dura **más de 8 s** y no se ha abortado.
Cola en memoria por dispositivo (máx. 20, caducidad 30 min); el servicio Android
los convierte en notificación nativa solo si la app no está en primer plano.
Errores: `401` si el token no es válido (el servicio se detiene y la app tendrá
que volver a emparejar).

### GET /api/activity?limit=30
Registro de turnos para la pantalla del agente (estilo consola).

```json
{ "activity": [
  { "id": "act_mwdsnqjh_1", "chatId": "session-…",
    "title": "Revisión del README", "workspaceName": "Agente Movil",
    "workspaceId": "ws_1", "status": "completed", "durationMs": 18300,
    "tools": ["read", "pwsh", "write"], "model": "deepseek-flash",
    "at": 1794502841885 } ] }
```

- `status`: `completed` | `error` | `aborted`.
- `durationMs`: tiempo del turno desde que arrancó el proceso `dsh`.
- `tools`: herramientas únicas usadas (máx. 12); vacío si solo respondió con texto.
- Guardado en `server/data/activity.json` (200 entradas), sobrevive reinicios.
- `title` y `workspaceName` se resuelven al leer (pueden ser `null` si el chat
  ya no existe).

### POST /api/provision  (solo desde el propio PC)
Crea un dispositivo sin PIN para **hornear el token en el APK** y que la app
entre sola. Solo acepta peticiones desde loopback (sin `X-Forwarded-For`).

```json
{ "deviceName": "Xiaomi principal" }
```
→ `201 { "token": "<hex 64>", "deviceId": "dev_…", "deviceName": "Xiaomi principal" }`

Se usa desde `scripts/provisionar.mjs`, que escribe `app/.env.production` con el
token y la URL pública. Después se compila la APK: el móvil arranca ya dentro,
sin pantalla de emparejamiento. Para revocar: borra el dispositivo desde la app
(Ajustes → dispositivos) y vuelve a aprovisionar.

### POST /api/chats/:chatId/fork
Continúa una conversación **creada en el escritorio** (que el runner de un solo
turno no puede adoptar). El puente abre una sesión nueva sembrada con las últimas
~20 intervenciones del chat original y arranca el turno con el mensaje nuevo.

```json
{ "text": "Sigue con lo de antes", "model": "deepseek-flash" }
```
→ `200 { "chatId": "session-nueva", "turnId": "turn_…", "model": "…", "forkedFrom": "session-original" }`

El chat nuevo queda vinculado con `forkedFrom` en sus metadatos y aparece en la
lista del proyecto como cualquier otro.

## Estático

`GET /` → app compilada (PWA). `GET /assets/*` → recursos. `GET /manifest.webmanifest`.

## Acceso remoto

El puente se publica también por **Tailscale Funnel** (`config.remoteAccess`), así
que la app funciona desde cualquier red sin instalar nada en el móvil.

### GET /api/health (público, sin auth)
```json
{ "ok": true, "version": "1.0.0",
  "dsh": { "ok": true, "profile": "headless", "trustMode": "workspace-write" },
  "remote": { "enabled": true, "publicUrl": "https://equipo.tailnet.ts.net:8443" } }
```
`GET /api/me` incluye el mismo bloque `remote`.

## Documentos

`POST /api/uploads` acepta imágenes **y documentos**: `pdf`, `txt`, `md`, `csv`,
`json`, `log`, `xml`, `yaml`, `doc(x)`, `xls(x)`, `ppt(x)`. Límites: 8 MB para
imágenes y 25 MB para documentos. Ejecutables y scripts (`exe`, `bat`, `ps1`,
`js`, `vbs`, `dll`…) se rechazan con `400 BAD_REQUEST`.

La respuesta incluye `kind: "image" | "file"` para que la app pinte miniatura o
chip. El agente lee PDF/DOCX/XLSX por sí mismo con sus herramientas.

## Dictado en el PC (opcional, sin internet)

### GET /api/voice-status
```json
{ "available": true, "engine": "transformers.js", "model": "whisper-base" }
```
o `{ "available": false, "reason": "Dictado en el PC no instalado (…)" }`.

### POST /api/transcribe
```json
{ "audio": "<base64 de WAV PCM mono>", "language": "es" }
```
→ `200 { "text": "Hola, soy Nexo", "language": "es", "seconds": 3.4, "engine": "…", "ms": 950 }`

Errores: `503 VOICE_UNAVAILABLE` si el motor no está instalado; `400` si falta el
audio o no es WAV. Máximo 60 s de audio.

## Configuración del servidor

`server/data/config.json` (no versionar):
```json
{ "port": 8790, "pin": "123456", "trustMode": "workspace-write",
  "remoteAccess": true, "remotePort": 8443,
  "publicUrl": "https://equipo.tailnet.ts.net:8443",
  "defaultModel": "deepseek-flash",
  "models": [ { "id": "deepseek-flash", "name": "DeepSeek Flash", "hint": "…" } ],
  "devices": [ { "id": "dev_ab12", "name": "Pixel 8", "hash": "...", "createdAt": 0, "lastSeenAt": 0 } ],
  "workspaces": [ { "id": "ws_1", "name": "proyecto-b", "path": "C:\\...\\proyecto-b" } ] }
```
`trustMode`: `read-only` | `workspace-write` (por defecto) | `danger-full-access`.
`remoteAccess: false` desactiva el acceso público (sigue en LAN y Tailscale).

## Seguridad del acceso público

- Todo `/api/*` exige token de dispositivo salvo `/api/health` y `/api/pair`.
- `/api/pair` tiene límite por IP y **bloqueo global**: 25 fallos en 15 minutos
  cierran el emparejamiento 15 minutos y avisan en el log recomendando rotar el PIN.
- La IP real se toma de `X-Forwarded-For` (detrás del túnel todo llega desde loopback).
- Los archivos subidos viven dentro del proyecto (`<proyecto>/.nexo/adjuntos/`).


