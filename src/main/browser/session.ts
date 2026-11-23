/**
 * Sandboxing for the internal browser.
 *
 * The agent drives a real web page, so the interesting question is not "can the page run
 * script" but "what can the page reach from inside beeCode". The answer must be: the
 * network, and nothing else. That is what this module pins down, once per session:
 *
 *   - a dedicated partition (in-memory unless the user opted into persistence), so the
 *     agent never shares cookies with the user's own browsing and forgets the run;
 *   - every permission request denied — camera, microphone, geolocation, notifications,
 *     clipboard, MIDI, serial, HID, fullscreen — regardless of what the page asks;
 *   - downloads confined to `<workspace>/Downloads`: a page may hand the user a file, but
 *     only into the folder the user already let beeCode write to;
 *   - non-web schemes blocked at the network layer (`file:`, `chrome:`, custom protocol
 *     handlers installed by other apps), so a `file:///C:/...` URL cannot become an
 *     arbitrary-file-read primitive;
 *   - popups and `window.open` denied in the host, which keeps a tab where the agent put it.
 *
 * Node integration is off and the view is sandboxed at construction (see `host.ts`); that
 * combination is what makes "the page cannot touch the OS" true rather than aspirational.
 */
import { createHash } from 'node:crypto';
import { session, type Session } from 'electron';
import { reserveDownloadPath } from './downloads';
import type { BrowserDownloadInfo } from '../../shared/browser';

/** Schemes a page may load. Everything else is cancelled before it hits the network. */
const ALLOWED_SCHEME = /^(https?|wss?|data|blob|about):/i;

const hardened = new Set<string>();

export interface BrowserSessionOptions {
  /** Keep cookies and storage between runs. Default false: an ephemeral session. */
  persistSession: boolean;
  /**
   * Workspace the cookies belong to. Each workspace gets its own partition, so a run in one
   * folder never sees the logins of another: persistence is per workspace, not per app.
   */
  workspace?: string;
  /**
   * Called once per page download. A download is the only way a page writes to the machine,
   * so it is reported rather than performed silently, and the UI/agent can say where the file
   * landed.
   */
  onDownload?: (download: BrowserDownloadInfo) => void;
}



/**
 * Partition name for a workspace: the root is hashed rather than embedded, which keeps the
 * name short and free of path separators and colons. No workspace means the plain default.
 */
export function browserPartition(options: BrowserSessionOptions): string {
  const root = (options.workspace ?? '').trim().replace(/\\/g, '/').toLowerCase();
  const key = root ? createHash('sha1').update(root).digest('hex').slice(0, 12) : '';
  const name = key ? `beecode-browser-${key}` : 'beecode-browser';
  return options.persistSession ? `persist:${name}` : name;
}

export function browserSession(options: BrowserSessionOptions): Session {
  const partition = browserPartition(options);
  const ses = session.fromPartition(partition);
  if (hardened.has(partition)) return ses;
  hardened.add(partition);
  harden(ses, options);
  return ses;
}

function harden(ses: Session, options: BrowserSessionOptions): void {
  // Deny everything, silently: answering "no" is the whole policy, and the agent cannot
  // grant permissions on the user's behalf because there is no UI path to do so.
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);

  // A download is a file write performed by a page, so it is the one place the sandbox lets
  // something out: it lands in `<workspace>/Downloads` and nowhere else. Without a workspace
  // there is no folder the user agreed to write into, so the download is dropped.
  ses.on('will-download', (event, item) => {
    const filename = item.getFilename();
    let target: string | undefined;
    try {
      target = reserveDownloadPath(options.workspace, filename);
    } catch {
      target = undefined;
    }
    if (!target) {
      event.preventDefault();
      options.onDownload?.({ filename, state: 'refused', at: new Date().toISOString() });
      return;
    }
    item.setSavePath(target);
    item.once('done', (_doneEvent, state) => {
      options.onDownload?.({ filename, path: target, state, at: new Date().toISOString() });
    });
  });

  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !ALLOWED_SCHEME.test(details.url) });
  });

  ses.setSpellCheckerEnabled(false);
}

/** Exposed for tests: is this URL something the sandboxed session may request? */
export function isAllowedRequestUrl(url: string): boolean {
  return ALLOWED_SCHEME.test(url);
}

/** Exposed for tests: the scheme check used for top-level navigation. */
export function isAllowedNavigation(url: string): boolean {
  return /^(https?):/i.test(url) || url === 'about:blank';
}
