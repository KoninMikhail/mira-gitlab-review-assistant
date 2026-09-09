/**
 * Try Cursor API keys in order until one review/reply succeeds. Lives in the
 * adapter layer so core stays unaware of credentials.
 *
 * Next key is used only when the current run looks like a dead key / auth /
 * quota / non-zero agent exit. Timeouts and unparseable findings are not
 * retried across keys (those are not "this key is unavailable").
 */
import type { ReviewContext, ReviewResult } from '../../../core/domain/index.ts';
import type { AssistantEngine, AssistantRequest, ReviewEngine } from '../../../core/ports/index.ts';

export interface KeyFailoverLogger {
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface CursorKeySticky {
  lastGood: number;
}

export interface KeyFailoverEngineOptions {
  keys: () => string[];
  create: (apiKey: string) => ReviewEngine & AssistantEngine;
  isRetryable?: (err: unknown) => boolean;
  logger?: KeyFailoverLogger;
  sticky?: CursorKeySticky;
}

export class KeyFailoverEngine implements ReviewEngine, AssistantEngine {
  readonly #keys: () => string[];
  readonly #create: (apiKey: string) => ReviewEngine & AssistantEngine;
  readonly #isRetryable: (err: unknown) => boolean;
  readonly #logger: KeyFailoverLogger;
  readonly #sticky: CursorKeySticky;

  constructor(options: KeyFailoverEngineOptions) {
    this.#keys = options.keys;
    this.#create = options.create;
    this.#isRetryable = options.isRetryable ?? isRetryableCursorKeyError;
    this.#logger = options.logger ?? { warn(): void {} };
    this.#sticky = options.sticky ?? { lastGood: 0 };
  }

  review(context: ReviewContext): Promise<ReviewResult> {
    return this.#withKeys((engine) => engine.review(context));
  }

  reply(request: AssistantRequest): Promise<string> {
    return this.#withKeys((engine) => engine.reply(request));
  }

  async #withKeys<T>(run: (engine: ReviewEngine & AssistantEngine) => Promise<T>): Promise<T> {
    const keys = this.#keys();
    if (keys.length === 0) {
      throw new Error('CURSOR_API_KEY has no usable keys');
    }

    const start = ((this.#sticky.lastGood % keys.length) + keys.length) % keys.length;
    let lastError: unknown;

    for (let offset = 0; offset < keys.length; offset++) {
      const index = (start + offset) % keys.length;
      const apiKey = keys[index];
      if (apiKey === undefined) {
        continue;
      }
      try {
        const result = await run(this.#create(apiKey));
        this.#sticky.lastGood = index;
        return result;
      } catch (err: unknown) {
        lastError = err;
        const retry = offset < keys.length - 1 && this.#isRetryable(err);
        if (!retry) {
          throw err;
        }
        this.#logger.warn('engine.key.failover', {
          from_index: index,
          remaining: keys.length - offset - 1,
          error: messageOf(err),
        });
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

/** Non-zero agent exit / auth / quota — try the next key. Timeout and bad JSON — do not. */
export function isRetryableCursorKeyError(err: unknown): boolean {
  const msg = messageOf(err);
  if (/timed out/i.test(msg)) {
    return false;
  }
  if (/could not be validated/i.test(msg) || /no parseable findings/i.test(msg)) {
    return false;
  }
  if (/exited with code/i.test(msg)) {
    return true;
  }
  return /unauthorized|authentication|invalid api key|api key|status code 401|status code 403|\b429\b/i.test(
    msg,
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
