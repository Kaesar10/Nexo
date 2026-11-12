import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import readline from 'node:readline';
import { shortId } from './util.js';

const MAX_TURN_MS = 15 * 60 * 1000;
const MAX_CONCURRENT_TURNS = 3;

/** Etiqueta humana (y sin ruido) para la actividad del agente. */
export function toolLabel(tool, input) {
  const name = String(tool ?? '').toLowerCase();
  if (/^(write|edit|str_replace|apply_patch|create)/.test(name)) return 'editando archivos…';
  if (/^(read|view|open)/.test(name)) return 'leyendo archivos…';
  if (/^(bash|pwsh|shell|exec|terminal|run)/.test(name)) return 'ejecutando órdenes…';
  if (/^(grep|glob|search|find|rg)/.test(name)) return 'buscando en el proyecto…';
  if (/^(web_search|web_fetch|fetch|browse)/.test(name)) return 'consultando la web…';
  if (/^(todo|task|plan)/.test(name)) return 'organizando el trabajo…';
  if (/^(skill)/.test(name)) return 'preparando una habilidad…';
  const target = input?.file_path ?? input?.path ?? input?.pattern;
  if (typeof target === 'string' && target) {
    return `${name || 'trabajando'} · ${target.split(/[\\/]/).pop()}`;
  }
  return name ? `usando ${name}…` : 'trabajando…';
}

