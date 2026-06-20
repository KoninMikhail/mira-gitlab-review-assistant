/**
 * Structured JSON logger with correlation fields, child loggers, and automatic
 * secret/diff redaction on every emitted line.
 */

import { redact } from './redact.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface CreateLoggerOptions {
  sink?: (line: string) => void;
  base?: Record<string, unknown>;
}

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

function mergeFields(
  base: Record<string, unknown>,
  fields: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (fields === undefined) {
    return { ...base };
  }
  return { ...base, ...fields };
}

function emit(
  sink: (line: string) => void,
  base: Record<string, unknown>,
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  const payload = mergeFields(base, fields);
  payload['ts'] = new Date().toISOString();
  payload['level'] = level;
  payload['msg'] = msg;
  const redacted = redact(payload) as Record<string, unknown>;
  sink(JSON.stringify(redacted));
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const sink = options.sink ?? defaultSink;
  const base = options.base ?? {};

  const logger: Logger = {
    debug(msg: string, fields?: Record<string, unknown>): void {
      emit(sink, base, 'debug', msg, fields);
    },
    info(msg: string, fields?: Record<string, unknown>): void {
      emit(sink, base, 'info', msg, fields);
    },
    warn(msg: string, fields?: Record<string, unknown>): void {
      emit(sink, base, 'warn', msg, fields);
    },
    error(msg: string, fields?: Record<string, unknown>): void {
      emit(sink, base, 'error', msg, fields);
    },
    child(childFields: Record<string, unknown>): Logger {
      return createLogger({ sink, base: mergeFields(base, childFields) });
    },
  };

  return logger;
}
