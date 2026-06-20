/**
 * Typed configuration loaded from the environment. Validation happens at
 * startup so a bad config fails early rather than surprising us at runtime.
 */

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
  return {
    cursor: {
      apiKey: required('CURSOR_API_KEY', env['CURSOR_API_KEY']),
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
