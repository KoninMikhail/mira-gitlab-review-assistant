/**
 * `CliHeadlessEngine` — a `ReviewEngine` that drives the Cursor CLI
 * (`cursor-agent`) headless with Cursor Grok 4.6 Fast (default effort).
 *
 * Flow: render `prompts/review.v1.md` from the `ReviewContext`, run
 * `cursor-agent -p --output-format json --model <model> --force --trust` in the
 * MR checkout (prompt piped via stdin), then read back the review either from
 * the `findings.json` the agent writes or from the fenced ```json block it
 * echoes, and validate it against the shared findings schema.
 *
 * ⚠ Windows caveat: the root `cursor-agent.cmd`/`.ps1` wrapper is broken
 * ("No version directories"); point `cursorAgentBin` at the versioned binary,
 * e.g. `...\\versions\\<version>\\cursor-agent.cmd`.
 */
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ReviewContext, ReviewResult } from '../../../core/domain/index.ts';
import type {
  AssistantEngine,
  AssistantRequest,
  AssistantThreadMessage,
  ReviewEngine,
} from '../../../core/ports/index.ts';
import { validateFindings } from '../../../core/findings/index.ts';
import { DEFAULT_CURSOR_MODEL } from '../../../core/policy/defaults.ts';
import { nodeSpawn } from './spawn.ts';

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type SpawnLike = (
  bin: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal },
) => Promise<SpawnResult>;

export interface CliHeadlessEngineOptions {
  /** Working directory where the agent runs and writes findings.json (the MR checkout). */
  workspaceDir: string;
  /** Model slug; default Cursor Grok 4.6 Fast (`cursor-grok-4.6-high-fast`). */
  model?: string;
  /** Absolute path to the prompt template; default resolves repo `prompts/review.v1.md`. */
  promptPath?: string;
  /** Absolute path to the assistant prompt template; default resolves repo `prompts/assistant.v1.md`. */
  assistantPromptPath?: string;
  /** cursor-agent binary/command; default 'cursor-agent' (override on Windows with versioned .cmd). */
  cursorAgentBin?: string;
  /** Extra env (e.g. CURSOR_API_KEY); merged over process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injectable process spawner for tests; defaults to a node:child_process impl. */
  spawn?: SpawnLike;
  /** Max wall time per agent run; default 600_000 (10 min). Aborts the child via {@link AbortSignal}. */
  timeoutMs?: number;
  /** Globs to tell the agent to ignore; default e.g. lock files + generated. */
  ignoredGlobs?: string[];
  /**
   * Stack-profile guidance (layer B) injected at the `{{profile_guidance}}`
   * placeholder. Omit / empty for no stack-specific guidance.
   */
  profileGuidance?: string;
}

const DEFAULT_MODEL = DEFAULT_CURSOR_MODEL;
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_PROMPT_PATH = path.resolve(process.cwd(), 'prompts', 'review.v1.md');
const DEFAULT_ASSISTANT_PROMPT_PATH = path.resolve(process.cwd(), 'prompts', 'assistant.v1.md');
const FINDINGS_FILENAME = 'findings.json';
const STDERR_MAX = 4000;

const DEFAULT_IGNORED_GLOBS = [
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/*.lock',
  '**/dist/**',
  '**/build/**',
  '**/node_modules/**',
  '**/*.min.js',
  '**/*.map',
];

export class CliHeadlessEngine implements ReviewEngine, AssistantEngine {
  readonly #workspaceDir: string;
  readonly #model: string;
  readonly #promptPath: string;
  readonly #assistantPromptPath: string;
  readonly #bin: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #spawn: SpawnLike;
  readonly #timeoutMs: number;
  readonly #ignoredGlobs: string[];
  readonly #profileGuidance: string;

  constructor(options: CliHeadlessEngineOptions) {
    this.#workspaceDir = options.workspaceDir;
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#promptPath = options.promptPath ?? DEFAULT_PROMPT_PATH;
    this.#assistantPromptPath = options.assistantPromptPath ?? DEFAULT_ASSISTANT_PROMPT_PATH;
    this.#bin = options.cursorAgentBin ?? 'cursor-agent';
    this.#env = { ...process.env, ...options.env };
    this.#spawn = options.spawn ?? nodeSpawn;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#ignoredGlobs = options.ignoredGlobs ?? DEFAULT_IGNORED_GLOBS;
    this.#profileGuidance = options.profileGuidance ?? '';
  }

