/**
 * Composition root for the MVP single-image service. Reads `ROLE` and wires the
 * core pipeline to concrete adapters (GitLab read, Kaiten read, SQLite store,
 * in-process queue, Cursor CLI engine, dry-run log publisher).
 *
 * Roles (docs/05-operations/deployment.md §3, docs/04-architecture/adr/003-modular-monolith-roles.md §5):
 *   - `worker` — consume the queue, run reviews.
 *   - `poller` — discover ready MRs, enqueue jobs.
 *   - `api`    — `/healthz` only (webhook receiver lands in phase 2).
 *   - `all`    — poller + worker + healthz in one process (default MVP mode).
 *
 * This is glue: no business logic lives here. Live runs still require the bot's
 * repo access (🔑P2); without pilot projects the poller simply idles.
 */
import os from 'node:os';
import path from 'node:path';

import { loadConfig, loadPolicyConfigFile } from '../config/index.ts';
import { assertProfilesResolvable, loadProfiles } from '../config/index.ts';
import type { MiraConfig, PolicyConfig, ProfileSet, ProjectPolicy } from '../config/index.ts';
import { defaultProjectPolicy } from '../core/policy/index.ts';
import { resolvePolicy } from '../core/policy/index.ts';
import type {
  IgnoreStore,
  MrSummary,
  Publisher,
  Queue,
  StateStore,
  TaskTracker,
} from '../core/ports/index.ts';
import type { ReviewJob } from '../core/domain/index.ts';
import { createReviewPipeline, runWorker } from '../core/orchestrator/index.ts';
import { ContextBuilder, cloneUrlFromConfig, prepareMirrorCheckout } from '../core/context/index.ts';
import type { CheckoutResult, PrepareCheckoutOptions } from '../core/context/index.ts';
import { GitLabCiReader, GitLabReader, GitLabWriter } from '../adapters/vcs/gitlab/index.ts';
import { CI_RETRY_MS } from '../core/ci/index.ts';
import { KaitenTracker } from '../adapters/tracker/kaiten/index.ts';
import { SqliteStateStore } from '../adapters/store/sqlite/index.ts';
import { PostgresStateStore } from '../adapters/store/postgres/index.ts';
import type { PgPoolLike } from '../adapters/store/postgres/index.ts';
import { InProcQueue } from '../adapters/queue/inproc/index.ts';
import { RedisQueue } from '../adapters/queue/redis/index.ts';
import type { RedisLike } from '../adapters/queue/redis/index.ts';
import { CachingTaskTracker } from '../adapters/cache/index.ts';
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
const DEFAULT_PROFILES_DIR = 'profiles';
const DEFAULT_READ_CACHE_TTL_MS = 300_000;
const DEFAULT_READ_CACHE_MAX_ENTRIES = 256;
const MIRROR_CACHE_DIRNAME = 'mira-mirror-cache';

type Role = 'all' | 'api' | 'poller' | 'worker';

/**
 * Queue surface the composition root relies on: the {@link Queue} port plus the
 * blocking pull used by the worker, a sync `close`, and an optional async
 * `quit` (Redis client teardown). Both `InProcQueue` and `RedisQueue` satisfy it.
 */
type AppQueue = Queue & {
  take(signal?: AbortSignal): Promise<ReviewJob | undefined>;
  close(): void;
  quit?(): Promise<unknown>;
};

