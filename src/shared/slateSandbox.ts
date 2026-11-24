/**
 * What a *live* slate is allowed to reach.
 *
 * A Tier A slate is inert: the renderer sanitises the HTML and the app's own CSP forbids
 * every connection, so a slate can show data but never fetch it. A live slate (Tier B) runs
 * its author's scripts inside a sandboxed `WebContentsView`, which moves the question from
 * "can it run code" to "what can the code reach". This module answers that second question
 * in one place, so the store, the approval card and the host cannot drift apart:
 *
 *   - an origin is a scheme, a host and a port — never a path, never credentials, never `*`;
 *   - the host builds the page CSP from exactly these origins and from nothing else;
 *   - markdown and csv slates cannot go live at all, because there is no script to run.
 *
 * The list is deliberately short (see `SLATE_LIVE_LIMITS`): an allowlist nobody reads is not
 * consent, and the approval card has to be able to print every entry.
 */

export const SLATE_LIVE_SCHEME = 'slate';
export const SLATE_LIVE_HOST = 'live';

export const SLATE_LIVE_LIMITS = {
  /** Origins one slate may call. */
  origins: 8,
} as const;

/**
 * One origin, normalised, or a refusal that says what to write instead. Errors are the
 * user-facing text on the approval card and in the gallery, so they describe the fix.
 */
export function normaliseSlateOrigin(raw: string): string {
  const text = raw.trim();
  if (!text) throw new Error('an origin cannot be empty');
  if (text.includes('*')) {
    throw new Error(
      `"${text}" is a wildcard — a live slate has to name the exact origins it calls`,
    );
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(
      `"${text}" is not a URL — name an origin such as https://api.example.com`,
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`"${text}" is not http(s) — a live slate may only call the web`);
  }
  if (url.username || url.password) {
    throw new Error(
      `"${text}" carries credentials — those belong in the service, never in a slate`,
    );
  }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error(`"${text}" is more than an origin — give scheme, host and port only`);
  }
  return url.origin;
}

/** The whole allowlist: normalised, deduplicated, order preserved, capped. */
export function normaliseSlateOrigins(input: readonly string[] | undefined): string[] {
  const raw = (input ?? []).map((entry) => String(entry));
  const seen = new Set<string>();
  for (const entry of raw) {
    const origin = normaliseSlateOrigin(entry);
    seen.add(origin);
  }
  const origins = [...seen];
  if (origins.length > SLATE_LIVE_LIMITS.origins) {
    throw new Error(
      `a live slate may call at most ${SLATE_LIVE_LIMITS.origins} origins (this one asks for ${origins.length})`,
    );
  }
  return origins;
}

/** Only an html slate has script to run; the other kinds stay inert whatever is asked. */
export function canSlateGoLive(kind: string): boolean {
  return kind === 'html';
}

/**
 * The page CSP. It is a whitelist in every direction: nothing loads that is not inline or
 * data:, and the network is exactly the allowlist — `connect-src 'none'` when it is empty.
 */
export function slateLiveCsp(origins: readonly string[]): string {
  const connect = origins.length ? origins.join(' ') : "'none'";
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    `connect-src ${connect}`,
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * `slate://live/<session>/<id>/v<version>` — the one URL the host ever loads. The ids are
 * the store's own (already path-guarded); this is only about parsing them back.
 */
export function slateLiveUrl(sessionId: string, slateId: string, version: number): string {
  const session = encodeURIComponent(sessionId);
  const id = encodeURIComponent(slateId);
  return `${SLATE_LIVE_SCHEME}://${SLATE_LIVE_HOST}/${session}/${id}/v${version}`;
}

export interface SlateLiveTarget {
  sessionId: string;
  id: string;
  version: number;
}

/** Parse a live URL, or `undefined` when it is not one — the host refuses rather than guesses. */
export function parseSlateLiveUrl(raw: string): SlateLiveTarget | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${SLATE_LIVE_SCHEME}:` || url.host !== SLATE_LIVE_HOST) return undefined;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 3) return undefined;
  const [sessionId, id, versionPart] = parts.map(decodeURIComponent);
  const match = /^v([1-9][0-9]{0,2})$/.exec(versionPart);
  if (!match) return undefined;
  return { sessionId, id, version: Number(match[1]) };
}

/** Is this URL inside the slate's allowlist? Used to police anything script tries to open. */
export function isSlateOriginAllowed(raw: string, origins: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return origins.some((origin) => {
    try {
      return new URL(origin).origin === url.origin;
    } catch {
      return false;
    }
  });
}