  async review(context: ReviewContext): Promise<ReviewResult> {
    const template = await readFile(this.#promptPath, 'utf8');
    const prompt = renderPrompt(template, context, this.#ignoredGlobs, this.#profileGuidance);

    const args = ['-p', '--output-format', 'json', '--model', this.#model, '--force', '--trust'];

    // Retry once only when exit code is 0 but findings JSON cannot be extracted or
    // fails schema validation. Non-zero exit, CLI logical failures (dead model
    // slug, region, bad key), and timeout are not retried.
    let lastError: Error | undefined;
    let lastStdout = '';

    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await this.#clearFindingsFile();
      }

      const result = await this.#runAgent(args, prompt);
      lastStdout = result.stdout;

      if (result.code !== 0) {
        const detail = truncate(result.stderr.trim() || result.stdout.trim(), STDERR_MAX);
        throw new Error(
          `cursor-agent exited with code ${String(result.code)}:\n${detail || '(no output)'}`,
        );
      }

      const logical = detectCursorCliLogicalFailure(result.stdout, result.stderr);
      if (logical !== undefined) {
        throw new Error(logical);
      }

      try {
        const parsed = await this.#extractFindings(result.stdout);
        return validateFindings(parsed);
      } catch (cause) {
        lastError = cause instanceof Error ? cause : new Error(String(cause));
      }
    }

    const stdoutHint = truncate(lastStdout.trim(), STDERR_MAX);
    throw new Error(
      `Review degraded after retry: cursor-agent output could not be validated.\n${lastError?.message ?? 'unknown error'}` +
        (stdoutHint === '' ? '' : `\nstdout: ${stdoutHint}`),
      { cause: lastError },
    );
  }

  async reply(request: AssistantRequest): Promise<string> {
    const template = await readFile(this.#assistantPromptPath, 'utf8');
    const prompt = renderAssistantPrompt(
      template,
      request,
      this.#ignoredGlobs,
      this.#profileGuidance,
    );

    const args = ['-p', '--output-format', 'json', '--model', this.#model, '--force', '--trust'];
    const result = await this.#runAgent(args, prompt);

    if (result.code !== 0) {
      const detail = truncate(result.stderr.trim() || result.stdout.trim(), STDERR_MAX);
      throw new Error(
        `cursor-agent exited with code ${String(result.code)}:\n${detail || '(no output)'}`,
      );
    }

    const logical = detectCursorCliLogicalFailure(result.stdout, result.stderr);
    if (logical !== undefined) {
      throw new Error(logical);
    }

    return parseAssistantTextFromStdout(result.stdout);
  }

  async #runAgent(args: string[], prompt: string): Promise<SpawnResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const spawnPromise = this.#spawn(this.#bin, args, {
        cwd: this.#workspaceDir,
        env: this.#env,
        input: prompt,
        signal: controller.signal,
      });

      const timeoutPromise = new Promise<SpawnResult>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`cursor-agent timed out after ${String(this.#timeoutMs)}ms`));
        }, this.#timeoutMs);
      });

      return await Promise.race([spawnPromise, timeoutPromise]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  async #clearFindingsFile(): Promise<void> {
    const filePath = path.join(this.#workspaceDir, FINDINGS_FILENAME);
    try {
      await unlink(filePath);
    } catch {
      // Ignore missing or unreadable stale output before a retry.
    }
  }

  /**
   * Resolve the review output, preferring the on-disk `findings.json` and
   * falling back to the fenced JSON the agent echoes in its message.
   */
  async #extractFindings(stdout: string): Promise<unknown> {
    const fromFile = await this.#readFindingsFile();
    if (fromFile !== undefined) {
      return fromFile;
    }

    const fromStdout = parseFindingsFromStdout(stdout);
    if (fromStdout !== undefined) {
      return fromStdout;
    }

    throw new Error(
      `cursor-agent produced no parseable findings: no ${FINDINGS_FILENAME} in ` +
        `workspace and no fenced JSON block in stdout.`,
    );
  }

  async #readFindingsFile(): Promise<unknown> {
    const filePath = path.join(this.#workspaceDir, FINDINGS_FILENAME);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      return undefined;
    }
    try {
      return JSON.parse(raw);
    } catch (cause) {
      throw new Error(`Failed to parse ${FINDINGS_FILENAME}: ${messageOf(cause)}`, { cause });
    }
  }
}

