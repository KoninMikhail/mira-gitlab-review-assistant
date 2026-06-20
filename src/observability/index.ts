/**
 * Observability barrel: structured logging, in-memory metrics, and redaction.
 */

export { createLogger } from './logger.ts';
export type { CreateLoggerOptions, Logger, LogLevel } from './logger.ts';

export { createMetricRegistry, METRIC_NAMES } from './metrics.ts';
export type {
  Counter,
  CounterSnapshot,
  Histogram,
  HistogramSnapshot,
  MetricName,
  MetricRegistry,
  MetricsSnapshot,
} from './metrics.ts';

export { redact } from './redact.ts';
