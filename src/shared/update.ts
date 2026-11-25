/**
 * Update checking. The published installer is a GitHub release asset, so "is there a newer
 * beeCode?" is a question about `releases/latest` — nothing here talks to the network: the
 * main process fetches the payload, these functions decide what it means and say it in one
 * line. Pure on purpose, so the interesting part (which release counts as newer, and why a
 * failed check must not hide a known update) is testable without Electron.
 */

export const UPDATE_REPO = 'steelburn/beecode';
export const RELEASES_API_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
export const RELEASES_PAGE_URL = `https://github.com/${UPDATE_REPO}/releases`;

/**
 * How long a successful check stays fresh. The installer is published by hand a few times a
 * week at most; asking GitHub more often is a request per minute for an answer that cannot
 * change that fast, and unauthenticated callers get 60 requests an hour per address.
 */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** A request that hangs must not leave the check spinning for the life of the window. */
export const UPDATE_FETCH_TIMEOUT_MS = 8000;

export interface UpdateAsset {
  name: string;
  size: number;
  url: string;
}

export interface UpdateRelease {
  /** Normalised `major.minor.patch`, no `v` prefix. */
  version: string;
  /** The raw tag, e.g. `v0.1.4` — what the release page is filed under. */
  tag: string;
  name: string;
  notes: string;
  url: string;
  publishedAt: string;
  /** The Windows installer, when the release carries one. */
  asset: UpdateAsset | null;
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'current'; checkedAt: number; version: string; latest: string }
  | { state: 'available'; checkedAt: number; version: string; release: UpdateRelease }
  | { state: 'error'; checkedAt: number; version: string; message: string };

export interface ParsedVersion {
  parts: [number, number, number];
  /** Empty for a plain release; a prerelease sorts below the same `parts`. */
  prerelease: string;
}

/**
 * `v1.2.3`, `1.2.3`, `1.2.3-beta.1` and `1.2.3+build` are all understood; anything else is
 * not a version this app can compare, and `null` keeps it out of a comparison instead of
 * letting it win one.
 */
export function parseVersion(text: string): ParsedVersion | null {
  const match = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/.exec(
    (text ?? '').trim(),
  );
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? '',
  };
}

/**
 * Semver order, restricted to what a release tag can be: numbers compare numerically, and a
 * prerelease sits below its release (`0.2.0-rc.1 < 0.2.0`). Two unreadable versions compare
 * equal — a caller that cannot read a version must not be told there is an update.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] < right.parts[i] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/** Strictly newer — the same version, or an older one, is not an update. */
export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

function pickInstaller(assets: unknown): UpdateAsset | null {
  if (!Array.isArray(assets)) return null;
  const exes = assets.filter(
    (asset): asset is Record<string, unknown> =>
      !!asset && typeof asset === 'object' && typeof (asset as { name?: unknown }).name === 'string' &&
      /\.exe$/i.test((asset as { name: string }).name),
  );
  // An installer is the one named as such; a release may also carry debug tooling as `.exe`.
  const chosen = exes.find((asset) => /setup/i.test(asset.name as string)) ?? exes[0];
  if (!chosen) return null;
  const name = chosen.name as string;
  const size = typeof chosen.size === 'number' ? chosen.size : 0;
  const url = typeof chosen.browser_download_url === 'string' ? chosen.browser_download_url : '';
  return { name, size, url };
}

/**
 * Read one `releases/latest` payload. Drafts and prereleases are refused by name: they are
 * not something a user can be pointed at, and `releases/latest` may still surface one when
 * it is the only release in the repository.
 */
export function readLatestRelease(payload: unknown): UpdateRelease | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  if (raw.draft === true || raw.prerelease === true) return null;
  const tag = typeof raw.tag_name === 'string' ? raw.tag_name.trim() : '';
  const parsed = parseVersion(tag);
  if (!parsed) return null;
  const version = parsed.parts.join('.');
  const notes = typeof raw.body === 'string' ? raw.body.slice(0, 2000) : '';
  return {
    version,
    tag,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : tag,
    notes,
    url: typeof raw.html_url === 'string' && /^https:\/\//.test(raw.html_url) ? raw.html_url : RELEASES_PAGE_URL,
    publishedAt: typeof raw.published_at === 'string' ? raw.published_at : '',
    asset: pickInstaller(raw.assets),
  };
}

/** Turn a fetched payload into the one status the UI renders. */
export function evaluateRelease(
  payload: unknown,
  currentVersion: string,
  checkedAt: number,
): UpdateStatus {
  const release = readLatestRelease(payload);
  if (!release) {
    return {
      state: 'error',
      checkedAt,
      version: currentVersion,
      message: 'the published releases could not be read',
    };
  }
  // A newer local build (a dev tree ahead of the release) is not an update either: the check
  // answers "is there something newer to install", not "is the tag different".
  if (!isNewerVersion(release.version, currentVersion)) {
    return { state: 'current', checkedAt, version: currentVersion, latest: release.version };
  }
  return { state: 'available', checkedAt, version: currentVersion, release };
}

/** Where a user should go: their own release page when known, the list otherwise. */
export function updateDownloadUrl(status: UpdateStatus): string | undefined {
  if (status.state !== 'available') return undefined;
  return status.release.asset?.url || status.release.url || RELEASES_PAGE_URL;
}

export function formatUpdateSize(bytes: number): string {
  if (!bytes || bytes < 0) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * One sentence for the UI, or `undefined` when there is nothing to say. A failed check stays
 * quiet in the badge on purpose — an update check that never asked to be noticed must not
 * turn an unreachable network into a permanent error on screen — but it is still available
 * to the manual check, which is what a person asked for.
 */
export function updateNotice(status: UpdateStatus): string | undefined {
  switch (status.state) {
    case 'available': {
      const size = formatUpdateSize(status.release.asset?.size ?? 0);
      const what = size ? `${size} installer` : 'installer';
      return `beeCode ${status.release.version} is available — download the ${what}`;
    }
    case 'current':
      return `beeCode ${status.version} is up to date`;
    case 'error':
      return `Could not check for updates: ${status.message}`;
    default:
      return undefined;
  }
}

/** The badge is a version, not a sentence: it has to fit in the rail foot. */
export function updateBadgeLabel(status: UpdateStatus): string | undefined {
  return status.state === 'available' ? `↑ ${status.release.version}` : undefined;
}

/** Which state the status is in, for a one-line log line. */
export function describeUpdateStatus(status: UpdateStatus): string {
  return updateNotice(status) ?? `update check ${status.state}`;
}
