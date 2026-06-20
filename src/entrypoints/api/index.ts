/**
 * GitLab webhook API entrypoint: parsing, ingress debounce, and HTTP server.
 */
import type { ReviewJob } from '../../core/domain/index.ts';
import type { ProjectPolicy } from '../../core/policy/types.ts';
import { Debouncer } from './debounce.ts';
import { createWebhookServer, type CreateWebhookServerOptions } from './server.ts';

export { Debouncer, type DebouncerOptions, type TimerHandle } from './debounce.ts';
export {
  createWebhookServer,
  type CreateWebhookServerOptions,
  type WebhookServerLogger,
} from './server.ts';
export {
  mrEventToJob,
  parseWebhookEvent,
  verifyToken,
  type MrWebhookEvent,
  type NoteWebhookEvent,
  type WebhookEvent,
} from './webhook.ts';

const DEFAULT_DEBOUNCE_MS = 5_000;

export interface RunApiServerOptions extends CreateWebhookServerOptions {
  port: number;
  signal: AbortSignal;
  debounceWindowMs?: number;
}

/**
 * Listen for webhooks until `signal` aborts. Jobs pass through a {@link Debouncer}
 * before `enqueue` is invoked.
 */
export function runApiServer(options: RunApiServerOptions): Promise<void> {
  const { port, signal, debounceWindowMs, enqueue, ...rest } = options;
  const debouncer = new Debouncer({
    windowMs: debounceWindowMs ?? DEFAULT_DEBOUNCE_MS,
    onFlush: enqueue,
  });

  const server = createWebhookServer({
    ...rest,
    enqueue: (job: ReviewJob) => {
      debouncer.submit(job);
    },
  });

  return new Promise<void>((resolve) => {
    server.listen(port, () => {
      rest.logger?.info('webhook.listening', { port });
    });

    const close = (): void => {
      server.close(() => resolve());
    };
    if (signal.aborted) {
      close();
      return;
    }
    signal.addEventListener('abort', close, { once: true });
  });
}

export type { ProjectPolicy, ReviewJob };
