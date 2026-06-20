/** Barrel for the cursor-agent headless review engine adapter. */
export { CliHeadlessEngine, parseFindingsFromStdout, renderPrompt } from './cli-headless-engine.ts';
export type { CliHeadlessEngineOptions, SpawnLike, SpawnResult } from './cli-headless-engine.ts';
export { nodeSpawn } from './spawn.ts';
