/**
 * Download a skill artifact from a URL, so the Integrations panel can install from a link
 * instead of a dropped file. The payload is either a `SKILL.md` or a skill `.zip`; both are
 * handed to the same install path a dropped file takes, so the layout under
 * `~/.beecode/skills` cannot drift between the two ways in.
 */

/** Hard cap on a downloaded artifact: the same 5 MB the drop zone accepts. */
const MAX_BYTES = 5 * 1024 * 1024;
/** How long the whole download may take before it is abandoned. */
const TIMEOUT_MS = 20_000;
/** A longer chain is treated as a loop instead of being followed. */
const MAX_REDIRECTS = 4;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export interface DownloadedSkill {
  /** Last path segment of the final URL, used when the markdown carries no `name`. */
  fileName: string;
  data: Buffer;
  /** True when the payload starts with a ZIP header, so it goes down the archive path. */
  zip: boolean;
}

/**
 * Fetch a skill artifact.
 *
 * `https://` only, plus `http://` on a loopback host so a skill kept in a local checkout can
 * be tried without TLS. Redirects are followed by hand so every hop is re-checked against
 * that same rule (a redirect must not downgrade or leave the network), the body is read with
 * a hard byte cap (a missing or lying `content-length` does not help), and a payload that is
 * neither a ZIP nor text is rejected before it reaches the installer.
 */
export async function downloadSkill(
  rawUrl: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<DownloadedSkill> {
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = allowedUrl(rawUrl);
    for (let hop = 0; ; hop += 1) {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'application/zip, text/markdown, text/plain, application/octet-stream' },
      });
      if (REDIRECT_CODES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new Error(`HTTP ${response.status} without a location`);
        if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
        url = allowedUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
      }
      const declared = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw tooLarge(maxBytes);
      }
      const data = await readCapped(response, maxBytes);
      if (!data.length) throw new Error('the URL returned an empty body');
      const zip = isZip(data);
      if (!zip && !looksLikeText(data)) throw new Error('that URL did not return a SKILL.md or a .zip');
      return { fileName: fileNameOf(url), data, zip };
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`the download did not finish within ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function tooLarge(maxBytes: number): Error {
  return new Error(`that skill file is too large (limit ${Math.round(maxBytes / 1024 / 1024)} MB)`);
}

/** Read the body chunk by chunk so the cap applies even when `content-length` is missing. */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(maxBytes);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function allowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('that is not a valid URL');
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return url;
  throw new Error('only https:// URLs can be installed (http:// only for a loopback host)');
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

function isZip(data: Buffer): boolean {
  if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) return false;
  return (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07) &&
    (data[3] === 0x04 || data[3] === 0x06 || data[3] === 0x08);
}

/** A skill can only be text: a NUL byte in the head means HTML chrome or a binary blob. */
function looksLikeText(data: Buffer): boolean {
  return !data.subarray(0, Math.min(data.length, 1024)).includes(0);
}

function fileNameOf(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).pop() ?? 'SKILL.md';
  try {
    return decodeURIComponent(last) || 'SKILL.md';
  } catch {
    return last;
  }
}
