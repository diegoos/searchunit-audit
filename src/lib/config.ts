import { parse as parseYaml } from 'yaml';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseOutFormat, type OutputFormat } from './args.ts';
import { parseMaxBodyBytes } from './maxBodyBytes.ts';

const CONFIG_FILENAME = '.searchunit.yaml';

export const CONFIG_KEYS = ['crux_api_key', 'output', 'max_body_bytes'] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

/** True for keys applied from `$HOME` YAML, flags, or env — not from project cwd YAML. */
export function isHomeOnlyConfigKey(key: ConfigKey): boolean {
  return key === 'crux_api_key';
}

/** True when `CRUX_API_KEY` is set. The value itself stays out of reports. */
export function cruxApiKeyAvailable(): boolean {
  return Boolean(process.env.CRUX_API_KEY?.trim());
}

/** Short label for human reports. */
export function cruxApiKeyLabel(available = cruxApiKeyAvailable()): string {
  return available ? 'CRUX_API_KEY available' : 'CRUX_API_KEY missing';
}

/** Value the CLI uses after merge (matches `loadConfig`). */
export function effectiveConfigValue(
  key: ConfigKey,
  layer: { local: string | undefined; global: string | undefined; default: string | undefined },
): string | undefined {
  if (key === 'crux_api_key') {
    const env = process.env.CRUX_API_KEY?.trim();

    if (env) {
      return env;
    }

    return layer.global ?? layer.default;
  }

  return layer.local ?? layer.global ?? layer.default;
}

/** Built-in values when a key is missing from both YAML files. */
const CONFIG_DEFAULTS: Partial<Record<ConfigKey, string>> = {
  output: 'table',
  max_body_bytes: '2097152',
};

/** YAML keys that map onto one canonical config key. */

function aliasNames(key: ConfigKey): readonly string[] {
  return key === 'crux_api_key' ? ['crux_api_key', 'CRUX_API_KEY'] : [key];
}

function stripHomeOnlyFromMapping(raw: Record<string, unknown>): Record<string, unknown> {
  const next = { ...raw };

  for (const name of aliasNames('crux_api_key')) {
    delete next[name];
  }

  return next;
}

/** Values loaded from `.searchunit.yaml` (cwd, then `$HOME`). */
export interface CliConfig {
  cruxApiKey?: string;
  output?: OutputFormat;
  maxBodyBytes?: number;
}

export interface LoadConfigOptions {
  cwd?: string;
  home?: string;
}

/**
 * Loads CLI config: cwd `.searchunit.yaml` overlays `$HOME` except
 * `crux_api_key` (home, flags, or env).
 * `max_body_bytes` overlays from cwd like `output`.
 * Missing keys stay unset so the parser applies CLI defaults.
 */
export function loadConfig(opts: LoadConfigOptions = {}): CliConfig {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const homeCfg = readConfigFile(join(home, CONFIG_FILENAME));
  const cwdPath = join(cwd, CONFIG_FILENAME);
  const cwdMapping = readConfigMapping(cwdPath);
  const cwdCfg =
    cwdMapping === undefined ? {} : normalizeConfig(stripHomeOnlyFromMapping(cwdMapping), cwdPath);

  return { ...homeCfg, ...cwdCfg };
}

/**
 * Sets `CRUX_API_KEY` from config when the environment variable is unset.
 */
export function applyConfig(config: CliConfig): void {
  if (config.cruxApiKey && !process.env.CRUX_API_KEY?.trim()) {
    process.env.CRUX_API_KEY = config.cruxApiKey;
  }
}

/** Absolute path of `.searchunit.yaml` in cwd or `$HOME`. */
export function configFilePath(opts: { global?: boolean; cwd?: string; home?: string }): string {
  const dir = opts.global ? (opts.home ?? homedir()) : (opts.cwd ?? process.cwd());

  return join(dir, CONFIG_FILENAME);
}

/** Local, `$HOME`, and CLI-default values for one config key. */
export function configLayerValues(
  key: ConfigKey,
  opts: LoadConfigOptions = {},
): { local: string | undefined; global: string | undefined; default: string | undefined } {
  return {
    local: mappingGet(readConfigMapping(configFilePath({ ...opts, global: false })) ?? {}, key),
    global: mappingGet(readConfigMapping(configFilePath({ ...opts, global: true })) ?? {}, key),
    default: CONFIG_DEFAULTS[key],
  };
}