/** State store surface: persistence + ignore list, with optional `close`. */
type AppStore = StateStore & IgnoreStore & { close?(): void };

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
  const profiles = loadStackProfiles(policyConfig, logger);

  const wsRoot = workspaceRoot();
  const reader = GitLabReader.fromConfig(config.gitlab);
  const tracker = createTracker(config, logger);
  const store = await createStore(logger);
  const queue = await createQueue(logger);
  const publisher = createPublisher(config, store, logger);

  const contextBuilder = new ContextBuilder({
    vcsReader: reader,
    taskTracker: tracker,
    cloneUrlBuilder: cloneUrlFromConfig(config),
    ...(wsRoot !== undefined ? { workspaceRoot: wsRoot } : {}),
    ...checkoutOption(wsRoot, logger),
  });

  const handled = new Set<string>();
  const ciRetryTimers = new Set<ReturnType<typeof setTimeout>>();

  const handle = createReviewPipeline({
    contextBuilder,
    resolvePolicy: policyFor,
    createEngine: (workspaceDir, policy) =>
      new CliHeadlessEngine(
        engineOptions(
          workspaceDir,
          config.cursor.apiKey,
          policy,
          profiles.guidanceFor(policy.profile),
        ),
      ),
    publisher,
    store,
    logger,
    clock: { now: () => new Date() },
    promptVersion: PROMPT_VERSION,
    partitionVersion: PARTITION_VERSION,
    resolveGuidanceVersion: (policy) => profiles.versionFor(policy.profile),
    ciReader: GitLabCiReader.fromConfig(config.gitlab),
    onWaiting: (job) => {
      handled.delete(jobKey(job));
      const timer = setTimeout(() => {
        ciRetryTimers.delete(timer);
        void queue.enqueue(job);
      }, CI_RETRY_MS);
      ciRetryTimers.add(timer);
    },
    onCiMayChange: (job) => {
      handled.delete(jobKey(job));
    },
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
  controller.signal.addEventListener('abort', () => {
    for (const timer of ciRetryTimers) {
      clearTimeout(timer);
    }
    ciRetryTimers.clear();
  });

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
  store.close?.();
  if (queue.quit !== undefined) {
    await queue.quit();
  }
  logger.info('shutdown.complete');
}

/**
 * Choose the publisher by `MIRA_PUBLISHER` (default `log` = dry-run). `gitlab`
 * publishes real, idempotent reviews under the bot account — keep it off until
 * the bot has write access to pilot repos (🔑P2).
 */
function createPublisher(config: MiraConfig, store: IgnoreStore, logger: Logger): Publisher {
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
  queue: AppQueue,
  store: IgnoreStore,
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

function engineOptions(
  workspaceDir: string,
  apiKey: string,
  policy: ProjectPolicy,
  profileGuidance: string | undefined,
): CliHeadlessEngineOptions {
  const options: CliHeadlessEngineOptions = {
    workspaceDir,
    model: policy.model,
    env: { CURSOR_API_KEY: apiKey },
  };
  if (profileGuidance !== undefined && profileGuidance.trim() !== '') {
    options.profileGuidance = profileGuidance;
  }
  const bin = process.env['CURSOR_AGENT_BIN'];
  if (bin !== undefined && bin.trim() !== '') {
    options.cursorAgentBin = bin;
  }
  return options;
}

/**
 * Load stack profiles (layer B) from `MIRA_PROFILES_DIR` (default `profiles/`)
 * and fail fast if any policy references a profile that does not exist.
 */
function loadStackProfiles(
  policyConfig: PolicyConfig,
  logger: { info(msg: string, fields?: Record<string, unknown>): void },
): ProfileSet {
  const dir = process.env['MIRA_PROFILES_DIR']?.trim() || DEFAULT_PROFILES_DIR;
  const profiles = loadProfiles(dir);

  const referenced = new Set<string>();
  if (policyConfig.defaults.profile !== undefined) {
    referenced.add(policyConfig.defaults.profile);
  }
  for (const override of Object.values(policyConfig.projects)) {
    if (override.profile !== undefined) {
      referenced.add(override.profile);
    }
  }
  assertProfilesResolvable(profiles, referenced);

  logger.info('profiles.loaded', {
    dir,
    available: profiles.names.length,
    referenced: referenced.size,
  });
  return profiles;
}

/**
 * Build the job queue. `MIRA_QUEUE=redis` enables the shared Redis queue (needs
 * `REDIS_URL`), allowing multiple worker processes to drain one queue; default
 * `inproc` is the single-process MVP queue.
 */
async function createQueue(logger: Logger): Promise<AppQueue> {
  const mode = (process.env['MIRA_QUEUE'] ?? 'inproc').trim().toLowerCase();
  if (mode === 'redis') {
    const url = process.env['REDIS_URL'];
    if (url === undefined || url.trim() === '') {
      throw new Error('MIRA_QUEUE=redis requires REDIS_URL');
    }
    const redis = await createRedisClient(url.trim());
    const prefix = process.env['MIRA_QUEUE_PREFIX']?.trim();
    logger.info('queue.redis', { prefix: prefix !== undefined && prefix !== '' ? prefix : 'mira' });
    return new RedisQueue({
      redis,
      ...(prefix !== undefined && prefix !== '' ? { keyPrefix: prefix } : {}),
    });
  }
  logger.info('queue.inproc');
  return new InProcQueue();
}

/**
 * Build the state store. `MIRA_STORE=postgres` enables the Postgres store (needs
 * `DATABASE_URL`) for concurrent multi-worker writes; default `sqlite` is the
 * single-node MVP store.
 */
async function createStore(logger: Logger): Promise<AppStore> {
  const mode = (process.env['MIRA_STORE'] ?? 'sqlite').trim().toLowerCase();
  if (mode === 'postgres') {
    const url = process.env['DATABASE_URL'] ?? process.env['POSTGRES_URL'];
    if (url === undefined || url.trim() === '') {
      throw new Error('MIRA_STORE=postgres requires DATABASE_URL (or POSTGRES_URL)');
    }
    const pool = await createPgPool(url.trim());
    logger.info('store.postgres');
    return new PostgresStateStore({ pool });
  }
  const dbPath = process.env['MIRA_DB_PATH'] ?? DEFAULT_DB_PATH;
  logger.info('store.sqlite', { path: dbPath });
  return new SqliteStateStore({ path: dbPath });
}

/**
 * Build the task tracker, optionally wrapped in a TTL read cache
 * (`MIRA_READ_CACHE=on`) so repeated lookups of the same Kaiten card are served
 * from memory instead of re-hitting the API.
 */
function createTracker(config: MiraConfig, logger: Logger): TaskTracker {
  const inner = new KaitenTracker({ baseUrl: config.kaiten.baseUrl, token: config.kaiten.token });
  if ((process.env['MIRA_READ_CACHE'] ?? 'off').trim().toLowerCase() !== 'on') {
    return inner;
  }
  const ttlMs = readCacheTtlMs();
  logger.info('tracker.cache', { ttl_ms: ttlMs });
  return new CachingTaskTracker({ inner, ttlMs, maxEntries: DEFAULT_READ_CACHE_MAX_ENTRIES });
}

/**
 * Optional checkout strategy. `MIRA_CHECKOUT=mirror` reuses a persistent bare
 * object cache (`MIRA_CHECKOUT_CACHE_DIR`) across reviews to speed up clones;
 * default is a fresh blobless clone per job.
 */
function checkoutOption(
  wsRoot: string | undefined,
  logger: Logger,
): { prepareCheckout?: (options: PrepareCheckoutOptions) => Promise<CheckoutResult> } {
  if ((process.env['MIRA_CHECKOUT'] ?? 'fresh').trim().toLowerCase() !== 'mirror') {
    return {};
  }
  const configured = process.env['MIRA_CHECKOUT_CACHE_DIR']?.trim();
  const cacheDir =
    configured !== undefined && configured !== ''
      ? configured
      : path.join(wsRoot ?? os.tmpdir(), MIRROR_CACHE_DIRNAME);
  logger.info('checkout.mirror', { cache_dir: cacheDir });
  return {
    prepareCheckout: (options: PrepareCheckoutOptions): Promise<CheckoutResult> =>
      prepareMirrorCheckout({ ...options, cacheDir }),
  };
}

/**
 * Lazily import `ioredis` only when the Redis queue is selected, so the package
 * stays an optional dependency that the default in-process path never needs.
 */
async function createRedisClient(url: string): Promise<RedisLike> {
  const specifier: string = 'ioredis';
  const mod = (await import(specifier)) as { default: new (connection: string) => RedisLike };
  const RedisCtor = mod.default;
  return new RedisCtor(url);
}

/** Lazily import `pg` only when the Postgres store is selected (optional dep). */
async function createPgPool(connectionString: string): Promise<PgPoolLike> {
  const specifier: string = 'pg';
  type PgPoolCtor = new (config: { connectionString: string }) => PgPoolLike;
  const mod = (await import(specifier)) as { Pool?: PgPoolCtor; default?: { Pool?: PgPoolCtor } };
  const PoolCtor = mod.Pool ?? mod.default?.Pool;
  if (PoolCtor === undefined) {
    throw new Error('pg module did not export a Pool constructor');
  }
  return new PoolCtor({ connectionString });
}

function readCacheTtlMs(): number {
  const raw = process.env['MIRA_READ_CACHE_TTL_MS'];
  const value = raw === undefined ? DEFAULT_READ_CACHE_TTL_MS : Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_READ_CACHE_TTL_MS;
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
  queue: AppQueue,
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
