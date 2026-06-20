/**
 * In-memory metrics registry — synchronous counters and histograms for the
 * observability seam; a Prometheus exporter can read {@link snapshot} later.
 */

export const METRIC_NAMES = {
  reviewsTotal: 'reviews_total',
  reviewDurationSeconds: 'review_duration_seconds',
  engineErrorsTotal: 'engine_errors_total',
  reviewUnitsTotal: 'review_units_total',
  tokensUsedTotal: 'tokens_used_total',
} as const;

export type MetricName = (typeof METRIC_NAMES)[keyof typeof METRIC_NAMES];

export interface Counter {
  inc(amount?: number): void;
}

export interface Histogram {
  observe(value: number): void;
}

export interface CounterSnapshot {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface HistogramSnapshot {
  name: string;
  labels: Record<string, string>;
  count: number;
  sum: number;
  min: number;
  max: number;
}

export interface MetricsSnapshot {
  counters: CounterSnapshot[];
  histograms: HistogramSnapshot[];
}

export interface MetricRegistry {
  counter(name: string, labels?: Record<string, string>): Counter;
  histogram(name: string, labels?: Record<string, string>): Histogram;
  snapshot(): MetricsSnapshot;
}

function normalizeLabels(labels: Record<string, string> | undefined): Record<string, string> {
  return labels ?? {};
}

function labelsKey(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) {
    return '';
  }
  return keys.map((key) => `${key}=${labels[key]}`).join(',');
}

interface CounterCell {
  name: string;
  labels: Record<string, string>;
  value: number;
}

interface HistogramCell {
  name: string;
  labels: Record<string, string>;
  count: number;
  sum: number;
  min: number;
  max: number;
}

export function createMetricRegistry(): MetricRegistry {
  const counters = new Map<string, CounterCell>();
  const histograms = new Map<string, HistogramCell>();

  function counterKey(name: string, labels: Record<string, string>): string {
    const labelPart = labelsKey(labels);
    return labelPart.length > 0 ? `${name}|${labelPart}` : name;
  }

  function counter(name: string, labels?: Record<string, string>): Counter {
    const normalized = normalizeLabels(labels);
    const key = counterKey(name, normalized);

    if (!counters.has(key)) {
      counters.set(key, { name, labels: { ...normalized }, value: 0 });
    }

    return {
      inc(amount = 1): void {
        const cell = counters.get(key);
        if (cell === undefined) {
          return;
        }
        cell.value += amount;
      },
    };
  }

  function histogram(name: string, labels?: Record<string, string>): Histogram {
    const normalized = normalizeLabels(labels);
    const key = counterKey(name, normalized);

    if (!histograms.has(key)) {
      histograms.set(key, {
        name,
        labels: { ...normalized },
        count: 0,
        sum: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
      });
    }

    return {
      observe(value: number): void {
        const cell = histograms.get(key);
        if (cell === undefined) {
          return;
        }
        cell.count += 1;
        cell.sum += value;
        if (value < cell.min) {
          cell.min = value;
        }
        if (value > cell.max) {
          cell.max = value;
        }
      },
    };
  }

  function snapshot(): MetricsSnapshot {
    const counterSnapshots: CounterSnapshot[] = [];
    for (const cell of counters.values()) {
      counterSnapshots.push({
        name: cell.name,
        labels: { ...cell.labels },
        value: cell.value,
      });
    }

    const histogramSnapshots: HistogramSnapshot[] = [];
    for (const cell of histograms.values()) {
      const min = cell.count === 0 ? 0 : cell.min;
      const max = cell.count === 0 ? 0 : cell.max;
      histogramSnapshots.push({
        name: cell.name,
        labels: { ...cell.labels },
        count: cell.count,
        sum: cell.sum,
        min,
        max,
      });
    }

    return { counters: counterSnapshots, histograms: histogramSnapshots };
  }

  return { counter, histogram, snapshot };
}
