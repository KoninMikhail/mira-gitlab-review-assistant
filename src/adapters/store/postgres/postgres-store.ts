/**
 * `StateStore` and `IgnoreStore` adapter backed by Postgres.
 */
import type { ReviewResult } from '../../../core/domain/index.ts';
import type { IgnoreStore, ReviewKey, StateStore } from '../../../core/ports/index.ts';
import { findingFingerprint } from './fingerprint.ts';
import { migratePostgres } from './schema.ts';

export interface PgQueryResult<R> {
  rows: R[];
}

export interface PgPoolLike {
  query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<PgQueryResult<R>>;
}

export interface PostgresStateStoreOptions {
  pool: PgPoolLike;
}

interface FingerprintRow {
  fingerprint: string;
}

export class PostgresStateStore implements StateStore, IgnoreStore {
  private readonly pool: PgPoolLike;
  private migrationPromise: Promise<void> | undefined;

  constructor(options: PostgresStateStoreOptions) {
    this.pool = options.pool;
  }

  private ensureMigrated(): Promise<void> {
    this.migrationPromise ??= migratePostgres(this.pool);
    return this.migrationPromise;
  }

  async seen(key: ReviewKey): Promise<boolean> {
    await this.ensureMigrated();
    const result = await this.pool.query(
      `SELECT 1 FROM mr_review
       WHERE project_id = $1 AND mr_iid = $2 AND head_sha = $3
         AND prompt_version = $4 AND partition_version = $5
       LIMIT 1`,
      [key.projectId, key.mrIid, key.headSha, key.promptVersion, key.partitionVersion],
    );
    return result.rows.length > 0;
  }

  async record(key: ReviewKey, result: ReviewResult): Promise<void> {
    await this.ensureMigrated();
    const createdAt = new Date().toISOString();

    // Sequential statements via the pool; a transaction would require a dedicated client.
    await this.pool.query(
      `INSERT INTO mr_review (
         project_id, mr_iid, head_sha, prompt_version, partition_version,
         verdict, summary, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (project_id, mr_iid, head_sha, prompt_version, partition_version)
       DO UPDATE SET
         verdict = EXCLUDED.verdict,
         summary = EXCLUDED.summary,
         created_at = EXCLUDED.created_at`,
      [
        key.projectId,
        key.mrIid,
        key.headSha,
        key.promptVersion,
        key.partitionVersion,
        result.verdict,
        result.summary,
        createdAt,
      ],
    );

    for (const finding of result.findings) {
      await this.pool.query(
        `INSERT INTO finding_record (
           project_id, mr_iid, head_sha, prompt_version, partition_version,
           fingerprint, severity, category, file_path, message, line_start, line_end
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (
           project_id, mr_iid, head_sha, prompt_version, partition_version, fingerprint
         ) DO NOTHING`,
        [
          key.projectId,
          key.mrIid,
          key.headSha,
          key.promptVersion,
          key.partitionVersion,
          findingFingerprint(finding),
          finding.severity,
          finding.category,
          finding.filePath,
          finding.message,
          finding.lineStart ?? null,
          finding.lineEnd ?? null,
        ],
      );
    }
  }

  async ignore(projectId: string, mrIid: number, fingerprint: string): Promise<void> {
    await this.ensureMigrated();
    await this.pool.query(
      `INSERT INTO mr_ignore (project_id, mr_iid, fingerprint, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, mr_iid, fingerprint) DO NOTHING`,
      [projectId, mrIid, fingerprint, new Date().toISOString()],
    );
  }

  async ignored(projectId: string, mrIid: number): Promise<Set<string>> {
    await this.ensureMigrated();
    const result = await this.pool.query<FingerprintRow>(
      `SELECT fingerprint FROM mr_ignore WHERE project_id = $1 AND mr_iid = $2`,
      [projectId, mrIid],
    );
    return new Set(result.rows.map((row) => row.fingerprint));
  }
}
