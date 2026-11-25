/**
 * The live slate host — the only place in beeCode where a slate's own scripts run.
 *
 * A Tier A slate is inert: its HTML is sanitised and the app's CSP forbids every
 * connection. A live slate (Tier B) is a real page, so it gets a real page's isolation:
 *
 *   - the document is served from memory over `slate://live/<session>/<id>/v<N>`, never
 *     from disk, so it has a proper origin but no filesystem reachability;
 *   - the slate's allowlist is baked into the response as a `content-security-policy`
 *     *header*, not a meta tag the document could rewrite or drop;
 *   - a per-slate in-memory partition, `sandbox: true` and **no preload**, so the page has
 *     no path to the bridge, the chat UI or the user's cookies;
 *   - permission requests, downloads, popups, webviews and redirects are all denied, and
 *     the only URL that may load or navigate is the exact hosted version.
 *
 * The bytes come from the service (`slate.read`), not from the filesystem: the store's path
 * guard stays the single source of truth for what a slate is and which version is current.
 */

import { protocol, session, WebContentsView, type BrowserWindow, type Session } from 'electron';
import {
  SLATE_LIVE_HOST,
  SLATE_LIVE_PARTITION_PREFIX,
  SLATE_LIVE_SCHEME,
  parseSlateLiveSubmitUrl,
  parseSlateLiveUrl,
  slateLiveCsp,
  slateLiveUrl,
  type SlateLiveBounds,
  type SlateLiveCommand,
  type SlateLiveDocument,
  type SlateLiveState,
  type SlateLiveTarget,
} from '../../shared/slateSandbox';
import { SLATE_SUBMIT_LIMITS, type SlateSubmission, type SlateSubmitError, type SlateSubmitSchema } from '../../shared/slateSubmit';

export interface SlateLiveHostDeps {
  /** Read one version through the service — never from disk. */
  readSlate(params: {
    sessionId: string;
    id: string;
    version?: number;
    cwd?: string;
  }): Promise<SlateLiveDocument | undefined>;
  getWindow(): BrowserWindow | null;
  /** Called after every state change so the renderer can follow it. */
  onState?(state: SlateLiveState): void;
  /**
   * Hand one form post to the sink. It goes through the service, so the store stays the
   * only thing that decides where a slate lives and which version is current.
   */
  recordSubmission(params: {
    sessionId: string;
    id: string;
    version: number;
    submissionId: string;
    /** The page's `{ fields }` object, exactly as posted. */
    payload: unknown;
    cwd?: string;
  }): Promise<
    | { ok: true; submission: SlateSubmission; total: number }
    | { ok: false; errors: SlateSubmitError[] }
  >;
}

interface Hosted {
  url: string;
  text: string;
  origins: string[];
  sessionId: string;
  id: string;
  version: number;
  /** The form this version declared; absent means no submit endpoint exists. */
  submit?: SlateSubmitSchema;
  /** Where the store should look when the session is not one the service knows. */
  cwd?: string;
}

export class SlateLiveHost {
  private view: WebContentsView | null = null;
  private hosted: Hosted | null = null;
  private attached = false;
  private bounds: SlateLiveBounds = { x: 0, y: 0, width: 1, height: 1 };
  private state: SlateLiveState = { visible: false };
  /** Partitions already hardened — `setPermissionRequestHandler` is per session, once. */
  private readonly hardened = new Set<string>();

  constructor(private readonly deps: SlateLiveHostDeps) {}

  getState(): SlateLiveState {
    return { ...this.state };
  }

  /**
   * The one write path a slate has: its own form posting back to its own origin.
   *
   * It answers the page and nothing else — `{ ok: true, n }` or `{ ok: false, errors }` —
   * and only for the version that is actually hosted, so a page cannot post against a
   * schema the user never saw. Same origin means no token, no port and no CSRF surface:
   * nothing but this page can reach this URL.
   */
  private async handleSubmit(
    target: SlateLiveTarget,
    request: Request,
    headers: Record<string, string>,
  ): Promise<Response> {
    const hosted = this.hosted;
    const matches =
      hosted !== null &&
      target.sessionId === hosted.sessionId &&
      target.id === hosted.id &&
      target.version === hosted.version;
    if (!matches || !hosted?.submit) {
      return this.json(
        { ok: false, errors: [{ field: '', message: 'no live slate is hosted at this address' }] },
        404,
        headers,
      );
    }
    if (request.method !== 'POST') {
      return this.json(
        { ok: false, errors: [{ field: '', message: 'submit with POST' }] },
        405,
        headers,
      );
    }
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > SLATE_SUBMIT_LIMITS.bytes) {
      return this.json(
        { ok: false, errors: [{ field: '', message: 'the submission is too large' }] },
        413,
        headers,
      );
    }

