/**
 * Unit tests for the GitLab write adapter. A fake `fetch` is injected so there
 * are NO network calls: we verify URL construction, headers, JSON bodies,
 * pagination mapping, and rate-limit retry behaviour.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { GitLabClient, GitLabWriter } from './index.ts';

const BASE = 'https://gitlab.example.com';
const TOKEN = 'test-token';

interface RecordedCall {
  url: string;
  method: string;
  token: string | null;
  contentType: string | null;
  body: string | undefined;
}

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

function makeRecorder(handler: (call: RecordedCall, url: URL) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    const url = new URL(urlOf(input));
    const call: RecordedCall = {
      url: url.href,
      method: init?.method ?? 'GET',
      token: new Headers(init?.headers).get('PRIVATE-TOKEN'),
      contentType: new Headers(init?.headers).get('Content-Type'),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return Promise.resolve(handler(call, url));
  };
  return { fetch: fakeFetch, calls };
}

void test('createNote POSTs to the right URL with token and JSON body', async () => {
  const { fetch, calls } = makeRecorder((_call, url) => {
    assert.ok(url.pathname.endsWith('/merge_requests/7/notes'));
    return jsonResponse({
      id: 101,
      body: 'Hello MR',
      author: { username: 'bot-user' },
      system: false,
    });
  });

  const writer = GitLabWriter.fromConfig(
    { baseUrl: BASE, token: TOKEN },
    { fetch, sleep: async () => {} },
  );

  const note = await writer.createNote('group/sub/proj', 7, 'Hello MR');

  assert.equal(note.id, 101);
  assert.equal(note.body, 'Hello MR');
  assert.equal(note.author, 'bot-user');
  assert.equal(note.system, false);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.token, TOKEN);
  assert.equal(calls[0]?.contentType, 'application/json');
  assert.deepEqual(JSON.parse(calls[0]?.body ?? ''), { body: 'Hello MR' });
  assert.ok(calls[0]?.url.includes('projects/group%2Fsub%2Fproj/'));
});

void test('updateNote PUTs to the right URL and body', async () => {
  const { fetch, calls } = makeRecorder((_call, url) => {
    assert.ok(url.pathname.endsWith('/merge_requests/3/notes/55'));
    return jsonResponse({ id: 55, body: 'Updated text', system: false });
  });

  const writer = GitLabWriter.fromConfig(
    { baseUrl: BASE, token: TOKEN },
    { fetch, sleep: async () => {} },
  );

  const note = await writer.updateNote('42', 3, 55, 'Updated text');

  assert.equal(note.id, 55);
  assert.equal(note.body, 'Updated text');

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'PUT');
  assert.equal(calls[0]?.token, TOKEN);
  assert.deepEqual(JSON.parse(calls[0]?.body ?? ''), { body: 'Updated text' });
});

void test('listNotes paginates and maps notes', async () => {
  const page1 = [{ id: 1, body: 'first', system: false }];
  const page2 = [{ id: 2, body: 'second', author: { username: 'dev' }, system: true }];

  const { fetch, calls } = makeRecorder((_call, url) => {
    if (url.searchParams.get('page') === '1') {
      return jsonResponse(page1, { 'x-next-page': '2' });
    }
    return jsonResponse(page2, { 'x-next-page': '' });
  });

  const writer = GitLabWriter.fromConfig(
    { baseUrl: BASE, token: TOKEN },
    { fetch, perPage: 1, sleep: async () => {} },
  );

  const notes = await writer.listNotes('group/sub/proj', 9);

  assert.equal(notes.length, 2);
  assert.equal(notes[0]?.id, 1);
  assert.equal(notes[0]?.author, undefined);
  assert.equal(notes[1]?.author, 'dev');
  assert.equal(notes[1]?.system, true);

  const noteCalls = calls.filter((c) => c.url.includes('/notes'));
  assert.equal(noteCalls.length, 2);
  assert.ok(noteCalls.every((c) => c.url.includes('projects/group%2Fsub%2Fproj/')));
  assert.ok(noteCalls.every((c) => c.method === 'GET'));
});

void test('listDiscussions paginates and derives resolved from resolvable notes', async () => {
  const page1 = [
    {
      id: 'disc-a',
      individual_note: false,
      notes: [
        { id: 10, body: 'thread', resolvable: true, resolved: true, system: false },
        { id: 11, body: 'reply', resolvable: true, resolved: true, system: false },
      ],
    },
  ];
  const page2 = [
    {
      id: 'disc-b',
      individual_note: true,
      notes: [{ id: 20, body: 'solo', resolvable: false, system: false }],
    },
    {
      id: 'disc-c',
      individual_note: false,
      notes: [
        { id: 30, body: 'open', resolvable: true, resolved: false, system: false },
        { id: 31, body: 'meta', resolvable: false, system: true },
      ],
    },
  ];

  const { fetch } = makeRecorder((_call, url) => {
    if (url.searchParams.get('page') === '1') {
      return jsonResponse(page1, { 'x-next-page': '2' });
    }
    return jsonResponse(page2, { 'x-next-page': '' });
  });

  const writer = GitLabWriter.fromConfig(
    { baseUrl: BASE, token: TOKEN },
    { fetch, perPage: 1, sleep: async () => {} },
  );

  const discussions = await writer.listDiscussions('group/sub/proj', 5);

  assert.equal(discussions.length, 3);

  assert.equal(discussions[0]?.id, 'disc-a');
  assert.equal(discussions[0]?.resolved, true);
  assert.equal(discussions[0]?.individualNote, false);

  assert.equal(discussions[1]?.id, 'disc-b');
  assert.equal(discussions[1]?.resolved, false);
  assert.equal(discussions[1]?.individualNote, true);

  assert.equal(discussions[2]?.id, 'disc-c');
  assert.equal(discussions[2]?.resolved, false);
  assert.equal(discussions[2]?.individualNote, false);
});

void test('createDiscussion with inline position serializes snake_case position object', async () => {
  const { fetch, calls } = makeRecorder((_call, url) => {
    assert.ok(url.pathname.endsWith('/merge_requests/12/discussions'));
    return jsonResponse({
      id: 'disc-inline',
      individual_note: false,
      notes: [{ id: 99, body: 'inline comment', system: false }],
    });
  });

  const writer = GitLabWriter.fromConfig(
    { baseUrl: BASE, token: TOKEN },
    { fetch, sleep: async () => {} },
  );

  const discussion = await writer.createDiscussion('proj', 12, 'inline comment', {
    baseSha: 'base111',
    startSha: 'start222',
    headSha: 'head333',
    newPath: 'src/foo.ts',
    oldPath: 'src/bar.ts',
    newLine: 42,
  });

  assert.equal(discussion.id, 'disc-inline');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'POST');

  const payload = JSON.parse(calls[0]?.body ?? '') as {
    body: string;
    position: Record<string, unknown>;
  };
  assert.equal(payload.body, 'inline comment');
  assert.deepEqual(payload.position, {
    position_type: 'text',
    base_sha: 'base111',
    start_sha: 'start222',
    head_sha: 'head333',
    new_path: 'src/foo.ts',
    old_path: 'src/bar.ts',
    new_line: 42,
  });
  assert.equal('old_line' in payload.position, false);
});

void test('createDiscussion without position omits position key', async () => {
  const { fetch, calls } = makeRecorder(() =>
    jsonResponse({
      id: 'disc-general',
      individual_note: true,
      notes: [{ id: 1, body: 'general', system: false }],
    }),
  );

  const writer = GitLabWriter.fromConfig(
    { baseUrl: BASE, token: TOKEN },
    { fetch, sleep: async () => {} },
  );

  await writer.createDiscussion('proj', 1, 'general');

  const payload = JSON.parse(calls[0]?.body ?? '') as Record<string, unknown>;
  assert.equal(payload['body'], 'general');
  assert.equal('position' in payload, false);
});

void test('resolveDiscussion PUTs resolved=true as query param', async () => {
  const { fetch, calls } = makeRecorder((_call, url) => {
    assert.equal(url.searchParams.get('resolved'), 'true');
    return new Response('', { status: 200 });
  });

  const writer = GitLabWriter.fromConfig(
    { baseUrl: BASE, token: TOKEN },
    { fetch, sleep: async () => {} },
  );

  await writer.resolveDiscussion('42', 8, 'abc123', true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'PUT');
  assert.ok(calls[0]?.url.includes('/discussions/abc123'));
  assert.deepEqual(JSON.parse(calls[0]?.body ?? '{}'), {});
});

void test('429 then success retries with injected no-op sleep', async () => {
  let attempts = 0;
  const sleepCalls: number[] = [];

  const fakeFetch: typeof fetch = (input, init) => {
    attempts += 1;
    if (attempts <= 2) {
      return Promise.resolve(
        new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '3' },
        }),
      );
    }
    assert.equal(init?.method, 'POST');
    return Promise.resolve(jsonResponse({ id: 7, body: 'ok', system: false }));
  };

  const client = new GitLabClient(
    { baseUrl: BASE, token: TOKEN },
    {
      fetch: fakeFetch,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    },
  );
  const writer = new GitLabWriter(client);

  const note = await writer.createNote('proj', 1, 'ok');

  assert.equal(note.id, 7);
  assert.equal(attempts, 3);
  assert.deepEqual(sleepCalls, [3_000, 3_000]);
});
