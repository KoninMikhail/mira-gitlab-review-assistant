import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleMrNote } from './handle-note.ts';
import type { HandleMrNoteDeps, IncomingMrNote } from './handle-note.ts';
import { REPLY_MARKER, findingMarker } from '../chatops/index.ts';
import type { ReviewContext, ReviewJob } from '../domain/index.ts';
import { defaultProjectPolicy } from '../policy/index.ts';
import {
  FakeAssistantEngine,
  FakeIgnoreStore,
  FakeVcsWriter,
} from '../ports/fakes.ts';

const NOW = new Date('2026-06-21T12:00:00.000Z');

function baseNote(overrides: Partial<IncomingMrNote> = {}): IncomingMrNote {
  const note: IncomingMrNote = {
    projectId: 'group/app',
    mrIid: 7,
    headSha: 'abc1234',
    body: 'это точно баг?',
    action: 'create',
    system: false,
    author: 'dev',
  };
  return { ...note, ...overrides };
}

function makeContext(): ReviewContext {
  return {
    job: { projectId: 'group/app', mrIid: 7, headSha: 'abc1234' },
    title: 'Fix null',
    description: 'desc',
    sourceBranch: 'feat/x',
    targetBranch: 'main',
    changedFiles: [{ path: 'src/a.ts', isBinary: false, isNew: false, isDeleted: false }],
    diff: '@@ -1 +1 @@\n',
  };
}

function makeDeps(overrides: {
  engine?: FakeAssistantEngine;
  writer?: FakeVcsWriter;
  publishReplies?: boolean;
  enqueue?: (job: ReviewJob) => Promise<boolean>;
}): HandleMrNoteDeps & { engine: FakeAssistantEngine; writer: FakeVcsWriter; jobs: ReviewJob[] } {
  const engine = overrides.engine ?? new FakeAssistantEngine('Да, смотри строку 12.');
  const writer = overrides.writer ?? new FakeVcsWriter();
  const jobs: ReviewJob[] = [];
  const enqueue =
    overrides.enqueue ??
    (async (job: ReviewJob) => {
      jobs.push(job);
      return true;
    });
  const deps: HandleMrNoteDeps = {
    enqueueReview: enqueue,
    ignoreStore: new FakeIgnoreStore(),
    writer,
    publishReplies: overrides.publishReplies ?? true,
    contextBuilder: {
      build: async (job) => ({
        context: {
          ...makeContext(),
          job: { projectId: job.projectId, mrIid: job.mrIid, headSha: job.headSha },
        },
        workspaceDir: '/tmp/ws',
        cleanup: async () => {},
      }),
    },
    createEngine: () => engine,
    resolvePolicy: () => defaultProjectPolicy,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => NOW,
    botUsername: 'mira',
  };
  return Object.assign(deps, { engine, writer, jobs });
}