/** Maps a user-supplied key (including `CRUX_API_KEY`) to the canonical name. */
export function canonicalConfigKey(raw: string): ConfigKey | undefined {
  const lower = raw.trim().toLowerCase();

  return CONFIG_KEYS.find((name) => name === lower);
}

/** Reads the YAML mapping, or `undefined` when the file is missing. */
export function readConfigMapping(path: string): Record<string, unknown> | undefined {
  let raw: string;

  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) {
      return undefined;
    }

    throw new Error(`Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }

  return parseMapping(raw, path);
}

/** Writes a YAML mapping. Creates the file when it is missing. */
export function writeConfigMapping(path: string, record: Record<string, unknown>): void {
  writeFileSync(path, stringifyMapping(record), { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Returns the string value for a canonical key, checking aliases. */
export function mappingGet(record: Record<string, unknown>, key: ConfigKey): string | undefined {
  for (const name of aliasNames(key)) {
    const value = record[name];

    if (key === 'max_body_bytes' && typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }

    if (typeof value === 'string' && value.trim()) {
      const trimmed = value.trim();

      return key === 'output' ? trimmed.toLowerCase() : trimmed;
    }
  }

  return undefined;
}

/** Sets a canonical key and drops its aliases. */
export function mappingSet(
  record: Record<string, unknown>,
  key: ConfigKey,
  value: string,
): Record<string, unknown> {
  const next = { ...record };
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error(`Invalid ${key}: expected a non-empty string`);
  }

  for (const name of aliasNames(key)) {
    delete next[name];
  }

  if (key === 'output') {
    next[key] = requireOutput(trimmed, 'Invalid output: must be table, json, html, or markdown');

    return next;
  }

  if (key === 'max_body_bytes') {
    next[key] = String(parseMaxBodyBytes(trimmed));

    return next;
  }

  next[key] = trimmed;

  return next;
}

/** Removes a canonical key and its aliases. */
export function mappingUnset(
  record: Record<string, unknown>,
  key: ConfigKey,
): { record: Record<string, unknown>; removed: boolean } {
  const next = { ...record };
  let removed = false;

  for (const name of aliasNames(key)) {
    if (name in next) {
      delete next[name];
      removed = true;
    }
  }

  return { record: next, removed };
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

function readConfigFile(path: string): CliConfig {
  const mapping = readConfigMapping(path);

  if (mapping === undefined) {
    return {};
  }

  return normalizeConfig(mapping, path);
}

function parseMapping(raw: string, path: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `Invalid YAML in ${path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (parsed === null || parsed === undefined) {
    return {};
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid config ${path}: expected a mapping`);
  }

  return parsed as Record<string, unknown>;
}

function stringifyMapping(record: Record<string, unknown>): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(record)) {
    lines.push(`${key}: ${formatYamlScalar(value)}`);
  }

  return `${lines.join('\n')}\n`;
}

function formatYamlScalar(value: unknown): string {
  if (typeof value === 'string') {
    return quoteYamlString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value === null || value === undefined) {
    return 'null';
  }

  return JSON.stringify(value);
}

function quoteYamlString(value: string): string {
  if (
    value === '' ||
    value === 'true' ||
    value === 'false' ||
    value === 'null' ||
    /[:#\n&*!%@`|>'"{}[\],]|^\s|\s$/.test(value)
  ) {
    return JSON.stringify(value);
  }

  return value;
}

function normalizeConfig(raw: Record<string, unknown>, path: string): CliConfig {
  const config: CliConfig = {};
  const crux = mappingGet(raw, 'crux_api_key');

  if (crux) {
    config.cruxApiKey = crux;
  }

  const output = mappingGet(raw, 'output');

  if (output) {
    config.output = requireOutput(
      output,
      `Invalid output in ${path}: must be table, json, html, or markdown`,
    );
  }

  const maxBodyBytes = mappingGet(raw, 'max_body_bytes');

  if (maxBodyBytes) {
    try {
      config.maxBodyBytes = parseMaxBodyBytes(maxBodyBytes);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      throw new Error(`Invalid max_body_bytes in ${path}: ${message}`, { cause: err });
    }
  }

  return config;
}

function requireOutput(raw: string, message: string): OutputFormat {
  try {
    return parseOutFormat(raw, false);
  } catch {
    throw new Error(message);
  }
}
