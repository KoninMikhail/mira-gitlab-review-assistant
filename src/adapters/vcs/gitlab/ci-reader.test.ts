/**
 * Unit tests for GitLabCiReader. Fake fetch — no network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { GitLabCiReader } from './index.ts';

const BASE = 'https://gitlab.example.com';
const TOKEN = 'test-token';

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

void test('getPresenceSnapshot: description + newest SHA pipeline jobs; skips other SHAs', async () => {
  const fakeFetch: typeof fetch = (input) => {
    const url = urlOf(input);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/merge_requests/7') && !parsed.pathname.includes('/pipelines')) {
      return Promise.resolve(jsonResponse({ description: 'See /cards/99' }));
    }
    if (parsed.pathname.endsWith('/merge_requests/7/pipelines')) {
      return Promise.resolve(
        jsonResponse([
          { id: 10, sha: 'old-sha' },
          { id: 11, sha: 'head-sha' },
          { id: 12, sha: 'head-sha' },
        ]),
      );
    }
    if (parsed.pathname.endsWith('/pipelines/12/jobs')) {
      return Promise.resolve(
        jsonResponse([
          {
            id: 1,
            name: 'test',
            status: 'success',
            when: 'on_success',
            allow_failure: false,
          },
          {
            id: 2,
            name: 'deploy',
            status: 'manual',
            when: 'manual',
            allow_failure: true,
          },
        ]),
      );
    }
    return Promise.reject(new Error(`unexpected url: ${url}`));
  };

  const reader = GitLabCiReader.fromConfig(
    { baseUrl: BASE, token: TOKEN },
    { fetch: fakeFetch, perPage: 50 },
  );
  const snap = await reader.getPresenceSnapshot('group/app', 7, 'head-sha');

  assert.equal(snap.description, 'See /cards/99');
  assert.equal(snap.jobs.length, 2);
  assert.deepEqual(snap.jobs[0], {
    id: 1,
    name: 'test',
    status: 'success',
    when: 'on_success',
    allowFailure: false,
  });
  assert.deepEqual(snap.jobs[1], {
    id: 2,
    name: 'deploy',
    status: 'manual',
    when: 'manual',
    allowFailure: true,
  });
});

void test('getPresenceSnapshot: no matching pipeline → empty jobs', async () => {
  const fakeFetch: typeof fetch = (input) => {
    const url = urlOf(input);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/merge_requests/3') && !parsed.pathname.includes('/pipelines')) {
      return Promise.resolve(jsonResponse({ description: null }));
    }
    if (parsed.pathname.endsWith('/merge_requests/3/pipelines')) {
      return Promise.resolve(jsonResponse([{ id: 1, sha: 'other' }]));
    }
    return Promise.reject(new Error(`unexpected url: ${url}`));
  };

  const reader = GitLabCiReader.fromConfig(
    { baseUrl: BASE, token: TOKEN },
    { fetch: fakeFetch },
  );
  const snap = await reader.getPresenceSnapshot('group/app', 3, 'head-sha');
  assert.equal(snap.description, '');
  assert.deepEqual(snap.jobs, []);
});

void test('getJobTrace: fetches plain-text job log', async () => {
  const fakeFetch: typeof fetch = (input) => {
    const url = urlOf(input);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/jobs/42/trace')) {
      return Promise.resolve(new Response('FAIL boom', { status: 200, headers: { 'content-type': 'text/plain' } }));
    }
    return Promise.reject(new Error(`unexpected url: ${url}`));
  };

  const reader = GitLabCiReader.fromConfig(
    { baseUrl: BASE, token: TOKEN },
    { fetch: fakeFetch },
  );
  const trace = await reader.getJobTrace('group/app', 42);
  assert.equal(trace, 'FAIL boom');
});
