/**
 * Default {@link SpawnLike} implementation over `node:child_process`.
 *
 * Captures stdout/stderr, writes the rendered prompt to the child's stdin, and
 * resolves once the process closes. Kept separate from the engine so tests can
 * inject a fake spawner and run with NO real process and NO network.
 */
import { spawn } from 'node:child_process';
import type { SpawnLike, SpawnResult } from './cli-headless-engine.ts';

export const nodeSpawn: SpawnLike = (bin, args, options) =>
  new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      // Windows: .cmd/.ps1 wrappers require a shell to resolve and execute.
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (handler: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      handler();
    };

    const onAbort = (): void => {
      finish(() => {
        child.kill();
        reject(new Error('spawn aborted'));
      });
    };

    const signal = options.signal;
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      finish(() => {
        reject(err);
      });
    });
    child.on('close', (code) => {
      finish(() => {
        resolve({ code, stdout, stderr });
      });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
