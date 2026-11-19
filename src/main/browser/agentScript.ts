/**
 * The page-side half of the internal browser.
 *
 * `installAgentBridge` is *not* imported by anything at runtime — it is stringified with
 * `Function.prototype.toString()` and evaluated inside the page (isolated world 1001). That
 * keeps the DOM glue in TypeScript (so it is typechecked and lint-clean) while still
 * shipping as page script. Two consequences to respect when editing it:
 *
 *   - it must be self-contained: no imports, no references to module-level helpers;
 *   - it must not rely on TypeScript syntax surviving — esbuild strips types, so only the
 *     emitted JavaScript is sent to the page. Enums/parameter properties would break.
 *
 * Why an isolated world: the page cannot see or shim our functions, so a hostile page
 * cannot rewrite `snapshot()` to lie to the model. The DOM the script touches is the real
 * one, and the cursor overlay it appends is a normal (invisible to page JS) DOM node, which
 * is exactly what we want — the user sees the AI pointer, the page does not get to move it.
 */

/** World id shared by the injected bootstrap; 999 is used by Electron internals on some paths. */
export const AGENT_WORLD_ID = 1001;

/** Attribute holding the ref of the last snapshot, so a stale ref fails instead of misfiring. */
export const REF_ATTRIBUTE = 'data-beecode-ref';

/** Ref whose element is `<body>` — used for page-level scroll and text reads. */
export const DOCUMENT_REF = 'document';

