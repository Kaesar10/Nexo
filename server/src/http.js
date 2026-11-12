import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { readJson } from './util.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const APP_DIST = resolve(import.meta.dirname, '..', '..', 'app', 'dist');

const STATUS_BY_CODE = {
  UNAUTHORIZED: 401,
  RATE_LIMITED: 429,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  METHOD_NOT_ALLOWED: 405,
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function mimeFor(file) {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Sirve la PWA compilada; en desarrollo (sin build) muestra una página guía. */
function serveStatic(req, res, pathname) {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  const safeRelative = normalize(relative).replace(/^(\.\.[\\/])+/, '');
  let file = resolve(APP_DIST, safeRelative);
  if (!file.startsWith(APP_DIST)) file = join(APP_DIST, 'index.html');

  if (existsSync(file) && statSync(file).isFile()) {
    const immutable = pathname.startsWith('/assets/');
    res.writeHead(200, {
      'Content-Type': mimeFor(file),
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
    return;
  }

  const index = join(APP_DIST, 'index.html');
  if (existsSync(index)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    createReadStream(index).pipe(res);
    return;
  }

  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Puente DSH · sin interfaz compilada</title>
<body style="font:16px/1.6 system-ui;background:#0a0a0c;color:#eee;padding:24px;max-width:40rem;margin:auto">
<h1>El puente funciona</h1>
<p>Pero la interfaz móvil todavía no está compilada. En el PC:</p>
<pre style="background:#16161a;padding:12px;border-radius:8px">cd app
npm install
npm run build</pre>
<p>Luego recarga esta página. API: <a style="color:#E8B36B" href="/api/health">/api/health</a></p>
</body>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/**
 * Enrutador HTTP del puente. Todo pasa por aquí: API, SSE y la PWA estática.
 */
export function createHttp({
  config,
  auth,
  workspaces,
  runner,
  sse,
  models,
  chatMeta,
  uploads,
  push,
  activity,
  desktopSync,
  version = '1.0.0',
  log = console.log,
}) {
  async function sessionsStore() {
    try {
      return await import('./dsh-sessions.js');
    } catch {
      return null;
    }
  }

  /** Motor de dictado local; puede no estar instalado (lo monta scripts/instalar-voz.ps1). */
  async function voiceModule() {
    try {
      return await import('./transcribe.js');
    } catch {
      return null;
    }
  }

  /**
   * IP real del cliente. Detrás de Tailscale Funnel todas las peticiones llegan
   * desde 127.0.0.1, así que el límite por IP necesita X-Forwarded-For.
   */
  function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  async function chatsOf(workspacePath) {
    const store = await sessionsStore();
    if (!store) return [];
    try {
      // `fast`: título + preview desde la cola del log, sin recorrerlo entero.
      // Un workspace con 40 MB de historial tarda 1,7 s en modo completo y 168 ms así.
      const sessions = store.listSessions(workspacePath, { fast: true }) ?? [];
      return sessions.map((session) => ({
        ...session,
        model: chatMeta.get(session.id)?.model ?? null,
      }));
    } catch (error) {
      log(`[chats] ${error.message}`);
      return [];
    }
  }

  async function chatDetail(chatId) {
    const store = await sessionsStore();
    if (!store) return null;
    try {
      const found = store.findSession(chatId);
      if (!found) return null;
      const workspace = config.workspaces.find(
        (item) => item.path.toLowerCase() === String(found.workspacePath).toLowerCase(),
      );
      const messages = (found.session.messages ?? []).map((message) => {
        if (message.role !== 'user') return message;
        const attachments = uploads.fromText(message.text);
        return attachments.length > 0 ? { ...message, attachments } : message;
      });
      return {
        ...found.session,
        messages,
        workspaceId: workspace?.id ?? null,
        workspaceName: workspace?.name ?? null,
        model: chatMeta.get(chatId)?.model ?? null,
      };
    } catch (error) {
      log(`[chat] ${error.message}`);
      return null;
    }
  }

  async function refreshTitle(chatId) {
    for (const delay of [1200, 4000]) {
      await new Promise((done) => setTimeout(done, delay));
      const detail = await chatDetail(chatId);
      if (detail?.title) {
        chatMeta.set(chatId, { title: detail.title });
        sse.broadcast({ type: 'title', chatId, title: detail.title });
        return;
      }
    }
  }

  /** Actividad reciente enriquecida con título del chat y nombre del proyecto. */
  function activityList(limit) {
    const items = activity?.list(limit) ?? [];
    return items.map((item) => {
      const meta = item.chatId ? chatMeta.get(item.chatId) : null;
      const workspace = config.workspaces.find(
        (entry) => item.workspacePath && entry.path.toLowerCase() === String(item.workspacePath).toLowerCase(),
      );
      return {
        id: item.id,
        chatId: item.chatId,
        title: meta?.title ?? null,
        workspaceName: workspace?.name ?? null,
        workspaceId: workspace?.id ?? null,
        status: item.status,
        durationMs: item.durationMs,
        tools: item.tools,
        model: item.model ?? meta?.model ?? null,
        at: item.at,
      };
    });
  }

  function requireSessionText(body, allowEmpty = false) {
    const text = String(body?.text ?? '').trim();
    if (!text && !allowEmpty) {
      throw Object.assign(new Error('Mensaje vacío'), { code: 'BAD_REQUEST', status: 400 });
    }
    if (text.length > 100_000) {
      throw Object.assign(new Error('Mensaje demasiado largo'), { code: 'BAD_REQUEST', status: 400 });
    }
    return text;
  }

  /** Adjuntos referenciados por id en el cuerpo de la petición. */
  function attachmentsOf(body) {
    const list = Array.isArray(body?.attachments) ? body.attachments : [];
    return list.map((item) => {
      const id = typeof item === 'string' ? item : item?.id;
      const entry = id ? uploads.toPublic(id) : null;
      if (!entry) {
        throw Object.assign(new Error('Adjunto no encontrado'), { code: 'NOT_FOUND', status: 404 });
      }
      return entry;
    });
  }

  /**
   * Texto que recibe DSH: el mensaje del usuario y, por cada imagen, una línea
   * `[Adjunto: <ruta absoluta>]`. El agente abre esa ruta con `read_image`
   * (verificado: el sandbox le deja leer lo que está dentro del workspace).
   */
  function buildPrompt(text, attachments) {
    const base = text || (attachments.length > 0 ? 'Analiza lo que te adjunto.' : '');
    if (attachments.length === 0) return base;
    return `${base}\n\n${attachments.map((entry) => `[Adjunto: ${entry.path}]`).join('\n')}`;
  }

  function serveAttachment(res, id) {
    const entry = uploads.get(id);
    if (!entry || !existsSync(entry.path)) {
      return sendError(res, 404, 'NOT_FOUND', 'Adjunto no encontrado');
    }
    res.writeHead(200, {
      'Content-Type': entry.mime,
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    createReadStream(entry.path).pipe(res);
    return undefined;
  }

  return async function handler(req, res) {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    // CORS: la app se sirve del mismo origen, esto solo ayuda en dev (Vite :5173)
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // ---------- rutas públicas ----------
      if (pathname === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          version,
          dsh: {
            ok: Boolean(config.dsh?.cli),
            profile: config.dsh?.profile ?? 'headless',
            trustMode: config.trustMode,
          },
          remote: {
            enabled: config.remoteAccess !== false,
            publicUrl: config.publicUrl ?? null,
          },
        });
      }
      if (pathname === '/api/pair' && req.method === 'POST') {
        const body = await readJson(req);
        const result = auth.pair({
          code: body.code,
          deviceName: body.deviceName,
          ip: clientIp(req),
        });
        log(`[auth] dispositivo emparejado: ${result.deviceName} (${result.deviceId}) desde ${clientIp(req)}`);
        return sendJson(res, 200, result);
      }

      // Aprovisionamiento local: crea un dispositivo sin PIN para hornear el
      // token en el APK. Solo acepta peticiones desde loopback (el script corre
      // en el propio PC).
      if (pathname === '/api/provision' && req.method === 'POST') {
        const forwarded = req.headers['x-forwarded-for'];
        const remote = req.socket.remoteAddress ?? '';
        const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
        if (forwarded || !loopback) {
          return sendError(res, 403, 'FORBIDDEN', 'El aprovisionamiento solo se permite desde el propio PC');
        }
        const body = await readJson(req);
        const result = auth.provision(body.deviceName ?? 'Móvil');
        log(`[auth] dispositivo aprovisionado: ${result.deviceName} (${result.deviceId})`);
        return sendJson(res, 201, result);
      }

      // ---------- autenticación ----------
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const token = bearer || url.searchParams.get('token') || '';
      const device = auth.verify(token);

      if (pathname === '/api/events') {
        if (!device) return sendError(res, 401, 'UNAUTHORIZED', 'Token no válido');
        sse.add(req, res, device.id);
        return undefined;
      }

      // Long-poll del servicio en primer plano: entrega avisos de tareas
      // terminadas aunque la app esté cerrada (push propio, sin FCM).
      if (pathname === '/api/push') {
        if (!device) return sendError(res, 401, 'UNAUTHORIZED', 'Token no válido');
        const wait = url.searchParams.get('wait') !== '0';
        const notifications = await push.take(device.id, { waitMs: wait ? push.LONG_POLL_MS : 0 });
        return sendJson(res, 200, { notifications, serverVersion: version });
      }

      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Método no permitido');
        }
        return serveStatic(req, res, pathname);
      }

      if (!device) return sendError(res, 401, 'UNAUTHORIZED', 'Token no válido');

      // ---------- sesión / dispositivos ----------
      if (pathname === '/api/me') {
        return sendJson(res, 200, {
          deviceId: device.id,
          deviceName: device.name,
          serverVersion: version,
          trustMode: config.trustMode,
          remote: {
            enabled: config.remoteAccess !== false,
            publicUrl: config.publicUrl ?? null,
          },
        });
      }
      if (pathname === '/api/devices' && req.method === 'GET') {
        return sendJson(res, 200, {
          devices: config.devices.map((item) => ({
            id: item.id,
            name: item.name,
            createdAt: item.createdAt,
            lastSeenAt: item.lastSeenAt,
            current: item.id === device.id,
          })),
        });
      }
      const deviceMatch = /^\/api\/devices\/([^/]+)$/.exec(pathname);
      if (deviceMatch && req.method === 'DELETE') {
        const removed = auth.revoke(decodeURIComponent(deviceMatch[1]));
        return sendJson(res, 200, { ok: removed });
      }

      // ---------- workspaces ----------
      if (pathname === '/api/workspaces' && req.method === 'GET') {
        return sendJson(res, 200, { workspaces: await workspaces.list() });
      }
      if (pathname === '/api/workspaces' && req.method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 201, { workspace: workspaces.add(body) });
      }
      const workspaceMatch = /^\/api\/workspaces\/([^/]+)$/.exec(pathname);
      if (workspaceMatch && req.method === 'DELETE') {
        const removed = workspaces.remove(decodeURIComponent(workspaceMatch[1]));
        return sendJson(res, 200, { ok: removed });
      }
      if (pathname === '/api/browse') {
        return sendJson(res, 200, workspaces.browse(url.searchParams.get('path')));
      }

      // ---------- modelos y adjuntos ----------
      if (pathname === '/api/models') {
        return sendJson(res, 200, {
          models: models.list(),
          maxUploadBytes: uploads.maxBytes,
          maxImageBytes: uploads.maxImageBytes,
        });
      }
      if (pathname === '/api/activity') {
        const limit = Number(url.searchParams.get('limit') ?? 30);
        return sendJson(res, 200, { activity: activityList(limit) });
      }
      if (pathname === '/api/voice-status') {
        const voice = await voiceModule();
        if (!voice) {
          return sendJson(res, 200, {
            available: false,
            engine: null,
            model: null,
            reason: 'Dictado en el PC no instalado (ejecuta scripts\\instalar-voz.ps1)',
          });
        }
        return sendJson(res, 200, await voice.voiceStatus());
      }
      if (pathname === '/api/transcribe' && req.method === 'POST') {
        const body = await readJson(req, 16 * 1024 * 1024);
        const voice = await voiceModule();
        if (!voice) {
          return sendError(
            res,
            503,
            'VOICE_UNAVAILABLE',
            'El dictado en el PC no está instalado. Ejecuta scripts\\instalar-voz.ps1 en el PC.',
          );
        }
        const raw = String(body.audio ?? body.data ?? '');
        const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
        if (!base64) {
          return sendError(res, 400, 'BAD_REQUEST', 'Falta el audio');
        }
        const started = Date.now();
        try {
          const result = await voice.transcribeWav(Buffer.from(base64, 'base64'), {
            language: String(body.language ?? 'es'),
          });
          log(`[voz] ${result.text.length} caracteres en ${Date.now() - started} ms (${result.engine})`);
          return sendJson(res, 200, { ...result, ms: Date.now() - started });
        } catch (error) {
          const code = error.code ?? 'INTERNAL';
          const status = code === 'VOICE_UNAVAILABLE' ? 503 : 500;
          return sendError(res, status, code, error.message);
        }
      }
      if (pathname === '/api/uploads' && req.method === 'POST') {
        // 25 MB de archivo → ~34 MB en base64; dejamos margen.
        const body = await readJson(req, 40 * 1024 * 1024);
        const workspaceId = String(body.workspaceId ?? '');
        if (!workspaceId) {
          return sendError(res, 400, 'BAD_REQUEST', 'Falta workspaceId: la imagen debe subirse dentro de un proyecto');
        }
        const workspace = workspaces.get(workspaceId);
        if (!workspace) return sendError(res, 404, 'NOT_FOUND', 'Proyecto no encontrado');
        const entry = uploads.save({
          workspacePath: workspace.path,
          name: body.name,
          mime: body.mime,
          data: body.data ?? body.base64,
        });
        log(`[upload] ${entry.name} (${entry.size} B) en ${workspace.name}`);
        return sendJson(res, 201, entry);
      }
      const attachmentMatch = /^\/api\/attachments\/([^/]+)$/.exec(pathname);
      if (attachmentMatch && req.method === 'GET') {
        return serveAttachment(res, decodeURIComponent(attachmentMatch[1]));
      }

      // ---------- chats ----------
      const workspaceChats = /^\/api\/workspaces\/([^/]+)\/chats$/.exec(pathname);
      if (workspaceChats && req.method === 'GET') {
        const workspace = workspaces.get(decodeURIComponent(workspaceChats[1]));
        if (!workspace) return sendError(res, 404, 'NOT_FOUND', 'Proyecto no encontrado');
        return sendJson(res, 200, { chats: await chatsOf(workspace.path) });
      }

      const newMessage = /^\/api\/workspaces\/([^/]+)\/messages$/.exec(pathname);
      if (newMessage && req.method === 'POST') {
        const workspace = workspaces.get(decodeURIComponent(newMessage[1]));
        if (!workspace) return sendError(res, 404, 'NOT_FOUND', 'Proyecto no encontrado');
        const body = await readJson(req);
        const attachments = attachmentsOf(body);
        const text = requireSessionText(body, attachments.length > 0);
        const model = models.resolve(body.model);
        const prompt = buildPrompt(text, attachments);
        let createdChatId = null;
        const result = await runner.runTurn({
          workspacePath: workspace.path,
          text: prompt,
          patchFile: models.patchFile(model),
          model,
          onSession: (sessionId) => {
            createdChatId = sessionId;
            chatMeta.set(sessionId, { model, workspacePath: workspace.path });
            desktopSync?.registerSession({
              sessionId,
              workspacePath: workspace.path,
              title: workspace.name,
            });
          },
        });
        if (result.chatId) {
          chatMeta.set(result.chatId, { model, workspacePath: workspace.path });
        }
        void refreshTitle(result.chatId ?? createdChatId);
        return sendJson(res, 200, { ...result, model });
      }

      const chatMatch = /^\/api\/chats\/([^/]+)$/.exec(pathname);
      if (chatMatch && req.method === 'GET') {
        const detail = await chatDetail(decodeURIComponent(chatMatch[1]));
        if (!detail) return sendError(res, 404, 'NOT_FOUND', 'Conversación no encontrada');
        return sendJson(res, 200, detail);
      }

      const chatMessages = /^\/api\/chats\/([^/]+)\/messages$/.exec(pathname);
      if (chatMessages && req.method === 'POST') {
        const chatId = decodeURIComponent(chatMessages[1]);
        const detail = await chatDetail(chatId);
        if (!detail) return sendError(res, 404, 'NOT_FOUND', 'Conversación no encontrada');
        const body = await readJson(req);
        const attachments = attachmentsOf(body);
        const text = requireSessionText(body, attachments.length > 0);
        const model = models.resolve(body.model ?? chatMeta.get(chatId)?.model);
        const prompt = buildPrompt(text, attachments);
        const result = await runner.runTurn({
          chatId,
          workspacePath: detail.workspacePath,
          text: prompt,
          patchFile: models.patchFile(model),
          model,
        });
        chatMeta.set(chatId, { model, workspacePath: detail.workspacePath });
        return sendJson(res, 200, { ...result, model });
      }

      const chatStop = /^\/api\/chats\/([^/]+)\/stop$/.exec(pathname);
      if (chatStop && req.method === 'POST') {
        const stopped = runner.stop(decodeURIComponent(chatStop[1]));
        return sendJson(res, 200, { ok: stopped });
      }

      // Continuar una conversación que el runner no puede adoptar (creada en el
      // escritorio con agent preset): se abre una sesión nueva sembrada con el
      // contexto reciente del chat original.
      const chatFork = /^\/api\/chats\/([^/]+)\/fork$/.exec(pathname);
      if (chatFork && req.method === 'POST') {
        const sourceId = decodeURIComponent(chatFork[1]);
        const source = await chatDetail(sourceId);
        if (!source) return sendError(res, 404, 'NOT_FOUND', 'Conversación no encontrada');
        const body = await readJson(req);
        const text = requireSessionText(body);
        const model = models.resolve(body.model ?? chatMeta.get(sourceId)?.model);
        const store = await sessionsStore();
        let context = '';
        if (store) {
          try {
            const original = store.readSession(source.workspacePath, sourceId, { maxMessages: 20 });
            const lines = (original?.messages ?? [])
              .slice(-20)
              .map((message) => `${message.role === 'user' ? 'Yo' : 'Agente'}: ${message.text}`)
              .join('\n');
            context = lines.slice(-12_000);
          } catch {
            context = '';
          }
        }
        const prompt = context
          ? `Contexto de una conversación anterior en este proyecto (continúala desde ahí, sin repetir lo ya hecho):\n\n${context}\n\nMi nuevo mensaje: ${text}`
          : text;
        const result = await runner.runTurn({
          workspacePath: source.workspacePath,
          text: prompt,
          patchFile: models.patchFile(model),
          model,
          onSession: (sessionId) => {
            chatMeta.set(sessionId, {
              model,
              workspacePath: source.workspacePath,
              forkedFrom: sourceId,
            });
            desktopSync?.registerSession({
              sessionId,
              workspacePath: source.workspacePath,
              title: source.workspaceName ?? undefined,
            });
          },
        });
        chatMeta.set(result.chatId, {
          model,
          workspacePath: source.workspacePath,
          forkedFrom: sourceId,
        });
        void refreshTitle(result.chatId);
        log(`[fork] ${sourceId} → ${result.chatId}`);
        return sendJson(res, 200, { ...result, model, forkedFrom: sourceId });
      }

      return sendError(res, 404, 'NOT_FOUND', `Ruta no encontrada: ${pathname}`);
    } catch (error) {
      const status = error.status ?? STATUS_BY_CODE[error.code] ?? 500;
      if (status >= 500) log(`[http] ${req.method} ${pathname} → ${error.message}`);
      if (!res.headersSent) {
        return sendError(res, status, error.code ?? 'INTERNAL', error.message);
      }
      return undefined;
    } finally {
      if (process.env.DSH_MOVIL_DEBUG) {
        log(`[http] ${req.method} ${pathname} ${Date.now() - started}ms`);
      }
    }
  };
}
