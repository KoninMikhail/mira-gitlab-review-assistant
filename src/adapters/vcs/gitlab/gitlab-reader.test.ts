/**
 * Unit tests for the GitLab read adapter. A fake `fetch` is injected so there
 * are NO network calls: we verify metadata mapping, diff pagination, binary
 * marking, and that the `PRIVATE-TOKEN` header is sent.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { GitLabApiError, GitLabClient, GitLabReader } from './index.ts';

const BASE = 'https://gitlab.example.com';
const TOKEN = 'test-token';

interface RecordedCall {
  url: string;
  token: string | null;
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

void test('getMrContext maps metadata, paginates diffs, and marks binaries', async () => {
  const calls: RecordedCall[] = [];

  const page1 = [
    {
      old_path: 'src/a.txt',
      new_path: 'src/a.txt',
      new_file: false,
      renamed_file: false,
      deleted_file: false,
      diff: '@@ -1 +1 @@\n-old\n+new\n',
    },
    {
      old_path: 'assets/img.png',
      new_path: 'assets/img.png',
      new_file: true,
      renamed_file: false,
      deleted_file: false,
      diff: 'Binary files /dev/null and b/assets/img.png differ\n',
    },
  ];
  const page2 = [
    {
      old_path: 'old/name.ts',
      new_path: 'new/name.ts',
      new_file: false,
      renamed_file: true,
      deleted_file: false,
      diff: '',
    },
    {
      old_path: 'gone.txt',
      new_path: 'gone.txt',
      new_file: false,
      renamed_file: false,
      deleted_file: true,
      diff: '@@ -1 +0,0 @@\n-bye\n',
    },
    {
      old_path: 'data/blob.bin',
      new_path: 'data/blob.bin',
      new_file: false,
      renamed_file: false,
      deleted_file: false,
      diff: '',
    },
  ];

  const fakeFetch: typeof fetch = (input, init) => {
    const url = urlOf(input);
    calls.push({
      url,
      token: new Headers(init?.headers).get('PRIVATE-TOKEN'),
    });

    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/merge_requests/7/diffs')) {
      const response =
        parsed.searchParams.get('page') === '1'
          ? jsonResponse(page1, { 'x-next-page': '2' })
          : jsonResponse(page2, { 'x-next-page': '' });
      return Promise.resolve(response);
    }
    if (parsed.pathname.endsWith('/merge_requests/7')) {
      return Promise.resolve(
        jsonResponse({
          title: 'Add feature',
          description: 'Does things',
          source_branch: 'feature/x',
          target_branch: 'main',
          sha: 'deadbeefcafe',
          diff_refs: { head_sha: 'should-not-be-used' },
        }),
      );
    }
    return Promise.reject(new Error(`unexpected url: ${url}`));
  };

  const reader = GitLabReader.fromConfig(
    { baseUrl: BASE, token: TOKEN },
    { fetch: fakeFetch, perPage: 2 },
  );

  const ctx = await reader.getMrContext('group/sub/proj', 7);

  // Metadata mapping.
  assert.equal(ctx.projectId, 'group/sub/proj');
  assert.equal(ctx.mrIid, 7);
  assert.equal(ctx.title, 'Add feature');
  assert.equal(ctx.description, 'Does things');
  assert.equal(ctx.sourceBranch, 'feature/x');
  assert.equal(ctx.targetBranch, 'main');
  assert.equal(ctx.headSha, 'deadbeefcafe');

  // Pagination: both pages were fetched and concatenated.
  const diffCalls = calls.filter((c) => c.url.includes('/diffs'));
  assert.equal(diffCalls.length, 2);
  assert.equal(ctx.changedFiles.length, 5);

  // Project id was URL-encoded (group/sub/project path).
  assert.ok(calls.every((c) => c.url.includes('projects/group%2Fsub%2Fproj/')));

  // PRIVATE-TOKEN header sent on every request.
  assert.ok(calls.every((c) => c.token === TOKEN));

  const [textFile, imgFile, renamed, deleted, blob] = ctx.changedFiles;

  // Plain text modification.
  assert.deepEqual(textFile, {
    path: 'src/a.txt',
    isBinary: false,
    isNew: false,
    isDeleted: false,
  });

  // Binary via the "Binary files ... differ" notice.
  assert.equal(imgFile?.path, 'assets/img.png');
  assert.equal(imgFile?.isBinary, true);
  assert.equal(imgFile?.isNew, true);

  // Pure rename: oldPath set, empty diff is NOT treated as binary.
  assert.equal(renamed?.path, 'new/name.ts');
  assert.equal(renamed?.oldPath, 'old/name.ts');
  assert.equal(renamed?.isBinary, false);

  // Deletion.
  assert.equal(deleted?.path, 'gone.txt');
  assert.equal(deleted?.isDeleted, true);
  assert.equal(deleted?.isBinary, false);

  // Binary via empty diff body on a real change.
  assert.equal(blob?.path, 'data/blob.bin');
  assert.equal(blob?.isBinary, true);
});

void test('getMrContext falls back to diff_refs.head_sha when sha is null', async () => {
  const fakeFetch: typeof fetch = (input) => {
    const parsed = new URL(urlOf(input));
    if (parsed.pathname.endsWith('/merge_requests/3/diffs')) {
      return Promise.resolve(jsonResponse([], { 'x-next-page': '' }));
    }
    return Promise.resolve(
      jsonResponse({
        title: 'No head sha',
        description: null,
        source_branch: 'topic',
        target_branch: 'main',
        sha: null,
        diff_refs: { head_sha: 'fallbacksha' },
      }),
    );
  };

  const reader = GitLabReader.fromConfig({ baseUrl: BASE, token: TOKEN }, { fetch: fakeFetch });

  const ctx = await reader.getMrContext('42', 3);

  assert.equal(ctx.headSha, 'fallbacksha');
  assert.equal(ctx.description, '');
  assert.equal(ctx.changedFiles.length, 0);
});

void test('non-2xx responses throw GitLabApiError with status', async () => {
  const fakeFetch: typeof fetch = () => Promise.resolve(new Response('not found', { status: 404 }));

  const reader = GitLabReader.fromConfig({ baseUrl: BASE, token: TOKEN }, { fetch: fakeFetch });

  await assert.rejects(reader.getMrContext('42', 99), (err: unknown) => {
    assert.ok(err instanceof GitLabApiError);
    assert.equal(err.status, 404);
    return true;
  });
});

void test('getAuthenticatedUsername reads GitLab /user', async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = (input) => {
    calls.push(urlOf(input));
    return Promise.resolve(jsonResponse({ username: 'mira-bot' }));
  };
  const reader = GitLabReader.fromConfig({ baseUrl: BASE, token: TOKEN }, { fetch: fakeFetch });
  assert.equal(await reader.getAuthenticatedUsername(), 'mira-bot');
  assert.ok(calls[0]?.endsWith('/api/v4/user'));
});

void test('setToken is used on the next request', async () => {
  const tokens: Array<string | null> = [];
  const fakeFetch: typeof fetch = (_input, init) => {
    tokens.push(new Headers(init?.headers).get('PRIVATE-TOKEN'));
    return Promise.resolve(jsonResponse({ username: 'mira-bot' }));
  };
  const client = new GitLabClient({ baseUrl: BASE, token: 'old-token' }, { fetch: fakeFetch });
  const reader = new GitLabReader(client);
  await reader.getAuthenticatedUsername();
  client.setToken('new-token');
  await reader.getAuthenticatedUsername();
  assert.deepEqual(tokens, ['old-token', 'new-token']);
});
