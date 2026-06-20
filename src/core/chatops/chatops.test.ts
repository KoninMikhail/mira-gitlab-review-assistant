import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseChatOps } from './index.ts';

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

  it('returns undefined for unknown command', () => {
    assert.equal(parseChatOps('@mira foobar'), undefined);
  });

  it('returns undefined when @mira is absent', () => {
    assert.equal(parseChatOps('please run a review'), undefined);
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
