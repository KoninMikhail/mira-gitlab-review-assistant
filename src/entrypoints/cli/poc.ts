/**
 * Phase-0 PoC runner: wire the existing building blocks (GitLab read, local
 * checkout/diff, Kaiten card resolution, prompt+schema, cursor-agent engine)
 * into a single `poc --project <id> --mr <iid>` command that reviews one MR and
 * prints a readable summary.
 *
 * The orchestration is split so the pure parts (flag parsing, context assembly,
 * the severity formatter) and the wiring (`runPoc` with injected dependencies)
 * are unit-testable without real git, network, or engine. Live multi-MR runs
 * remain blocked on the bot's repo access (🔑P2); `--no-engine` lets us exercise
 * everything up to the agent call in the meantime.
 */
import os from 'node:os';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import type { MiraConfig } from '../../config/index.ts';
import { loadConfig as defaultLoadConfig, parseCursorApiKeys } from '../../config/index.ts';
import type { MrContext, ReviewEngine, TaskTracker, VcsReader } from '../../core/ports/index.ts';
import type {
  Finding,
  ReviewContext,
  ReviewResult,
  Severity,
  TaskCard,
} from '../../core/domain/index.ts';
import type { LinkResolverConfig, ResolveResult } from '../../core/linking/index.ts';
import { resolveCard } from '../../core/linking/index.ts';
import type { CheckoutResult, PrepareCheckoutOptions } from '../../core/context/checkout.ts';
import { buildCloneUrl, prepareCheckout } from '../../core/context/checkout.ts';
import { GitLabReader } from '../../adapters/vcs/gitlab/index.ts';
import { KaitenTracker } from '../../adapters/tracker/kaiten/index.ts';
import type { CliHeadlessEngineOptions } from '../../adapters/engine/cli/index.ts';
import { CliHeadlessEngine, KeyFailoverEngine } from '../../adapters/engine/cli/index.ts';
import { DEFAULT_CURSOR_MODEL } from '../../core/policy/defaults.ts';

const DEFAULT_MODEL = DEFAULT_CURSOR_MODEL;
const SEVERITY_ORDER: readonly Severity[] = ['blocker', 'major', 'minor', 'nit'];

export interface PocArgs {
  /** Numeric id or `group/sub/project` path. */
  projectId: string;
  mrIid: number;
  /** Checkout dir; defaults to a fresh temp dir under `os.tmpdir()`. */
  workspace?: string;
  cursorBin?: string;
  model?: string;
  /** Skip the agent run, print the assembled context only. */
  noEngine: boolean;
  /** Keep the checkout instead of deleting it. */
  keep: boolean;
}

/** Bad/missing CLI flags. Surfaced as a clean usage error, not a stack trace. */
export class PocArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PocArgsError';
  }
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Options handed to the engine factory (kept independent of the concrete impl). */
export interface EngineFactoryOptions {
  workspaceDir: string;
  model?: string;
  cursorAgentBin?: string;
  env?: NodeJS.ProcessEnv;
}

/** The slice of filesystem IO the runner needs; injectable for tests. */
export interface PocFs {
  mkdir(dir: string): Promise<void>;
  writeFile(file: string, data: string): Promise<void>;
  rm(dir: string): Promise<void>;
}

/** Injected dependencies; each defaults to the real implementation. */
export interface PocDeps {
  loadConfig: (env?: NodeJS.ProcessEnv) => MiraConfig;
  createReader: (config: MiraConfig) => VcsReader;
  createTracker: (config: MiraConfig) => TaskTracker;
  createEngine: (options: EngineFactoryOptions) => ReviewEngine;
  prepareCheckout: (options: PrepareCheckoutOptions) => Promise<CheckoutResult>;
  fs: PocFs;
  logger: Logger;
  resolverConfig?: LinkResolverConfig;
}

export interface PocRunResult {
  context: ReviewContext;
  cardResolution: ResolveResult;
  workspaceDir: string;
  /** Present unless `--no-engine` was passed. */
  review?: ReviewResult;
}

/** Parse `poc` flags into {@link PocArgs}. Pure; throws {@link PocArgsError}. */
export function parsePocArgs(argv: readonly string[]): PocArgs {
  let projectId: string | undefined;
  let mrRaw: string | undefined;
  let workspace: string | undefined;
  let cursorBin: string | undefined;
  let model: string | undefined;
  let noEngine = false;
  let keep = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--project':
        projectId = takeValue(argv, ++i, arg);
        break;
      case '--mr':
        mrRaw = takeValue(argv, ++i, arg);
        break;
      case '--workspace':
        workspace = takeValue(argv, ++i, arg);
        break;
      case '--cursor-bin':
        cursorBin = takeValue(argv, ++i, arg);
        break;
      case '--model':
        model = takeValue(argv, ++i, arg);
        break;
      case '--no-engine':
        noEngine = true;
        break;
      case '--keep':
        keep = true;
        break;
      default:
        throw new PocArgsError(`Unknown or unexpected argument: ${String(arg)}`);
    }
  }

  if (projectId === undefined) {
    throw new PocArgsError('Missing required flag: --project <id>');
  }
  if (mrRaw === undefined) {
    throw new PocArgsError('Missing required flag: --mr <iid>');
  }

  const mrIid = Number(mrRaw);
  if (!Number.isInteger(mrIid) || mrIid <= 0) {
    throw new PocArgsError(`--mr must be a positive integer, got: ${mrRaw}`);
  }

  const args: PocArgs = { projectId, mrIid, noEngine, keep };
  if (workspace !== undefined) args.workspace = workspace;
  if (cursorBin !== undefined) args.cursorBin = cursorBin;
  if (model !== undefined) args.model = model;
  return args;
}

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new PocArgsError(`Flag ${flag} requires a value`);
  }
  return value;
}