    let parsed: { submissionId?: unknown; payload?: unknown };
    try {
      const body = await request.text();
      if (Buffer.byteLength(body, 'utf8') > SLATE_SUBMIT_LIMITS.bytes) {
        return this.json(
          { ok: false, errors: [{ field: '', message: 'the submission is too large' }] },
          413,
          headers,
        );
      }
      const raw = JSON.parse(body) as { submissionId?: unknown; fields?: unknown };
      parsed = { submissionId: raw?.submissionId, payload: { fields: raw?.fields } };
    } catch {
      return this.json(
        { ok: false, errors: [{ field: '', message: 'the submission is not JSON' }] },
        400,
        headers,
      );
    }

    const submissionId = typeof parsed.submissionId === 'string' ? parsed.submissionId : '';
    if (!submissionId) {
      return this.json(
        { ok: false, errors: [{ field: '', message: 'the submission needs an id' }] },
        400,
        headers,
      );
    }

    let result: Awaited<ReturnType<SlateLiveHostDeps['recordSubmission']>>;
    try {
      result = await this.deps.recordSubmission({
        sessionId: target.sessionId,
        id: target.id,
        version: target.version,
        submissionId,
        payload: parsed.payload,
        ...(hosted.cwd ? { cwd: hosted.cwd } : {}),
      });
    } catch (error) {
      return this.json(
        { ok: false, errors: [{ field: '', message: messageOf(error) }] },
        500,
        headers,
      );
    }
    if (!result.ok) return this.json({ ok: false, errors: result.errors }, 422, headers);
    return this.json({ ok: true, n: result.submission.n }, 200, headers);
  }

  private json(body: unknown, status: number, headers: Record<string, string>): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
    });
  }

  /**
   * Answer one `slate://` request. Anything that is not the exact hosted version gets a
   * 404 with no body: the host serves what it was asked to show, not what a URL asks for.
   */
  handleRequest(request: Request): Response | Promise<Response> {
    const headers: Record<string, string> = {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };
    const submitTarget = parseSlateLiveSubmitUrl(request.url);
    if (submitTarget) return this.handleSubmit(submitTarget, request, headers);
    const hosted = this.hosted;
    const target = parseSlateLiveUrl(request.url);
    const matches =
      target !== undefined &&
      hosted !== null &&
      target.sessionId === hosted.sessionId &&
      target.id === hosted.id &&
      target.version === hosted.version;
    if (request.method !== 'GET' || !matches || !hosted) {
      return new Response('no live slate is hosted at this address', { status: 404, headers });
    }
    return new Response(hosted.text, {
      status: 200,
      headers: {
        ...headers,
        'content-type': 'text/html; charset=utf-8',
        // The allowlist as a response header: the document cannot widen or remove it.
        'content-security-policy': slateLiveCsp(hosted.origins, { submit: Boolean(hosted.submit) }),
        'referrer-policy': 'no-referrer',
      },
    });
  }

  /** Run one command from the renderer. Never throws: a refusal becomes `state.error`. */
  async run(command: SlateLiveCommand): Promise<SlateLiveState> {
    switch (command.kind) {
      case 'show':
        return this.show(command);
      case 'bounds':
        this.setBounds(command.bounds);
        return this.getState();
      case 'hide':
        return this.hide();
    }
  }

  async show(command: Extract<SlateLiveCommand, { kind: 'show' }>): Promise<SlateLiveState> {
    this.bounds = normaliseBounds(command.bounds);
    const target = { sessionId: command.sessionId, id: command.id };

    let doc: SlateLiveDocument | undefined;
    try {
      doc = await this.deps.readSlate({
        ...target,
        version: command.version,
        ...(command.cwd ? { cwd: command.cwd } : {}),
      });
    } catch (error) {
      return this.fail(command.id, `this slate could not be read: ${messageOf(error)}`);
    }
    if (!doc) return this.fail(command.id, 'this slate does not exist');
    // Belt and braces: the store already refuses a non-html live slate, and the consent
    // switch already withdrew these origins. Checked here because this is where it costs.
    if (!doc.live) return this.fail(command.id, 'this slate has no execution permission');
    // No such check on the origins themselves: a slate that reaches nothing is the most
    // common live slate — an interactive page that builds its DOM and keeps its state in the
    // document. What it may reach is decided by the CSP baked into the response above, so an
    // empty allowlist means the code runs and every connection is refused. Refusing to attach
    // it would have made the self-contained slate the only one that could not run.

    const url = slateLiveUrl(command.sessionId, command.id, doc.version);
    this.hosted = {
      url,
      text: doc.text,
      origins: doc.origins,
      ...target,
      version: doc.version,
      ...(doc.submit ? { submit: doc.submit } : {}),
      ...(command.cwd ? { cwd: command.cwd } : {}),
    };

    const view = this.ensureView(command.id);
    if (!view) return this.fail(command.id, 'there is no window to show this slate in');
    this.attach();
    this.state = {
      visible: this.attached,
      ...target,
      slateId: command.id,
      version: doc.version,
      url,
      origins: [...doc.origins],
    };
    this.publish();

    try {
      await view.webContents.loadURL(url);
    } catch (error) {
      // A CSP refusal of the document itself shows up here; the page is not on screen.
      this.state = { ...this.state, visible: false, error: messageOf(error) };
      this.publish();
    }
    return this.getState();
  }

  hide(): SlateLiveState {
    this.detach();
    this.hosted = null;
    this.state = { visible: false };
    this.publish();
    return this.getState();
  }

  setBounds(bounds: SlateLiveBounds): void {
    this.bounds = normaliseBounds(bounds);
    if (this.view && this.attached) this.view.setBounds(this.bounds);
  }

  /** The window is closing: drop the view and forget the document. */
  dispose(): void {
    this.detach();
    const view = this.view;
    this.view = null;
    this.hosted = null;
    this.state = { visible: false };
    if (view) {
      try {
        view.webContents.close();
      } catch {
        // Already gone with the window.
      }
    }
  }

  private fail(slateId: string, error: string): SlateLiveState {
    this.detach();
    this.hosted = null;
    this.state = { visible: false, slateId, error };
    this.publish();
    return this.getState();
  }

  private publish(): void {
    this.deps.onState?.(this.getState());
  }

  private attach(): void {
    const win = this.deps.getWindow();
    const view = this.view;
    if (!win || win.isDestroyed() || !view) return;
    if (!this.attached) {
      win.contentView.addChildView(view);
      this.attached = true;
    }
    view.setBounds(this.bounds);
  }

  private detach(): void {
    const win = this.deps.getWindow();
    const view = this.view;
    if (view && this.attached && win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(view);
      } catch {
        // The window went away first; nothing to detach from.
      }
    }
    this.attached = false;
  }

  /**
   * One view, reused across slates: showing a second slate reloads the same sandboxed
   * page rather than leaving an old one alive somewhere off-screen.
   */
  private ensureView(slateId: string): WebContentsView | null {
    const win = this.deps.getWindow();
    if (!win || win.isDestroyed()) return null;
    const ses = this.harden(slateId);

    if (this.view && !this.view.webContents.isDestroyed()) {
      return this.view;
    }

    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        // No preload, therefore no bridge: the page cannot even see `window.beeCode`.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        spellcheck: false,
        devTools: false,
      },
    });
    view.setBackgroundColor('#00000000');
    view.setBounds(this.bounds);

    const wc = view.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event, url) => {
      // `loadURL` of the hosted version is initiated here, so it does not reach this
      // handler; anything the page itself tries (including in-page links) is refused.
      if (!this.isHostedUrl(url)) event.preventDefault();
    });
    wc.on('will-redirect', (event, url) => {
      if (!this.isHostedUrl(url)) event.preventDefault();
    });
    wc.on('will-attach-webview', (event) => event.preventDefault());
    wc.on('render-process-gone', () => {
      this.state = { ...this.state, visible: false, error: 'the slate page stopped responding' };
      this.publish();
    });

    this.view = view;
    return view;
  }

  private isHostedUrl(url: string): boolean {
    const hosted = this.hosted;
    const target = parseSlateLiveUrl(url);
    return (
      target !== undefined &&
      hosted !== null &&
      target.sessionId === hosted.sessionId &&
      target.id === hosted.id &&
      target.version === hosted.version
    );
  }

  /**
   * A slate gets its own in-memory partition, hardened before a single byte is loaded:
   * every permission denied, every download refused.
   */
  private harden(slateId: string): Session {
    const partition = `${SLATE_LIVE_PARTITION_PREFIX}${slateId}`;
    const ses = session.fromPartition(partition, { cache: false });
    if (this.hardened.has(partition)) return ses;
    this.hardened.add(partition);

    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());
    // No service workers or shared workers: a slate runs while it is on screen, and no
    // longer, so it must not be able to leave something running behind it.
    ses.setPreloads([]);
    return ses;
  }
}

