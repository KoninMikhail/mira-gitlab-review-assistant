import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyNote } from './classify.ts';
import { REPLY_MARKER, SUMMARY_MARKER, findingMarker } from './markers.ts';
import type { MrDiscussion } from '../ports/index.ts';

function findingThread(): MrDiscussion {
  return {
    id: 'd1',
    resolved: false,
    individualNote: false,
    notes: [
      {
        id: 1,
        body: `${findingMarker('ab'.repeat(32))}\n**[major · bug]** \`src/a.ts:3\`\n\nNull deref`,
        author: 'mira',
        system: false,
      },
    ],
  };
}

function summaryThread(): MrDiscussion {
  return {
    id: 'd-sum',
    resolved: false,
    individualNote: true,
    notes: [{ id: 9, body: `${SUMMARY_MARKER}\n\n## Mira review`, author: 'mira', system: false }],
  };
}

describe('classifyNote', () => {
  it('skips system notes', () => {
    assert.deepEqual(classifyNote({ body: '@mira review', system: true, action: 'create' }), {
      kind: 'skip',
      reason: 'system',
    });
  });

  it('skips note updates', () => {
    assert.deepEqual(
      classifyNote({ body: 'hello @mira', system: false, action: 'update' }),
      { kind: 'skip', reason: 'update' },
    );
  });

  it('skips the bot account and own reply marker', () => {
    assert.deepEqual(
      classifyNote({
        body: 'I am posting a finding',
        system: false,
        action: 'create',
        author: 'Mira',
        botUsername: 'mira',
      }),
      { kind: 'skip', reason: 'bot' },
    );
    assert.deepEqual(
      classifyNote({
        body: `${REPLY_MARKER}\n\nОк, гляну.`,
        system: false,
        action: 'create',
        author: 'dev',
      }),
      { kind: 'skip', reason: 'own-reply' },
    );
  });

  it('treats whitelist commands as commands even inside a Mira thread', () => {
    const discussion = findingThread();
    discussion.notes.push({ id: 2, body: '@mira ignore deadbeef', system: false, author: 'dev' });
    assert.deepEqual(
      classifyNote({
        body: '@mira ignore deadbeef',
        system: false,
        action: 'create',
        author: 'dev',
        discussion,
      }),
      { kind: 'command', command: { kind: 'ignore', fingerprint: 'deadbeef' } },
    );
    assert.deepEqual(
      classifyNote({
        body: '@mira review',
        system: false,
        action: '',
        author: 'dev',
      }),
      { kind: 'command', command: { kind: 'review', full: false } },
    );
  });

  it('routes a reply in a finding or summary thread as thread chat without @mira', () => {
    const finding = findingThread();
    finding.notes.push({ id: 2, body: 'это точно баг? строка же под null check', system: false });
    assert.deepEqual(
      classifyNote({
        body: 'это точно баг? строка же под null check',
        system: false,
        action: 'create',
        author: 'dev',
        discussion: finding,
      }),
      { kind: 'chat', channel: 'thread' },
    );

    const summary = summaryThread();
    summary.notes.push({ id: 10, body: 'а почему blockers?', system: false });
    assert.deepEqual(
      classifyNote({
        body: 'а почему blockers?',
        system: false,
        action: 'create',
        author: 'dev',
        discussion: summary,
      }),
      { kind: 'chat', channel: 'thread' },
    );
  });

  it('routes a root @mira mention as root chat', () => {
    assert.deepEqual(
      classifyNote({
        body: '@mira зачем этот helper?',
        system: false,
        action: 'create',
        author: 'dev',
        discussion: {
          id: 'new',
          resolved: false,
          individualNote: true,
          notes: [
            {
              id: 50,
              body: '@mira зачем этот helper?',
              system: false,
              author: 'dev',
            },
          ],
        },
      }),
      { kind: 'chat', channel: 'root' },
    );
  });

  it('routes a rewrite-description alias as a command', () => {
    assert.deepEqual(
      classifyNote({
        body: '@mira улучши мой mr сообщение',
        system: false,
        action: 'create',
        author: 'dev',
      }),
      { kind: 'command', command: { kind: 'rewrite-description' } },
    );
  });

  it('routes a Russian review alias as a review command', () => {
    assert.deepEqual(
      classifyNote({
        body: '@mira давай новое ревью',
        system: false,
        action: 'create',
        author: 'dev',
      }),
      { kind: 'command', command: { kind: 'review', full: false } },
    );
  });

  it('skips human chatter without @mira outside Mira threads', () => {
    assert.deepEqual(
      classifyNote({
        body: 'lgtm',
        system: false,
        action: 'create',
        author: 'dev',
        discussion: {
          id: 'humans',
          resolved: false,
          individualNote: false,
          notes: [
            { id: 1, body: 'please check this', system: false, author: 'alice' },
            { id: 2, body: 'lgtm', system: false, author: 'dev' },
          ],
        },
      }),
      { kind: 'skip', reason: 'unrelated' },
    );
  });
});
