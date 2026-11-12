#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveDshCli, rotatePin, saveConfig, SERVER_ROOT, PROJECT_ROOT, configFile } from './config.js';
import { createAuth } from './auth.js';
import { createSseHub } from './sse.js';
import { createWorkspaces } from './workspaces.js';
import { createDshRunner, resolveApiKey } from './dsh.js';
import { createModels } from './models.js';
import { createChatMeta } from './chats.js';
import { createUploads } from './uploads.js';
import { createPushHub } from './push.js';
import { createActivity } from './activity.js';
import { createDesktopSync } from './desktop-sync.js';
import { createHttp } from './http.js';

const VERSION = '1.0.0';
const command = process.argv[2] ?? 'serve';

function privateIPv4() {
  const result = [];
  const virtualNames = /(?:cloudflare|warp|vethernet|virtual|vmware|virtualbox|hyper-v|wsl|docker|tailscale|zerotier|radmin|hamachi|tun|tap)/i;
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      result.push({ name, address: address.address, virtual: virtualNames.test(name) });
    }
  }
  const isTailscale = (ip) => /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
  const isLan = (ip) => /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(ip);
  return {
    lan: result.filter((entry) => isLan(entry.address) && !entry.virtual),
    virtual: result.filter((entry) => isLan(entry.address) && entry.virtual),
    tailscale: result.filter((entry) => isTailscale(entry.address)),
    other: result.filter((entry) => !isLan(entry.address) && !isTailscale(entry.address)),
  };
}

function tailscaleCli() {
  return process.platform === 'win32'
    ? 'C:\\Program Files\\Tailscale\\tailscale.exe'
    : 'tailscale';
}

/**
 * Publica el puente en Internet con Tailscale Funnel: URL HTTPS estable, sin
 * abrir puertos ni configurar nada en el router, y sin necesidad de instalar
 * Tailscale en el móvil. Es lo que permite "usarlo todo fuera de casa solo con
 * la app".
 */
function enableRemoteAccess(config) {
  if (config.remoteAccess === false) return null;
  const cli = tailscaleCli();
  if (!existsSync(cli)) return null;
  const port = config.remotePort ?? 8443;
  try {
    execFileSync(cli, ['funnel', '--bg', `--https=${port}`, String(config.port)], {
      timeout: 15_000,
      stdio: 'ignore',
    });
  } catch (error) {
    console.error(`[remoto] no se pudo activar el acceso público: ${error.message}`);
    return null;
  }
  try {
    const status = execFileSync(cli, ['funnel', 'status'], { timeout: 8_000, encoding: 'utf8' });
    if (!status.includes(`:${port}`)) {
      console.error(`[remoto] el túnel no confirma el puerto ${port}`);
      return null;
    }
    const info = JSON.parse(
      execFileSync(cli, ['status', '--json'], { timeout: 8_000, encoding: 'utf8' }),
    );
    const dnsName = info?.Self?.DNSName?.replace(/\.$/, '');
    if (!dnsName) return null;
    const url = `https://${dnsName}:${port}`;
    config.publicUrl = url;
    saveConfig(config);
    return url;
  } catch (error) {
    console.error(`[remoto] ${error.message}`);
    return null;
  }
}

function banner(config) {
  const { lan, tailscale } = privateIPv4();
  const publicUrl = config.publicUrl;
  const lines = [];
  lines.push('');
  lines.push('  ┌─────────────────────────────────────────────┐');
  lines.push('  │   Nexo · puente DSH ⇄ móvil                 │');
  lines.push('  └─────────────────────────────────────────────┘');
  lines.push('');
  lines.push(`  PIN de emparejamiento:  ${config.pin}`);
  lines.push('');
  if (publicUrl) {
    lines.push(`  ★ Desde cualquier red: ${publicUrl}`);
    lines.push('    (Tailscale Funnel · HTTPS válido · sin instalar nada en el móvil)');
    lines.push('');
  }
  lines.push(`  En este PC:   http://127.0.0.1:${config.port}`);
  for (const entry of lan) {
    lines.push(`  En tu WiFi:   http://${entry.address}:${config.port}   (${entry.name})`);
  }
  for (const entry of tailscale) {
    lines.push(`  Tailscale:    http://${entry.address}:${config.port}`);
  }
  if (!publicUrl) {
    lines.push('  Remoto:       no activo · revisa Tailscale o pon remoteAccess:true en la config');
  }
  lines.push('');
  lines.push(`  Modo de confianza: ${config.trustMode}`);
  if (publicUrl) {
    lines.push('  Aviso: el puente es accesible desde Internet (protegido por PIN + tokens).');
  }
  lines.push(`  Configuración:     ${configFile()}`);
  lines.push('');
  lines.push('  En la app: escribe el PIN (las direcciones ya vienen puestas).');
  lines.push('  Si el móvil no carga en WiFi, permite el puerto en el Firewall de Windows.');
  lines.push('');
  console.log(lines.join('\n'));
}

