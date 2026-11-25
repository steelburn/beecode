import {
  RELEASES_API_URL,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_FETCH_TIMEOUT_MS,
  evaluateRelease,
  type UpdateStatus,
} from '../shared/update';

/** The slice of a `fetch` Response this needs — Electron's `net.fetch` satisfies it. */
export interface JsonResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type JsonFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<JsonResponseLike>;

/**
 * `releases/latest` as JSON, from the same network stack Electron uses (so the app proxy,
 * if the user has one, is honoured). The User-Agent is required — GitHub answers 403 without
 * it — and the accept type pins the version of the payload these functions were written for.
 */
export function githubJsonFetcher(fetch: JsonFetch, userAgent: string, timeoutMs = UPDATE_FETCH_TIMEOUT_MS) {
  return async (): Promise<unknown> => {
    const response = await fetch(RELEASES_API_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': userAgent,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return response.json();
  };
}

export interface UpdateCheckerOptions {
  /** The running build, e.g. `0.1.3`. */
  currentVersion: string;
  /** Injected so a test drives the payload instead of the network. */
  fetchJson: () => Promise<unknown>;
  /** Called with every state a completed check lands on (never for a throttled no-op). */
  onChange?: (status: UpdateStatus) => void;
  now?: () => number;
  intervalMs?: number;
}

/**
 * One checker per app run.
 *
 * Two rules it exists for. The first is that a check must not be repeated: an answer that
 * cannot change within hours is asked for once at startup, then every `intervalMs`. The
 * second is that a *failed* check must not take a known update away — the network dropping
 * for a second is not evidence that 0.1.4 was unpublished — so an error keeps the previous
 * `available` status and only a successful read may replace it.
 */
export class UpdateChecker {
  #status: UpdateStatus = { state: 'idle' };
  /** When the last *successful* check happened; a failure must be retried, not cached. */
  #lastSuccessMs = 0;
  #inFlight: Promise<UpdateStatus> | null = null;
  #options: Required<Omit<UpdateCheckerOptions, 'onChange'>> & Pick<UpdateCheckerOptions, 'onChange'>;

  constructor(options: UpdateCheckerOptions) {
    this.#options = {
      now: () => Date.now(),
      intervalMs: UPDATE_CHECK_INTERVAL_MS,
      ...options,
    };
  }

  get status(): UpdateStatus {
    return this.#status;
  }

  /**
   * `force` is a person asking — it ignores the interval, because "check now" that answers
   * from a six-hour-old cache is a lie. A request already in flight is shared instead of
   * doubled: two clicks are one call to GitHub.
   */
  async check(force = false): Promise<UpdateStatus> {
    if (this.#inFlight) return this.#inFlight;
    const now = this.#options.now();
    // `lastSuccessMs > 0` rather than "a status exists": after a failure there is a status but
    // nothing fresh to answer with, and the next check must ask GitHub again.
    if (!force && this.#lastSuccessMs > 0 && now - this.#lastSuccessMs < this.#options.intervalMs) {
      return this.#status;
    }
    this.#inFlight = this.#run().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #run(): Promise<UpdateStatus> {
    const previous = this.#status;
    try {
      const payload = await this.#options.fetchJson();
      this.#status = evaluateRelease(payload, this.#options.currentVersion, this.#options.now());
      // Only a read that produced a comparable answer counts as fresh; an unreadable payload
      // is an error like any other.
      if (this.#status.state !== 'error') this.#lastSuccessMs = this.#options.now();
    } catch (error) {
      const message = (error as Error)?.name === 'TimeoutError'
        ? 'the request timed out'
        : ((error as Error)?.message || 'the request failed');
      this.#status =
        previous.state === 'available'
          ? previous
          : { state: 'error', checkedAt: this.#options.now(), version: this.#options.currentVersion, message };
    }
    this.#options.onChange?.(this.#status);
    return this.#status;
  }
}
