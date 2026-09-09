/**
 * GitLab write adapter implementing the `VcsWriter` port over REST v4.
 *
 * Covers MR notes, discussions (general and inline), the bot's own
 * approve/unapprove, and MR description updates. Idempotent publication
 * policy belongs in a higher-level publisher — this adapter is a thin REST
 * mapping layer.
 */
import type { InlinePosition, MrDiscussion, MrNote, VcsWriter } from '../../../core/ports/index.ts';
import { GitLabClient } from './client.ts';
import type { GitLabClientConfig, GitLabClientOptions } from './client.ts';

/** Subset of GitLab note JSON used for mapping. */
interface GitLabNoteJson {
  id: number;
  body: string;
  author?: { username?: string };
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
}

/** Subset of GitLab discussion JSON used for mapping. */
interface GitLabDiscussionJson {
  id: string;
  individual_note: boolean;
  notes: GitLabNoteJson[];
}

export class GitLabWriter implements VcsWriter {
  readonly #client: GitLabClient;

  constructor(client: GitLabClient) {
    this.#client = client;
  }

  /** Convenience factory wiring a `GitLabClient` from plain config. */
  static fromConfig(config: GitLabClientConfig, options?: GitLabClientOptions): GitLabWriter {
    return new GitLabWriter(new GitLabClient(config, options));
  }

  async listNotes(projectId: string, mrIid: number): Promise<MrNote[]> {
    const path = this.#mrNotesPath(projectId, mrIid);
    const items = await this.#client.getAll<GitLabNoteJson>(path);
    return items.map(toMrNote);
  }

  async createNote(projectId: string, mrIid: number, body: string): Promise<MrNote> {
    const path = this.#mrNotesPath(projectId, mrIid);
    const note = await this.#client.post<GitLabNoteJson>(path, { body });
    return toMrNote(note);
  }

  async updateNote(
    projectId: string,
    mrIid: number,
    noteId: number,
    body: string,
  ): Promise<MrNote> {
    const encodedId = encodeURIComponent(projectId);
    const path = `projects/${encodedId}/merge_requests/${String(mrIid)}/notes/${String(noteId)}`;
    const note = await this.#client.put<GitLabNoteJson>(path, { body });
    return toMrNote(note);
  }

  async listDiscussions(projectId: string, mrIid: number): Promise<MrDiscussion[]> {
    const path = this.#mrDiscussionsPath(projectId, mrIid);
    const items = await this.#client.getAll<GitLabDiscussionJson>(path);
    return items.map(toMrDiscussion);
  }

  async getDiscussion(
    projectId: string,
    mrIid: number,
    discussionId: string,
  ): Promise<MrDiscussion> {
    const encodedId = encodeURIComponent(projectId);
    const path = `projects/${encodedId}/merge_requests/${String(mrIid)}/discussions/${discussionId}`;
    const discussion = await this.#client.get<GitLabDiscussionJson>(path);
    return toMrDiscussion(discussion);
  }

  async addDiscussionNote(
    projectId: string,
    mrIid: number,
    discussionId: string,
    body: string,
  ): Promise<MrNote> {
    const encodedId = encodeURIComponent(projectId);
    const path = `projects/${encodedId}/merge_requests/${String(mrIid)}/discussions/${discussionId}/notes`;
    const note = await this.#client.post<GitLabNoteJson>(path, { body });
    return toMrNote(note);
  }

  async createDiscussion(
    projectId: string,
    mrIid: number,
    body: string,
    position?: InlinePosition,
  ): Promise<MrDiscussion> {
    const path = this.#mrDiscussionsPath(projectId, mrIid);
    const payload: { body: string; position?: Record<string, unknown> } = { body };
    if (position !== undefined) {
      payload.position = toGitLabPosition(position);
    }
    const discussion = await this.#client.post<GitLabDiscussionJson>(path, payload);
    return toMrDiscussion(discussion);
  }

  async resolveDiscussion(
    projectId: string,
    mrIid: number,
    discussionId: string,
    resolved: boolean,
  ): Promise<void> {
    const encodedId = encodeURIComponent(projectId);
    const path = `projects/${encodedId}/merge_requests/${String(mrIid)}/discussions/${discussionId}`;
    await this.#client.put(path, {}, { resolved });
  }

  async approveMr(projectId: string, mrIid: number, sha: string): Promise<void> {
    const path = this.#mrPath(projectId, mrIid, 'approve');
    await this.#client.post(path, { sha });
  }

  async unapproveMr(projectId: string, mrIid: number): Promise<void> {
    const path = this.#mrPath(projectId, mrIid, 'unapprove');
    await this.#client.post(path, {});
  }

  async updateMrDescription(projectId: string, mrIid: number, description: string): Promise<void> {
    const encodedId = encodeURIComponent(projectId);
    const path = `projects/${encodedId}/merge_requests/${String(mrIid)}`;
    await this.#client.put(path, { description });
  }

  #mrNotesPath(projectId: string, mrIid: number): string {
    const encodedId = encodeURIComponent(projectId);
    return `projects/${encodedId}/merge_requests/${String(mrIid)}/notes`;
  }

  #mrDiscussionsPath(projectId: string, mrIid: number): string {
    const encodedId = encodeURIComponent(projectId);
    return `projects/${encodedId}/merge_requests/${String(mrIid)}/discussions`;
  }

  #mrPath(projectId: string, mrIid: number, suffix: string): string {
    const encodedId = encodeURIComponent(projectId);
    return `projects/${encodedId}/merge_requests/${String(mrIid)}/${suffix}`;
  }
}

function toMrNote(note: GitLabNoteJson): MrNote {
  const mapped: MrNote = {
    id: note.id,
    body: note.body,
    system: note.system ?? false,
  };
  const username = note.author?.username;
  if (username !== undefined) {
    mapped.author = username;
  }
  return mapped;
}

function toMrDiscussion(discussion: GitLabDiscussionJson): MrDiscussion {
  const resolvableNotes = discussion.notes.filter((note) => note.resolvable === true);
  const resolved =
    resolvableNotes.length > 0 && resolvableNotes.every((note) => note.resolved === true);

  return {
    id: discussion.id,
    notes: discussion.notes.map(toMrNote),
    resolved,
    individualNote: discussion.individual_note === true,
  };
}

/** Maps domain inline position to GitLab REST snake_case `position` object. */
function toGitLabPosition(position: InlinePosition): Record<string, string | number> {
  const gitlabPosition: Record<string, string | number> = {
    position_type: 'text',
    base_sha: position.baseSha,
    start_sha: position.startSha,
    head_sha: position.headSha,
    new_path: position.newPath,
  };
  if (position.oldPath !== undefined) {
    gitlabPosition['old_path'] = position.oldPath;
  }
  if (position.newLine !== undefined) {
    gitlabPosition['new_line'] = position.newLine;
  }
  if (position.oldLine !== undefined) {
    gitlabPosition['old_line'] = position.oldLine;
  }
  return gitlabPosition;
}