/** Clave del proveedor: entorno primero, luego el almacén de credenciales de DSH. */
export function resolveApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const file = join(homedir(), '.dsh', '.credentials.yaml');
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8');
    const match = /^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m.exec(raw);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function quoteWin(value) {
  const text = String(value);
  return /\s|"/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

/**
 * Prepara el lanzamiento de `dsh`.
 *
 * En Windows el lanzador oficial es un `.cmd`, y `spawn` no puede ejecutarlo sin
 * pasar por `cmd.exe` (que además rompe las comillas anidadas). Por eso, cuando
 * reconocemos la instalación de escritorio, lanzamos el mismo binario de Electron
 * en modo Node que usa ese `.cmd` — sin shell de por medio. Si no, se usa
 * `cmd /c` con `windowsVerbatimArguments`.
 *
 * Los argumentos son siempre fijos (el texto del usuario va por stdin con `-`),
 * así que no hay riesgo de inyección en la línea de órdenes.
 */
export function buildLaunch(cli, args, env) {
  const childEnv = { ...process.env, ...env };

  if (/\.cmd$/i.test(cli)) {
    // <raíz>\resources\runtime\cli\bin\dsh.cmd → <raíz>\DeepSeek Harness.exe
    const binDir = dirname(cli);
    const installRoot = resolve(binDir, '..', '..', '..', '..');
    const exe = join(installRoot, 'DeepSeek Harness.exe');
    const cliJs = join(
      installRoot, 'resources', 'app.asar', 'dsh', 'node_modules',
      '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js',
    );
    if (process.platform === 'win32' && existsSync(exe)) {
      return {
        command: exe,
        args: ['--expose-internals', cliJs, ...args],
        env: { ...childEnv, ELECTRON_RUN_AS_NODE: '1' },
        shellWrapped: false,
      };
    }
  }

  if (/\.(cmd|bat)$/i.test(cli) || cli === 'dsh') {
    const command = process.env.ComSpec || 'cmd.exe';
    const inner = [`"${cli}"`, ...args.map(quoteWin)].join(' ');
    return {
      command,
      args: ['/d', '/s', '/c', `"${inner}"`],
      env: childEnv,
      shellWrapped: true,
      verbatim: true,
    };
  }

  return { command: cli, args, env: childEnv, shellWrapped: false };
}

/** Traduce errores conocidos de DSH a algo que un humano pueda leer en el móvil. */
export function friendlyError(message) {
  const text = String(message ?? '').trim();
  if (!text) return 'El agente terminó sin dar detalles.';
  if (/runs under agent preset/.test(text)) {
    return 'Esta conversación se creó en el escritorio de DSH y no se puede continuar desde el móvil. Abre una nueva conversación aquí o sigue esta en el PC.';
  }
  if (/MISSING_CREDENTIAL|no API key for provider/i.test(text)) {
    return 'Falta la clave del modelo (DEEPSEEK_API_KEY) en el PC. Ejecuta "node server/src/index.js doctor" para comprobarlo.';
  }
  if (/cannot be adopted|is a subagent session/i.test(text)) {
    return 'DSH no permite continuar esta conversación desde el móvil. Empieza una nueva.';
  }
  if (/ENOENT|no such file or directory/i.test(text)) {
    return `No encuentro un archivo necesario: ${text}`;
  }
  return text;
}

/**
 * Ejecutor de turnos: un proceso `dsh headless --json` por turno.
 *
 * Emite eventos ya normalizados al bus SSE:
 *   turn_start · thinking · tool · delta · turn_end
 */
export function createDshRunner({ config, emit, log = console.log, onTurnEnd }) {
  const turns = new Map(); // chatId → turn
  const active = new Set();

  function isBusy(chatId) {
    return turns.has(chatId);
  }

  function busyCount() {
    return active.size;
  }

  function stop(chatId) {
    const turn = turns.get(chatId);
    if (!turn) return false;
    turn.aborted = true;
    killTree(turn.child);
    return true;
  }

  function stopAll() {
    for (const chatId of [...turns.keys()]) stop(chatId);
  }

  /**
   * Lanza un turno.
   * @param {object} options
   * @param {string} [options.chatId]      sesión DSH existente; si falta, se crea una
   * @param {string} options.workspacePath carpeta del proyecto (cwd del proceso)
   * @param {string} options.text          mensaje del usuario
   * @param {string} [options.patchFile]   overlay que fija el modelo de este turno
   * @param {string} [options.model]       id del modelo (para el registro de actividad)
   * @param {(sessionId: string) => void} [options.onSession] se llama al conocer el id
   * @returns {Promise<{chatId: string, turnId: string}>}
   */
  async function runTurn({ chatId, workspacePath, text, patchFile, model, onSession }) {
    if (active.size >= MAX_CONCURRENT_TURNS) {
      throw Object.assign(new Error('El agente está ocupado con otros turnos'), { code: 'CONFLICT' });
    }
    if (chatId && turns.has(chatId)) {
      throw Object.assign(new Error('Ya hay un turno en marcha en este chat'), { code: 'CONFLICT' });
    }

    const turnId = shortId('turn');
    const profile = config.dsh?.profile ?? 'headless';
    const approval = 'never';
    const permission = config.trustMode ?? 'workspace-write';
    const args = ['--profile', profile];
    if (patchFile) args.push('--patch', patchFile);
    args.push(
      '--json',
      '--approval-policy', approval,
      '--permission-mode', permission,
    );
    if (chatId) args.push('--session-id', chatId);
    args.push('-');

    const apiKey = resolveApiKey();
    const launch = buildLaunch(
      config.dsh?.cli ?? 'dsh',
      args,
      apiKey ? { DEEPSEEK_API_KEY: apiKey, ELECTRON_RUN_AS_NODE: '1' } : { ELECTRON_RUN_AS_NODE: '1' },
    );

    log(`[turn] ${turnId} ${chatId ?? 'nueva sesión'} en ${workspacePath}`);
    const child = spawn(launch.command, launch.args, {
      cwd: workspacePath,
      env: launch.env,
      windowsHide: true,
      windowsVerbatimArguments: Boolean(launch.verbatim),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const turn = {
      chatId: chatId ?? null,
      turnId,
      child,
      aborted: false,
      sawFinal: false,
      stderr: [],
      toolNames: new Map(),
      thinkingSent: false,
      resolvedSession: Boolean(chatId),
      startedAt: Date.now(),
      textChunks: [],
      toolsUsed: [],
      model: model ?? null,
      timer: null,
      resolveSession: null,
      rejectSession: null,
    };

    const sessionReady = new Promise((resolve, reject) => {
      turn.resolveSession = resolve;
      turn.rejectSession = reject;
      if (chatId) resolve(chatId);
    });
    active.add(child);
    if (chatId) turns.set(chatId, turn);

    turn.timer = setTimeout(() => {
      turn.stderr.push(`turno superado el límite de ${MAX_TURN_MS / 60000} min`);
      killTree(child);
    }, MAX_TURN_MS);
    if (turn.timer.unref) turn.timer.unref();

    // --- entrada: el mensaje va por stdin para no tocar la línea de órdenes ---
    child.stdin.end(text, 'utf8');

    // --- salida: NDJSON línea a línea ---
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (!trimmed.startsWith('{')) {
        // ruido de diagnóstico del CLI: por stderr al log del servidor
        turn.stderr.push(trimmed);
        return;
      }
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }
      handleEvent(turn, event);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) turn.stderr.push(line.trim());
      }
      while (turn.stderr.length > 40) turn.stderr.shift();
    });

    child.on('error', (error) => {
      finish(turn, 'error', `No se pudo lanzar DSH: ${error.message}`);
    });

    child.on('close', (code) => {
      if (!turn.sawFinal) {
        const tail = turn.stderr.slice(-4).join(' | ');
        const reason = turn.aborted ? 'aborted' : 'error';
        const message = turn.aborted
          ? undefined
          : `DSH terminó con código ${code}${tail ? `: ${tail}` : ''}`;
        finish(turn, reason, message);
      }
    });

    function handleEvent(activeTurn, event) {
      switch (event.type) {
        case 'session': {
          if (!activeTurn.resolvedSession) {
            activeTurn.resolvedSession = true;
            activeTurn.chatId = event.sessionId;
            turns.set(event.sessionId, activeTurn);
            activeTurn.resolveSession(event.sessionId);
            onSession?.(event.sessionId);
            emit({ type: 'chat_created', chatId: event.sessionId, workspacePath });
          }
          break;
        }
        case 'status': {
          if (event.phase === 'turn_start') {
            emit({ type: 'turn_start', chatId: activeTurn.chatId, turnId: activeTurn.turnId });
          } else if (event.phase === 'step_start' && !activeTurn.thinkingSent) {
            activeTurn.thinkingSent = true;
            emit({ type: 'thinking', chatId: activeTurn.chatId });
          }
          break;
        }
        case 'thinking': {
          if (!activeTurn.thinkingSent) {
            activeTurn.thinkingSent = true;
            emit({ type: 'thinking', chatId: activeTurn.chatId });
          }
          break;
        }
        case 'tool_call': {
          activeTurn.toolNames.set(event.callId, event.tool);
          if (event.tool && !activeTurn.toolsUsed.includes(event.tool)) {
            activeTurn.toolsUsed.push(event.tool);
          }
          emit({
            type: 'tool',
            chatId: activeTurn.chatId,
            tool: event.tool,
            status: 'start',
            label: toolLabel(event.tool, event.input),
          });
          break;
        }
        case 'tool_result': {
          emit({
            type: 'tool',
            chatId: activeTurn.chatId,
            tool: activeTurn.toolNames.get(event.callId) ?? null,
            status: 'done',
            label: null,
          });
          break;
        }
        case 'text': {
          if (event.text) {
            activeTurn.textChunks.push(event.text);
            emit({ type: 'delta', chatId: activeTurn.chatId, text: event.text });
          }
          break;
        }
        case 'final': {
          if (!activeTurn.resolvedSession && event.sessionId) {
            activeTurn.resolvedSession = true;
            activeTurn.chatId = event.sessionId;
            turns.set(event.sessionId, activeTurn);
            activeTurn.resolveSession(event.sessionId);
            onSession?.(event.sessionId);
          }
          const kind = event.reason?.kind ?? 'completed';
          const status = activeTurn.aborted
            ? 'aborted'
            : kind === 'completed'
              ? 'completed'
              : 'error';
          const errorText =
            status === 'error'
              ? event.reason?.error?.message ?? event.text ?? 'El agente terminó con un error'
              : undefined;
          finish(activeTurn, status, errorText);
          break;
        }
        default:
          break;
      }
    }

    function finish(activeTurn, status, errorText) {
      if (activeTurn.sawFinal) return;
      activeTurn.sawFinal = true;
      clearTimeout(activeTurn.timer);
      turns.delete(activeTurn.chatId ?? '__pending__');
      active.delete(activeTurn.child);
      const friendly = status === 'error' ? friendlyError(errorText) : undefined;
      if (!activeTurn.resolvedSession) {
        activeTurn.rejectSession?.(
          Object.assign(new Error(friendly ?? 'DSH no creó la sesión'), { code: 'INTERNAL' }),
        );
      }
      emit({
        type: 'turn_end',
        chatId: activeTurn.chatId,
        turnId: activeTurn.turnId,
        status,
        ...(friendly ? { text: friendly } : {}),
      });
      // Aviso para el servicio en primer plano del móvil (push propio).
      try {
        onTurnEnd?.({
          chatId: activeTurn.chatId,
          turnId: activeTurn.turnId,
          status,
          error: friendly ?? null,
          text: activeTurn.textChunks.join('').trim(),
          durationMs: Date.now() - activeTurn.startedAt,
          tools: [...activeTurn.toolsUsed],
          model: activeTurn.model,
        });
      } catch (error) {
        log(`[push] no se pudo encolar el aviso: ${error.message}`);
      }
      // el proceso puede seguir vivo un instante; nos aseguramos de no dejarlo colgado
      setTimeout(() => killTree(activeTurn.child), 1500).unref?.();
    }

    const resolvedChatId = await sessionReady;
    return { chatId: resolvedChatId, turnId };
  }

  function killTree(child) {
    if (!child || child.killed) return;
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        }).on('error', () => child.kill());
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      try {
        child.kill();
      } catch {
        /* ya murió */
      }
    }
  }

  return { runTurn, stop, stopAll, isBusy, busyCount };
}
