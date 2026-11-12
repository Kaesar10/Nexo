#!/usr/bin/env node
/**
 * Aprovisiona el APK para que entre solo, sin PIN.
 *
 *   node scripts/provisionar.mjs ["Nombre del móvil"]
 *
 * 1. Pide al puente un token de dispositivo (solo se puede desde el propio PC).
 * 2. Escribe `app/.env.production` con el token y la URL pública.
 * 3. Deja los siguientes comandos listos para construir la APK.
 *
 * El token queda dentro del APK. Si el móvil se pierde:
 *   node server/src/index.js doctor   (o revoca en la app: Ajustes → dispositivos)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE ?? 'http://127.0.0.1:8790';
const deviceName = process.argv[2] ?? 'Móvil principal';

async function main() {
  const health = await fetch(`${BASE}/api/health`).then((response) => response.json());
  if (!health.ok) throw new Error('El puente no responde. Arranca scripts\\iniciar.cmd primero.');
  const serverUrl = health.remote?.publicUrl;
  if (!serverUrl) {
    throw new Error(
      'El puente no tiene acceso remoto activo. Revisa Tailscale/Funnel antes de aprovisionar.',
    );
  }

  const provisioned = await fetch(`${BASE}/api/provision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceName }),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));

  if (provisioned.status !== 201) {
    throw new Error(`No se pudo aprovisionar: ${JSON.stringify(provisioned.body)}`);
  }

  const { token, deviceId, deviceName: name } = provisioned.body;
  const envFile = join(root, 'app', '.env.production');
  const content = [
    '# Generado por scripts/provisionar.mjs — no editar a mano ni versionar.',
    `VITE_DEVICE_TOKEN=${token}`,
    `VITE_DEVICE_ID=${deviceId}`,
    `VITE_BOOTSTRAP_SERVER=${serverUrl}`,
    '',
  ].join('\n');
  await writeFile(envFile, content, 'utf8');
  await writeFile(
    join(root, 'scripts', 'provision.json'),
    `${JSON.stringify({ deviceId, deviceName: name, serverUrl, createdAt: Date.now() }, null, 2)}\n`,
    'utf8',
  );

  console.log('\n  Dispositivo aprovisionado:');
  console.log(`    nombre:  ${name}`);
  console.log(`    id:      ${deviceId}`);
  console.log(`    servidor ${serverUrl}`);
  console.log(`    token   ${token.slice(0, 8)}…${token.slice(-6)} (guardado en app/.env.production)\n`);
  console.log('  Ahora:');
  console.log('    cd app; npm run build');
  console.log('    cd ..\\apk; npx cap sync android; npm run apk');
  console.log('    adb -s <movil> install -r ..\\Nexo-1.0.0.apk\n');
}

main().catch((error) => {
  console.error(`\n  ✗ ${error.message}\n`);
  process.exit(1);
});
