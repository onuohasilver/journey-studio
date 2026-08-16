// ---- Configuration and secrets, server-side only ----
//
// The trust boundary of the whole tool lives in this file. Environments, auth
// schemes and secret values are read here, in the node process, and never sent
// to the browser: the client is told the *names* of the schemes and secrets so
// it can offer them in a dropdown, and nothing else.

import {readFileSync, existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import type {AuthScheme, EnvironmentConfig} from '../src/core/types';

export type OAuth2Scheme = Extract<AuthScheme, {type: 'oauth2'}>;

export interface SlackConfig {
  /** Incoming webhook URL. This *is* the credential — it never leaves this side. */
  webhookUrl?: string;
  /** Prefix for the message headline, e.g. the service name. */
  title?: string;
}

/** Where run metrics go, if anywhere. */
export interface TelemetryConfig {
  /** OTLP HTTP base, e.g. http://localhost:4318. */
  endpoint?: string;
  headers?: Record<string, string>;
  serviceName?: string;
}

export interface ServerConfig {
  environments: EnvironmentConfig[];
  auth: Record<string, AuthScheme>;
  secrets: Record<string, string>;
  slack?: SlackConfig;
  telemetry?: TelemetryConfig;
  issues?: import('../src/core/issues').IssueConfig;
}

/** What the browser is allowed to know: names, never values. */
export interface PublicConfig {
  environments: {name: string; baseUrl: string}[];
  /** Names and kinds, so the UI can say which schemes need a token fetched. */
  authSchemes: {name: string; type: AuthScheme['type']}[];
  secretNames: string[];
  /** Whether a report can be posted — never the webhook itself. */
  slackConfigured: boolean;
}

const FILES = ['journey.config.local.json', 'journey.config.json'];

const DEFAULT_CONFIG: ServerConfig = {
  environments: [{name: 'local', baseUrl: 'http://localhost:3000'}],
  auth: {},
  secrets: {},
};

/**
 * Where a config value can come from.
 *
 * The point of the non-`env` ones is that a team stops copying credentials into
 * files at all: the value lives in the vault it already lives in, and the config
 * says where to find it.
 *
 *   ${env:NAME}                    an environment variable
 *   ${file:./secrets/token}        the contents of a file, trimmed
 *   ${op://Vault/Item/field}       1Password, via its CLI
 */
export type Resolver = (reference: string) => string | undefined;

/** Reads a file relative to the config, so a path in it means what it says. */
function fileResolver(root: string): Resolver {
  return (reference) => {
    const target = path.resolve(root, reference);
    if (!existsSync(target)) return undefined;
    return readFileSync(target, 'utf8').trim();
  };
}

/**
 * 1Password, through the CLI the user has already signed into.
 *
 * Shelling out is the supported integration path — `op read` takes a reference
 * and nothing else, so no part of the config becomes a command to run.
 */
function onePasswordResolver(): Resolver {
  return (reference) => {
    try {
      return execFileSync('op', ['read', `op://${reference}`], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
    } catch {
      return undefined;
    }
  };
}

/**
 * Substitute every reference in a config.
 *
 * An unresolved reference is **left in place**, not blanked. This is the same
 * choice the template engine makes, for the same reason: a request that fails
 * carrying a literal `${env:API_TOKEN}` says exactly what is wrong, and one that
 * fails carrying an empty header looks like the API rejecting you. Silently
 * substituting nothing for a missing secret is how an afternoon disappears.
 */
export function expandConfig(
  value: unknown,
  resolvers: Record<string, Resolver>,
  missing: string[] = [],
): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([a-z0-9_]+):(\/\/)?([^}]+)\}/gi, (whole, scheme: string, slashes: string | undefined, rest: string) => {
      const resolve = resolvers[scheme.toLowerCase()];
      if (!resolve) return whole;
      const resolved = resolve(slashes ? rest : rest);
      if (resolved === undefined || resolved === '') {
        missing.push(whole);
        return whole;
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) return value.map((v) => expandConfig(v, resolvers, missing));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandConfig(v, resolvers, missing);
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

  const missing: string[] = [];
  const expanded = expandConfig(
    raw,
    {
      env: (name) => process.env[name],
      file: fileResolver(root),
      op: onePasswordResolver(),
    },
    missing,
  ) as Partial<ServerConfig>;

  if (missing.length) {
    // Loud, once, at load. The alternative is a 401 an hour later that looks
    // like the API's fault.
    process.stderr.write(
      `! Could not resolve ${[...new Set(missing)].join(', ')} — left as written, so the failure will say so.\n`,
    );
  }

  // Any JOURNEY_SECRET_FOO env var becomes the secret `foo`, so a secret never
  // has to be written into a file at all.
  const fromEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('JOURNEY_SECRET_') && value) {
      fromEnv[key.slice('JOURNEY_SECRET_'.length).toLowerCase()] = value;
    }
  }

  const slack: ServerConfig['slack'] = {
    ...expanded.slack,
    webhookUrl: expanded.slack?.webhookUrl || process.env.SLACK_WEBHOOK_URL || undefined,
  };

  const telemetry: TelemetryConfig = {
    ...expanded.telemetry,
    endpoint: expanded.telemetry?.endpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
  };

  cached = {
    environments: expanded.environments?.length ? expanded.environments : DEFAULT_CONFIG.environments,
    auth: expanded.auth ?? {},
    secrets: {...(expanded.secrets ?? {}), ...fromEnv},
    ...(slack.webhookUrl || slack.title ? {slack} : {}),
    ...(telemetry.endpoint ? {telemetry} : {}),
    ...(expanded.issues?.repo
      ? {issues: {...expanded.issues, token: expanded.issues.token || process.env.GITHUB_TOKEN || ''}}
      : {}),
  };
  return cached;
}

export function publicConfig(config: ServerConfig): PublicConfig {
  return {
    environments: config.environments.map((e) => ({name: e.name, baseUrl: e.baseUrl})),
    authSchemes: Object.entries(config.auth).map(([name, scheme]) => ({name, type: scheme.type})),
    secretNames: Object.keys(config.secrets),
    slackConfigured: Boolean(config.slack?.webhookUrl),
  };
}

/** Test seam — configuration is cached for the life of the process otherwise. */
export function resetConfig(): void {
  cached = undefined;
}