describe('handleMrNote', () => {
  it('enqueues @mira review and ignores fingerprints without chatting', async () => {
    const deps = makeDeps({});
    await handleMrNote(baseNote({ body: '@mira review' }), deps);
    assert.equal(deps.jobs.length, 1);
    assert.equal(deps.jobs[0]?.trigger, 'chatops');
    assert.equal(deps.engine.requests.length, 0);

    const ignoreDeps = makeDeps({});
    await handleMrNote(baseNote({ body: '@mira ignore deadbeef' }), ignoreDeps);
    const muted = await ignoreDeps.ignoreStore.ignored('group/app', 7);
    assert.equal(muted.has('deadbeef'), true);
    assert.equal(ignoreDeps.engine.requests.length, 0);
  });

  it('replies in a Mira finding thread without requiring @mira', async () => {
    const writer = new FakeVcsWriter();
    const fp = 'ab'.repeat(32);
    writer.seedDiscussion('group/app', 7, {
      id: 'd1',
      resolved: false,
      individualNote: false,
      notes: [
        {
          id: 1,
          body: `${findingMarker(fp)}\nNull deref`,
          author: 'mira',
          system: false,
        },
      ],
    });
    const deps = makeDeps({ writer });
    await handleMrNote(baseNote({ body: 'это точно баг?', discussionId: 'd1' }), deps);

    assert.equal(deps.engine.requests.length, 1);
    assert.equal(deps.engine.requests[0]?.kind, 'thread');
    assert.equal(deps.engine.requests[0]?.userMessage, 'это точно баг?');
    const discussion = await writer.getDiscussion('group/app', 7, 'd1');
    assert.equal(discussion.notes.length, 2);
    assert.ok(discussion.notes[1]?.body.startsWith(REPLY_MARKER));
    assert.ok(discussion.notes[1]?.body.includes('Да, смотри строку 12.'));
  });

  it('replies to a root @mira mention in the same discussion', async () => {
    const writer = new FakeVcsWriter();
    writer.seedDiscussion('group/app', 7, {
      id: 'root-1',
      resolved: false,
      individualNote: true,
      notes: [
        {
          id: 50,
          body: '@mira зачем этот helper?',
          author: 'dev',
          system: false,
        },
      ],
    });
    const deps = makeDeps({ writer, engine: new FakeAssistantEngine('Чтобы не копипастить.') });
    await handleMrNote(
      baseNote({ body: '@mira зачем этот helper?', discussionId: 'root-1' }),
      deps,
    );
    assert.equal(deps.engine.requests[0]?.kind, 'root');
    const discussion = await writer.getDiscussion('group/app', 7, 'root-1');
    assert.equal(discussion.notes.length, 2);
    assert.ok(discussion.notes[1]?.body.includes('Чтобы не копипастить.'));
  });

  it('dry-run runs the engine but does not POST', async () => {
    const writer = new FakeVcsWriter();
    writer.seedDiscussion('group/app', 7, {
      id: 'd1',
      resolved: false,
      individualNote: false,
      notes: [
        { id: 1, body: `${findingMarker('aa'.repeat(32))}\nfinding`, author: 'mira', system: false },
      ],
    });
    const deps = makeDeps({ writer, publishReplies: false });
    await handleMrNote(baseNote({ discussionId: 'd1' }), deps);
    assert.equal(deps.engine.requests.length, 1);
    const discussion = await writer.getDiscussion('group/app', 7, 'd1');
    assert.equal(discussion.notes.length, 1);
  });

  it('skips bot notes and still cleans up after engine failure', async () => {
    const writer = new FakeVcsWriter();
    writer.seedDiscussion('group/app', 7, {
      id: 'd1',
      resolved: false,
      individualNote: false,
      notes: [
        { id: 1, body: `${findingMarker('aa'.repeat(32))}\nfinding`, author: 'mira', system: false },
      ],
    });
    const skipped = makeDeps({ writer });
    await handleMrNote(baseNote({ author: 'mira', discussionId: 'd1' }), skipped);
    assert.equal(skipped.engine.requests.length, 0);

    const failing = new FakeAssistantEngine();
    failing.fail = new Error('boom');
    const failWriter = new FakeVcsWriter();
    failWriter.seedDiscussion('group/app', 7, {
      id: 'd1',
      resolved: false,
      individualNote: false,
      notes: [
        { id: 1, body: `${findingMarker('aa'.repeat(32))}\nfinding`, author: 'mira', system: false },
      ],
    });
    const deps = makeDeps({ writer: failWriter, engine: failing });
    await handleMrNote(baseNote({ discussionId: 'd1' }), deps);
    const discussion = await failWriter.getDiscussion('group/app', 7, 'd1');
    assert.equal(discussion.notes.length, 1);
  });

  it('enqueues a Russian review alias without chatting', async () => {
    const deps = makeDeps({});
    await handleMrNote(baseNote({ body: '@mira давай новое ревью' }), deps);
    assert.equal(deps.jobs.length, 1);
    assert.equal(deps.jobs[0]?.trigger, 'chatops');
    assert.equal(deps.engine.requests.length, 0);
  });

  it('rewrites the MR description and confirms in the same discussion', async () => {
    const writer = new FakeVcsWriter();
    writer.seedDiscussion('group/app', 7, {
      id: 'root-1',
      resolved: false,
      individualNote: true,
      notes: [
        {
          id: 50,
          body: '@mira улучши мой mr сообщение',
          author: 'dev',
          system: false,
        },
      ],
    });
    const deps = makeDeps({
      writer,
      engine: new FakeAssistantEngine('## Зачем\n\nЧиним null в хелпере.'),
    });
    await handleMrNote(
      baseNote({ body: '@mira улучши мой mr сообщение', discussionId: 'root-1' }),
      deps,
    );

    assert.equal(deps.jobs.length, 0);
    assert.equal(deps.engine.requests[0]?.kind, 'rewrite-description');
    assert.deepEqual(writer.mrDescriptions, [
      { projectId: 'group/app', mrIid: 7, description: '## Зачем\n\nЧиним null в хелпере.' },
    ]);
    const discussion = await writer.getDiscussion('group/app', 7, 'root-1');
    assert.equal(discussion.notes.length, 2);
    assert.ok(discussion.notes[1]?.body.startsWith(REPLY_MARKER));
    assert.ok(discussion.notes[1]?.body.includes('Переписала описание MR'));
    assert.equal(discussion.notes[1]?.body.includes('## Зачем'), false);
  });

  it('strips a wrapping fence before PATCHing the MR description', async () => {
    const writer = new FakeVcsWriter();
    const deps = makeDeps({
      writer,
      engine: new FakeAssistantEngine('```markdown\n## Goal\n\nDo the thing.\n```'),
    });
    await handleMrNote(baseNote({ body: '@mira перепиши описание' }), deps);
    assert.deepEqual(writer.mrDescriptions, [
      { projectId: 'group/app', mrIid: 7, description: '## Goal\n\nDo the thing.' },
    ]);
  });

  it('dry-run rewrite runs the engine but does not PATCH or POST', async () => {
    const writer = new FakeVcsWriter();
    writer.seedDiscussion('group/app', 7, {
      id: 'root-1',
      resolved: false,
      individualNote: true,
      notes: [
        { id: 50, body: '@mira перепиши описание', author: 'dev', system: false },
      ],
    });
    const deps = makeDeps({
      writer,
      publishReplies: false,
      engine: new FakeAssistantEngine('## Draft'),
    });
    await handleMrNote(
      baseNote({ body: '@mira перепиши описание', discussionId: 'root-1' }),
      deps,
    );
    assert.equal(deps.engine.requests.length, 1);
    assert.equal(writer.mrDescriptions.length, 0);
    const discussion = await writer.getDiscussion('group/app', 7, 'root-1');
    assert.equal(discussion.notes.length, 1);
  });
});
