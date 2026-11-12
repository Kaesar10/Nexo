import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Modelos disponibles por conversación.
 *
 * `dsh headless` no tiene un flag `--model`; el modelo se fija en el perfil con
 * el plugin `agent-default-model`. La forma de cambiarlo por turno es un overlay
 * `--patch` (verificado) con esta forma:
 *
 *   - id: agent-default-model
 *     config:
 *       provider: deepseek-official
 *       model: deepseek-v4-pro
 *
 * Generamos un `.yml` por modelo una sola vez y lo pasamos a cada turno.
 */
export function createModels({ config, dataDir }) {
  const dir = join(dataDir, 'models');
  mkdirSync(dir, { recursive: true });
  const patches = new Map();

  function list() {
    const defaultModel = config.defaultModel ?? config.models?.[0]?.id ?? 'deepseek-flash';
    return (config.models ?? []).map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      hint: model.hint ?? '',
      isDefault: model.id === defaultModel,
    }));
  }

  function has(id) {
    return (config.models ?? []).some((model) => model.id === id);
  }

  function resolve(id) {
    if (id && has(id)) return id;
    return config.defaultModel ?? list()[0]?.id ?? 'deepseek-flash';
  }

  /** Ruta del overlay que fija `modelId` (se crea bajo demanda). */
  function patchFile(modelId) {
    const id = resolve(modelId);
    if (patches.has(id)) return patches.get(id);
    const file = join(dir, `${id}.yml`);
    if (!existsSync(file)) {
      const yaml = [
        '- id: agent-default-model',
        '  config:',
        `    provider: ${config.provider ?? 'deepseek-official'}`,
        `    model: ${id}`,
        '',
      ].join('\n');
      writeFileSync(file, yaml, 'utf8');
    }
    patches.set(id, file);
    return file;
  }

  return { list, has, resolve, patchFile };
}
