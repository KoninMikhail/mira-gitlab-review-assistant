/**
 * Unit tests for live secret rotation. In-memory config only; file persist is
 * covered by env-file tests.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SecretRuntime } from './runtime-secrets.ts';

function sampleConfig() {
  return {
    cursor: { apiKey: 'cursor-old' },
    gitlab: { token: 'gitlab-old' },
    kaiten: { token: 'kaiten-old' },
  };
}

void test('apply mutates config, env, hooks and persists the file', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mira-secrets-'));
  try {
    const file = path.join(dir, '.env');
    writeFileSync(file, 'CURSOR_API_KEY=cursor-old\n', 'utf8');
    const config = sampleConfig();
    const env: NodeJS.ProcessEnv = {};
    const gitlab: string[] = [];
    const kaiten: string[] = [];
    const runtime = new SecretRuntime({
      config,
      envFilePath: file,
      env,
      hooks: {
        onGitlabToken: (token) => gitlab.push(token),
        onKaitenToken: (token) => kaiten.push(token),
      },
    });

    const updated = await runtime.apply({
      CURSOR_API_KEY: 'cursor-new',
      GITLAB_TOKEN: 'gitlab-new',
      KAITEN_TOKEN: 'kaiten-new',
    });

    assert.deepEqual(updated, ['CURSOR_API_KEY', 'GITLAB_TOKEN', 'KAITEN_TOKEN']);
    assert.equal(config.cursor.apiKey, 'cursor-new');
    assert.equal(config.gitlab.token, 'gitlab-new');
    assert.equal(config.kaiten.token, 'kaiten-new');
    assert.equal(env['CURSOR_API_KEY'], 'cursor-new');
    assert.deepEqual(gitlab, ['gitlab-new']);
    assert.deepEqual(kaiten, ['kaiten-new']);
    const onDisk = readFileSync(file, 'utf8');
    assert.match(onDisk, /CURSOR_API_KEY=cursor-new/);
    assert.match(onDisk, /GITLAB_TOKEN=gitlab-new/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('reload overrides in-memory keys from the env file', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mira-secrets-'));
  try {
    const file = path.join(dir, '.env');
    writeFileSync(file, 'CURSOR_API_KEY=from-disk\nGITLAB_TOKEN=gl-disk\n', 'utf8');
    const config = sampleConfig();
    const runtime = new SecretRuntime({ config, envFilePath: file, env: {} });
    const updated = await runtime.reload();
    assert.deepEqual(updated, ['CURSOR_API_KEY', 'GITLAB_TOKEN']);
    assert.equal(config.cursor.apiKey, 'from-disk');
    assert.equal(config.gitlab.token, 'gl-disk');
    assert.equal(config.kaiten.token, 'kaiten-old');
    assert.deepEqual(runtime.status(), {
      CURSOR_API_KEY: 'set',
      GITLAB_TOKEN: 'set',
      KAITEN_TOKEN: 'set',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('apply skips persistence when envFilePath is empty', async () => {
  const config = sampleConfig();
  const runtime = new SecretRuntime({ config, envFilePath: '', env: {} });
  const updated = await runtime.apply({ CURSOR_API_KEY: 'only-memory' });
  assert.deepEqual(updated, ['CURSOR_API_KEY']);
  assert.equal(config.cursor.apiKey, 'only-memory');
});
