/**
 * GitLab read adapter implementing the `VcsReader` port over REST v4.
 *
 * Returns MR metadata plus the changed-files list only. The unified diff is
 * intentionally NOT fetched here — per docs/03-reference/integrations-api §2/§6 the diff is
 * taken locally from a git checkout (`git diff target...source`) in a later
 * task. Keeping this adapter thin and deterministic.
 */
import type { ChangedFile } from '../../../core/domain/index.ts';
import type { MrContext, MrSummary, VcsMrLister, VcsReader } from '../../../core/ports/index.ts';
import { GitLabClient } from './client.ts';
import type { GitLabClientConfig, GitLabClientOptions } from './client.ts';

/** Subset of `GET /projects/:id/merge_requests/:iid` we depend on. */
interface GitLabMergeRequest {
  title: string;
  description: string | null;
  source_branch: string;
  target_branch: string;
  sha: string | null;
  diff_refs: { head_sha: string | null } | null;
}

/** Subset of `GET /projects/:id/merge_requests` list entries we depend on. */
interface GitLabMergeRequestListItem {
  iid: number;
  title: string;
  source_branch: string;
  target_branch: string;
  sha: string | null;
  diff_refs: { head_sha: string | null } | null;
  draft: boolean;
  state: string;
}

/** A single entry from `GET /projects/:id/merge_requests/:iid/diffs`. */
interface GitLabMrDiff {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
  collapsed?: boolean;
  too_large?: boolean;
}

// GitLab emits this notice (instead of a textual hunk) for binary changes.
const BINARY_NOTICE = /^Binary files .* differ$/m;

export class GitLabReader implements VcsReader, VcsMrLister {
  readonly #client: GitLabClient;

  constructor(client: GitLabClient) {
    this.#client = client;
  }

  /** Convenience factory wiring a `GitLabClient` from plain config. */
  static fromConfig(config: GitLabClientConfig, options?: GitLabClientOptions): GitLabReader {
    return new GitLabReader(new GitLabClient(config, options));
  }

  async listOpenMergeRequests(projectId: string): Promise<MrSummary[]> {
    const encodedId = encodeURIComponent(projectId);
    const items = await this.#client.getAll<GitLabMergeRequestListItem>(
      `projects/${encodedId}/merge_requests`,
      { state: 'opened' },
    );

    return items.map((item) => toMrSummary(projectId, item));
  }

  async getMrContext(projectId: string, mrIid: number): Promise<MrContext> {
    // Project id may be a numeric id or a `group/sub/project` path.
    const encodedId = encodeURIComponent(projectId);
    const mrPath = `projects/${encodedId}/merge_requests/${String(mrIid)}`;

    const mr = await this.#client.get<GitLabMergeRequest>(mrPath);
    const diffs = await this.#client.getAll<GitLabMrDiff>(`${mrPath}/diffs`);

    return {
      projectId,
      mrIid,
      title: mr.title,
      description: mr.description ?? '',
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      headSha: mr.sha ?? mr.diff_refs?.head_sha ?? '',
      changedFiles: diffs.map(toChangedFile),
    };
  }

  /** Username of the token owner (bot account). Used to ignore Mira's own notes. */
  async getAuthenticatedUsername(): Promise<string> {
    const user = await this.#client.get<{ username?: string }>('user');
    const username = user.username;
    if (username === undefined || username.trim() === '') {
      throw new Error('GitLab /user did not return a username');
    }
    return username;
  }
}

function toMrSummary(projectId: string, item: GitLabMergeRequestListItem): MrSummary {
  return {
    projectId,
    mrIid: item.iid,
    title: item.title,
    sourceBranch: item.source_branch,
    targetBranch: item.target_branch,
    headSha: item.sha ?? item.diff_refs?.head_sha ?? '',
    isDraft: item.draft,
    state: normalizeMrState(item.state),
  };
}

function normalizeMrState(state: string): MrSummary['state'] {
  switch (state) {
    case 'opened':
    case 'closed':
    case 'merged':
    case 'locked':
      return state;
    default:
      return 'opened';
  }
}

function toChangedFile(diff: GitLabMrDiff): ChangedFile {
  const file: ChangedFile = {
    path: diff.new_path,
    isBinary: deriveIsBinary(diff),
    isNew: diff.new_file,
    isDeleted: diff.deleted_file,
  };
  // Only set `oldPath` for genuine renames (exactOptionalPropertyTypes: no undefined).
  if (diff.renamed_file && diff.old_path !== diff.new_path) {
    file.oldPath = diff.old_path;
  }
  return file;
}

function deriveIsBinary(diff: GitLabMrDiff): boolean {
  const text = diff.diff;
  // Most reliable signal: the explicit binary notice.
  if (BINARY_NOTICE.test(text)) {
    return true;
  }
  // Body excluded due to size limits — unknown, not a binary signal.
  if (diff.collapsed === true || diff.too_large === true) {
    return false;
  }
  // A pure rename legitimately carries no diff body.
  if (diff.renamed_file && text.trim() === '') {
    return false;
  }
  // Otherwise an empty diff body on a real change is GitLab's binary indicator.
  return text.trim() === '';
}
