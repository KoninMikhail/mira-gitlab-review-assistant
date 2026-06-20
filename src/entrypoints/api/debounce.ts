/**
 * Ingress debounce and dedup (T2.5). Collapses rapid webhook bursts per MR and
 * suppresses duplicate deliveries of the same job key before flush.
 */
import type { ReviewJob } from '../../core/domain/index.ts';

/** Opaque timer handle — defaults to Node `Timeout`; tests inject fakes. */
export type TimerHandle = unknown;

export interface DebouncerOptions {
  /** Quiet period before flushing the latest job for an MR. */
  windowMs: number;
  /** Called once per MR after the debounce window with the latest job. */
  onFlush: (job: ReviewJob) => void;
  schedule?: (fn: () => void, ms: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
}

/**
 * Debounces review jobs per `(projectId, mrIid)` and deduplicates exact replays.
 *
 * - **Debounce**: at most one pending timer per MR; a newer submit replaces the
 *   pending job and resets the window so a burst of pushes yields one review of
 *   the latest SHA.
 * - **Dedup**: `(projectId, mrIid, headSha, trigger)` keys already submitted
 *   return `'duplicate'` without rescheduling (covers GitLab redelivery).
 */
export class Debouncer {
  private readonly windowMs: number;
  private readonly onFlush: (job: ReviewJob) => void;
  private readonly schedule: (fn: () => void, ms: number) => TimerHandle;
  private readonly cancel: (handle: TimerHandle) => void;
  private readonly seenKeys = new Set<string>();
  private readonly pendingByMr = new Map<string, { job: ReviewJob; handle: TimerHandle }>();

  constructor(options: DebouncerOptions) {
    this.windowMs = options.windowMs;
    this.onFlush = options.onFlush;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel =
      options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Submit a job for debounced enqueue. */
  submit(job: ReviewJob): 'scheduled' | 'replaced' | 'duplicate' {
    const dedupKey = jobKey(job);
    if (this.seenKeys.has(dedupKey)) {
      return 'duplicate';
    }
    this.seenKeys.add(dedupKey);

    const mr = mrKey(job);
    const existing = this.pendingByMr.get(mr);
    if (existing !== undefined) {
      this.cancel(existing.handle);
      const handle = this.schedule(() => this.flush(mr), this.windowMs);
      this.pendingByMr.set(mr, { job, handle });
      return 'replaced';
    }

    const handle = this.schedule(() => this.flush(mr), this.windowMs);
    this.pendingByMr.set(mr, { job, handle });
    return 'scheduled';
  }

  /** Number of MRs with a pending debounce timer. */
  pending(): number {
    return this.pendingByMr.size;
  }

  private flush(mr: string): void {
    const entry = this.pendingByMr.get(mr);
    if (entry === undefined) {
      return;
    }
    this.pendingByMr.delete(mr);
    this.onFlush(entry.job);
  }
}

function jobKey(job: ReviewJob): string {
  return `${job.projectId}\u0000${String(job.mrIid)}\u0000${job.headSha}\u0000${job.trigger}`;
}

function mrKey(job: ReviewJob): string {
  return `${job.projectId}\u0000${String(job.mrIid)}`;
}
