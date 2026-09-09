/**
 * Unit tests for the `.env` parser and upsert. Temp files only; no network.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyEnvFileIfPresent, parseEnvFile, upsertEnvFile } from './env-file.ts';

void test('parseEnvFile skips comments and unquotes values', () => {
  const parsed = parseEnvFile(
    [
      '# heading',
      'CURSOR_API_KEY=plain',
      'GITLAB_TOKEN="quoted value"',
      "KAITEN_TOKEN='single'",
      'export GITLAB_BASE_URL=https://gitlab.example.com',
      'EMPTY=',
      'WITH_COMMENT=foo # note',
      '',
    ].join('\n'),
  );

  assert.equal(parsed['CURSOR_API_KEY'], 'plain');
  assert.equal(parsed['GITLAB_TOKEN'], 'quoted value');
  assert.equal(parsed['KAITEN_TOKEN'], 'single');
  assert.equal(parsed['GITLAB_BASE_URL'], 'https://gitlab.example.com');
  assert.equal(parsed['EMPTY'], '');
  assert.equal(parsed['WITH_COMMENT'], 'foo');
});

void test('applyEnvFileIfPresent fills missing keys and does not override set ones', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mira-env-'));
  try {
    const file = path.join(dir, '.env');
    writeFileSync(file, 'CURSOR_API_KEY=from-file\nGITLAB_TOKEN=file-token\n', 'utf8');
    const env: NodeJS.ProcessEnv = { CURSOR_API_KEY: 'already' };
    assert.equal(applyEnvFileIfPresent(file, env), true);
    assert.equal(env['CURSOR_API_KEY'], 'already');
    assert.equal(env['GITLAB_TOKEN'], 'file-token');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('applyEnvFileIfPresent no-ops when the file is missing', () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(applyEnvFileIfPresent(path.join(tmpdir(), 'mira-missing-env-nope'), env), false);
  assert.deepEqual(env, {});
});

void test('upsertEnvFile replaces existing keys and appends new ones', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mira-env-'));
  try {
    const file = path.join(dir, '.env');
    writeFileSync(file, '# keep me\nCURSOR_API_KEY=old\nGITLAB_BASE_URL=https://x\n', 'utf8');
    await upsertEnvFile(file, { CURSOR_API_KEY: 'new-key', GITLAB_TOKEN: 'tok' });
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^# keep me$/m);
    assert.match(text, /^CURSOR_API_KEY=new-key$/m);
    assert.match(text, /^GITLAB_BASE_URL=https:\/\/x$/m);
    assert.match(text, /^GITLAB_TOKEN=tok$/m);
    assert.equal(parseEnvFile(text)['CURSOR_API_KEY'], 'new-key');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
