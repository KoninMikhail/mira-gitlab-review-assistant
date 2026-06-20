/**
 * Assembles a {@link ReviewContext} for the review engine: MR metadata from the
 * VCS reader, a local unified diff from an ephemeral checkout, and an optional
 * linked Kaiten card. All IO is injectable so tests use fakes — no real git,
 * network, or filesystem.
 */
import os from 'node:os';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import type { MiraConfig } from '../../config/index.ts';
import type { ReviewContext, ReviewJob, TaskCard } from '../domain/index.ts';
import type { Clock, MrContext, TaskTracker, VcsReader } from '../ports/index.ts';
import type { LinkResolverConfig } from '../linking/index.ts';
import { resolveCard } from '../linking/index.ts';
import type { CheckoutResult, PrepareCheckoutOptions } from './checkout.ts';
import { buildCloneUrl, prepareCheckout } from './checkout.ts';
import { buildWorkspacePath } from './workspace.ts';

export interface ContextFs {
  mkdir(dir: string): Promise<void>;
  writeFile(file: string, data: string): Promise<void>;
  rm(dir: string): Promise<void>;
}

export interface CloneUrlBuilder {
  build(projectId: string): string;
}

export interface ContextBuilderOptions {
  vcsReader: VcsReader;
  taskTracker: TaskTracker;
  cloneUrlBuilder: CloneUrlBuilder;
  prepareCheckout?: (options: PrepareCheckoutOptions) => Promise<CheckoutResult>;
  fs?: ContextFs;
  clock?: Clock;
  /** Parent directory for auto-created workspaces; defaults to `os.tmpdir()`. */
  workspaceRoot?: string;
  /** Explicit checkout dir; when omitted a fresh path under `workspaceRoot` is used. */
  workspaceDir?: string;
  /** Write `.mira/context.json` into the workspace (default: true). */
  writeContext?: boolean;
  resolverConfig?: LinkResolverConfig;
}

export interface ContextBuildResult {
  context: ReviewContext;
  workspaceDir: string;
  cleanup: () => Promise<void>;
}

/** Build an authenticated clone URL from {@link MiraConfig} GitLab settings. */
export function cloneUrlFromConfig(config: MiraConfig): CloneUrlBuilder {
  return {
    build(projectId: string): string {
      return buildCloneUrl(config.gitlab.baseUrl, projectId, config.gitlab.token);
    },
  };
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

export class ContextBuilder {
  private readonly vcsReader: VcsReader;
  private readonly taskTracker: TaskTracker;
  private readonly cloneUrlBuilder: CloneUrlBuilder;
  private readonly prepareCheckoutFn: (options: PrepareCheckoutOptions) => Promise<CheckoutResult>;
  private readonly fs: ContextFs;
  private readonly clock: Clock;
  private readonly workspaceRoot: string;
  private readonly workspaceDirOverride: string | undefined;
  private readonly writeContext: boolean;
  private readonly resolverConfig: LinkResolverConfig | undefined;

  constructor(options: ContextBuilderOptions) {
    this.vcsReader = options.vcsReader;
    this.taskTracker = options.taskTracker;
    this.cloneUrlBuilder = options.cloneUrlBuilder;
    this.prepareCheckoutFn = options.prepareCheckout ?? prepareCheckout;
    this.fs = options.fs ?? defaultContextFs();
    this.clock = options.clock ?? systemClock;
    this.workspaceRoot = options.workspaceRoot ?? os.tmpdir();
    this.workspaceDirOverride = options.workspaceDir;
    this.writeContext = options.writeContext ?? true;
    this.resolverConfig = options.resolverConfig;
  }

  async build(job: ReviewJob): Promise<ContextBuildResult> {
    const mr = await this.vcsReader.getMrContext(job.projectId, job.mrIid);

    const workspaceDir =
      this.workspaceDirOverride ??
      buildWorkspacePath({
        rootDir: this.workspaceRoot,
        projectId: job.projectId,
        mrIid: job.mrIid,
        now: this.clock.now(),
      });

    const checkout = await this.prepareCheckoutFn({
      repoUrl: this.cloneUrlBuilder.build(job.projectId),
      sourceBranch: mr.sourceBranch,
      targetBranch: mr.targetBranch,
      workspaceDir,
    });

    const cardResolution = await resolveCard(
      { title: mr.title, description: mr.description, sourceBranch: mr.sourceBranch },
      this.taskTracker,
      this.resolverConfig,
    );

    const context = assembleReviewContext(
      mr,
      checkout.diff,
      cardResolution.found ? cardResolution.card : undefined,
    );

    if (this.writeContext) {
      await persistContext(this.fs, workspaceDir, context);
    }

    const cleanup = async (): Promise<void> => {
      await this.fs.rm(workspaceDir).catch(() => {
        // Best-effort; a leftover temp dir is not worth failing the caller.
      });
    };

    return { context, workspaceDir, cleanup };
  }
}

async function persistContext(
  fs: ContextFs,
  workspaceDir: string,
  context: ReviewContext,
): Promise<void> {
  const dir = path.join(workspaceDir, '.mira');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'context.json'), `${JSON.stringify(context, null, 2)}\n`);
}

function defaultContextFs(): ContextFs {
  return {
    mkdir: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
    writeFile: (file, data) => writeFile(file, data, 'utf8'),
    rm: (dir) => rm(dir, { recursive: true, force: true }),
  };
}

const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
};