function installAgentBridge(): void {
  const w = globalThis as unknown as Record<string, unknown>;
  if (w.__beeCodeBrowser) return;

  const REF_ATTR = 'data-beecode-ref';
  const MAX_ELEMENTS = 120;
  const MAX_TEXT = 6000;
  const NAME_LIMIT = 120;

  const CANDIDATE_SELECTOR = [
    'a[href]',
    'button',
    'input',
    'textarea',
    'select',
    'summary',
    '[role]:not([role=""])',
    '[contenteditable="true"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const norm = (value: unknown, limit: number): string =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, limit);

  const rectOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  };

  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number(style.opacity || '1') === 0) return false;
    // Elements far outside the viewport are still clickable after a scroll, so keep them —
    // but drop ones taller than the document (hidden off-canvas menus live there).
    return r.bottom > -5000 && r.top < 100000;
  };

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    if ((el as HTMLElement).isContentEditable) return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return 'element';
  };

  const nameOf = (el: Element): string => {
    const candidates: unknown[] = [
      el.getAttribute('aria-label'),
      el.getAttribute('aria-placeholder'),
      el.getAttribute('placeholder'),
      el.getAttribute('title'),
      el.getAttribute('alt'),
      el.getAttribute('name'),
      (el as HTMLInputElement).innerText,
      (el as HTMLInputElement).value,
      (el.textContent ?? ''),
    ];
    for (const candidate of candidates) {
      const text = norm(candidate, NAME_LIMIT);
      if (text) return text;
    }
    return el.tagName.toLowerCase();
  };

  const editableOf = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return !['checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'image'].includes(type);
    }
    return tag === 'textarea' || (el as HTMLElement).isContentEditable === true || el.getAttribute('role') === 'textbox';
  };

  const byRef = (ref: string): Element | null => {
    if (!ref || ref === 'document') return document.body;
    const all = document.querySelectorAll('[' + REF_ATTR + '="' + ref.replace(/"/g, '') + '"]');
    return all.length ? (all[0] as Element) : null;
  };

  const bySelector = (selector: string): Element | null => {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  };

  const scrollIntoView = (el: Element): void => {
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
    } catch {
      el.scrollIntoView();
    }
  };

  /* ------------------------------------------------------------- AI cursor overlay */

  const ensureCursor = (): HTMLElement | null => {
    const existing = document.getElementById('beecode-ai-cursor');
    if (existing) return existing;
    if (!document.documentElement) return null;

    const host = document.createElement('div');
    host.id = 'beecode-ai-cursor';
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;' +
      'contain:layout style;will-change:transform;';

    const root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : (host as unknown as ShadowRoot);
    root.innerHTML =
      '<style>' +
      '.pointer{position:fixed;left:0;top:0;transform:translate3d(-120px,-120px,0);' +
      'transition:transform 240ms cubic-bezier(.22,.61,.36,1);will-change:transform}' +
      '.pointer svg{display:block;filter:drop-shadow(0 2px 6px rgba(0,0,0,.45))}' +
      '.ripple{position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;' +
      'border:2px solid #4c8dff;opacity:0;transform:scale(.4)}' +
      '.ripple.pulse{animation:beecode-pulse 620ms ease-out 1}' +
      '.label{position:absolute;left:16px;top:14px;max-width:260px;white-space:nowrap;overflow:hidden;' +
      'text-overflow:ellipsis;font:12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#fff;' +
      'background:rgba(24,28,38,.92);border:1px solid rgba(120,160,255,.55);border-radius:6px;' +
      'padding:3px 7px;opacity:0;transition:opacity 160ms ease;box-shadow:0 4px 14px rgba(0,0,0,.35)}' +
      '.label.on{opacity:1}' +
      '@keyframes beecode-pulse{0%{opacity:.85;transform:scale(.4)}100%{opacity:0;transform:scale(2.1)}}' +
      '</style>' +
      '<div class="pointer">' +
      '<div class="ripple"></div>' +
      '<svg width="20" height="26" viewBox="0 0 20 26" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M2 1.5 L2 20 L6.6 15.6 L9.6 23.4 L12.6 22.2 L9.7 14.7 L16 14.2 Z" ' +
      'fill="#ffffff" stroke="#1b1f2a" stroke-width="1.6" stroke-linejoin="round"/></svg>' +
      '<div class="label"></div>' +
      '</div>';

    document.documentElement.appendChild(host);
    return host;
  };

  const cursorApi = {
    move(spot: { x?: number; y?: number; label?: string; kind?: string }) {
      const host = ensureCursor();
      if (!host) return false;
      const root = (host.shadowRoot ?? (host as unknown as ShadowRoot)) as ShadowRoot | HTMLElement;
      const pointer = (root as ShadowRoot).querySelector('.pointer') as HTMLElement | null;
      const label = (root as ShadowRoot).querySelector('.label') as HTMLElement | null;
      const ripple = (root as ShadowRoot).querySelector('.ripple') as HTMLElement | null;
      if (!pointer) return false;
      const x = Math.round(Number(spot.x) || 0);
      const y = Math.round(Number(spot.y) || 0);
      pointer.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
      if (label) {
        const text = String(spot.label ?? '').slice(0, 80);
        label.textContent = text;
        label.classList.toggle('on', text.length > 0);
      }
      if (ripple && (spot.kind === 'click' || spot.kind === 'type')) {
        ripple.classList.remove('pulse');
        // Force a reflow so the animation restarts on a repeated click.
        void ripple.offsetWidth;
        ripple.classList.add('pulse');
      }
      return true;
    },
    hide() {
      const host = document.getElementById('beecode-ai-cursor');
      if (host) host.remove();
      return true;
    },
    /** Redraw the highlight ring around an element the agent is about to touch. */
    marker(rect: { x: number; y: number; width: number; height: number } | null) {
      const host = ensureCursor();
      if (!host) return false;
      const root = (host.shadowRoot ?? (host as unknown as ShadowRoot)) as ShadowRoot;
      let box = root.querySelector('.target') as HTMLElement | null;
      if (!rect) {
        if (box) box.remove();
        return true;
      }
      if (!box) {
        box = document.createElement('div');
        box.className = 'target';
        box.style.cssText =
          'position:fixed;border:2px solid rgba(76,141,255,.9);border-radius:4px;' +
          'background:rgba(76,141,255,.10);transition:all 180ms ease;pointer-events:none';
        root.appendChild(box);
      }
      box.style.left = rect.x + 'px';
      box.style.top = rect.y + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';
      return true;
    },
  };

  /* ------------------------------------------------------------------- reading */

  const snapshot = () => {
    const nodes = Array.from(document.querySelectorAll(CANDIDATE_SELECTOR));
    const elements: unknown[] = [];
    let truncated = false;
    let counter = 0;
    for (const el of nodes) {
      if (elements.length >= MAX_ELEMENTS) {
        truncated = true;
        break;
      }
      if (!isVisible(el)) continue;
      counter += 1;
      const ref = 'e' + counter;
      el.setAttribute(REF_ATTR, ref);
      elements.push({
        ref,
        role: roleOf(el),
        name: nameOf(el),
        tag: el.tagName.toLowerCase(),
        value: editableOf(el) ? norm((el as HTMLInputElement).value, NAME_LIMIT) : undefined,
        rect: rectOf(el),
        disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
        editable: editableOf(el),
      });
    }

    const body = document.body;
    const text = norm(body ? body.innerText || body.textContent || '' : '', MAX_TEXT * 2);
    return {
      url: location.href,
      title: document.title || '',
      text: text.slice(0, MAX_TEXT),
      truncated: truncated || text.length > MAX_TEXT,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
      },
      elements,
    };
  };

  const resolve = (target: { ref?: string; selector?: string; x?: number; y?: number }) => {
    if (typeof target.x === 'number' && typeof target.y === 'number') {
      return { ok: true, point: { x: Math.round(target.x), y: Math.round(target.y) }, role: 'point', name: 'coordinates' };
    }
    const el = target.ref ? byRef(target.ref) : target.selector ? bySelector(target.selector) : null;
    if (!el) return { ok: false, error: 'element not found (the page changed since the last snapshot)' };
    scrollIntoView(el);
    const rect = rectOf(el);
    if (rect.width < 1 || rect.height < 1) return { ok: false, error: 'element is not visible' };
    return {
      ok: true,
      point: { x: rect.x + Math.round(rect.width / 2), y: rect.y + Math.round(rect.height / 2) },
      rect,
      role: roleOf(el),
      name: nameOf(el),
      editable: editableOf(el),
      disabled: (el as HTMLButtonElement).disabled === true,
    };
  };

  /* ------------------------------------------------------- DOM fallbacks for input */
  // Used only when the Chrome DevTools protocol is unavailable; CDP input is preferred in
  // the main process because the events are trusted and behave like a real pointer.

  const elementOf = (target: { ref?: string; selector?: string }): Element | null => {
    if (target && target.ref) return byRef(target.ref);
    if (target && target.selector) return bySelector(target.selector);
    return (document.activeElement as Element) || null;
  };

  const domType = (target: { ref?: string; selector?: string }, text: string) => {
    const el = elementOf(target) as HTMLElement | null;
    if (!el) return { ok: false, error: 'element not found' };
    el.focus?.();
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : null;
    if (proto) {
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, text);
      else (el as HTMLInputElement).value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      return { ok: false, error: 'element does not accept text' };
    }
    return { ok: true };
  };

  const domClick = (target: { ref?: string; selector?: string }) => {
    const el = elementOf(target) as HTMLElement | null;
    if (!el) return { ok: false, error: 'element not found' };
    el.focus?.();
    el.click();
    return { ok: true };
  };

  const domKey = (key: string) => {
    const codes: Record<string, number> = {
      Enter: 13,
      Tab: 9,
      Escape: 27,
      Backspace: 8,
      Delete: 46,
      ArrowUp: 38,
      ArrowDown: 40,
      ArrowLeft: 37,
      ArrowRight: 39,
      PageUp: 33,
      PageDown: 34,
      Home: 36,
      End: 35,
    };
    const code = codes[key];
    if (code === undefined) return { ok: false, error: 'unsupported key "' + key + '"' };
    const target = (document.activeElement as HTMLElement) || document.body;
    if (!target) return { ok: false, error: 'no focused element' };
    for (const type of ['keydown', 'keyup'] as const) {
      const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
      Object.defineProperty(event, 'keyCode', { get: () => code });
      Object.defineProperty(event, 'which', { get: () => code });
      target.dispatchEvent(event);
    }
    if (key === 'Enter' && target instanceof HTMLInputElement && target.form) {
      target.form.requestSubmit?.();
    }
    return { ok: true };
  };

  const domScroll = (deltaY: number) => {
    window.scrollBy(0, deltaY);
    return { ok: true, scrollY: Math.round(window.scrollY) };
  };

  w.__beeCodeBrowser = {
    snapshot,
    resolve,
    cursor: cursorApi,
    domType,
    domClick,
    domKey,
    domScroll,
    version: 1,
  };
}

/**
 * Source injected before every action. Idempotent — the bridge installs once per document
 * and the call is a no-op afterwards, so the round trip costs a string compare.
 */
export function agentBootstrapSource(): string {
  return `(${installAgentBridge.toString()})();`;
}
