// ---- Configuration and secrets, server-side only ----
//
// The trust boundary of the whole tool lives in this file. Environments, auth
// schemes and secret values are read here, in the node process, and never sent
// to the browser: the client is told the *names* of the schemes and secrets so
// it can offer them in a dropdown, and nothing else.

import {readFileSync, existsSync} from 'node:fs';
import path from 'node:path';
import type {AuthScheme, EnvironmentConfig} from '../src/core/types';

export interface ServerConfig {
  environments: EnvironmentConfig[];
  auth: Record<string, AuthScheme>;
  secrets: Record<string, string>;
}

/** What the browser is allowed to know: names, never values. */
export interface PublicConfig {
  environments: {name: string; baseUrl: string}[];
  authSchemes: string[];
  secretNames: string[];
}

const FILES = ['journey.config.local.json', 'journey.config.json'];

const DEFAULT_CONFIG: ServerConfig = {
  environments: [{name: 'local', baseUrl: 'http://localhost:3000'}],
  auth: {},
  secrets: {},
};

/** `${env:NAME}` anywhere in a config string is replaced from the environment. */
function expand(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{env:([A-Za-z0-9_]+)\}/g, (_m, name: string) => process.env[name] ?? '');
  }
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expand(v);
    return out;
  }
  return value;
}

let cached: ServerConfig | undefined;

export function loadConfig(root = process.cwd()): ServerConfig {
  if (cached) return cached;

  let raw: Record<string, unknown> = {};
  for (const name of FILES) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
      break;
    } catch (err) {
      // A broken config should say so loudly at boot, not produce confusing
      // 404s later when every request goes to the wrong base URL.
      throw new Error(`${name} is not valid JSON: ${(err as Error).message}`);
    }
  }

  const expanded = expand(raw) as Partial<ServerConfig>;

  // Any JOURNEY_SECRET_FOO env var becomes the secret `foo`, so a secret never
  // has to be written into a file at all.
  const fromEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('JOURNEY_SECRET_') && value) {
      fromEnv[key.slice('JOURNEY_SECRET_'.length).toLowerCase()] = value;
    }
  }

  cached = {
    environments: expanded.environments?.length ? expanded.environments : DEFAULT_CONFIG.environments,
    auth: expanded.auth ?? {},
    secrets: {...(expanded.secrets ?? {}), ...fromEnv},
  };
  return cached;
}

export function publicConfig(config: ServerConfig): PublicConfig {
  return {
    environments: config.environments.map((e) => ({name: e.name, baseUrl: e.baseUrl})),
    authSchemes: Object.keys(config.auth),
    secretNames: Object.keys(config.secrets),
  };
}

/** Test seam — configuration is cached for the life of the process otherwise. */
export function resetConfig(): void {
  cached = undefined;
}
