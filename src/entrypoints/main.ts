/**
 * Composition root for the MVP single-image service. Reads `ROLE` and wires the
 * core pipeline to concrete adapters (GitLab read, Kaiten read, SQLite store,
 * in-process queue, Cursor CLI engine, dry-run log publisher).
 *
 * Roles (docs/08-deployment.md §3, docs/13-project-structure.md §5):
 *   - `worker` — consume the queue, run reviews.
 *   - `poller` — discover ready MRs, enqueue jobs.
 *   - `api`    — `/healthz` only (webhook receiver lands in phase 2).
 *   - `all`    — poller + worker + healthz in one process (default MVP mode).
 *
 * This is glue: no business logic lives here. Live runs still require the bot's
 * repo access (🔑P2); without pilot projects the poller simply idles.
 */
import { loadConfig, loadPolicyConfigFile } from '../config/index.ts';
import type { MiraConfig, PolicyConfig, ProjectPolicy } from '../config/index.ts';
import { defaultProjectPolicy } from '../core/policy/index.ts';
import { resolvePolicy } from '../core/policy/index.ts';
import type { MrSummary, Publisher } from '../core/ports/index.ts';
import type { ReviewJob } from '../core/domain/index.ts';
import { createReviewPipeline, runWorker } from '../core/orchestrator/index.ts';
import { ContextBuilder, cloneUrlFromConfig } from '../core/context/index.ts';
import { GitLabReader, GitLabWriter } from '../adapters/vcs/gitlab/index.ts';
import { KaitenTracker } from '../adapters/tracker/kaiten/index.ts';
import { SqliteStateStore } from '../adapters/store/sqlite/index.ts';
import { InProcQueue } from '../adapters/queue/inproc/index.ts';
import { CliHeadlessEngine } from '../adapters/engine/cli/index.ts';
import type { CliHeadlessEngineOptions } from '../adapters/engine/cli/index.ts';
import { LogPublisher } from '../adapters/publisher/log/index.ts';
import { GitLabPublisher } from '../adapters/publisher/gitlab/index.ts';
import { createLogger, createMetricRegistry, METRIC_NAMES } from '../observability/index.ts';
import type { Logger } from '../observability/index.ts';
import { parseChatOps } from '../core/chatops/index.ts';
import { runApiServer } from './api/index.ts';
import type { NoteWebhookEvent } from './api/index.ts';
import { runPoller } from './poller/index.ts';

const PROMPT_VERSION = 'review.v1';
const PARTITION_VERSION = 'single.v1';
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_DB_PATH = 'mira.db';
const DEFAULT_HEALTH_PORT = 8080;

type Role = 'all' | 'api' | 'poller' | 'worker';

function parseRole(value: string | undefined): Role {
  switch (value) {
    case undefined:
    case '':
    case 'all':
      return 'all';
    case 'api':
    case 'poller':
    case 'worker':
      return value;
    default:
      throw new Error(`Unknown ROLE: ${value} (expected all|api|poller|worker)`);
  }
}

function loadPolicy(logger: {
  warn(msg: string, fields?: Record<string, unknown>): void;
}): PolicyConfig {
  const path = process.env['MIRA_POLICY_CONFIG'];
  if (path !== undefined && path.trim() !== '') {
    return loadPolicyConfigFile(path);
  }
  logger.warn('policy.config.missing', {
    detail: 'MIRA_POLICY_CONFIG not set; using defaults with no pilot projects',
  });
  return {
    defaults: defaultProjectPolicy,
    projects: {},
    discovery: { mode: 'explicit', projects: [] },
  };
}

async function main(): Promise<void> {
  const role = parseRole(process.env['ROLE']);
  const config = loadConfig();
  const logger = createLogger({ base: { service: 'mira', role } });
  const metrics = createMetricRegistry();
  const policyConfig = loadPolicy(logger);
  const policyFor = (projectId: string): ProjectPolicy => resolvePolicy(policyConfig, projectId);

  const wsRoot = workspaceRoot();
  const reader = GitLabReader.fromConfig(config.gitlab);
  const tracker = new KaitenTracker({ baseUrl: config.kaiten.baseUrl, token: config.kaiten.token });
  const store = new SqliteStateStore({ path: process.env['MIRA_DB_PATH'] ?? DEFAULT_DB_PATH });
  const queue = new InProcQueue();
  const publisher = createPublisher(config, store, logger);

  const contextBuilder = new ContextBuilder({
    vcsReader: reader,
    taskTracker: tracker,
    cloneUrlBuilder: cloneUrlFromConfig(config),
    ...(wsRoot !== undefined ? { workspaceRoot: wsRoot } : {}),
  });

  const handle = createReviewPipeline({
    contextBuilder,
    resolvePolicy: policyFor,
    createEngine: (workspaceDir) =>
      new CliHeadlessEngine(engineOptions(workspaceDir, config.cursor.apiKey)),
    publisher,
    store,
    logger,
    clock: { now: () => new Date() },
    promptVersion: PROMPT_VERSION,
    partitionVersion: PARTITION_VERSION,
    hooks: {
      onReviewStart: () => metrics.counter(METRIC_NAMES.reviewsTotal).inc(),
      onReviewDone: (durationMs, unitCount) => {
        metrics.histogram(METRIC_NAMES.reviewDurationSeconds).observe(durationMs / 1000);
        metrics.counter(METRIC_NAMES.reviewUnitsTotal).inc(unitCount);
      },
      onEngineError: () => metrics.counter(METRIC_NAMES.engineErrorsTotal).inc(),
    },
  });

  const controller = new AbortController();
  installShutdown(controller, queue, logger);

  const tasks: Array<Promise<void>> = [];

  if (role === 'api' || role === 'all') {
    logger.info('api.start', { port: healthPort() });
    tasks.push(
      runApiServer({
        port: healthPort(),
        signal: controller.signal,
        secret: config.gitlab.webhookSecret,
        policyFor,
        enqueue: (job: ReviewJob) => {
          void queue.enqueue(job);
        },
        onNote: (note: NoteWebhookEvent) => {
          void handleNote(note, queue, store, logger);
        },
        now: () => new Date(),
        logger,
      }),
    );
  }

  if (role === 'worker' || role === 'all') {
    logger.info('worker.start', { concurrency: concurrency() });
    tasks.push(
      runWorker({
        queue,
        handler: handle,
        concurrency: concurrency(),
        signal: controller.signal,
        logger: { error: (msg) => logger.error('worker.error', { error: msg }) },
      }),
    );
  }

  if (role === 'poller' || role === 'all') {
    const projects = policyConfig.discovery.projects;
    logger.info('poller.start', { projects: projects.length, interval_ms: pollIntervalMs() });
    const handled = new Set<string>();
    tasks.push(
      runPoller({
        lister: reader,
        projects,
        queue: {
          enqueue: async (job: ReviewJob) => {
            const accepted = await queue.enqueue(job);
            if (accepted) {
              handled.add(jobKey(job));
            }
            return accepted;
          },
        },
        policyFor,
        alreadyHandled: (mr: MrSummary) => handled.has(summaryKey(mr)),
        now: () => new Date(),
        intervalMs: pollIntervalMs(),
        signal: controller.signal,
        logger: { error: (msg) => logger.error('poller.error', { error: msg }) },
      }),
    );
  }

  await Promise.all(tasks);
  store.close();
  logger.info('shutdown.complete');
}

