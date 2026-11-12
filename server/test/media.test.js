import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createModels } from '../src/models.js';
import { createUploads } from '../src/uploads.js';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

const BASE_CONFIG = {
  provider: 'deepseek-official',
  defaultModel: 'deepseek-flash',
  models: [
    { id: 'deepseek-flash', name: 'DeepSeek Flash', hint: 'rápido' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', hint: 'máximo razonamiento' },
  ],
};

test('models: lista, marca el de defecto y resuelve desconocidos', () => {
  const dataDir = tempDir('nexo-models-');
  try {
    const models = createModels({ config: BASE_CONFIG, dataDir });
    const list = models.list();
    assert.equal(list.length, 2);
    assert.equal(list.find((model) => model.isDefault)?.id, 'deepseek-flash');
    assert.equal(models.resolve('deepseek-v4-pro'), 'deepseek-v4-pro');
    assert.equal(models.resolve('modelo-inventado'), 'deepseek-flash');
    assert.equal(models.resolve(undefined), 'deepseek-flash');
    assert.equal(models.has('deepseek-v4-pro'), true);
    assert.equal(models.has('nope'), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('models: genera un overlay --patch válido por modelo', () => {
  const dataDir = tempDir('nexo-models-');
  try {
    const models = createModels({ config: BASE_CONFIG, dataDir });
    const file = models.patchFile('deepseek-v4-pro');
    assert.ok(existsSync(file));
    const yaml = readFileSync(file, 'utf8');
    assert.match(yaml, /- id: agent-default-model/);
    assert.match(yaml, /provider: deepseek-official/);
    assert.match(yaml, /model: deepseek-v4-pro/);
    // segunda llamada reutiliza el fichero
    assert.equal(models.patchFile('deepseek-v4-pro'), file);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('uploads: guarda la imagen dentro del workspace y la expone', () => {
  const dataDir = tempDir('nexo-uploads-');
  const workspace = tempDir('nexo-ws-');
  try {
    const uploads = createUploads({ dataDir });
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const entry = uploads.save({
      workspacePath: workspace,
      name: 'foto de prueba.png',
      mime: 'image/png',
      data: png.toString('base64'),
    });
    assert.match(entry.id, /^att_/);
    assert.equal(entry.size, png.length);
    assert.match(entry.mime, /^image\/png$/);
    assert.equal(entry.url, `/api/attachments/${entry.id}`);
    assert.ok(entry.path.startsWith(join(workspace, '.nexo', 'adjuntos')));
    assert.ok(existsSync(entry.path));
    assert.equal(uploads.toPublic(entry.id)?.id, entry.id);
    assert.equal(uploads.isReadable(entry.id), true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('uploads: acepta documentos y marca kind=file', () => {
  const dataDir = tempDir('nexo-uploads-');
  const workspace = tempDir('nexo-ws-');
  try {
    const uploads = createUploads({ dataDir });
    const entry = uploads.save({
      workspacePath: workspace,
      name: 'informe.pdf',
      mime: 'application/pdf',
      data: Buffer.from('%PDF-1.4 prueba').toString('base64'),
    });
    assert.equal(entry.kind, 'file');
    assert.match(entry.path, /\.pdf$/);

    const text = uploads.save({
      workspacePath: workspace,
      name: 'notas.txt',
      mime: 'text/plain',
      data: Buffer.from('hola').toString('base64'),
    });
    assert.equal(text.kind, 'file');
    assert.match(text.path, /\.txt$/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('uploads: rechaza vacío, ejecutables y exceso de tamaño', () => {
  const dataDir = tempDir('nexo-uploads-');
  const workspace = tempDir('nexo-ws-');
  try {
    const uploads = createUploads({ dataDir });
    assert.throws(
      () => uploads.save({ workspacePath: workspace, name: 'x.png', mime: 'image/png', data: '' }),
      /vac[íi]o/,
    );
    assert.throws(
      () =>
        uploads.save({
          workspacePath: workspace,
          name: 'virus.exe',
          mime: 'application/octet-stream',
          data: Buffer.from('MZ').toString('base64'),
        }),
      /no está permitido/,
    );
    const bigImage = Buffer.alloc(8 * 1024 * 1024 + 10, 1).toString('base64');
    assert.throws(
      () => uploads.save({ workspacePath: workspace, name: 'big.png', mime: 'image/png', data: bigImage }),
      /8 MB/,
    );
    const bigDoc = Buffer.alloc(25 * 1024 * 1024 + 10, 1).toString('base64');
    assert.throws(
      () => uploads.save({ workspacePath: workspace, name: 'big.pdf', mime: 'application/pdf', data: bigDoc }),
      /25 MB/,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('uploads: resuelve los adjuntos citados en el texto del historial', () => {
  const dataDir = tempDir('nexo-uploads-');
  const workspace = tempDir('nexo-ws-');
  try {
    const uploads = createUploads({ dataDir });
    const entry = uploads.save({
      workspacePath: workspace,
      name: 'captura.png',
      mime: 'image/png',
      data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'),
    });
    const text = `Mira esto\n\n[Adjunto: ${entry.path}]`;
    const found = uploads.fromText(text);
    assert.equal(found.length, 1);
    assert.equal(found[0].id, entry.id);

    // el índice sobrevive a un reinicio del proceso
    const again = createUploads({ dataDir });
    assert.equal(again.toPublic(entry.id)?.id, entry.id);
    assert.equal(again.fromText(text).length, 1);
    assert.equal(again.fromText('sin adjuntos').length, 0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

