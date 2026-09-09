export {
  CI_GRACE_MS,
  CI_RETRY_MS,
  CI_WAIT_TIMEOUT_MS,
  ciOutcomeMayChange,
  classifyRequiredCi,
  foldCiIntoPromptVersion,
  isExplicitReview,
  isOptionalManualJob,
  resolvePresenceKind,
  skipsCiWait,
} from './classify.ts';
export type { PresenceKind, RequiredCiStatus, ResolvePresenceKindInput } from './classify.ts';
export {
  CI_FAILURE_JOB_CAP,
  CI_TRACE_MAX_CHARS,
  ciContextForKind,
  excerptTrace,
  loadCiFailures,
  requiredBlockingFailures,
} from './failures.ts';
