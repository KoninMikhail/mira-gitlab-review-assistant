/**
 * Thin GitLab REST v4 HTTP client.
 *
 * Responsibilities are deliberately narrow: send the `PRIVATE-TOKEN` header,
 * build `/api/v4/...` URLs, parse JSON, surface non-2xx responses as a typed
 * error, follow pagination via the `x-next-page` response header, and retry
 * briefly on HTTP 429. No review logic lives here — that belongs in `core`.
 */

export interface GitLabClientConfig {
  /** Instance base URL, e.g. `https://gitlab.example.com` (no trailing `/api/v4`). */
  baseUrl: string;
  /** Personal/bot access token sent as the `PRIVATE-TOKEN` header. */
  token: string;
}

export interface GitLabClientOptions {
  /** Injectable `fetch` (defaults to the global). Used to mock the network in tests. */
  fetch?: typeof fetch;
  /** Page size for paginated requests. */
  perPage?: number;
  /**
   * Injectable sleep for rate-limit backoff (defaults to real `setTimeout`).
   * Tests should pass a no-op to avoid delays.
   */
  sleep?: (ms: number) => Promise<void>;
}

type QueryValue = string | number | boolean;
type Query = Record<string, QueryValue | undefined>;

/** Raised when GitLab returns a non-2xx response. Carries status + body for diagnostics. */
export class GitLabApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(status: number, url: string, body: string) {
    super(`GitLab API request failed: HTTP ${String(status)} for ${url}`);
    this.name = 'GitLabApiError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const API_PREFIX = 'api/v4';
const DEFAULT_PER_PAGE = 50;
const MAX_RATE_LIMIT_RETRIES = 2;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 1_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class GitLabClient {
  readonly #baseUrl: string;
  #token: string;
  readonly #fetch: typeof fetch;
  readonly #perPage: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(config: GitLabClientConfig, options: GitLabClientOptions = {}) {
    this.#baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.#token = config.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#perPage = options.perPage ?? DEFAULT_PER_PAGE;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /** Rotate the PRIVATE-TOKEN used on subsequent requests. */
  setToken(token: string): void {
    this.#token = token;
  }

  /** GET a single JSON resource under `/api/v4/<path>`. */
  async get<T>(path: string, query: Query = {}): Promise<T> {
    const response = await this.#request('GET', this.#buildUrl(path, query));
    return (await response.json()) as T;
  }

  /** GET a plain-text resource (job traces). */
  async getText(path: string, query: Query = {}): Promise<string> {
    const response = await this.#request(
      'GET',
      this.#buildUrl(path, query),
      undefined,
      'text/plain',
    );
    return response.text();
  }

  /**
   * GET a paginated JSON collection, following `x-next-page` until exhausted.
   * Each page must be a JSON array; results are concatenated in page order.
   */
  async getAll<T>(path: string, query: Query = {}): Promise<T[]> {
    const items: T[] = [];
    let page: number | undefined = 1;

    while (page !== undefined) {
      const url = this.#buildUrl(path, {
        ...query,
        per_page: this.#perPage,
        page,
      });
      const response = await this.#request('GET', url);
      const pageItems = (await response.json()) as T[];
      items.push(...pageItems);

      // GitLab returns the next page number here, or an empty string on the
      // final page (and no header at all for non-paginated responses).
      const next = response.headers.get('x-next-page');
      const parsed = next ? Number(next) : NaN;
      page = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    }

    return items;
  }

  /** POST JSON to `/api/v4/<path>` and parse the JSON response (empty body → `undefined`). */
  async post<T>(path: string, body: unknown, query: Query = {}): Promise<T> {
    const response = await this.#request('POST', this.#buildUrl(path, query), body);
    return this.#parseJsonBody<T>(response);
  }

  /** PUT JSON to `/api/v4/<path>` and parse the JSON response (empty body → `undefined`). */
  async put<T>(path: string, body: unknown, query: Query = {}): Promise<T> {
    const response = await this.#request('PUT', this.#buildUrl(path, query), body);
    return this.#parseJsonBody<T>(response);
  }

  #buildUrl(path: string, query: Query): string {
    const normalizedPath = path.replace(/^\/+/, '');
    const url = new URL(`${this.#baseUrl}/${API_PREFIX}/${normalizedPath}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async #parseJsonBody<T>(response: Response): Promise<T> {
    const text = await response.text();
    if (text === '') {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  async #request(
    method: string,
    url: string,
    body?: unknown,
    accept = 'application/json',
  ): Promise<Response> {
    let rateLimitRetries = 0;

    while (true) {
      const headers: Record<string, string> = {
        'PRIVATE-TOKEN': this.#token,
        Accept: accept,
      };
      const init: RequestInit = { method, headers };

      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }

      const response = await this.#fetch(url, init);

      if (response.status === 429 && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        const retryAfter = response.headers.get('Retry-After');
        const seconds = retryAfter ? Number(retryAfter) : NaN;
        const backoffMs =
          Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : DEFAULT_RATE_LIMIT_BACKOFF_MS;
        await this.#sleep(backoffMs);
        rateLimitRetries += 1;
        continue;
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new GitLabApiError(response.status, url, errorBody);
      }

      return response;
    }
  }
}
