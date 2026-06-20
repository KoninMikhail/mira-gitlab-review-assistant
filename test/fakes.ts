/**
 * In-memory fake implementations of every `core` port. These let `core` logic
 * (orchestrator, poller, etc.) be unit-tested with NO network, git, or engine —
 * the explicit DoD of T1.1 (docs/04-architecture/overview.md).
 *
 * This module intentionally has no top-level side effects: the Node test runner
 * loads files under `test/`, but with only class definitions here that is a
 * no-op (0 tests).
 */
import type {
  Clock,
  IgnoreStore,
  InlinePosition,
  MrDiscussion,
  MrNote,
  Queue,
  ReviewEngine,
  ReviewKey,
  StateStore,
  TaskTracker,
  VcsReader,
  VcsWriter,
  MrContext,
} from '../src/core/ports/index.ts';
import type {
  JobKey,
  ReviewContext,
  ReviewJob,
  ReviewResult,
  TaskCard,
} from '../src/core/domain/index.ts';

function jobKeyOf(key: JobKey): string {
  return `${key.projectId}\u0000${String(key.mrIid)}\u0000${key.headSha}`;
}

function reviewKeyOf(key: ReviewKey): string {
  return `${jobKeyOf(key)}\u0000${key.promptVersion}\u0000${key.partitionVersion}`;
}

/** Reader seeded with MR contexts; rejects unknown `(project, mr)`. */
export class FakeVcsReader implements VcsReader {
  readonly requested: Array<{ projectId: string; mrIid: number }> = [];
  private readonly mrs = new Map<string, MrContext>();

  constructor(seed: readonly MrContext[] = []) {
    for (const mr of seed) {
      this.mrs.set(`${mr.projectId}\u0000${String(mr.mrIid)}`, mr);
    }
  }

  getMrContext(projectId: string, mrIid: number): Promise<MrContext> {
    this.requested.push({ projectId, mrIid });
    const mr = this.mrs.get(`${projectId}\u0000${String(mrIid)}`);
    if (mr === undefined) {
      return Promise.reject(new Error(`MR ${projectId}!${String(mrIid)} not found`));
    }
    return Promise.resolve(mr);
  }
}

/**
 * In-memory `VcsWriter`: records notes/discussions per `(project, mr)` so
 * idempotent-publisher logic can be unit-tested without GitLab. Note ids and
 * discussion ids are assigned monotonically.
 */
export class FakeVcsWriter implements VcsWriter {
  private readonly notes = new Map<string, MrNote[]>();
  private readonly discussions = new Map<string, MrDiscussion[]>();
  /** Inline positions captured alongside each created discussion (by id). */
  readonly positions = new Map<string, InlinePosition>();
  private nextNoteId = 1;
  private nextDiscussionId = 1;

  private mrKey(projectId: string, mrIid: number): string {
    return `${projectId}\u0000${String(mrIid)}`;
  }

  /** Seed an existing note (e.g. a prior bot comment) for idempotency tests. */
  seedNote(projectId: string, mrIid: number, note: MrNote): void {
    const list = this.notes.get(this.mrKey(projectId, mrIid)) ?? [];
    list.push(note);
    this.notes.set(this.mrKey(projectId, mrIid), list);
  }

  /** Seed an existing discussion for idempotency tests. */
  seedDiscussion(projectId: string, mrIid: number, discussion: MrDiscussion): void {
    const list = this.discussions.get(this.mrKey(projectId, mrIid)) ?? [];
    list.push(discussion);
    this.discussions.set(this.mrKey(projectId, mrIid), list);
  }

  listNotes(projectId: string, mrIid: number): Promise<MrNote[]> {
    return Promise.resolve([...(this.notes.get(this.mrKey(projectId, mrIid)) ?? [])]);
  }

  createNote(projectId: string, mrIid: number, body: string): Promise<MrNote> {
    const note: MrNote = { id: this.nextNoteId++, body, system: false };
    this.seedNote(projectId, mrIid, note);
    return Promise.resolve(note);
  }

  updateNote(projectId: string, mrIid: number, noteId: number, body: string): Promise<MrNote> {
    const list = this.notes.get(this.mrKey(projectId, mrIid)) ?? [];
    const note = list.find((n) => n.id === noteId);
    if (note === undefined) {
      return Promise.reject(new Error(`note ${String(noteId)} not found`));
    }
    note.body = body;
    return Promise.resolve(note);
  }

  listDiscussions(projectId: string, mrIid: number): Promise<MrDiscussion[]> {
    return Promise.resolve([...(this.discussions.get(this.mrKey(projectId, mrIid)) ?? [])]);
  }

