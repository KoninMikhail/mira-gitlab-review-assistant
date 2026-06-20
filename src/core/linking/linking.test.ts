/**
 * Unit tests for the MR ↔ Kaiten card resolver. A fake `TaskTracker` is used so
 * there are NO network calls. Covers: branch strategy, description precedence,
 * the no-id degradation, and graceful degradation when the card lookup fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCard } from './index.ts';

interface FakeCard {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

function makeCard(id: string): FakeCard {
  return { id, title: `Card ${id}`, description: 'body', acceptanceCriteria: [] };
}

/** In-memory tracker that records lookups and rejects unknown ids. */
class FakeTracker {
  readonly requested: string[] = [];
  private readonly known: Record<string, FakeCard>;

  constructor(known: Record<string, FakeCard>) {
    this.known = known;
  }

  getCard(cardId: string): Promise<FakeCard> {
    this.requested.push(cardId);
    const card = this.known[cardId];
    if (card === undefined) {
      return Promise.reject(new Error(`card ${cardId} not found`));
    }
    return Promise.resolve(card);
  }
}

interface CardLinkInput {
  title: string;
  description: string;
  sourceBranch: string;
}

void test('resolves via the branch name when the id is only in the branch', async () => {
  const tracker = new FakeTracker({ '4567': makeCard('4567') });
  const input: CardLinkInput = {
    title: 'Improve logging',
    description: 'No card link in here.',
    sourceBranch: 'feature/4567-improve-logging',
  };

  const result = await resolveCard(input, tracker);

  assert.equal(result.found, true);
  if (result.found) {
    assert.equal(result.strategy, 'branch');
    assert.equal(result.card.id, '4567');
  }
  assert.deepEqual(tracker.requested, ['4567']);
});

void test('description reference takes precedence over the branch name', async () => {
  const tracker = new FakeTracker({
    '111': makeCard('111'),
    '222': makeCard('222'),
  });
  const input: CardLinkInput = {
    title: 'Fix bug',
    description: 'Implements KAITEN-111 as specified.',
    sourceBranch: 'bugfix/222-other-card',
  };

  const result = await resolveCard(input, tracker);

  assert.equal(result.found, true);
  if (result.found) {
    assert.equal(result.strategy, 'description');
    assert.equal(result.card.id, '111');
  }
  // Branch id (222) must never be looked up when the description wins.
  assert.deepEqual(tracker.requested, ['111']);
});

void test('degrades to not-found when no id is present anywhere', async () => {
  const tracker = new FakeTracker({});
  const input: CardLinkInput = {
    title: 'Cleanup',
    description: 'Just some refactoring, no task.',
    sourceBranch: 'chore/cleanup',
  };

  const result = await resolveCard(input, tracker);

  assert.equal(result.found, false);
  if (!result.found) {
    assert.equal(result.reason, 'card not found');
  }
  assert.deepEqual(tracker.requested, []);
});

void test('degrades gracefully when a parsed card id is not found', async () => {
  const tracker = new FakeTracker({});
  const input: CardLinkInput = {
    title: 'Add feature',
    description: 'See https://kaiten.example.com/cards/4567 for details.',
    sourceBranch: 'feature/4567-add-feature',
  };

  const result = await resolveCard(input, tracker);

  assert.equal(result.found, false);
  if (!result.found) {
    assert.match(result.reason, /4567/);
  }
  assert.deepEqual(tracker.requested, ['4567']);
});