/** Assemble the engine-facing {@link ReviewContext} from MR metadata + diff (+ card). */
export function assembleReviewContext(mr: MrContext, diff: string, card?: TaskCard): ReviewContext {
  const context: ReviewContext = {
    job: { projectId: mr.projectId, mrIid: mr.mrIid, headSha: mr.headSha },
    title: mr.title,
    description: mr.description,
    sourceBranch: mr.sourceBranch,
    targetBranch: mr.targetBranch,
    changedFiles: mr.changedFiles,
    diff,
  };
  if (card !== undefined) {
    context.card = card;
  }
  return context;
}

/** Tally findings per severity (all buckets always present). */
export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}

/** Render a human-readable console summary: verdict, counts, findings, coverage. */
export function formatReviewSummary(review: ReviewResult): string {
  const counts = countBySeverity(review.findings);
  const lines: string[] = ['', '=== Review summary ===', `verdict: ${review.verdict}`];
  lines.push(
    SEVERITY_ORDER.map((severity) => `${severity}: ${String(counts[severity])}`).join('  '),
  );
  lines.push(`total: ${String(review.findings.length)}`, '');

  const ordered = [...review.findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  for (const finding of ordered) {
    lines.push(
      `[${finding.severity}/${finding.category}] ${finding.message} — ${formatLocation(finding)}`,
    );
    const detail = [
      finding.rationale,
      finding.suggestion ? `Suggestion: ${finding.suggestion}` : undefined,
    ]
      .filter((part): part is string => part !== undefined && part.trim() !== '')
      .join('\n');
    if (detail !== '') {
      lines.push(indent(detail));
    }
  }

  if (review.requirementsCoverage !== undefined && review.requirementsCoverage.length > 0) {
    lines.push('', 'Acceptance criteria:');
    for (const item of review.requirementsCoverage) {
      lines.push(`  - [${item.status}] ${item.criterion}`);
    }
  }

  if (review.degradations !== undefined && review.degradations.length > 0) {
    lines.push('', 'Degradations:');
    for (const note of review.degradations) {
      lines.push(`  - ${note}`);
    }
  }

  lines.push('', 'Summary:', review.summary.trim());
  return lines.join('\n');
}

function formatLocation(finding: Finding): string {
  if (finding.lineStart === undefined) {
    return finding.filePath;
  }
  const span =
    finding.lineEnd === undefined || finding.lineEnd === finding.lineStart
      ? String(finding.lineStart)
      : `${String(finding.lineStart)}-${String(finding.lineEnd)}`;
  return `${finding.filePath}:${span}`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

/**
 * Orchestrate one MR review. Returns the assembled context (+ review unless
 * `--no-engine`). All IO goes through injected {@link PocDeps}, so tests pass
 * fakes and never touch git/network/engine/fs.
 */
export async function runPoc(
  args: PocArgs,
  overrides: Partial<PocDeps> = {},
): Promise<PocRunResult> {
  const deps: PocDeps = { ...defaultDeps(), ...overrides };
  const { logger } = deps;

  const config = deps.loadConfig();
  const isTempWorkspace = args.workspace === undefined;
  const workspaceDir = args.workspace ?? defaultWorkspace(args);
  let shouldCleanup = false;

  try {
    logger.info(`Fetching MR !${String(args.mrIid)} from ${args.projectId} ...`);
    const mr = await deps.createReader(config).getMrContext(args.projectId, args.mrIid);

    logger.info(`Preparing checkout of ${mr.sourceBranch} into ${workspaceDir} ...`);
    const checkout = await deps.prepareCheckout({
      repoUrl: buildCloneUrl(config.gitlab.baseUrl, args.projectId, config.gitlab.token),
      sourceBranch: mr.sourceBranch,
      targetBranch: mr.targetBranch,
      workspaceDir,
    });
    shouldCleanup = isTempWorkspace && !args.keep;

    const cardResolution = await resolveCard(
      { title: mr.title, description: mr.description, sourceBranch: mr.sourceBranch },
      deps.createTracker(config),
      deps.resolverConfig,
    );
    if (cardResolution.found) {
      logger.info(`Linked Kaiten card ${cardResolution.card.id} (via ${cardResolution.strategy}).`);
    } else {
      logger.warn(`No linked card (${cardResolution.reason}); reviewing by diff only.`);
    }

    const context = assembleReviewContext(
      mr,
      checkout.diff,
      cardResolution.found ? cardResolution.card : undefined,
    );
    await persistContext(deps.fs, workspaceDir, context);

    const result: PocRunResult = { context, cardResolution, workspaceDir };

    if (args.noEngine) {
      logger.info('Skipping engine run (--no-engine); assembled context written to .mira/.');
      return result;
    }

    logger.info(`Running review engine (model ${args.model ?? DEFAULT_MODEL}) ...`);
    const engine = deps.createEngine(toEngineFactoryOptions(args, workspaceDir, config));
    const review = await engine.review(context);
    logger.info(formatReviewSummary(review));
    result.review = review;
    return result;
  } finally {
    if (shouldCleanup) {
      await deps.fs.rm(workspaceDir).catch(() => {
        // Best-effort cleanup; a leftover temp dir is not worth failing the run.
      });
    } else if (!isTempWorkspace || args.keep) {
      logger.info(`Checkout kept at ${workspaceDir}`);
    }
  }
}

/** Parse argv, run, and map failures to a non-zero `process.exitCode`. */
export async function mainPoc(argv: readonly string[]): Promise<void> {
  let args: PocArgs;
  try {
    args = parsePocArgs(argv);
  } catch (err) {
    console.error(messageOf(err));
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  try {
    await runPoc(args);
  } catch (err) {
    console.error(`poc failed: ${messageOf(err)}`);
    process.exitCode = 1;
  }
}

export function usage(): string {
  return [
    'Usage:',
    '  mira poc --project <id> --mr <iid> [options]',
    '',
    'Required:',
    '  --project <id>     Numeric project id or group/sub/project path',
    '  --mr <iid>         Merge request iid (positive integer)',
    '',
    'Options:',
    '  --workspace <dir>  Checkout dir (default: temp dir under os.tmpdir())',
    '  --model <slug>     Engine model (default: cursor-grok-4.6[fast=true])',
    '  --cursor-bin <p>   cursor-agent binary (use versioned .cmd on Windows)',
    '  --no-engine        Assemble + print context only; skip the agent run',
    '  --keep             Do not delete the checkout afterwards',
  ].join('\n');
}

function defaultDeps(): PocDeps {
  return {
    loadConfig: defaultLoadConfig,
    createReader: (config) => GitLabReader.fromConfig(config.gitlab),
    createTracker: (config) =>
      new KaitenTracker({ baseUrl: config.kaiten.baseUrl, token: config.kaiten.token }),
    createEngine: (options) =>
      new KeyFailoverEngine({
        keys: () => parseCursorApiKeys(options.env?.['CURSOR_API_KEY'] ?? ''),
        create: (apiKey) =>
          new CliHeadlessEngine(
            toCliEngineOptions({
              ...options,
              env: { ...options.env, CURSOR_API_KEY: apiKey },
            }),
          ),
      }),
    prepareCheckout,
    fs: nodeFs,
    logger: consoleLogger,
  };
}

function toEngineFactoryOptions(
  args: PocArgs,
  workspaceDir: string,
  config: MiraConfig,
): EngineFactoryOptions {
  const options: EngineFactoryOptions = {
    workspaceDir,
    env: { CURSOR_API_KEY: config.cursor.apiKey },
  };
  if (args.model !== undefined) options.model = args.model;
  if (args.cursorBin !== undefined) options.cursorAgentBin = args.cursorBin;
  return options;
}

function toCliEngineOptions(options: EngineFactoryOptions): CliHeadlessEngineOptions {
  const result: CliHeadlessEngineOptions = { workspaceDir: options.workspaceDir };
  if (options.model !== undefined) result.model = options.model;
  if (options.cursorAgentBin !== undefined) result.cursorAgentBin = options.cursorAgentBin;
  if (options.env !== undefined) result.env = options.env;
  return result;
}

function defaultWorkspace(args: PocArgs): string {
  const slug = args.projectId.replace(/[^\w.-]+/g, '-');
  return path.join(os.tmpdir(), `mira-poc-${slug}-mr${String(args.mrIid)}-${String(Date.now())}`);
}

async function persistContext(
  fs: PocFs,
  workspaceDir: string,
  context: ReviewContext,
): Promise<void> {
  const dir = path.join(workspaceDir, '.mira');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'context.json'), `${JSON.stringify(context, null, 2)}\n`);
}

const nodeFs: PocFs = {
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  writeFile: (file, data) => writeFile(file, data, 'utf8'),
  rm: (dir) => rm(dir, { recursive: true, force: true }),
};

const consoleLogger: Logger = {
  info: (message) => {
    console.log(message);
  },
  warn: (message) => {
    console.warn(message);
  },
  error: (message) => {
    console.error(message);
  },
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
