import { existsSync } from 'node:fs';
import type { CliFlags } from '../lib/args.ts';
import {
  CONFIG_KEYS,
  canonicalConfigKey,
  configFilePath,
  configLayerValues,
  effectiveConfigValue,
  isHomeOnlyConfigKey,
  mappingGet,
  mappingSet,
  mappingUnset,
  readConfigMapping,
  writeConfigMapping,
  type ConfigKey,
} from '../lib/config.ts';

import { CliError } from '../lib/errors.ts';
import { printJson, renderAgentMarkdown } from '../lib/output.ts';
import { formatTable } from '../lib/table.ts';
import { theme } from '../lib/theme.ts';

const NOT_SET = 'not set';
const REDACTED = '[redacted]';

interface ConfigDirs {
  cwd?: string;
  home?: string;
}

interface ConfigLayer {
  local: string | undefined;
  global: string | undefined;
  default: string | undefined;
}

function redactMappingForJson(record: Record<string, unknown>): Record<string, unknown> {
  const next = { ...record };

  for (const name of ['crux_api_key', 'CRUX_API_KEY']) {
    const value = next[name];

    if (typeof value === 'string' && value.trim()) {
      next[name] = REDACTED;
    }
  }

  return next;
}

function redactSecret(key: ConfigKey, value: string): string {
  return key === 'crux_api_key' && value.trim() ? REDACTED : value;
}

function displayLayerForTable(key: ConfigKey, value: string | undefined): string {
  return displayLayer(value === undefined ? undefined : redactSecret(key, value));
}

function assertWritableScope(key: ConfigKey, flags: CliFlags): void {
  if (isHomeOnlyConfigKey(key) && !flags.global) {
    throw new CliError(
      `${key} must use -g/--global ($HOME/.searchunit.yaml); project cwd YAML is not applied`,
      2,
    );
  }
}

function redactLayerJson(
  key: ConfigKey,
  layer: ReturnType<typeof jsonLayers>,
): ReturnType<typeof jsonLayers> {
  if (key !== 'crux_api_key') {
    return layer;
  }

  return {
    local: layer.local ? redactSecret(key, layer.local) : layer.local,
    global: layer.global ? redactSecret(key, layer.global) : layer.global,
    default: layer.default,
  };
}

/**
 * Gets, sets, or unsets keys in `.searchunit.yaml`.
 * `-g/--global` selects `$HOME`; otherwise the current directory.
 */
export async function runConfig(
  target: string | undefined,
  flags: CliFlags,
  dirs: ConfigDirs = {},
): Promise<number> {
  const path = configFilePath({ global: flags.global, cwd: dirs.cwd, home: dirs.home });

  if (target === 'list') {
    if (flags.unset) {
      throw new CliError('list cannot be used with --unset. Example: searchunit config list', 2);
    }

    if (flags.rest.length > 0) {
      throw new CliError('Too many arguments. Example: searchunit config list', 2);
    }

    return listFile(path, flags);
  }

  if (flags.unset) {
    if (flags.rest.length > 0) {
      throw new CliError('Too many arguments. Example: searchunit config --unset output', 2);
    }

    return unsetKey(path, target, flags, dirs);
  }

  if (flags.rest.length > 1) {
    throw new CliError('Too many arguments. Example: searchunit config output json', 2);
  }

  if (target && flags.rest[0] !== undefined) {
    return setKey(path, target, flags.rest[0], flags, dirs);
  }

  if (target) {
    return getKey(path, target, flags, dirs);
  }

  return listKeys(path, flags, dirs);
}

function requireKey(raw: string | undefined): ConfigKey {
  if (!raw) {
    throw new CliError('A config key is required. Example: searchunit config output json', 2);
  }

  const key = canonicalConfigKey(raw);

  if (!key) {
    throw new CliError(
      `Unknown config key "${raw}". Expected one of: ${CONFIG_KEYS.join(', ')}`,
      2,
    );
  }

  return key;
}

/** Lists keys from the selected YAML file only (cwd, or `$HOME` with `-g`). */
function listFile(path: string, flags: CliFlags): number {
  const mapping = readConfigMapping(path) ?? {};
  const scope = flags.global ? 'Global' : 'Local';

  printConfigView(flags, {
    subtitle: flags.global ? 'list global' : 'list local',
    files: [configFileLine(scope, path)],
    json: {
      ok: true,
      command: 'config',
      action: 'list',
      path,
      global: Boolean(flags.global),
      values: redactMappingForJson(mapping),
    },
    headers: ['Key', 'Value'],
    rows: CONFIG_KEYS.map((key) => [key, displayLayerForTable(key, mappingGet(mapping, key))]),
  });

  return 0;
}