const NO_PROFILE_GUIDANCE =
  '(no stack-specific profile configured — apply general best practices for the ' +
  'languages present in the diff)';

/**
 * Render the versioned prompt template by substituting every `{{...}}`
 * placeholder. `task.*` come from the linked card when present; otherwise a
 * clear "review by diff only" note is used. `profileGuidance` is the optional
 * stack-profile body (layer B); empty falls back to a neutral note.
 */
export function renderPrompt(
  template: string,
  context: ReviewContext,
  ignoredGlobs: string[],
  profileGuidance = '',
): string {
  const substitutions: Record<string, string> = {
    ...buildBaseSubstitutions(context, ignoredGlobs, profileGuidance),
    'ci.status': renderCiStatus(context),
    'ci.failures': renderCiFailures(context),
  };

  return applySubstitutions(template, substitutions);
}

/**
 * Render the assistant prompt template: same MR/task/file/profile placeholders as
 * {@link renderPrompt}, plus chat context for conversational replies.
 */
export function renderAssistantPrompt(
  template: string,
  request: AssistantRequest,
  ignoredGlobs: string[],
  profileGuidance = '',
): string {
  const substitutions: Record<string, string> = {
    ...buildBaseSubstitutions(request.context, ignoredGlobs, profileGuidance),
    'mr.title': request.context.title,
    'mr.description': request.context.description,
    'chat.kind': request.kind,
    'chat.user_message': request.userMessage,
    'chat.thread': renderAssistantThread(request.thread),
  };

  return applySubstitutions(template, substitutions);
}

function buildBaseSubstitutions(
  context: ReviewContext,
  ignoredGlobs: string[],
  profileGuidance: string,
): Record<string, string> {
  const card = context.card;

  return {
    'task.title': card?.title ?? '(no linked card — review by diff only)',
    'task.description':
      card?.description ?? 'No linked Kaiten card was resolved; review the diff on its own merits.',
    'task.acceptance_criteria': renderAcceptanceCriteria(card?.acceptanceCriteria ?? []),
    'mr.iid': String(context.job.mrIid),
    'mr.source_branch': context.sourceBranch,
    'mr.target_branch': context.targetBranch,
    'mr.sha': context.job.headSha,
    changed_files: renderChangedFiles(context.changedFiles),
    ignored_globs: ignoredGlobs.join(', '),
    profile_guidance: profileGuidance.trim() === '' ? NO_PROFILE_GUIDANCE : profileGuidance.trim(),
  };
}

function applySubstitutions(template: string, substitutions: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = substitutions[key];
    return value ?? '';
  });
}

function renderAssistantThread(thread: readonly AssistantThreadMessage[]): string {
  if (thread.length === 0) {
    return '(empty — first message in this conversation)';
  }

  return thread
    .map((message) => {
      const header =
        message.role === 'mira'
          ? '- **mira**'
          : `- **user (@${message.author ?? 'unknown'})**`;
      return `${header}\n${message.body}`;
    })
    .join('\n\n');
}

function renderAcceptanceCriteria(criteria: readonly string[]): string {
  if (criteria.length === 0) {
    return '(none)';
  }
  return criteria.map((item) => `- ${item}`).join('\n');
}

function renderChangedFiles(files: ReviewContext['changedFiles']): string {
  if (files.length === 0) {
    return '(none)';
  }
  return files
    .map((file) => {
      const flags: string[] = [];
      if (file.isNew) flags.push('new');
      if (file.isDeleted) flags.push('deleted');
      if (file.oldPath !== undefined) flags.push(`renamed from ${file.oldPath}`);
      if (file.isBinary) flags.push('binary');
      const suffix = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
      return `- ${file.path}${suffix}`;
    })
    .join('\n');
}

function renderCiStatus(context: ReviewContext): string {
  return context.ci?.status ?? 'unknown (CI was not read for this run)';
}

function renderCiFailures(context: ReviewContext): string {
  const ci = context.ci;
  if (ci === undefined) {
    return '(none)';
  }
  if (ci.status !== 'red') {
    return '(no failed required jobs)';
  }
  if (ci.failures.length === 0) {
    return '(required CI failed; job logs were not available)';
  }
  return ci.failures
    .map((failure) => {
      const head = `- ${failure.jobName} (${failure.status})`;
      if (failure.excerpt === undefined || failure.excerpt === '') {
        return head;
      }
      return `${head}\n\`\`\`\n${failure.excerpt}\n\`\`\``;
    })
    .join('\n\n');
}