/**
 * Choose the publisher by `MIRA_PUBLISHER` (default `log` = dry-run). `gitlab`
 * publishes real, idempotent reviews under the bot account — keep it off until
 * the bot has write access to pilot repos (🔑P2).
 */
function createPublisher(config: MiraConfig, store: SqliteStateStore, logger: Logger): Publisher {
  const mode = (process.env['MIRA_PUBLISHER'] ?? 'log').trim().toLowerCase();
  if (mode === 'gitlab') {
    logger.info('publisher.gitlab', { dry_run: false });
    return new GitLabPublisher({
      writer: GitLabWriter.fromConfig(config.gitlab),
      ignoreStore: store,
      logger,
    });
  }
  logger.info('publisher.log', { dry_run: true });
  return new LogPublisher({ logger });
}

/**
 * Handle an MR comment: dispatch `@mira` ChatOps. `review` enqueues a re-review
 * of the note's head SHA; `ignore` mutes a finding fingerprint for the MR.
 */
async function handleNote(
  note: NoteWebhookEvent,
  queue: InProcQueue,
  store: SqliteStateStore,
  logger: Logger,
): Promise<void> {
  const command = parseChatOps(note.body);
  if (command === undefined) {
    return;
  }
  if (command.kind === 'ignore') {
    await store.ignore(note.projectId, note.mrIid, command.fingerprint);
    logger.info('chatops.ignore', {
      project_id: note.projectId,
      mr_iid: note.mrIid,
      fingerprint: command.fingerprint,
    });
    return;
  }
  if (note.headSha === '') {
    return;
  }
  await queue.enqueue({
    projectId: note.projectId,
    mrIid: note.mrIid,
    headSha: note.headSha,
    trigger: 'chatops',
    enqueuedAt: new Date().toISOString(),
  });
  logger.info('chatops.review', {
    project_id: note.projectId,
    mr_iid: note.mrIid,
    head_sha: note.headSha,
    full: command.full,
  });
}

function engineOptions(workspaceDir: string, apiKey: string): CliHeadlessEngineOptions {
  const options: CliHeadlessEngineOptions = {
    workspaceDir,
    env: { CURSOR_API_KEY: apiKey },
  };
  const bin = process.env['CURSOR_AGENT_BIN'];
  if (bin !== undefined && bin.trim() !== '') {
    options.cursorAgentBin = bin;
  }
  return options;
}

function concurrency(): number {
  const raw = process.env['MAX_CONCURRENCY'];
  const value = raw === undefined ? DEFAULT_CONCURRENCY : Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CONCURRENCY;
}

function pollIntervalMs(): number {
  const raw = process.env['POLL_INTERVAL_MS'];
  const value = raw === undefined ? DEFAULT_POLL_INTERVAL_MS : Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_POLL_INTERVAL_MS;
}

function workspaceRoot(): string | undefined {
  const raw = process.env['WORKSPACE_ROOT'];
  return raw !== undefined && raw.trim() !== '' ? raw : undefined;
}

function jobKey(job: ReviewJob): string {
  return `${job.projectId}\u0000${String(job.mrIid)}\u0000${job.headSha}`;
}

function summaryKey(mr: MrSummary): string {
  return `${mr.projectId}\u0000${String(mr.mrIid)}\u0000${mr.headSha}`;
}

function healthPort(): number {
  const raw = process.env['HEALTH_PORT'];
  const value = raw === undefined ? DEFAULT_HEALTH_PORT : Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_HEALTH_PORT;
}

function installShutdown(
  controller: AbortController,
  queue: InProcQueue,
  logger: ReturnType<typeof createLogger>,
): void {
  const onSignal = (signal: string): void => {
    logger.info('shutdown.signal', { signal });
    controller.abort();
    queue.close();
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // Composition-root failure (bad config, etc.): log and exit non-zero.
  process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'fatal', error: message })}\n`);
  process.exitCode = 1;
});

export { main };
