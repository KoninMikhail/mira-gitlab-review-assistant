/**
 * Live rotation of integration tokens without a process restart. Mutates the
 * in-memory {@link MiraConfig}, `process.env`, adapter hooks, and optionally
 * the `.env` file on disk.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { parseEnvFile, upsertEnvFile } from './env-file.ts';

/** Slice of {@link MiraConfig} that live rotation mutates. */
export interface RotatableConfig {
  cursor: { apiKey: string };
  gitlab: { token: string };
  kaiten: { token: string };
}

export const ROTATABLE_KEYS = ['CURSOR_API_KEY', 'GITLAB_TOKEN', 'KAITEN_TOKEN'] as const;
export type RotatableKey = (typeof ROTATABLE_KEYS)[number];
export type SecretPatch = Partial<Record<RotatableKey, string>>;
export type SecretPresence = Record<RotatableKey, 'set' | 'missing'>;

export interface SecretRuntimeHooks {
  onGitlabToken?: (token: string) => void;
  onKaitenToken?: (token: string) => void;
}

export interface SecretRuntimeOptions {
  config: RotatableConfig;
  /** Empty string disables persistence. Default `.env`. */
  envFilePath: string;
  env?: NodeJS.ProcessEnv;
  hooks?: SecretRuntimeHooks;
}

const KEY_SET = new Set<string>(ROTATABLE_KEYS);

export function isRotatableKey(name: string): name is RotatableKey {
  return KEY_SET.has(name);
}

export class SecretRuntime {
  readonly #config: RotatableConfig;
  readonly #envFilePath: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #hooks: SecretRuntimeHooks;

  constructor(options: SecretRuntimeOptions) {
    this.#config = options.config;
    this.#envFilePath = options.envFilePath;
    this.#env = options.env ?? process.env;
    this.#hooks = options.hooks ?? {};
  }

  status(): SecretPresence {
    return {
      CURSOR_API_KEY: presence(this.#config.cursor.apiKey),
      GITLAB_TOKEN: presence(this.#config.gitlab.token),
      KAITEN_TOKEN: presence(this.#config.kaiten.token),
    };
  }

  async apply(patch: SecretPatch): Promise<RotatableKey[]> {
    const updated = this.#applyInMemory(patch);
    if (updated.length > 0 && this.#envFilePath.trim() !== '') {
      const persist: Record<string, string> = {};
      for (const key of updated) {
        persist[key] = patch[key] ?? '';
      }
      await upsertEnvFile(this.#envFilePath, persist);
    }
    return updated;
  }

  async reload(): Promise<RotatableKey[]> {
    if (this.#envFilePath.trim() === '' || !existsSync(this.#envFilePath)) {
      return [];
    }
    const parsed = parseEnvFile(await readFile(this.#envFilePath, 'utf8'));
    const patch: SecretPatch = {};
    for (const key of ROTATABLE_KEYS) {
      const value = parsed[key]?.trim();
      if (value !== undefined && value !== '') {
        patch[key] = value;
      }
    }
    return this.#applyInMemory(patch);
  }

  #applyInMemory(patch: SecretPatch): RotatableKey[] {
    const updated: RotatableKey[] = [];

    const cursor = patch.CURSOR_API_KEY?.trim();
    if (cursor !== undefined && cursor !== '') {
      this.#config.cursor.apiKey = cursor;
      this.#env['CURSOR_API_KEY'] = cursor;
      updated.push('CURSOR_API_KEY');
    }

    const gitlab = patch.GITLAB_TOKEN?.trim();
    if (gitlab !== undefined && gitlab !== '') {
      this.#config.gitlab.token = gitlab;
      this.#env['GITLAB_TOKEN'] = gitlab;
      this.#hooks.onGitlabToken?.(gitlab);
      updated.push('GITLAB_TOKEN');
    }

    const kaiten = patch.KAITEN_TOKEN?.trim();
    if (kaiten !== undefined && kaiten !== '') {
      this.#config.kaiten.token = kaiten;
      this.#env['KAITEN_TOKEN'] = kaiten;
      this.#hooks.onKaitenToken?.(kaiten);
      updated.push('KAITEN_TOKEN');
    }

    return updated;
  }
}

function presence(value: string): 'set' | 'missing' {
  return value.trim() === '' ? 'missing' : 'set';
}