/**
 * Best-effort extraction of the findings object from the CLI's stdout. The
 * `--output-format json` mode wraps the assistant message in a JSON envelope,
 * so we try, in order: (a) the whole stdout is already the findings object,
 * (b) parse the envelope and pull the assistant text, then extract its fenced
 * JSON, (c) regex a fenced ```json block straight out of the raw stdout.
 */
export function parseFindingsFromStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    return undefined;
  }

  const direct = tryParseJson(trimmed);
  if (direct !== undefined) {
    if (looksLikeFindings(direct)) {
      return direct;
    }
    const text = extractEnvelopeText(direct);
    if (text !== undefined) {
      const fenced = extractFencedJson(text);
      if (fenced !== undefined) {
        return fenced;
      }
    }
  }

  return extractFencedJson(stdout);
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function looksLikeFindings(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'findings' in value && 'summary' in value;
}

/**
 * Parse the assistant reply text from cursor-agent stdout. Tries, in order:
 * JSON envelope text, trimmed raw stdout when not JSON, then strips a single
 * wrapping markdown code fence when the whole payload is one fence.
 */
export function parseAssistantTextFromStdout(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    throw new Error('cursor-agent produced empty assistant reply');
  }

  const direct = tryParseJson(trimmed);
  if (direct !== undefined) {
    const fromEnvelope = extractEnvelopeText(direct);
    if (fromEnvelope !== undefined) {
      const text = stripWrappingFence(fromEnvelope.trim()).trim();
      if (text !== '') {
        return text;
      }
    }
    throw new Error('cursor-agent JSON output contained no assistant text');
  }

  const text = stripWrappingFence(trimmed).trim();
  if (text === '') {
    throw new Error('cursor-agent produced empty assistant reply');
  }
  return text;
}

/** Pull the assistant text out of a cursor-agent JSON envelope, defensively. */
export function extractEnvelopeText(envelope: unknown): string | undefined {
  if (typeof envelope !== 'object' || envelope === null) {
    return undefined;
  }
  const record = envelope as Record<string, unknown>;

  // Common single-string carriers across CLI output shapes.
  for (const key of ['result', 'text', 'response', 'output', 'content']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  // Chat-style: { message: { content: string | [{ text }] } }.
  const message = record['message'];
  if (typeof message === 'object' && message !== null) {
    const content = (message as Record<string, unknown>)['content'];
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      const parts = content
        .map((part) =>
          typeof part === 'object' && part !== null
            ? (part as Record<string, unknown>)['text']
            : undefined,
        )
        .filter((part): part is string => typeof part === 'string');
      if (parts.length > 0) {
        return parts.join('');
      }
    }
  }

  return undefined;
}

/** Strip one outer ``` fence when the entire string is a single fenced block. */
function stripWrappingFence(text: string): string {
  const match = /^```(?:\w+)?\s*\n?([\s\S]*?)\n?```$/.exec(text.trim());
  return match?.[1] ?? text;
}

/** Extract and parse the LAST ```json fenced block from a markdown string. */
function extractFencedJson(text: string): unknown {
  const fenceRe = /```json\s*([\s\S]*?)```/gi;
  let lastBody: string | undefined;
  for (let match = fenceRe.exec(text); match !== null; match = fenceRe.exec(text)) {
    lastBody = match[1];
  }
  if (lastBody === undefined) {
    return undefined;
  }
  return tryParseJson(lastBody.trim());
}

/**
 * cursor-agent often exits 0 while printing a fatal line (dead model slug,
 * geo-block, bad key). Treat that as a hard failure so we do not retry it as
 * "unparseable findings" and so the MR copy can classify the real cause.
 */
export function detectCursorCliLogicalFailure(
  stdout: string,
  stderr: string,
): string | undefined {
  const text = `${stderr}\n${stdout}`.trim();
  if (text === '') {
    return undefined;
  }

  if (/cannot use this model/i.test(text)) {
    return `cursor-agent rejected model:\n${truncate(text, STDERR_MAX)}`;
  }
  if (/not available in your region/i.test(text)) {
    return `cursor-agent region blocked:\n${truncate(text, STDERR_MAX)}`;
  }
  if (/provided api key is invalid|invalid user api key|invalid api key/i.test(text)) {
    return `cursor-agent rejected api key:\n${truncate(text, STDERR_MAX)}`;
  }
  return undefined;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (truncated)` : text;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
