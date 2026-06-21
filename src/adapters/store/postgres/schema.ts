/**
 * Postgres DDL and migration runner for the durable state store.
 */
import type { PgPoolLike } from './postgres-store.ts';

const MR_REVIEW_DDL = `
CREATE TABLE IF NOT EXISTS mr_review (
  project_id text NOT NULL,
  mr_iid integer NOT NULL,
  head_sha text NOT NULL,
  prompt_version text NOT NULL,
  partition_version text NOT NULL,
  verdict text NOT NULL,
  summary text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, mr_iid, head_sha, prompt_version, partition_version)
)`;

const FINDING_RECORD_DDL = `
CREATE TABLE IF NOT EXISTS finding_record (
  project_id text NOT NULL,
  mr_iid integer NOT NULL,
  head_sha text NOT NULL,
  prompt_version text NOT NULL,
  partition_version text NOT NULL,
  fingerprint text NOT NULL,
  severity text NOT NULL,
  category text NOT NULL,
  file_path text NOT NULL,
  message text NOT NULL,
  line_start integer,
  line_end integer,
  PRIMARY KEY (
    project_id,
    mr_iid,
    head_sha,
    prompt_version,
    partition_version,
    fingerprint
  )
)`;

const MR_IGNORE_DDL = `
CREATE TABLE IF NOT EXISTS mr_ignore (
  project_id text NOT NULL,
  mr_iid integer NOT NULL,
  fingerprint text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, mr_iid, fingerprint)
)`;

/** Apply idempotent schema migrations via `pool`. */
export async function migratePostgres(pool: PgPoolLike): Promise<void> {
  await pool.query(MR_REVIEW_DDL);
  await pool.query(FINDING_RECORD_DDL);
  await pool.query(MR_IGNORE_DDL);
}
