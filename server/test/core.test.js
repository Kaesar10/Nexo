import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { newPin, safeEqual, sha256 } from '../src/util.js';
import { createAuth } from '../src/auth.js';
import { createWorkspaces } from '../src/workspaces.js';
import { buildLaunch } from '../src/dsh.js';

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'nexo-test-'));
  return {
    dir,
    config: {
      pin: '123456',
      trustMode: 'workspace-write',
      dsh: { cli: 'dsh', profile: 'headless' },
      devices: [],
      workspaces: [],
    },
    save() {},
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('util: safeEqual compara sin filtrar longitud', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
});

test('util: newPin siempre son 6 dígitos', () => {
  for (let i = 0; i < 500; i += 1) {
    const pin = newPin();
    assert.match(pin, /^\d{6}$/);
  }
});

test('auth: PIN incorrecto falla, correcto empareja y el token verifica', () => {
  const { config, save } = tempConfig();
  const auth = createAuth({ config, save });
  assert.throws(() => auth.pair({ code: '000000', deviceName: 'x', ip: '1.1.1.1' }), /Código incorrecto/);

  const paired = auth.pair({ code: '123456', deviceName: 'Pixel', ip: '1.1.1.1' });
  assert.match(paired.token, /^[0-9a-f]{64}$/);
  assert.equal(paired.deviceName, 'Pixel');

  const device = auth.verify(paired.token);
  assert.equal(device.id, paired.deviceId);
  assert.equal(auth.verify('token-falso'), null);
  assert.equal(auth.verify(''), null);
});

test('auth: el token no se guarda en claro y se revoca', () => {
  const { config, save } = tempConfig();
  const auth = createAuth({ config, save });
  const paired = auth.pair({ code: '123456', deviceName: 'Pixel', ip: '1.1.1.1' });
  assert.equal(config.devices[0].hash, sha256(paired.token));
  assert.ok(!JSON.stringify(config.devices).includes(paired.token));

  assert.equal(auth.revoke(paired.deviceId), true);
  assert.equal(auth.verify(paired.token), null);
});

test('auth: bloquea tras 5 intentos fallidos', () => {
  const { config, save } = tempConfig();
  const auth = createAuth({ config, save });
  for (let i = 0; i < 5; i += 1) {
    assert.throws(() => auth.pair({ code: '999999', deviceName: 'x', ip: '2.2.2.2' }), /Código incorrecto/);
  }
  assert.throws(() => auth.pair({ code: '123456', deviceName: 'x', ip: '2.2.2.2' }), /Demasiados intentos/);
});

test('workspaces: alta válida, deduplicada y borrado', () => {
  const { dir, config, save } = tempConfig();
  const workspaces = createWorkspaces({ config, save });
  const created = workspaces.add({ path: dir, name: 'Prueba' });
  assert.equal(created.name, 'Prueba');
  assert.equal(created.exists, true);

  const duplicate = workspaces.add({ path: dir.toUpperCase(), name: 'Otra' });
  assert.equal(duplicate.id, created.id);
  assert.equal(config.workspaces.length, 1);

  assert.equal(workspaces.remove(created.id), true);
  assert.equal(config.workspaces.length, 0);
});

test('workspaces: rechaza rutas relativas o inexistentes', () => {
  const { config, save } = tempConfig();
  const workspaces = createWorkspaces({ config, save });
  assert.throws(() => workspaces.add({ path: 'no/es/absoluta' }), /absoluta/);
  assert.throws(() => workspaces.add({ path: 'C:\\carpeta-que-no-existe-nexo-123' }), /no existe/);
});

test('workspaces: browse lista carpetas y marca la raíz', () => {
  const { dir, config, save } = tempConfig();
  mkdirSync(join(dir, 'proyecto-a'));
  mkdirSync(join(dir, 'proyecto-b'));
  mkdirSync(join(dir, '.oculta'));
  const workspaces = createWorkspaces({ config, save });

  const listing = workspaces.browse(dir);
  const names = listing.entries.map((entry) => entry.name);
  assert.deepEqual(names, ['proyecto-a', 'proyecto-b']);
  assert.equal(listing.path, dir);

  const roots = workspaces.browse('roots');
  assert.ok(Array.isArray(roots.entries));
  assert.ok(roots.quickLinks.length > 0);
});

test('dsh: en Windows lanza el binario de Electron sin pasar por cmd', () => {
  const cli = 'C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd';
  const launch = buildLaunch(cli, ['--profile', 'headless', '-'], {});
  if (process.platform === 'win32') {
    const exists = launch.command.toLowerCase().endsWith('deepseek harness.exe');
    assert.ok(exists || launch.shellWrapped, 'esperaba exe directo o envoltorio de shell');
    assert.equal(launch.args[0] === '--expose-internals' || launch.args[0] === '/d', true);
  } else {
    assert.equal(launch.command, cli);
  }
});

test('dsh: un CLI alternativo se lanza tal cual', () => {
  const launch = buildLaunch('C:\\tools\\dsh.exe', ['--profile', 'headless'], {});
  assert.equal(launch.command, 'C:\\tools\\dsh.exe');
  assert.deepEqual(launch.args, ['--profile', 'headless']);
});