  createDiscussion(
    projectId: string,
    mrIid: number,
    body: string,
    position?: InlinePosition,
  ): Promise<MrDiscussion> {
    const id = `d${String(this.nextDiscussionId++)}`;
    const note: MrNote = { id: this.nextNoteId++, body, system: false };
    const discussion: MrDiscussion = {
      id,
      notes: [note],
      resolved: false,
      individualNote: false,
    };
    this.seedDiscussion(projectId, mrIid, discussion);
    if (position !== undefined) {
      this.positions.set(id, position);
    }
    return Promise.resolve(discussion);
  }

  resolveDiscussion(
    projectId: string,
    mrIid: number,
    discussionId: string,
    resolved: boolean,
  ): Promise<void> {
    const list = this.discussions.get(this.mrKey(projectId, mrIid)) ?? [];
    const discussion = list.find((d) => d.id === discussionId);
    if (discussion === undefined) {
      return Promise.reject(new Error(`discussion ${discussionId} not found`));
    }
    discussion.resolved = resolved;
    return Promise.resolve();
  }
}

/** In-memory `IgnoreStore` keyed by `(project, mr)`. */
export class FakeIgnoreStore implements IgnoreStore {
  private readonly muted = new Map<string, Set<string>>();

  private mrKey(projectId: string, mrIid: number): string {
    return `${projectId}\u0000${String(mrIid)}`;
  }

  ignore(projectId: string, mrIid: number, fingerprint: string): Promise<void> {
    const key = this.mrKey(projectId, mrIid);
    const set = this.muted.get(key) ?? new Set<string>();
    set.add(fingerprint);
    this.muted.set(key, set);
    return Promise.resolve();
  }

  ignored(projectId: string, mrIid: number): Promise<Set<string>> {
    return Promise.resolve(new Set(this.muted.get(this.mrKey(projectId, mrIid)) ?? []));
  }
}

/** Tracker seeded with cards; rejects unknown ids and records lookups. */
export class FakeTaskTracker implements TaskTracker {
  readonly requested: string[] = [];
  private readonly cards: Map<string, TaskCard>;

  constructor(seed: Record<string, TaskCard> = {}) {
    this.cards = new Map(Object.entries(seed));
  }

  getCard(cardId: string): Promise<TaskCard> {
    this.requested.push(cardId);
    const card = this.cards.get(cardId);
    if (card === undefined) {
      return Promise.reject(new Error(`card ${cardId} not found`));
    }
    return Promise.resolve(card);
  }
}

/** Engine that returns a canned result and records the contexts it saw. */
export class FakeReviewEngine implements ReviewEngine {
  readonly reviewed: ReviewContext[] = [];
  private readonly result: ReviewResult;

  constructor(result: ReviewResult) {
    this.result = result;
  }

  review(context: ReviewContext): Promise<ReviewResult> {
    this.reviewed.push(context);
    return Promise.resolve(this.result);
  }
}

/** FIFO in-memory queue that dedups by {@link JobKey} while a job is pending. */
export class InMemoryQueue implements Queue {
  private readonly jobs: ReviewJob[] = [];
  private readonly pending = new Set<string>();

  enqueue(job: ReviewJob): Promise<boolean> {
    const key = jobKeyOf(job);
    if (this.pending.has(key)) {
      return Promise.resolve(false);
    }
    this.pending.add(key);
    this.jobs.push(job);
    return Promise.resolve(true);
  }

  dequeue(): Promise<ReviewJob | undefined> {
    const job = this.jobs.shift();
    if (job !== undefined) {
      this.pending.delete(jobKeyOf(job));
    }
    return Promise.resolve(job);
  }

  size(): Promise<number> {
    return Promise.resolve(this.jobs.length);
  }
}

/** In-memory state store keyed by the full {@link ReviewKey}. */
export class InMemoryStateStore implements StateStore {
  private readonly records = new Map<string, ReviewResult>();

  seen(key: ReviewKey): Promise<boolean> {
    return Promise.resolve(this.records.has(reviewKeyOf(key)));
  }

  record(key: ReviewKey, result: ReviewResult): Promise<void> {
    this.records.set(reviewKeyOf(key), result);
    return Promise.resolve();
  }
}

/** Deterministic clock; starts at a fixed instant and can be advanced. */
export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date = new Date('2026-01-01T00:00:00.000Z')) {
    this.current = start;
  }

  now(): Date {
    return new Date(this.current);
  }

  /** Move time forward by `ms` milliseconds. */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
