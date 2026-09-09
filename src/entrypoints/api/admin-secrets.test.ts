/**
 * Unit tests for `/admin/secrets`: patch parsing, loopback auth, and the HTTP
 * surface on the existing webhook server. Loopback only; no network services.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProjectPolicy } from '../../core/policy/types.ts';
import { isLoopbackAddress, parseSecretPatch } from './admin-secrets.ts';
import { createWebhookServer } from './server.ts';
import type { AdminSecretsSurface } from './admin-secrets.ts';
import type { RotatableKey, SecretPatch, SecretPresence } from '../../config/runtime-secrets.ts';

function testPolicy(): ProjectPolicy {
  return {
    reviewOn: { open: true, ready: true, push: false, reopen: true, manual: true },
    strictness: 'balanced',
    ignoredGlobs: [],
    contextBudget: { maxChunkTokens: 60_000, estimate: 'bytes' },
    decomposition: { mode: 'single' },
    model: 'cursor-grok-4.6[fast=true]',
  };
}

function memorySecrets(initial?: Partial<SecretPresence>): AdminSecretsSurface & {
  applied: SecretPatch[];
  reloads: number;
} {
  const presence: SecretPresence = {
    CURSOR_API_KEY: 'set',
    GITLAB_TOKEN: 'set',
    KAITEN_TOKEN: 'set',
    ...initial,
  };
  const applied: SecretPatch[] = [];
  return {
    applied,
    reloads: 0,
    status: () => ({ ...presence }),
    apply: (patch) => {
      applied.push(patch);
      return Promise.resolve(Object.keys(patch) as RotatableKey[]);
    },
    reload: function reload() {
      this.reloads += 1;
      return Promise.resolve(['CURSOR_API_KEY'] as RotatableKey[]);
    },
  };
}

async function listen(
  secrets?: AdminSecretsSurface,
  adminToken?: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createWebhookServer({
    secret: '',
    policyFor: () => testPolicy(),
    enqueue: () => {},
    ...(secrets !== undefined ? { secrets } : {}),
    ...(adminToken !== undefined ? { adminToken } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  return {
    port: addr.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

void test('parseSecretPatch accepts a partial rotatable object', () => {
  const parsed = parseSecretPatch({ CURSOR_API_KEY: '  abc  ' });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.patch, { CURSOR_API_KEY: 'abc' });
  }
});

void test('parseSecretPatch accepts a Cursor key array', () => {
  const parsed = parseSecretPatch({ CURSOR_API_KEY: [' key_a ', 'key_b'] });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.patch, { CURSOR_API_KEY: 'key_a,key_b' });
  }
});

void test('parseSecretPatch rejects unknown or empty keys', () => {
  assert.equal(parseSecretPatch({ DATABASE_URL: 'x' }).ok, false);
  assert.equal(parseSecretPatch({ CURSOR_API_KEY: '   ' }).ok, false);
  assert.equal(parseSecretPatch({}).ok, false);
});

void test('isLoopbackAddress accepts ipv4, ipv6, and ipv4-mapped', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('10.0.0.8'), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

void test('GET /admin/secrets returns presence and never values', async () => {
  const secrets = memorySecrets();
  const { port, close } = await listen(secrets);
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/admin/secrets`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, string>;
    assert.deepEqual(body, {
      CURSOR_API_KEY: 'set',
      GITLAB_TOKEN: 'set',
      KAITEN_TOKEN: 'set',
    });
    assert.equal(JSON.stringify(body).includes('secret'), false);
  } finally {
    await close();
  }
});

void test('PUT /admin/secrets applies a Cursor key from loopback without admin token', async () => {
  const secrets = memorySecrets();
  const { port, close } = await listen(secrets);
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/admin/secrets`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ CURSOR_API_KEY: 'key_live' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { updated: ['CURSOR_API_KEY'] });
    assert.deepEqual(secrets.applied, [{ CURSOR_API_KEY: 'key_live' }]);
  } finally {
    await close();
  }
});

void test('PUT /admin/secrets requires the admin token when configured', async () => {
  const secrets = memorySecrets();
  const { port, close } = await listen(secrets, 'admin-secret');
  try {
    const denied = await fetch(`http://127.0.0.1:${String(port)}/admin/secrets`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ CURSOR_API_KEY: 'nope' }),
    });
    assert.equal(denied.status, 401);

    const ok = await fetch(`http://127.0.0.1:${String(port)}/admin/secrets`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer admin-secret',
      },
      body: JSON.stringify({ GITLAB_TOKEN: 'gl' }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { updated: ['GITLAB_TOKEN'] });
  } finally {
    await close();
  }
});

void test('POST /admin/secrets/reload re-reads the env file', async () => {
  const secrets = memorySecrets();
  const { port, close } = await listen(secrets);
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/admin/secrets/reload`, {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { updated: ['CURSOR_API_KEY'] });
    assert.equal(secrets.reloads, 1);
  } finally {
    await close();
  }
});

void test('GET /admin/secrets is 404 when the handler is not wired', async () => {
  const { port, close } = await listen();
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/admin/secrets`);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});
