/**
 * Typed configuration loaded from the environment. Validation happens at
 * startup so a bad config fails early rather than surprising us at runtime.
 */
import { parseCursorApiKeys } from './cursor-keys.ts';

export interface MiraConfig {
  cursor: {
    apiKey: string;
  };
  gitlab: {
    baseUrl: string;
    token: string;
    /** Shared secret for the `X-Gitlab-Token` webhook header. Empty = unverified. */
    webhookSecret: string;
  };
  kaiten: {
    baseUrl: string;
    token: string;
  };
}

class ConfigError extends Error {}

function required(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Loads config from `process.env`. Throws `ConfigError` listing the first
 * missing variable. Optional sections (e.g. for PoC subsets) can be loaded
 * lazily by callers that only need part of the config.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): MiraConfig {
  const cursorRaw = required('CURSOR_API_KEY', env['CURSOR_API_KEY']);
  if (parseCursorApiKeys(cursorRaw).length === 0) {
    throw new ConfigError('CURSOR_API_KEY has no usable keys');
  }
  return {
    cursor: {
      apiKey: cursorRaw,
    },
    gitlab: {
      baseUrl: required('GITLAB_BASE_URL', env['GITLAB_BASE_URL']),
      token: required('GITLAB_TOKEN', env['GITLAB_TOKEN']),
      webhookSecret: env['GITLAB_WEBHOOK_SECRET'] ?? '',
    },
    kaiten: {
      baseUrl: required('KAITEN_BASE_URL', env['KAITEN_BASE_URL']),
      token: required('KAITEN_TOKEN', env['KAITEN_TOKEN']),
    },
  };
}

export { ConfigError };
export { parsePolicyConfig, loadPolicyConfigFile, PolicyConfigError } from './policy-config.ts';
export { loadProfiles, assertProfilesResolvable, ProfileError } from './profiles.ts';
export type { ProfileSet } from './profiles.ts';
export type { PolicyConfig, ProjectPolicy } from '../core/policy/index.ts';
export { applyEnvFileIfPresent, parseEnvFile, upsertEnvFile } from './env-file.ts';
export { parseCursorApiKeys, serializeCursorApiKeys } from './cursor-keys.ts';
export { ROTATABLE_KEYS, SecretRuntime, isRotatableKey } from './runtime-secrets.ts';
export type {
  RotatableKey,
  SecretPatch,
  SecretPresence,
  SecretRuntimeHooks,
} from './runtime-secrets.ts';
