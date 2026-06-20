/**
 * Unit tests for the Kaiten REST adapter. A fake `fetch` (typed as the
 * adapter's `FetchLike`) is injected so there are NO network calls.
 *
 * On `ai-referent.kaiten.ru` the dedicated `/cards/:id/checklists` endpoint
 * returns 405, so acceptance criteria are read from checklists embedded on the
 * card via `?additional_card_fields=checklists` in a single request. These
 * tests verify that request shape, the `sort_order` ordering, normalization,
 * and the `KaitenHttpError` on non-2xx.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { KaitenTracker } from '../src/adapters/tracker/kaiten/index.ts';
import type { FetchLike, HttpResponse } from '../src/adapters/tracker/kaiten/http.ts';

interface RecordedCall {
  url: string;
  authorization: string | undefined;
}

function jsonResponse(body: unknown, status = 200): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function makeFakeFetch(routes: Record<string, HttpResponse>): {
  fetch: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    calls.push({ url: input, authorization: init?.headers?.['Authorization'] });
    const matched = Object.entries(routes).find(([suffix]) => input.endsWith(suffix));
    if (!matched) {
      return Promise.resolve(jsonResponse({ error: 'not found' }, 404));
    }
    return Promise.resolve(matched[1]);
  };
  return { fetch: fetchImpl, calls };
}

const CARD = '/api/latest/cards/123?additional_card_fields=checklists';

void test('getCard reads embedded checklists in a single request', async () => {
  const fake = makeFakeFetch({
    [CARD]: jsonResponse({
      id: 123,
      title: 'Implement login',
      description: 'Add OAuth login flow',
      checklists: [
        {
          id: 1,
          name: 'Acceptance',
          sort_order: 1,
          items: [
            { id: 11, text: 'User can sign in', checked: false, sort_order: 1 },
            { id: 12, text: 'Errors are shown', checked: true, sort_order: 2 },
          ],
        },
        {
          id: 2,
          name: 'QA',
          sort_order: 2,
          items: [{ id: 21, text: 'E2E test passes', checked: false, sort_order: 1 }],
        },
      ],
    }),
  });

  const tracker = new KaitenTracker({
    baseUrl: 'https://kaiten.example.com',
    token: 'secret-token',
    fetch: fake.fetch,
  });

  const card = await tracker.getCard('123');

  assert.equal(card.id, '123');
  assert.equal(card.title, 'Implement login');
  assert.equal(card.description, 'Add OAuth login flow');
  assert.deepEqual(card.acceptanceCriteria, [
    'User can sign in',
    'Errors are shown',
    'E2E test passes',
  ]);

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.authorization, 'Bearer secret-token');
});

void test('getCard orders checklists and items by sort_order, not array order', async () => {
  // Mirrors the real `ai-referent.kaiten.ru` shape: items arrive unsorted and
  // ordering is carried by `sort_order` (observed live on card 66103377).
  const fake = makeFakeFetch({
    [CARD]: jsonResponse({
      id: 123,
      title: 'SSPB ID rollout',
      description: 'Ship SSPB ID on prod',
      checklists: [
        {
          id: 11629662,
          name: 'Чеклист выката prod SSPB ID',
          sort_order: 1.62,
          items: [
            { id: 1, text: 'fourth', checked: true, sort_order: 4.53 },
            { id: 2, text: 'fifth', checked: true, sort_order: 6.89 },
            { id: 3, text: 'first', checked: true, sort_order: 1.16 },
            { id: 4, text: 'third', checked: true, sort_order: 3.14 },
            { id: 5, text: 'second', checked: false, sort_order: 1.55 },
          ],
        },
      ],
    }),
  });

  const tracker = new KaitenTracker({
    baseUrl: 'https://kaiten.example.com',
    token: 't',
    fetch: fake.fetch,
  });

  const card = await tracker.getCard('123');

  assert.deepEqual(card.acceptanceCriteria, ['first', 'second', 'third', 'fourth', 'fifth']);
});

void test('getCard normalizes criteria: trims and drops empty/whitespace items', async () => {
  const fake = makeFakeFetch({
    '/api/latest/cards/55?additional_card_fields=checklists': jsonResponse({
      id: 55,
      title: 'T',
      description: 'D',
      checklists: [
        {
          items: [{ text: '  spaced  ' }, { text: '' }, { text: '   ' }, { text: 'kept' }, {}],
        },
      ],
    }),
  });

  const tracker = new KaitenTracker({
    baseUrl: 'https://kaiten.example.com/',
    token: 't',
    fetch: fake.fetch,
  });

  const card = await tracker.getCard('55');

  assert.deepEqual(card.acceptanceCriteria, ['spaced', 'kept']);
});

void test('getCard yields no criteria when the card has no checklists', async () => {
  const fake = makeFakeFetch({
    '/api/latest/cards/9?additional_card_fields=checklists': jsonResponse({
      id: 9,
      title: 'No criteria',
      description: 'goals_total is 0 so checklists is absent',
    }),
  });

  const tracker = new KaitenTracker({
    baseUrl: 'https://kaiten.example.com',
    token: 't',
    fetch: fake.fetch,
  });

  const card = await tracker.getCard('9');

  assert.deepEqual(card.acceptanceCriteria, []);
  assert.equal(fake.calls.length, 1);
});

void test('getCard throws KaitenHttpError on non-2xx', async () => {
  const fake = makeFakeFetch({
    '/api/latest/cards/404?additional_card_fields=checklists': jsonResponse({ error: 'nope' }, 404),
  });

  const tracker = new KaitenTracker({
    baseUrl: 'https://kaiten.example.com',
    token: 't',
    fetch: fake.fetch,
  });

  await assert.rejects(() => tracker.getCard('404'), /failed: 404/);
});
