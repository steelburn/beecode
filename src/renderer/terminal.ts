import type { TerminalLine, TerminalState } from '../shared/terminal';
import { clear, h } from './dom';

/**
 * The terminal panel: scrollback, a command line, cancel and clear.
 *
 * Output streams in while a command runs, so the panel is mounted once and then patched.
 * Rebuilding the body on every arriving line would steal focus from the input and reset the
 * caret mid-typing, so only the lines that are actually new are appended — the scrollback is
 * rebuilt from scratch only when it was cleared or truncated at the front.
 *
 * This file renders and nothing else: the command runs in the main process (see
 * src/main/terminal.ts), which is also what decides where it may run.
 */
export interface TerminalActions {
  run: (command: string) => void;
  cancel: () => void;
  clear: () => void;
  /** Set when the terminal lives in a drawer that can be folded away from its header. */
  hide?: () => void;
}

interface Elements {
  root: HTMLElement;
  scroll: HTMLElement;
  where: HTMLElement;
  status: HTMLElement;
  input: HTMLInputElement;
  send: HTMLButtonElement;
  stop: HTMLButtonElement;
}

let panel: Elements | null = null;
/** What the mounted scrollback already shows, so the next update can append a tail. */
let drawnCount = 0;
let drawnFirstId = -1;
/** -1 means "no history recalled": the input shows the user's own draft. */
let historyCursor = -1;
/** Latest state, read by the input handlers without re-mounting them. */
let latest: TerminalState | null = null;

function lineNode(line: TerminalLine): HTMLElement {
  return h('div', {
    class: `term-line term-${line.stream}`,
    text: line.text.replace(/\r\n?/g, '\n').replace(/\n$/, ''),
  });
}

/** Where the command will run, shortened against the root when it is a folder inside it. */
function describe(state: TerminalState): string {
  if (!state.root) return 'No workspace folder is open.';
  if (state.cwd === state.root) return state.root;
  if (state.cwd.startsWith(`${state.root}/`) || state.cwd.startsWith(`${state.root}\\`)) {
    return `.\\${state.cwd.slice(state.root.length + 1)}`;
  }
  return state.cwd;
}

function mount(host: HTMLElement, actions: TerminalActions): Elements {
  clear(host);
  const scroll = h('div', { class: 'term-scroll', role: 'log', 'aria-live': 'polite' });
  const where = h('span', { class: 'term-where' });
  const status = h('span', { class: 'term-status' });
  const input = h('input', {
    class: 'term-input',
    type: 'text',
    spellcheck: false,
    autocomplete: 'off',
    placeholder: 'Type a command — it runs in the workspace folder',
  });
  const send = h('button', { class: 'btn primary small', type: 'button', text: 'Run' });
  const stop = h('button', { class: 'btn danger small hidden', type: 'button', text: 'Stop' });
  const wipe = h('button', { class: 'btn ghost small', type: 'button', text: 'Clear' });
  const fold = h('button', {
    class: 'btn ghost small',
    type: 'button',
    text: '✕',
    title: 'Hide the terminal',
  });
  fold.addEventListener('click', () => actions.hide?.());

  const submit = (): void => {
    const command = input.value.trim();
    if (!command) return;
    input.value = '';
    historyCursor = -1;
    actions.run(command);
    input.focus();
  };

  send.addEventListener('click', submit);
  stop.addEventListener('click', () => actions.cancel());
  wipe.addEventListener('click', () => actions.clear());

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const history = latest?.history ?? [];
    if (!history.length) return;
    event.preventDefault();
    if (event.key === 'ArrowUp') {
      historyCursor = historyCursor < 0 ? history.length - 1 : Math.max(0, historyCursor - 1);
    } else {
      historyCursor = historyCursor < 0 ? -1 : historyCursor + 1 >= history.length ? -1 : historyCursor + 1;
    }
    input.value = historyCursor < 0 ? '' : (history[historyCursor] ?? '');
    input.setSelectionRange(input.value.length, input.value.length);
  });

  const root = h(
    'div',
    { class: 'card term' },
    h(
      'div',
      { class: 'term-head' },
      h('h4', { text: 'Workspace terminal' }),
      stop,
      wipe,
      ...(actions.hide ? [fold] : []),
    ),
    h('p', { class: 'sub term-meta' }, where, status),
    scroll,
    h('div', { class: 'term-form' }, input, send),
    h('p', {
      class: 'sub term-note',
      text:
        'One command at a time, started inside the workspace folder. `cd` cannot climb above it — ' +
        'but a command can still reach whatever the user account can, exactly like a normal shell.',
    }),
  );
  host.append(root);

  panel = { root, scroll, where, status, input, send, stop };
  drawnCount = 0;
  drawnFirstId = -1;
  return panel;
}

function update(state: TerminalState): void {
  const el = panel;
  if (!el) return;
  latest = state;

  el.where.textContent = describe(state);
  el.where.title = state.cwd;
  el.status.textContent = state.busy
    ? 'running…'
    : state.exitCode === undefined
      ? 'idle'
      : `last exit ${state.exitCode}`;
  el.status.className = `term-status${state.busy ? ' busy' : ''}`;
  el.input.disabled = state.busy;
  el.send.disabled = state.busy || !state.root;
  el.stop.classList.toggle('hidden', !state.busy);

  // A cleared scrollback (or one truncated at the front by the line cap) no longer shares a
  // prefix with what is drawn, so it has to be rebuilt; otherwise only the tail is new.
  const firstId = state.lines[0]?.id ?? -1;
  const rebuild = state.lines.length < drawnCount || firstId !== drawnFirstId;
  if (rebuild) {
    clear(el.scroll);
    drawnCount = 0;
    drawnFirstId = firstId;
  }
  const pinned = el.scroll.scrollHeight - el.scroll.scrollTop - el.scroll.clientHeight < 40;
  for (let i = drawnCount; i < state.lines.length; i += 1) {
    el.scroll.append(lineNode(state.lines[i]!));
  }
  drawnCount = state.lines.length;
  if (rebuild || pinned) el.scroll.scrollTop = el.scroll.scrollHeight;
}

/**
 * Draw the terminal into `host`, mounting it first if the panel body was rebuilt since the
 * last render. Safe to call for every arriving line of output.
 */
export function renderTerminal(host: HTMLElement, state: TerminalState, actions: TerminalActions): void {
  if (!panel || !host.contains(panel.root)) mount(host, actions);
  update(state);
}