function normaliseBounds(bounds: SlateLiveBounds): SlateLiveBounds {
  const clamp = (value: number): number => {
    const n = Number.isFinite(value) ? Math.floor(value) : 0;
    return n < 0 ? 0 : n;
  };
  return {
    x: clamp(bounds.x),
    y: clamp(bounds.y),
    width: Math.max(1, clamp(bounds.width)),
    height: Math.max(1, clamp(bounds.height)),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wire the `slate://` scheme to a host. Called once, after `app.whenReady()`, because
 * `protocol.handle` refuses to register earlier.
 */
export function serveSlateLive(host: SlateLiveHost): void {
  protocol.handle(SLATE_LIVE_SCHEME, (request) => host.handleRequest(request));
}

/** The privileges the scheme needs, and deliberately nothing more. */
export const SLATE_LIVE_SCHEME_PRIVILEGES = {
  scheme: SLATE_LIVE_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    // The fetch API is on because a page has to reach its own origin to post a form; CORS
    // and service workers stay off, and `connect-src` is still the only way out — `'self'`
    // is added there for slates that declared a form, and for nothing else.
    supportFetchAPI: true,
    corsEnabled: false,
    allowServiceWorkers: false,
    bypassCSP: false,
  },
} as const;

export { SLATE_LIVE_HOST };
