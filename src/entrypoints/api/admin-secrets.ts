/**
 * Admin HTTP helpers for live token rotation. Transport stays in {@link ./server.ts}.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import {
  isRotatableKey,
  type RotatableKey,
  type SecretPatch,
  type SecretPresence,
} from '../../config/runtime-secrets.ts';

export interface AdminSecretsSurface {
  apply(patch: SecretPatch): Promise<RotatableKey[]>;
  status(): SecretPresence;
  reload(): Promise<RotatableKey[]>;
}

export function isAdminSecretsPath(url: string | undefined): boolean {
  if (url === undefined) {
    return false;
  }
  const path = url.split('?')[0];
  return path === '/admin/secrets' || path === '/admin/secrets/reload';
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined || address === '') {
    return false;
  }
  const host = address.replace(/^::ffff:/i, '');
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export function authorizeAdmin(req: IncomingMessage, adminToken: string): boolean {
  const expected = adminToken.trim();
  if (expected !== '') {
    const given = adminTokenFromRequest(req);
    return given !== undefined && secretsEqual(given, expected);
  }
  return isLoopbackAddress(req.socket.remoteAddress);
}

export function parseSecretPatch(
  body: unknown,
): { ok: true; patch: SecretPatch } | { ok: false; error: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'JSON object expected' };
  }
  const record = body as Record<string, unknown>;
  const patch: SecretPatch = {};
  for (const [key, value] of Object.entries(record)) {
    if (!isRotatableKey(key)) {
      return { ok: false, error: `unknown key: ${key}` };
    }
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, error: `${key} must be a non-empty string` };
    }
    patch[key] = value.trim();
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'no rotatable keys in body' };
  }
  return { ok: true, patch };
}

export async function dispatchAdminSecrets(
  method: string,
  url: string,
  rawBody: Buffer | undefined,
  secrets: AdminSecretsSurface,
): Promise<{ status: number; json?: Record<string, unknown> }> {
  const path = url.split('?')[0] ?? url;

  if (method === 'GET' && path === '/admin/secrets') {
    return { status: 200, json: { ...secrets.status() } };
  }

  if (method === 'PUT' && path === '/admin/secrets') {
    let payload: unknown;
    try {
      payload = JSON.parse((rawBody ?? Buffer.alloc(0)).toString('utf8')) as unknown;
    } catch {
      return { status: 400, json: { error: 'invalid JSON' } };
    }
    const parsed = parseSecretPatch(payload);
    if (!parsed.ok) {
      return { status: 400, json: { error: parsed.error } };
    }
    const updated = await secrets.apply(parsed.patch);
    return { status: 200, json: { updated } };
  }

  if (method === 'POST' && path === '/admin/secrets/reload') {
    const updated = await secrets.reload();
    return { status: 200, json: { updated } };
  }

  return { status: 404 };
}

function adminTokenFromRequest(req: IncomingMessage): string | undefined {
  const dedicated = headerValue(req.headers['x-mira-admin-token']);
  if (dedicated !== undefined && dedicated !== '') {
    return dedicated;
  }
  const authorization = headerValue(req.headers.authorization);
  if (authorization === undefined) {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)/i.exec(authorization);
  return match?.[1];
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function secretsEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