function printPin(config) {
  console.log(config.pin);
}

async function doctor(config) {
  const checks = [];
  checks.push(['Lanzador dsh', config.dsh.cli, existsSync(config.dsh.cli) || config.dsh.cli === 'dsh']);
  const key = resolveApiKey();
  checks.push(['Credencial DEEPSEEK_API_KEY', key ? `…${key.slice(-6)}` : 'NO ENCONTRADA', Boolean(key)]);
  try {
    const store = await import('./dsh-sessions.js');
    const stored = store.listStoredWorkspaces();
    checks.push(['Almacén de sesiones DSH', `${stored.length} workspaces`, stored.length > 0]);
  } catch (error) {
    checks.push(['Almacén de sesiones DSH', error.message, false]);
  }
  const dist = join(PROJECT_ROOT, 'app', 'dist', 'index.html');
  checks.push(['Interfaz compilada', dist, existsSync(dist)]);

  // Acceso remoto: Funnel activo y URL pública (sin tocar nada, solo informar)
  {
    const cli = tailscaleCli();
    let detail = 'no configurado (remoteAccess:false)';
    let ok = false;
    if (config.remoteAccess !== false && existsSync(cli)) {
      try {
        const status = execFileSync(cli, ['funnel', 'status'], { timeout: 8000, encoding: 'utf8' });
        const port = config.remotePort ?? 8443;
        const match = new RegExp(`https://([^\\s]+):${port}`).exec(status);
        if (match) {
          detail = `https://${match[1]}:${port}`;
          ok = true;
        } else {
          detail = `Tailscale Funnel no activo en el puerto ${port}`;
        }
      } catch {
        detail = 'no se pudo consultar Tailscale';
      }
    }
    checks.push(['Acceso desde cualquier red', detail, ok]);
  }

  // Dictado local
  try {
    const voice = await import('./transcribe.js');
    const status = await voice.voiceStatus();
    checks.push(['Dictado en el PC', status.available ? `${status.engine} · ${status.model}` : status.reason ?? 'no instalado', status.available]);
  } catch {
    checks.push(['Dictado en el PC', 'no instalado (scripts/instalar-voz.ps1)', false]);
  }

  for (const [name, value, ok] of checks) {
    console.log(`${ok ? '  ok  ' : ' FALTA'}  ${name}: ${value}`);
  }
}

