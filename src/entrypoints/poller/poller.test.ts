/**
 * Unit tests for the polling trigger: pure job selection, one poll tick, and
 * GitLab open-MR listing. No network; tests terminate without real timers.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { GitLabReader } from '../../adapters/vcs/gitlab/index.ts';
import { InProcQueue } from '../../adapters/queue/inproc/index.ts';
import { defaultProjectPolicy } from '../../core/policy/index.ts';
import type { MrSummary, VcsMrLister } from '../../core/ports/index.ts';
import type { ProjectPolicy } from '../../core/policy/index.ts';
import { pollOnce, selectJobs } from './index.ts';

const NOW = new Date('2026-06-21T12:00:00.000Z');
const now = (): Date => NOW;

function mr(overrides: Partial<MrSummary> & Pick<MrSummary, 'mrIid' | 'headSha'>): MrSummary {
  return {
    projectId: 'group/app',
    title: `MR !${String(overrides.mrIid)}`,
    sourceBranch: 'feature/x',
    targetBranch: 'main',
    isDraft: false,
    state: 'opened',
    ...overrides,
  };
}

void test('selectJobs enqueues a ready (non-draft) open MR', () => {
  const jobs = selectJobs(
    [mr({ mrIid: 5, headSha: 'abc123' })],
    () => defaultProjectPolicy,
    () => false,
    now,
  );

  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0], {
    projectId: 'group/app',
    mrIid: 5,
    headSha: 'abc123',
    trigger: 'open',
    enqueuedAt: NOW.toISOString(),
  });
});

void test('selectJobs skips draft MRs', () => {
  const jobs = selectJobs(
    [mr({ mrIid: 3, headSha: 'draft1', isDraft: true })],
    () => defaultProjectPolicy,
    () => false,
    now,
  );

  assert.equal(jobs.length, 0);
});

void test('selectJobs suppresses already-handled MRs', () => {
  const handled = mr({ mrIid: 9, headSha: 'seen' });

  const jobs = selectJobs(
    [handled],
    () => defaultProjectPolicy,
    (m) => m.headSha === 'seen',
    now,
  );

  assert.equal(jobs.length, 0);
});

void test('selectJobs does not re-trigger fix commits when MR was already reviewed', () => {
  const reviewedMrIid = 12;

  const jobs = selectJobs(
    [mr({ mrIid: reviewedMrIid, headSha: 'fix-commit-sha' })],
    () => defaultProjectPolicy,
    (m) => m.mrIid === reviewedMrIid,
    now,
  );

  assert.equal(jobs.length, 0);
});

void test('selectJobs uses ready trigger when open is disabled', () => {
  const policy: ProjectPolicy = {
    ...defaultProjectPolicy,
    reviewOn: { ...defaultProjectPolicy.reviewOn, open: false, ready: true },
  };

  const jobs = selectJobs(
    [mr({ mrIid: 2, headSha: 'sha2' })],
    () => policy,
    () => false,
    now,
  );

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.trigger, 'ready');
});

void test('pollOnce lists projects, selects jobs, and enqueues via InProcQueue', async () => {
  class FakeLister implements VcsMrLister {
    readonly requested: string[] = [];

    listOpenMergeRequests(projectId: string): Promise<MrSummary[]> {
      this.requested.push(projectId);
      if (projectId === 'group/app') {
        return Promise.resolve([
          mr({ mrIid: 1, headSha: 'aaa' }),
          mr({ mrIid: 2, headSha: 'bbb', isDraft: true }),
        ]);
      }
      return Promise.resolve([mr({ projectId: 'other/proj', mrIid: 3, headSha: 'ccc' })]);
    }
  }

  const lister = new FakeLister();
  const queue = new InProcQueue();

  const count = await pollOnce({
    lister,
    projects: ['group/app', 'other/proj'],
    queue,
    policyFor: () => defaultProjectPolicy,
    alreadyHandled: () => false,
    now,
  });

  assert.equal(count, 2);
  assert.deepEqual(lister.requested, ['group/app', 'other/proj']);
  assert.equal(await queue.size(), 2);

  const first = await queue.dequeue();
  assert.equal(first?.mrIid, 1);
  assert.equal(first?.headSha, 'aaa');
});

void test('listOpenMergeRequests maps GitLab list response and paginates', async () => {
  const BASE = 'https://gitlab.example.com';
  const TOKEN = 'test-token';

  const page1 = [
    {
      iid: 10,
      title: 'Feature A',
      source_branch: 'feat/a',
      target_branch: 'main',
      sha: 'sha-a',
      diff_refs: { head_sha: 'ignored' },
      draft: false,
      state: 'opened',
    },
    {
      iid: 11,
      title: 'WIP draft',
      source_branch: 'feat/b',
      target_branch: 'main',
      sha: null,
      diff_refs: { head_sha: 'sha-b' },
      draft: true,
      state: 'opened',
    },
  ];
  const page2 = [
    {
      iid: 12,
      title: 'Feature C',
      source_branch: 'feat/c',
      target_branch: 'develop',
      sha: 'sha-c',
      diff_refs: null,
      draft: false,
      state: 'opened',
    },
  ];

  const calls: string[] = [];

  const fakeFetch: typeof fetch = (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const parsed = new URL(url);

    if (!parsed.pathname.endsWith('/merge_requests')) {
      return Promise.reject(new Error(`unexpected url: ${url}`));
    }

    const page = parsed.searchParams.get('page');
    const body = page === '1' ? page1 : page2;
    const headers =
      page === '1'
        ? { 'content-type': 'application/json', 'x-next-page': '2' }
        : { 'content-type': 'application/json' };

    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers }));
  };

  const reader = GitLabReader.fromConfig(
    { baseUrl: BASE, token: TOKEN },
    { fetch: fakeFetch, perPage: 2 },
  );

  const mrs = await reader.listOpenMergeRequests('group/sub/proj');

  assert.equal(mrs.length, 3);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((u) => u.includes('projects/group%2Fsub%2Fproj/merge_requests')));
  assert.ok(calls.every((u) => new URL(u).searchParams.get('state') === 'opened'));

  const [a, draft, c] = mrs;
  assert.deepEqual(a, {
    projectId: 'group/sub/proj',
    mrIid: 10,
    title: 'Feature A',
    sourceBranch: 'feat/a',
    targetBranch: 'main',
    headSha: 'sha-a',
    isDraft: false,
    state: 'opened',
  });
  assert.equal(draft?.isDraft, true);
  assert.equal(draft?.headSha, 'sha-b');
  assert.equal(c?.mrIid, 12);
  assert.equal(c?.headSha, 'sha-c');
});
