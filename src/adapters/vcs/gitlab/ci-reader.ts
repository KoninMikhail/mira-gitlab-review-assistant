/**
 * GitLab adapter for {@link VcsCiReader}: MR description + jobs of the newest
 * pipeline for a SHA, plus job traces. Thin mapping only — required-vs-manual
 * policy and log truncation live in core.
 */
import type { CiJob, PresenceSnapshot, VcsCiReader } from '../../../core/ports/index.ts';
import { GitLabClient } from './client.ts';
import type { GitLabClientConfig, GitLabClientOptions } from './client.ts';

interface GitLabMergeRequestLite {
  description: string | null;
}

interface GitLabPipelineLite {
  id: number;
  sha: string;
}

interface GitLabJobLite {
  id: number;
  name: string;
  status: string;
  when?: string;
  allow_failure?: boolean;
}

export class GitLabCiReader implements VcsCiReader {
  readonly #client: GitLabClient;

  constructor(client: GitLabClient) {
    this.#client = client;
  }

  static fromConfig(config: GitLabClientConfig, options?: GitLabClientOptions): GitLabCiReader {
    return new GitLabCiReader(new GitLabClient(config, options));
  }

  async getPresenceSnapshot(
    projectId: string,
    mrIid: number,
    sha: string,
  ): Promise<PresenceSnapshot> {
    const encodedId = encodeURIComponent(projectId);
    const mrPath = `projects/${encodedId}/merge_requests/${String(mrIid)}`;

    const mr = await this.#client.get<GitLabMergeRequestLite>(mrPath);
    const pipelines = await this.#client.getAll<GitLabPipelineLite>(`${mrPath}/pipelines`);
    const pipelineId = newestPipelineIdForSha(pipelines, sha);
    const rawJobs =
      pipelineId === undefined
        ? []
        : await this.#client.getAll<GitLabJobLite>(
            `projects/${encodedId}/pipelines/${String(pipelineId)}/jobs`,
          );

    return {
      description: mr.description ?? '',
      jobs: rawJobs.map(toCiJob),
    };
  }

  async getJobTrace(projectId: string, jobId: number): Promise<string> {
    const encodedId = encodeURIComponent(projectId);
    return this.#client.getText(`projects/${encodedId}/jobs/${String(jobId)}/trace`);
  }
}

function newestPipelineIdForSha(
  pipelines: readonly GitLabPipelineLite[],
  sha: string,
): number | undefined {
  let bestId: number | undefined;
  for (const pipeline of pipelines) {
    if (pipeline.sha !== sha) {
      continue;
    }
    if (bestId === undefined || pipeline.id > bestId) {
      bestId = pipeline.id;
    }
  }
  return bestId;
}

function toCiJob(job: GitLabJobLite): CiJob {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    when: job.when ?? 'on_success',
    allowFailure: job.allow_failure === true,
  };
}
