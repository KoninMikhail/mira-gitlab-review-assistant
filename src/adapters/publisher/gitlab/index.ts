/**
 * Barrel for the idempotent GitLab MR publisher.
 */
export {
  GitLabPublisher,
  SUMMARY_MARKER,
  FINDING_MARKER_RE,
  countBySeverity,
  findingMarker,
  fingerprintFromDiscussion,
} from './gitlab-publisher.ts';
export type { GitLabPublisherLogger, GitLabPublisherOptions } from './gitlab-publisher.ts';