function listKeys(path: string, flags: CliFlags, dirs: ConfigDirs): number {
  const layers = CONFIG_KEYS.map((key) => ({ key, layer: configLayerValues(key, dirs) }));

  printConfigView(flags, {
    files: configFileLines(dirs),
    json: {
      ok: true,
      command: 'config',
      path,
      global: Boolean(flags.global),
      values: redactMappingForJson(readConfigMapping(path) ?? {}),
      layers: Object.fromEntries(
        layers.map(({ key, layer }) => [key, redactLayerJson(key, jsonLayers(layer))]),
      ),
    },
    headers: ['Key', 'Local', 'Global', 'Default', 'Effective'],
    rows: layers.map(({ key, layer }) => [
      key,
      displayLayerForTable(key, layer.local),
      displayLayerForTable(key, layer.global),
      displayLayerForTable(key, layer.default),
      displayLayerForTable(key, effectiveConfigValue(key, layer)),
    ]),
  });

  return 0;
}

function getKey(path: string, raw: string, flags: CliFlags, dirs: ConfigDirs): number {
  const key = requireKey(raw);
  const layer = configLayerValues(key, dirs);
  const value = effectiveConfigValue(key, layer);
  const layersJson = redactLayerJson(key, jsonLayers(layer));

  printConfigView(flags, {
    subtitle: key,
    files: configFileLines(dirs),
    json: {
      ok: true,
      command: 'config',
      path,
      key,
      ...layersJson,
      value: jsonSecretValue(key, value),
    },
    headers: ['Field', 'Value'],

    rows: layerRows(key, layer),
  });

  return 0;
}

function setKey(
  path: string,
  raw: string,
  value: string,
  flags: CliFlags,
  dirs: ConfigDirs,
): number {
  const key = requireKey(raw);

  assertWritableScope(key, flags);
  const created = !existsSync(path);
  const next = mappingSet(readConfigMapping(path) ?? {}, key, value);

  writeConfigMapping(path, next);
  const stored = mappingGet(next, key) ?? value.trim();
  const layer = configLayerValues(key, dirs);

  printConfigView(flags, {
    files: configFileLines(dirs),
    subtitle: `set ${key}`,
    json: {
      ok: true,
      command: 'config',
      path,
      action: 'set',
      key,
      value: jsonSecretValue(key, stored),
      created,
      ...redactLayerJson(key, jsonLayers(layer)),
    },
    headers: ['Field', 'Value'],

    rows: layerRows(key, layer),
  });
  announceWrite(path, created, flags);

  return 0;
}

function unsetKey(
  path: string,
  raw: string | undefined,
  flags: CliFlags,
  dirs: ConfigDirs,
): number {
  const key = requireKey(raw);

  assertWritableScope(key, flags);
  const { record, removed } = mappingUnset(readConfigMapping(path) ?? {}, key);

  if (!removed) {
    throw new CliError(`key "${key}" is not set in ${path}`, 1);
  }

  writeConfigMapping(path, record);
  const layer = configLayerValues(key, dirs);

  printConfigView(flags, {
    files: configFileLines(dirs),
    subtitle: `unset ${key}`,
    json: {
      ok: true,
      command: 'config',
      path,
      action: 'unset',
      key,
      ...redactLayerJson(key, jsonLayers(layer)),
    },
    headers: ['Field', 'Value'],

    rows: layerRows(key, layer),
  });
  announceWrite(path, false, flags);

  return 0;
}

function printConfigView(
  flags: CliFlags,
  opts: {
    subtitle?: string;
    files: string[];
    json: unknown;
    headers: string[];
    rows: string[][];
  },
): void {
  if (flags.agent) {
    process.stdout.write(renderAgentMarkdown(opts.json));

    return;
  }

  if (flags.json) {
    printJson(opts.json);

    return;
  }

  const heading = opts.subtitle
    ? `${theme.title('Config')}  ${theme.dim(opts.subtitle)}`
    : theme.title('Config');
  console.log(
    ['', heading, '', ...opts.files, '', formatTable(opts.headers, opts.rows)].join('\n'),
  );
}

function configFileLines(dirs: ConfigDirs): string[] {
  return [
    configFileLine('Local', configFilePath({ ...dirs, global: false })),
    configFileLine('Global', configFilePath({ ...dirs, global: true })),
  ];
}

function configFileLine(label: string, path: string): string {
  return `${theme.dim(label.padEnd(6))}  ${theme.url(path)}`;
}

function layerRows(key: ConfigKey, layer: ConfigLayer): string[][] {
  return [
    ['Local', displayLayerForTable(key, layer.local)],
    ['Global', displayLayerForTable(key, layer.global)],
    ['Default', displayLayerForTable(key, layer.default)],
    ['Effective', displayLayerForTable(key, effectiveConfigValue(key, layer))],
  ];
}

function displayLayer(value: string | undefined): string {
  return value ?? theme.dim(NOT_SET);
}

function jsonSecretValue(key: ConfigKey, value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return redactSecret(key, value);
}

function jsonLayers(layer: ConfigLayer): {
  local: string | null;
  global: string | null;
  default: string | null;
} {
  return {
    local: layer.local ?? null,
    global: layer.global ?? null,
    default: layer.default ?? null,
  };
}

function announceWrite(path: string, created: boolean, flags: CliFlags): void {
  if (flags.silent) {
    return;
  }

  const verb = created ? 'Created' : 'Updated';

  console.error(`\n${theme.ok(verb)} ${path}`);
}