async function main() {
  const config = loadConfig();
  config.dsh.cli = resolveDshCli(config);
  saveConfig(config);

  if (command === 'pin') return printPin(config);
  if (command === 'rotate-pin') {
    console.log(rotatePin(config));
    return undefined;
  }
  if (command === 'doctor') return doctor(config);
  if (command === 'config') {
    console.log(configFile());
    return undefined;
  }
  if (command !== 'serve') {
    console.error(`Comando desconocido: ${command}. Usa: serve | pin | rotate-pin | doctor | config`);
    process.exitCode = 1;
    return undefined;
  }

  const sse = createSseHub();
  const dataDir = join(SERVER_ROOT, 'data');
  const auth = createAuth({ config, save: () => saveConfig(config) });
  const workspaces = createWorkspaces({ config, save: () => saveConfig(config) });
  const models = createModels({ config, dataDir });
  const chatMeta = createChatMeta({ file: join(dataDir, 'chats.json') });
  const uploads = createUploads({ dataDir });
  const push = createPushHub({ log: console.log });
  const activity = createActivity({ file: join(dataDir, 'activity.json') });
  // Con el plugin `nexo-live-sync` instalado en el escritorio es él quien
  // registra las sesiones en vivo; escribir el mismo fichero desde los dos
  // procesos podría pisarse. Si el plugin está, el puente delega.
  const desktopPatchFile = join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
  let desktopLiveSync = false;
  try {
    desktopLiveSync = readFileSync(desktopPatchFile, 'utf8').includes('nexo-live-sync');
  } catch {
    desktopLiveSync = false;
  }
  if (desktopLiveSync) console.log('[escritorio] plugin de sincronización en vivo activo; registro delegado');
  const desktopSync = desktopLiveSync ? null : createDesktopSync({ log: console.log });

  // Aviso cuando termina una tarea larga. Lo consume el servicio en primer
  // plano del móvil vía /api/push (push propio, sin FCM).
  const runner = createDshRunner({
    config,
    emit: (event) => sse.broadcast(event),
    log: console.log,
    onTurnEnd: (info) => {
      if (!info.chatId || info.status === 'aborted') return;
      const meta = chatMeta.get(info.chatId);
      // Todo turno queda en el registro de actividad (aunque sea corto).
      activity.record({
        chatId: info.chatId,
        workspacePath: meta?.workspacePath ?? null,
        status: info.status,
        durationMs: info.durationMs,
        tools: info.tools ?? [],
        model: info.model ?? meta?.model ?? null,
      });
      // Aviso push solo para tareas largas.
      if (info.durationMs < 8000) return;
      const workspace = config.workspaces.find(
        (item) => meta?.workspacePath && item.path.toLowerCase() === meta.workspacePath.toLowerCase(),
      );
      const body =
        info.status === 'error'
          ? info.error ?? 'La tarea falló'
          : info.text || 'Tarea terminada';
      push.enqueue(
        {
          chatId: info.chatId,
          title: `Nexo · ${workspace?.name ?? 'tu proyecto'}`,
          body: body.slice(0, 140),
        },
        config.devices.map((device) => device.id),
      );
    },
  });

  // Acceso desde cualquier red (Tailscale Funnel). Si falla, se sigue sirviendo
  // en local y en la tailnet; solo se pierde el acceso por Internet.
  const publicUrl = enableRemoteAccess(config);
  if (publicUrl) console.log(`[remoto] publicando en ${publicUrl}`);
  else if (config.remoteAccess !== false) {
    console.log('[remoto] no se pudo activar el acceso público; sigo en local y Tailscale');
  }

  const imported = await workspaces.seedFromDsh();
  if (imported > 0) console.log(`[workspaces] importados ${imported} proyectos de DSH`);

  // Recupera en el registro del escritorio las conversaciones que ya existían
  // y se crearon fuera de él (p. ej. desde el móvil). El escritorio las mostrará
  // la próxima vez que arranque.
  if (desktopSync !== null) {
    try {
      const store = await import('./dsh-sessions.js');
      const recovered = desktopSync.backfill(config.workspaces, (path) =>
        store.listSessions(path, { fast: true }),
      );
      if (recovered > 0) console.log(`[escritorio] ${recovered} conversaciones registradas para el GUI`);
    } catch (error) {
      console.log(`[escritorio] no se pudo sincronizar el registro: ${error.message}`);
    }
  }

  const handler = createHttp({
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
    version: VERSION,
  });
  const server = createServer((req, res) => {
    handler(req, res).catch((error) => {
      console.error(`[http] fallo no controlado: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL', message: error.message } }));
      }
    });
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`\n  El puerto ${config.port} ya está ocupado.`);
      console.error(`  Cierra el otro proceso o cambia "port" en ${configFile()}.\n`);
    } else {
      console.error(`[servidor] ${error.message}`);
    }
    process.exit(1);
  });

  server.listen(config.port, config.bind, () => {
    banner(config);
    console.log(`  Servidor escuchando en ${config.bind}:${config.port} · v${VERSION}\n`);
  });

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`\n[servidor] ${signal}: cerrando turnos y conexiones…`);
    runner.stopAll();
    sse.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return undefined;
}

main().catch((error) => {
  console.error(`[arranque] ${error.stack ?? error.message}`);
  process.exit(1);
});
