import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mentionsMira, parseChatOps } from './index.ts';

describe('parseChatOps', () => {
  it('parses plain @mira review', () => {
    assert.deepEqual(parseChatOps('@mira review'), {
      kind: 'review',
      full: false,
    });
  });

  it('parses @mira review --full', () => {
    assert.deepEqual(parseChatOps('@mira review --full'), {
      kind: 'review',
      full: true,
    });
  });

  it('accepts --full before review', () => {
    assert.deepEqual(parseChatOps('@mira --full review'), {
      kind: 'review',
      full: true,
    });
  });

  it('parses @mira ignore with fingerprint', () => {
    const fingerprint = 'a'.repeat(64);
    assert.deepEqual(parseChatOps(`@mira ignore ${fingerprint}`), {
      kind: 'ignore',
      fingerprint,
    });
  });

  it('returns undefined for ignore without fingerprint', () => {
    assert.equal(parseChatOps('@mira ignore'), undefined);
  });

  it('parses Russian review aliases as review', () => {
    assert.deepEqual(parseChatOps('@mira давай новое ревью'), {
      kind: 'review',
      full: false,
    });
    assert.deepEqual(parseChatOps('@mira ревью'), {
      kind: 'review',
      full: false,
    });
    assert.deepEqual(parseChatOps('@mira давай новое ревью --full'), {
      kind: 'review',
      full: true,
    });
  });

  it('does not treat a question about review as a review command', () => {
    assert.equal(parseChatOps('@mira что такое ревью'), undefined);
  });

  it('parses rewrite-description aliases', () => {
    assert.deepEqual(parseChatOps('@mira улучши мой mr сообщение'), {
      kind: 'rewrite-description',
    });
    assert.deepEqual(parseChatOps('@mira перепиши описание MR под текущий diff'), {
      kind: 'rewrite-description',
    });
    assert.deepEqual(parseChatOps('@mira improve the MR description'), {
      kind: 'rewrite-description',
    });
  });

  it('does not treat a question about the description as rewrite-description', () => {
    assert.equal(parseChatOps('@mira что написано в описании'), undefined);
  });

  it('returns undefined for unknown command', () => {
    assert.equal(parseChatOps('@mira foobar'), undefined);
  });

  it('returns undefined when @mira is absent', () => {
    assert.equal(parseChatOps('please run a review'), undefined);
  });

  it('detects a mention without a whitelist command', () => {
    assert.equal(mentionsMira('@mira перепиши описание'), true);
    assert.equal(mentionsMira('ping @mirage'), false);
  });

  it('is case-insensitive for mention and keywords', () => {
    assert.deepEqual(parseChatOps('@MIRA REVIEW --FULL'), {
      kind: 'review',
      full: true,
    });
    assert.deepEqual(parseChatOps('@Mira Ignore deadbeef'), {
      kind: 'ignore',
      fingerprint: 'deadbeef',
    });
  });

  it('finds command embedded in multi-line prose', () => {
    const body = [
      'Thanks for the update!',
      '',
      'Could you @mira review when ready?',
      'Appreciate it.',
    ].join('\n');

    assert.deepEqual(parseChatOps(body), {
      kind: 'review',
      full: false,
    });
  });

  it('does not match @mirage or @mirabot', () => {
    assert.equal(parseChatOps('@mirage review'), undefined);
    assert.equal(parseChatOps('@mirabot review'), undefined);
  });

  it('tolerates extra whitespace between tokens', () => {
    assert.deepEqual(parseChatOps('  @mira   review   --full  '), {
      kind: 'review',
      full: true,
    });
    assert.deepEqual(parseChatOps('@mira  ignore  abc123  '), {
      kind: 'ignore',
      fingerprint: 'abc123',
    });
  });
});
