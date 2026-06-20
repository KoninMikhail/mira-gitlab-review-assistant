/**
 * `StateStore` adapter backed by the built-in `node:sqlite` module (MVP).
 */
import { DatabaseSync } from 'node:sqlite';

import type { ReviewResult } from '../../../core/domain/index.ts';
import type { IgnoreStore, ReviewKey, StateStore } from '../../../core/ports/index.ts';
import { findingFingerprint } from './fingerprint.ts';
import { migrate } from './schema.ts';

export interface SqliteStateStoreOptions {
  /** Filesystem path, or `:memory:` for an ephemeral database. */
  path: string;
}

interface SeenRow {
  seen: number;
}

interface FingerprintRow {
  fingerprint: string;
}

export class SqliteStateStore implements StateStore, IgnoreStore {
  private readonly db: DatabaseSync;

  constructor(options: SqliteStateStoreOptions) {
    this.db = new DatabaseSync(options.path);
    migrate(this.db);
  }

  seen(key: ReviewKey): Promise<boolean> {
    const row = this.db
      .prepare(
        `SELECT 1 AS seen FROM MR_REVIEW
         WHERE project_id = ? AND mr_iid = ? AND head_sha = ?
           AND prompt_version = ? AND partition_version = ?
         LIMIT 1`,
      )
      .get(key.projectId, key.mrIid, key.headSha, key.promptVersion, key.partitionVersion) as
      | SeenRow
      | undefined;

    return Promise.resolve(row !== undefined);
  }

  record(key: ReviewKey, result: ReviewResult): Promise<void> {
    const createdAt = new Date().toISOString();

    const upsertReview = this.db.prepare(
      `INSERT OR REPLACE INTO MR_REVIEW (
         project_id, mr_iid, head_sha, prompt_version, partition_version,
         verdict, summary, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertFinding = this.db.prepare(
      `INSERT OR IGNORE INTO FINDING_RECORD (
         project_id, mr_iid, head_sha, prompt_version, partition_version,
         fingerprint, severity, category, file_path, message, line_start, line_end
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.exec('BEGIN IMMEDIATE');
    try {
      upsertReview.run(
        key.projectId,
        key.mrIid,
        key.headSha,
        key.promptVersion,
        key.partitionVersion,
        result.verdict,
        result.summary,
        createdAt,
      );

      for (const finding of result.findings) {
        insertFinding.run(
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
        );
      }

      this.db.exec('COMMIT');
    } catch (cause) {
      this.db.exec('ROLLBACK');
      throw cause;
    }

    return Promise.resolve();
  }

  ignore(projectId: string, mrIid: number, fingerprint: string): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO MR_IGNORE (project_id, mr_iid, fingerprint, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(projectId, mrIid, fingerprint, new Date().toISOString());
    return Promise.resolve();
  }

  ignored(projectId: string, mrIid: number): Promise<Set<string>> {
    const rows = this.db
      .prepare(`SELECT fingerprint FROM MR_IGNORE WHERE project_id = ? AND mr_iid = ?`)
      .all(projectId, mrIid) as unknown as FingerprintRow[];
    return Promise.resolve(new Set(rows.map((row) => row.fingerprint)));
  }

  /** Close the underlying database connection. */
  close(): void {
    this.db.close();
  }
}
