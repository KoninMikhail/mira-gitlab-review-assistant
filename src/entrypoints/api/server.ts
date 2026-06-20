/**
 * Thin HTTP wiring for the GitLab webhook receiver. Parsing and policy logic
 * live in {@link ./webhook.ts}; this module only handles transport.
 */
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ReviewJob } from '../../core/domain/index.ts';
import type { ProjectPolicy } from '../../core/policy/types.ts';
import { mrEventToJob, parseWebhookEvent, verifyToken, type NoteWebhookEvent } from './webhook.ts';

export interface WebhookServerLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface CreateWebhookServerOptions {
  secret: string;
  policyFor: (projectId: string) => ProjectPolicy;
  enqueue: (job: ReviewJob) => void;
  onNote?: (note: NoteWebhookEvent) => void;
  now?: () => Date;
  logger?: WebhookServerLogger;
}

/** Create a Node HTTP server for `/webhook` and `/healthz`. */
export function createWebhookServer(options: CreateWebhookServerOptions): http.Server {
  const now = options.now ?? ((): Date => new Date());

  return http.createServer((req, res) => {
    void handleRequest(req, res, options, now);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: CreateWebhookServerOptions,
  now: () => Date,
): Promise<void> {
  const { method, url } = req;

  if (method === 'GET' && url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (method !== 'POST' || url !== '/webhook') {
    res.writeHead(404);
    res.end();
    return;
  }

  const token = req.headers['x-gitlab-token'];
  const tokenValue = Array.isArray(token) ? token[0] : token;
  if (!verifyToken(tokenValue, options.secret)) {
    res.writeHead(401);
    res.end();
    return;
  }

  let payload: unknown;
  try {
    const body = await readBody(req);
    payload = JSON.parse(body.toString('utf8')) as unknown;
  } catch (err: unknown) {
    options.logger?.warn('webhook.bad_json', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.writeHead(400);
    res.end();
    return;
  }

  const eventHeader = req.headers['x-gitlab-event'];
  const headerValue = Array.isArray(eventHeader) ? eventHeader[0] : eventHeader;
  const event = parseWebhookEvent(headerValue, payload);

  if (event === undefined) {
    res.writeHead(204);
    res.end();
    return;
  }

  if (event.kind === 'mr') {
    const policy = options.policyFor(event.projectId);
    const job = mrEventToJob(event, policy, now);
    if (job !== undefined) {
      options.enqueue(job);
    }
    res.writeHead(202);
    res.end();
    return;
  }

  options.onNote?.(event);
  res.writeHead(202);
  res.end();
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
