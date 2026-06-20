/**
 * Runtime validation of the review output contract against
 * `schema/findings.schema.json` (JSON Schema draft 2020-12).
 *
 * The schema lives outside `rootDir: src`, so it is loaded from disk at runtime
 * via `node:fs` rather than imported — importing it would break `tsc` emit.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import type {
  Confidence,
  Finding,
  FindingCategory,
  RequirementCoverage,
  RequirementStatus,
  ReviewResult,
  Severity,
  Verdict,
} from '../domain/index.ts';

/**
 * The on-the-wire shape (snake_case) the agent emits — mirrors
 * `schema/findings.schema.json`. Mapped to the camelCase domain by
 * {@link toReviewResult} once the schema has validated it.
 */
interface RawFinding {
  severity: Severity;
  category: FindingCategory;
  file_path: string;
  message: string;
  line_start?: number;
  line_end?: number;
  rationale?: string;
  suggestion?: string;
  confidence?: Confidence;
}

interface RawRequirementCoverage {
  criterion: string;
  status: RequirementStatus;
  evidence?: string;
}

interface RawReviewResult {
  verdict: Verdict;
  summary: string;
  findings: RawFinding[];
  requirements_coverage?: RawRequirementCoverage[];
  degradations?: string[];
}

/** Resolved relative to the project root (cwd), where `schema/` lives. */
const SCHEMA_PATH = path.resolve(process.cwd(), 'schema', 'findings.schema.json');

/** Compiled lazily and memoized so the schema is only read/compiled once. */
let compiledValidator: ValidateFunction | undefined;

function getValidator(): ValidateFunction {
  if (compiledValidator === undefined) {
    const raw = readFileSync(SCHEMA_PATH, 'utf8');
    const schema = JSON.parse(raw) as AnySchema;
    const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
    compiledValidator = ajv.compile(schema);
  }
  return compiledValidator;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return 'unknown validation error';
  }
  return errors
    .map((err) => {
      const where = err.instancePath === '' ? '(root)' : err.instancePath;
      return `  - ${where}: ${err.message ?? 'is invalid'}`;
    })
    .join('\n');
}

/**
 * Validates an unknown value against the findings schema and maps the validated
 * wire shape (snake_case) to the camelCase domain {@link ReviewResult}.
 *
 * @throws {Error} with a human-readable, multi-line list of ajv errors when the
 *   input does not conform.
 */
export function validateFindings(input: unknown): ReviewResult {
  const validate = getValidator();
  if (!validate(input)) {
    throw new Error(`Invalid review findings:\n${formatErrors(validate.errors)}`);
  }
  return toReviewResult(input as RawReviewResult);
}

function toReviewResult(raw: RawReviewResult): ReviewResult {
  const result: ReviewResult = {
    verdict: raw.verdict,
    summary: raw.summary,
    findings: raw.findings.map(toFinding),
  };
  if (raw.requirements_coverage !== undefined) {
    result.requirementsCoverage = raw.requirements_coverage.map(toCoverage);
  }
  if (raw.degradations !== undefined) {
    result.degradations = raw.degradations;
  }
  return result;
}

function toFinding(raw: RawFinding): Finding {
  const finding: Finding = {
    severity: raw.severity,
    category: raw.category,
    filePath: raw.file_path,
    message: raw.message,
  };
  if (raw.line_start !== undefined) finding.lineStart = raw.line_start;
  if (raw.line_end !== undefined) finding.lineEnd = raw.line_end;
  if (raw.rationale !== undefined) finding.rationale = raw.rationale;
  if (raw.suggestion !== undefined) finding.suggestion = raw.suggestion;
  if (raw.confidence !== undefined) finding.confidence = raw.confidence;
  return finding;
}

function toCoverage(raw: RawRequirementCoverage): RequirementCoverage {
  const coverage: RequirementCoverage = { criterion: raw.criterion, status: raw.status };
  if (raw.evidence !== undefined) coverage.evidence = raw.evidence;
  return coverage;
}
