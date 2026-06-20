/** Polling trigger entrypoint (docs/04-architecture/triggers.md variant B). */
export { pollOnce, runPoller, selectJobs } from './poller.ts';
export type { PollOnceOptions, PollerQueue, RunPollerOptions } from './poller.ts';
