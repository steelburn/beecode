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

import type { SlateSubmitSchema } from './slateSubmit';

export const SLATE_LIVE_SCHEME = 'slate';
export const SLATE_LIVE_HOST = 'live';

/**
 * One partition per slate, and *in memory*: a live slate keeps no cookies, no storage and
 * no cache past the end of its run, so two slates never share state and a re-run starts
 * from nothing.
 */
export const SLATE_LIVE_PARTITION_PREFIX = 'slate-live:';

export const SLATE_LIVE_LIMITS = {
  /** Origins one slate may call. */
  origins: 8,
  /** The largest page that may be served: a slate version, or a plain HTML file. */
  textBytes: 4 * 1024 * 1024,
} as const;

/**
 * The synthetic session and version a page hosted from a plain file is served under:
 * `slate://live/file/<id>/v1`.
 *
 * A document tab's own HTML file needs exactly the isolation a slate gets — a real origin, no
 * filesystem reachability, the same CSP — so it reuses this host and this URL parser instead
 * of growing a second sandbox that could drift from it. `<id>` is a hash of the file's path
 * and bytes, so the URL never names a folder and an edited file is a different page.
 */
export const SLATE_LIVE_FILE_SESSION = 'file';
export const SLATE_LIVE_FILE_VERSION = 1;

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
 *
 * A slate that declares a form adds `'self'` and nothing else: posting to its own
 * `slate://live/...` origin is not a new capability, it is the app answering its own
 * page. `form-action` stays `'none'`, so the form has to be posted with `fetch` from a
 * submit handler — which is also what keeps the target pinned to this version.
 */
export function slateLiveCsp(
  origins: readonly string[],
  options: { submit?: boolean } = {},
): string {
  const connect = [...origins, ...(options.submit ? ["'self'"] : [])].join(' ') || "'none'";
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

/**
 * `slate://live/<session>/<id>/v<version>/submit` — where a live page posts its form.
 * One path deeper on the origin that served it, so the page needs no token, no port and
 * no CORS: `fetch(location.pathname + '/submit', ...)` is the whole protocol.
 */
export function parseSlateLiveSubmitUrl(raw: string): SlateLiveTarget | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${SLATE_LIVE_SCHEME}:` || url.host !== SLATE_LIVE_HOST) return undefined;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 4 || parts[3] !== 'submit') return undefined;
  const [sessionId, id, versionPart] = parts.slice(0, 3).map(decodeURIComponent);
  const match = /^v([1-9][0-9]{0,2})$/.exec(versionPart);
  if (!match) return undefined;
  return { sessionId, id, version: Number(match[1]) };
}

/** Is this URL inside the slate's allowlist? Used to police anything script tries to open. */
/** The rectangle the renderer reserves for the live view, in window coordinates. */
export interface SlateLiveBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What the renderer asks the host to do. The renderer never holds a handle to the view: it
 * shows one slate at a time by id and keeps the rectangle current.
 */
export type SlateLiveCommand =
  | {
      kind: 'show';
      sessionId: string;
      id: string;
      version?: number;
      /** Where to look when the session is not one the service still knows (a smoke run). */
      cwd?: string;
      bounds: SlateLiveBounds;
    }
  | {
      kind: 'showFile';
      /** The file the page came from: a label for the bar and the host's state, never a source. */
      path: string;
      /** The HTML the document tab is showing — served from memory, like a slate version. */
      text: string;
      /** What the user granted for this one run. Empty is the common case: a self-contained page. */
      origins?: string[];
      bounds: SlateLiveBounds;
    }
  | { kind: 'bounds'; bounds: SlateLiveBounds }
  | { kind: 'hide' };

/** One version, read through the service, ready to serve. */
export interface SlateLiveDocument {
  text: string;
  /** The version actually read — the store's current one when none was asked for. */
  version: number;
  /** The allowlist as persisted. Empty means the slate may reach nothing. */
  origins: string[];
  /**
   * The form this version declares, if any. Present means the page may post to
   * `<this url>/submit` and `connect-src` carries `'self'`.
   */
  submit?: SlateSubmitSchema;
  live: boolean;
}

/**
 * What the host reports back. `error` is user-facing and means nothing was attached, so a
 * refusal never leaves a blank rectangle where the page should be.
 */
export interface SlateLiveState {
  visible: boolean;
  sessionId?: string;
  slateId?: string;
  version?: number;
  url?: string;
  origins?: string[];
  /** Set when the page came from a plain file rather than a slate version. */
  filePath?: string;
  error?: string;
}

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
