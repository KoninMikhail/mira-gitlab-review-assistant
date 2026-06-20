/**
 * SQLite DDL and migration runner for the MVP state store (docs/05-review-pipeline.md §8).
 */
import type { DatabaseSync } from 'node:sqlite';

const MR_REVIEW_DDL = `
CREATE TABLE IF NOT EXISTS MR_REVIEW (
  project_id TEXT NOT NULL,
  mr_iid INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  partition_version TEXT NOT NULL,
  verdict TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, mr_iid, head_sha, prompt_version, partition_version)
)`;

const FINDING_RECORD_DDL = `
CREATE TABLE IF NOT EXISTS FINDING_RECORD (
  project_id TEXT NOT NULL,
  mr_iid INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  partition_version TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  file_path TEXT NOT NULL,
  message TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  PRIMARY KEY (
    project_id,
    mr_iid,
    head_sha,
    prompt_version,
    partition_version,
    fingerprint
  ),
  FOREIGN KEY (
    project_id,
    mr_iid,
    head_sha,
    prompt_version,
    partition_version
  ) REFERENCES MR_REVIEW (
    project_id,
    mr_iid,
    head_sha,
    prompt_version,
    partition_version
  )
)`;

// Per-MR mute list for `@mira ignore <fingerprint>` (phase 2). Keyed by
// (project, mr) only — an ignore persists across head SHAs.
const MR_IGNORE_DDL = `
CREATE TABLE IF NOT EXISTS MR_IGNORE (
  project_id TEXT NOT NULL,
  mr_iid INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, mr_iid, fingerprint)
)`;

/** Apply idempotent schema migrations to `db`. */
export function migrate(db: DatabaseSync): void {
  db.exec(MR_REVIEW_DDL);
  db.exec(FINDING_RECORD_DDL);
  db.exec(MR_IGNORE_DDL);
}
