/**
 * Thin HTTP client for the Kaiten REST API over the global `fetch` (Node 22).
 *
 * `fetch` is injectable (`FetchLike`) so the adapter can be unit-tested with a
 * fake transport and zero network access.
 */
import { API_BASE_PATH } from './endpoints.ts';

/**
 * Minimal subset of the WHATWG `Response` the client relies on. The global
 * `Response` is structurally assignable to this, so production code passes the
 * real `fetch` while tests pass a fake.
 */
export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Minimal `fetch` signature this client depends on. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<HttpResponse>;

export interface KaitenHttpOptions {
  baseUrl: string;
  token: string;
  /** Defaults to the global `fetch`; override in tests. */
  fetch?: FetchLike;
}

/** Raised on any non-2xx response from Kaiten, carrying status and body. */
export class KaitenHttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: string;

  constructor(method: string, url: string, status: number, statusText: string, body: string) {
    super(`Kaiten ${method} ${url} failed: ${status} ${statusText}`);
    this.name = 'KaitenHttpError';
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export class KaitenHttpClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: KaitenHttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetch ?? defaultFetch;
  }

  /** GET `path` (relative to the API base) and parse the JSON body. */
  async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${API_BASE_PATH}${path}`;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const body = await safeText(res);
      throw new KaitenHttpError('GET', url, res.status, res.statusText, body);
    }

    return (await res.json()) as T;
  }
}

async function safeText(res: HttpResponse): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
