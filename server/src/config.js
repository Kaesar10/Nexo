import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newPin, writeJsonAtomic } from './util.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = resolve(HERE, '..');
export const PROJECT_ROOT = resolve(SERVER_ROOT, '..');
const CONFIG_FILE = join(SERVER_ROOT, 'data', 'config.json');

export const DEFAULTS = {
  version: 1,
  port: 8790,
  bind: '0.0.0.0',
  pin: null,
  trustMode: 'workspace-write',
  provider: 'deepseek-official',
  defaultModel: 'deepseek-flash',
  models: [
    { id: 'deepseek-flash', name: 'DeepSeek Flash', hint: 'rápido, para el día a día' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', hint: 'máximo razonamiento' },
  ],
  // Acceso desde cualquier red sin configurar nada: Tailscale Funnel publica el
  // puente en una URL HTTPS estable dentro del dominio del equipo.
  remoteAccess: true,
  remotePort: 8443,
  publicUrl: null,
  dsh: {
    cli: null,
    profile: 'headless',
  },
  devices: [],
  workspaces: [],
};

/** Rutas candidatas donde puede vivir el lanzador `dsh` en este equipo. */
export function dshCandidates() {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return [
    process.env.DSH_CLI,
    join(local, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    join(local, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.exe'),
    'dsh',
  ].filter(Boolean);
}

/** Primer lanzador de DSH que exista (o el nombre `dsh` si está en PATH). */
export function resolveDshCli(config) {
  if (config?.dsh?.cli) return config.dsh.cli;
  for (const candidate of dshCandidates()) {
    if (candidate === 'dsh') return candidate;
    if (existsSync(candidate)) return candidate;
  }
  return 'dsh';
}

export function configFile() {
  return CONFIG_FILE;
}

export function loadConfig() {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  let saved = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    } catch (error) {
      console.error(`[config] no se pudo leer ${CONFIG_FILE}: ${error.message}`);
      saved = {};
    }
  }
  const config = {
    ...DEFAULTS,
    ...saved,
    dsh: { ...DEFAULTS.dsh, ...(saved.dsh ?? {}) },
    devices: Array.isArray(saved.devices) ? saved.devices : [],
    workspaces: Array.isArray(saved.workspaces) ? saved.workspaces : [],
  };
  let changed = !existsSync(CONFIG_FILE);
  if (!config.pin) {
    config.pin = newPin();
    changed = true;
  }
  if (changed) saveConfig(config);
  return config;
}

export function saveConfig(config) {
  writeJsonAtomic(CONFIG_FILE, config);
}

/** Fuerza un PIN nuevo (para `node server/src/index.js pin`). */
export function rotatePin(config) {
  config.pin = newPin();
  saveConfig(config);
  return config.pin;
}
