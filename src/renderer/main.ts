import type { AppInfo, BeeCodeBridge, ServiceStatusPayload } from '../shared/bridge';
import type {
  AgentInfo,
  ApprovalRequest,
  AuditEntry,
  BeeCodeConfig,
  CliAgentEntry,
  PolicyDocument,
  SessionGoal,
  SessionSnapshot,
  SessionStatus,
  SessionSummary,
  PluginInfo,
  SkillInfo,
  McpServerStatus,
  SubagentRunInfo,
  TodoItem,
  ToolInfo,
  TranscriptAction,
  TranscriptEntry,
  WorkspaceState,
} from '../shared/protocol';
import { clear, formatJsonForDisplay, h, renderMarkdown } from './dom';
import { mountBrowserDock } from './browserDock';
import { renderExplorer, type ExplorerState } from './explorer';
import { renderActivity, renderIntegrations, renderPermissions, renderSettings, renderSubagents } from './panels';
import { renderPlan, renderWorkspaceGate, type WorkspaceActions } from './plan';

declare global {
  interface Window {
    beeCode: BeeCodeBridge;
    /** Smoke-check hook (see scripts/smoke.mjs): counts what a sample message rendered. */
    __renderMessageSample?: () => Record<string, number>;
    /** Screenshot-capture hook (see src/main/docsCapture.ts): renders a demo transcript. */
    __renderDocsSample?: () => void;
  }
}

/**
 * One message that exercises every renderer feature the smoke run checks: headings, nested
 * lists, a table, inline code, a safe link and a chart fence.
 */
const RENDER_SAMPLE = [
  '## Renderer sample',
  '',
  'A **bold** and *italic* line with `code` and a [link](https://example.com).',
  '',
  '- first',
  '  - nested',
  '- second',
  '',
  '| tool | calls |',
  '| --- | ---: |',
  '| shell_run | 2 |',
  '',
  '```chart',
  '{"type":"bar","title":"Tool calls","labels":["shell","files"],"values":[2,5]}',
  '```',
].join('\n');

const api = window.beeCode;

window.__renderMessageSample = () => {
  const body = h('div', { class: 'body', html: renderMarkdown(RENDER_SAMPLE) });
  const holder = h('div', { class: 'msg assistant' }, body);
  document.body.append(holder);
  const counts = {
    headings: holder.querySelectorAll('.md-heading').length,
    listItems: holder.querySelectorAll('.md-list li').length,
    tableRows: holder.querySelectorAll('.md-table tbody tr').length,
    codeBlocks: holder.querySelectorAll('pre.md-pre').length,
    links: holder.querySelectorAll('a[rel="noreferrer noopener"]').length,
    charts: holder.querySelectorAll('.chart-block svg').length,
  };
  holder.remove();
  return counts;
};

// Surface renderer crashes in the main-process log (and in the smoke report).
const rendererErrors: string[] = [];
(window as unknown as { __rendererErrors: string[] }).__rendererErrors = rendererErrors;

/**
 * Demo conversation for the README screenshots. It goes through the normal `buildEntry`
 * path, so the images show the real bubble, tool-call and markdown rendering.
 */
window.__renderDocsSample = () => {
  const at = new Date().toISOString();
  const entries: TranscriptEntry[] = [
    {
      id: 'docs-user',
      role: 'user',
      at,
      text:
        'Open the Northwind support board and raise a ticket for the invoice PDF that renders a ' +
        'blank second page. Priority high, and mention it is blocking the Contoso close.',
    },
    {
      id: 'docs-assistant',
      role: 'assistant',
      at,
      text: [
        'Working in the **internal browser** — your desktop stays untouched.',
        '',
        '1. Open *Northwind Support → Tickets*',
        '2. Read the open tickets to find the invoice one',
        '3. Press **Create ticket** and fill in the report',
        '',
        '| step | tool | effect |',
        '| --- | --- | --- |',
        '| 1 | `browser_open` | new sandboxed tab |',
        '| 2 | `browser_snapshot` | visible text + elements |',
        '| 3 | `browser_click` | press *Create ticket* |',
        '',
        'The cursor in the panel moves to each target before it is used, so you can watch the ' +
        'run instead of guessing what it touched.',
      ].join('\n'),
    },
    {
      id: 'docs-tool-open',
      role: 'tool',
      at,
      toolName: 'browser_open',
      toolCallId: 'docs-call-1',
      text: '{\n  "url": "http://127.0.0.1:49152/"\n}',
      toolResult: '{\n  "ok": true,\n  "tabId": "tab-1",\n  "title": "Northwind Support — Tickets"\n}',
    },
  ];
  for (const entry of entries) {
    try {
      els.transcript.append(buildEntry(entry));
    } catch {
      // A capture-only convenience: never let a demo entry break the real UI.
    }
  }
  els.transcript.scrollTop = 0;
};
window.addEventListener('error', (event) => rendererErrors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => rendererErrors.push(String((event as PromiseRejectionEvent).reason)));

type PanelTab = 'permissions' | 'subagents' | 'integrations' | 'activity' | 'settings' | 'explorer';

interface State {
  info?: AppInfo;
  status: ServiceStatusPayload['supervisor'];
  health?: ServiceStatusPayload['health'];
  sessions: SessionSummary[];
  current?: SessionSnapshot;
  /** Goal + plan of the current session, mirrored from `session.goal` / `session.todos`. */
  goal?: SessionGoal;
  todos: TodoItem[];
  /** Last directory the user picked; new sessions start there. */
  lastCwd?: string;
  entries: TranscriptEntry[];
  approval?: ApprovalRequest;
  /** Pending `ask_user` question, shown above the composer until answered. */
  question?: PendingQuestion;
  policy?: PolicyDocument;
  config?: BeeCodeConfig;
  /** Workspace folder state — `configured: false` shows the setup gate. */
  workspace?: WorkspaceState;
  audit: AuditEntry[];
  subagents: SubagentRunInfo[];
  agents: AgentInfo[];
  /** Probed CLI catalogue (Settings → external agents); includes presets that are not configured. */
  detectedAgents: AgentInfo[];
  tools: ToolInfo[];
  mcpServers: McpServerStatus[];
  skills: SkillInfo[];
  plugins: PluginInfo[];
  /**
   * Status of every live session. A background session keeps running while another one is
   * on screen, so the list is painted from this map rather than from the current session.
   */
  statuses: Record<string, SessionStatus>;
  /** Sessions that produced output while the user was looking elsewhere. */
  unread: Set<string>;
  /** Workspace explorer state; the listing itself comes from the service. */
  explorer: ExplorerState;
  panel: PanelTab;
  ready: boolean;
}

interface PendingQuestion {
  question: string;
  options: string[];
}

const state: State = {
  status: 'starting',
  sessions: [],
  entries: [],
  todos: [],
  audit: [],
  subagents: [],
  agents: [],
  detectedAgents: [],
  tools: [],
  mcpServers: [],
  skills: [],
  plugins: [],
  statuses: {},
  unread: new Set<string>(),
  explorer: {},
  panel: 'permissions',
  ready: false,
};

const els = {
  app: document.getElementById('app') as HTMLElement,
  sessionList: document.getElementById('session-list') as HTMLElement,
  transcript: document.getElementById('transcript') as HTMLElement,
  browserDock: document.getElementById('browser-dock') as HTMLElement,
  approvalSlot: document.getElementById('approval-slot') as HTMLElement,
  questionSlot: document.getElementById('question-slot') as HTMLElement,
  goalSlot: document.getElementById('goal-slot') as HTMLElement,
  workspaceGate: document.getElementById('workspace-gate') as HTMLElement,
  title: document.getElementById('session-title') as HTMLElement,
  cwd: document.getElementById('session-cwd') as HTMLElement,
  modeSelect: document.getElementById('mode-select') as HTMLSelectElement,
  modelSelect: document.getElementById('model-select') as HTMLSelectElement,
  input: document.getElementById('input') as HTMLTextAreaElement,
  composer: document.getElementById('composer') as HTMLFormElement,
  send: document.getElementById('send') as HTMLButtonElement,
  stop: document.getElementById('stop') as HTMLButtonElement,
  hint: document.getElementById('composer-hint') as HTMLElement,
  serviceDot: document.getElementById('service-dot') as HTMLElement,
  serviceText: document.getElementById('service-text') as HTMLElement,
  restart: document.getElementById('restart-service') as HTMLButtonElement,
  newSession: document.getElementById('new-session') as HTMLButtonElement,
  panel: document.getElementById('panel') as HTMLElement,
  panelBody: document.getElementById('panel-body') as HTMLElement,
  togglePanel: document.getElementById('toggle-panel') as HTMLButtonElement,
};

/* ------------------------------------------------------------------ boot */

void boot();

async function boot(): Promise<void> {
  bindUi();
  const browserDock = mountBrowserDock(els.browserDock, api.browser);
  api.browser.onState((next) => browserDock.render(next));
  api.onEvent(handleEvent);
  api.onServiceStatus((payload) => {
    state.status = payload.supervisor;
    renderStatus();
    if (payload.supervisor === 'ready' && !state.ready) void loadAll();
  });
  await api.appInfo().then((info) => {
    state.info = info;
  });
  await pollService();
}

async function pollService(attempt = 0): Promise<void> {
  const status = await api.serviceStatus();
  state.status = status.supervisor;
  state.health = status.health;
  renderStatus();
  if (status.supervisor === 'ready') {
    await loadAll();
    return;
  }
  if (attempt < 40) {
    setTimeout(() => void pollService(attempt + 1), 1000);
  } else if (status.error) {
    setHint(`service error: ${status.error}`);
  }
}

let loadingAll = false;

async function loadAll(): Promise<void> {
  if (loadingAll) return;
  loadingAll = true;
  try {
    const [sessions, config, policy, audit, subagents, agents, tools, mcp, skills, plugins, workspace] =
      await Promise.all([
      api.invoke('session.list', {}),
      api.getConfig(),
      api.getPolicy(),
      api.invoke('audit.list', { limit: 80 }),
      api.invoke('subagent.list', {}),
      api.invoke('agents.list', {}),
      api.invoke('tools.list', {}),
      api.invoke('mcp.list', {}),
      api.invoke('skill.list', {}),
      api.invoke('plugin.list', {}),
      api.invoke('workspace.state', {}),
    ]);
    state.config = config;
    state.policy = policy;
    state.audit = audit;
    state.subagents = subagents;
    state.agents = agents;
    state.detectedAgents = agents;
    state.tools = tools;
    state.mcpServers = mcp.servers;
    state.skills = skills.skills;
    state.plugins = plugins.plugins;
    state.workspace = workspace;
    state.sessions = sessions;
    state.ready = true;

    populateModels();
    renderSessions();
    paintWorkspaceGate();
    renderPanelBody();
    if (!workspace.configured) {
      // No workspace folder: the gate is the whole column and no session is started.
      renderGoalPanel();
      return;
    }
    if (sessions.length && !state.current) {
      await openSession(sessions[0]!.id);
    } else if (!sessions.length) {
      await newSession();
    }
  } catch (err) {
    setHint(`failed to load: ${(err as Error).message}`);
  } finally {
    loadingAll = false;
  }
}

/* ------------------------------------------------------------------ ui bindings */

function bindUi(): void {
  document.getElementById('workspace-btn')?.addEventListener('click', () => toggleWorkspaceMenu());
  els.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendPrompt();
  });

  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendPrompt();
    }
  });

  els.input.addEventListener('input', () => {
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(220, els.input.scrollHeight)}px`;
  });

  els.stop.addEventListener('click', () => {
    if (!state.current) return;
    void api.invoke('session.abort', { sessionId: state.current.id });
  });

  els.newSession.addEventListener('click', () => void newSession());

  els.cwd.addEventListener('click', () => void changeWorkingDirectory());

  els.restart.addEventListener('click', async () => {
    setHint('restarting agent service…');
    state.ready = false;
    await api.restartService();
    await pollService();
  });

  els.modeSelect.addEventListener('change', async () => {
    if (!state.current) return;
    const mode = els.modeSelect.value as SessionSnapshot['mode'];
    await api.invoke('session.setMode', { sessionId: state.current.id, mode });
    state.current.mode = mode;
  });

  els.modelSelect.addEventListener('change', async () => {
    if (!state.current) return;
    await api.invoke('session.setModel', { sessionId: state.current.id, model: els.modelSelect.value });
    state.current.model = els.modelSelect.value;
  });

  els.togglePanel.addEventListener('click', () => els.app.classList.toggle('panel-hidden'));

  for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
    tab.addEventListener('click', () => {
      state.panel = (tab.dataset.panel as PanelTab) ?? 'permissions';
      for (const other of document.querySelectorAll('.tab')) other.classList.toggle('active', other === tab);
      renderPanelBody();
    });
  }

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      void newSession();
    }
  });
}

/* ---------------------------------------------------------------- actions */

async function newSession(): Promise<void> {
  // Nothing to start until there is a folder to work in: the gate is the only action.
  if (!state.workspace?.configured) {
    paintWorkspaceGate();
    return;
  }
  // A new session starts in the workspace; a per-session directory change stays opt-in.
  const cwd = state.workspace.root;
  const snapshot = await api.invoke('session.create', { cwd });
  state.sessions = await api.invoke('session.list', {});
  await openSession(snapshot.id);
  els.input.focus();
}

/**
 * Per-session working directory: pick a folder, move the session there and let the service
 * re-scope its file tools. Without a session the pick only seeds the next one.
 */
async function changeWorkingDirectory(): Promise<void> {
  const picked = await api.pickDirectory({
    title: 'Working directory for this session',
    defaultPath: state.current?.cwd ?? state.lastCwd ?? state.info?.workspace,
  });
  if (!picked) return;
  if (!state.current) {
    state.lastCwd = picked;
    setHint(`New sessions will start in ${picked}`);
    return;
  }
  try {
    const summary = await api.invoke('session.setCwd', { sessionId: state.current.id, cwd: picked });
    state.current.cwd = summary.cwd;
    state.lastCwd = summary.cwd;
    state.sessions = await api.invoke('session.list', {});
    renderSessions();
    renderHeader();
    setHint(`Working directory: ${summary.cwd}`);
  } catch (err) {
    setHint(`Could not change the working directory: ${(err as Error).message}`);
  }
}

async function openSession(sessionId: string): Promise<void> {
  const snapshot = await api.invoke('session.get', { sessionId });
  // Opening a session is what clears its "new output" flag; its transcript is re-read whole.
  state.unread.delete(sessionId);
  state.statuses[sessionId] = snapshot.status;
  state.current = snapshot;
  state.lastCwd = snapshot.cwd;
  state.entries = snapshot.entries;
  state.approval = snapshot.pendingApproval;
  state.question = undefined;
  // A restored session comes back with its plan; `restored` only tells the UI it came
  // from disk, the goal and items are the same ones the agent wrote.
  state.goal = snapshot.goal;
  state.todos = snapshot.todos ?? [];
  void api
    .invoke('todo.list', { sessionId })
    .then(({ todos }) => {
      if (state.current?.id !== sessionId) return;
      state.todos = todos;
      renderGoalPanel();
    })
    .catch(() => undefined);
  els.modeSelect.value = snapshot.mode;
  els.modelSelect.value = snapshot.model;
  state.sessions = await api.invoke('session.list', {});
  renderSessions();
  renderHeader();
  renderTranscript(true);
  renderApproval();
  renderQuestion();
  renderGoalPanel();
  renderBusy();
}

async function sendPrompt(): Promise<void> {
  const text = els.input.value.trim();
  if (!text) return;
  if (!state.workspace?.configured) {
    setHint('Choose a workspace folder first — beeCode will not work in an unset directory.');
    paintWorkspaceGate();
    return;
  }
  clearQuestion();
  if (!state.current) await newSession();
  const session = state.current;
  if (!session) return;

  els.input.value = '';
  els.input.style.height = 'auto';
  els.input.disabled = true;
  setHint('');
  try {
    await api.invoke('session.prompt', { sessionId: session.id, text });
  } catch (err) {
    setHint(`could not send: ${(err as Error).message}`);
  } finally {
    els.input.disabled = !state.workspace?.configured;
    els.input.focus();
  }
}

async function respondApproval(approvalId: string, decision: 'allow' | 'allow-session' | 'deny'): Promise<void> {
  await api.invoke('approval.respond', { approvalId, decision });
}

async function savePolicy(next: PolicyDocument): Promise<void> {
  state.policy = await api.savePolicy(next);
  renderPanelBody();
}

/* ----------------------------------------------------------------- events */

/**
 * Output arrived for a session the user is not looking at. Nothing is lost — the agent keeps
 * running and the service owns the transcript — but the list is flagged so switching back is
 * discoverable. Repainted only when the flag actually flips: deltas arrive in bursts.
 */
function markBackground(sessionId: string): void {
  if (state.unread.has(sessionId)) return;
  state.unread.add(sessionId);
  renderSessions();
}

/** Record a session status and repaint the list only when it changed. */
function noteStatus(sessionId: string, status: SessionStatus): void {
  const previous = state.statuses[sessionId];
  state.statuses[sessionId] = status;
  if (previous !== status) renderSessions();
}

function handleEvent(event: import('../shared/protocol').ServiceEvent): void {
  switch (event.type) {
    case 'service.health':
      state.health = event.payload;
      state.status = event.payload.ok ? 'ready' : 'failed';
      renderStatus();
      break;

    case 'session.snapshot':
      void api.invoke('session.list', {}).then((sessions) => {
        state.sessions = sessions;
        for (const session of sessions) {
          if (!state.statuses[session.id]) state.statuses[session.id] = session.status;
        }
        renderSessions();
      });
      break;

    case 'session.entry':
      if (event.payload.sessionId !== state.current?.id) {
        markBackground(event.payload.sessionId);
        return;
      }
      upsertEntry(event.payload.entry);
      break;

    case 'assistant.delta': {
      if (event.payload.sessionId !== state.current?.id) {
        markBackground(event.payload.sessionId);
        return;
      }
      appendDelta(event.payload.entryId, event.payload.text);
      break;
    }

    case 'tool.result': {
      if (event.payload.sessionId !== state.current?.id) {
        markBackground(event.payload.sessionId);
        return;
      }
      upsertEntry({
        id: `tool_${event.payload.callId}`,
        role: 'tool',
        text: event.payload.result,
        at: new Date().toISOString(),
        toolCallId: event.payload.callId,
        toolName: event.payload.name,
        toolResult: event.payload.result,
        failed: event.payload.failed,
      });
      const meta = event.payload.meta;
      if (meta?.awaitingUser === true) {
        const raw = meta.options;
        setQuestion({
          question:
            typeof meta.question === 'string' && meta.question.trim()
              ? meta.question
              : event.payload.result,
          options: Array.isArray(raw) ? raw.filter((o): o is string => typeof o === 'string') : [],
        });
      }

      break;
    }

    case 'session.status':
      // A background session changes status too — record it before deciding what to paint.
      noteStatus(event.payload.sessionId, event.payload.status);
      if (event.payload.sessionId !== state.current?.id) return;
      if (state.current) state.current.status = event.payload.status;
      renderBusy();
      break;

    case 'approval.request':
      if (event.payload.sessionId !== state.current?.id) return;
      state.approval = event.payload;
      renderApproval();
      renderBusy();
      break;

    case 'approval.resolved':
      state.approval = undefined;
      renderApproval();
      renderBusy();
      break;

    case 'subagent.update': {
      const index = state.subagents.findIndex((r) => r.id === event.payload.id);
      if (index >= 0) state.subagents[index] = event.payload;
      else state.subagents.push(event.payload);
      if (state.panel === 'subagents') renderPanelBody();
      break;
    }

    case 'session.goal':
      if (event.payload.sessionId !== state.current?.id) return;
      state.goal = event.payload.goal;
      if (state.current) state.current.goal = event.payload.goal;
      renderGoalPanel();
      break;

    case 'session.todos':
      if (event.payload.sessionId !== state.current?.id) return;
      state.todos = event.payload.todos;
      if (state.current) state.current.todos = event.payload.todos;
      renderGoalPanel();
      break;

    case 'desktop.activity':
      state.audit.unshift(event.payload);
      state.audit = state.audit.slice(0, 120);
      if (state.panel === 'activity') renderPanelBody();
      break;

    case 'log':
      if (event.payload.level === 'error') console.warn('[service]', event.payload.message);
      break;

    case 'error':
      if (event.payload.sessionId && event.payload.sessionId !== state.current?.id) return;
      addSystemEntry(`Error: ${event.payload.message}`);
      break;
  }
}

/* ------------------------------------------------------------- rendering */

function renderStatus(): void {
  const label =
    state.status === 'ready'
      ? `service ready · ${state.health?.tools ?? 0} tools · pid ${state.health?.pid ?? '?'}`
      : state.status;
  els.serviceText.textContent = label;
  els.serviceDot.className = `dot ${state.status}`;
  els.restart.disabled = state.status === 'starting';
}

function renderHeader(): void {
  const session = state.current;
  els.title.textContent = session?.title ?? 'New session';
  els.cwd.textContent = session?.cwd || state.workspace?.root || 'no workspace folder';
  els.cwd.title = session
    ? `Working directory: ${session.cwd} — click to change it for this session`
    : 'No session yet — click to choose the working directory for the next session';
  if (session?.mode) els.modeSelect.value = session.mode;
  if (session?.model) els.modelSelect.value = session.model;
}

function populateModels(): void {
  const models = state.config?.models ?? [];
  clear(els.modelSelect);
  for (const model of models) {
    els.modelSelect.append(h('option', { value: model.id, text: model.label }));
  }
  if (state.current) els.modelSelect.value = state.current.model;
}

function renderSessions(): void {
  clear(els.sessionList);
  if (!state.sessions.length) {
    els.sessionList.append(h('div', { class: 'empty', text: 'No sessions yet' }));
    return;
  }
  for (const session of state.sessions) {
    // The live status wins over the one the list was loaded with: several sessions can run.
    const live = state.statuses[session.id] ?? session.status;
    const unread = state.unread.has(session.id) && session.id !== state.current?.id;
    const item = h(
      'div',
      {
        class: `session-item${session.id === state.current?.id ? ' active' : ''}${live === 'idle' ? '' : ' busy'}`,
        on: { click: () => void openSession(session.id) },
        title: session.cwd,
      },
      h('div', { class: 's-title', text: session.parentSessionId ? `↳ ${session.title}` : session.title }),
      // A background session keeps working while another one is on screen; this badge is
      // the only signal in the list that it is still running (and that there is new output).
      live === 'idle' && !unread
        ? null
        : h(
            'div',
            { class: 's-badges' },
            live === 'idle' ? null : h('span', { class: 's-badge run', text: live }),
            unread ? h('span', { class: 's-badge unread', text: 'new output' }) : null,
          ),
      // The goal is the most useful subtitle a persisted session can carry.
      h('div', {
        class: 's-meta',
        text: session.goal?.text || (session.status === 'idle' ? '' : session.status),
        title: session.goal?.text ?? '',
      }),
      h('button', {
        class: 's-del',
        text: '✕',
        title: 'Delete session',
        on: {
          click: (event: Event) => {
            event.stopPropagation();
            void deleteSession(session.id);
          },
        },
      }),
    );
    els.sessionList.append(item);
  }
}

async function deleteSession(sessionId: string): Promise<void> {
  await api.invoke('session.delete', { sessionId });
  state.sessions = await api.invoke('session.list', {});
  if (state.current?.id === sessionId) {
    state.current = undefined;
    state.entries = [];
    if (state.sessions.length) await openSession(state.sessions[0]!.id);
    else await newSession();
  }
  renderSessions();
}

function renderBusy(): void {
  const status = state.current?.status;
  const busy = status === 'thinking' || status === 'running-tool' || status === 'awaiting-approval';
  const unconfigured = !state.workspace?.configured;
  els.stop.classList.toggle('hidden', !busy);
  els.send.disabled = busy || Boolean(state.approval) || unconfigured;
  els.input.disabled = unconfigured;
  els.input.placeholder = busy
    ? status === 'awaiting-approval'
      ? 'Waiting for your approval…'
      : 'Working… (Esc to keep typing)'
    : 'Describe what to do on the desktop…  (Enter to send, Shift+Enter for a new line)';
}

function renderTranscript(scroll = true): void {
  clear(els.transcript);
  if (!state.entries.length) {
    els.transcript.append(renderWelcome());
    return;
  }
  for (const entry of state.entries) appendEntryElement(entry);
  if (scroll) scrollToBottom();
}

function renderWelcome(): HTMLElement {
  const examples: Array<[string, string]> = [
    ['Open and type', 'Open Notepad and write a haiku about background services'],
    ['Read the screen', 'What is currently on my desktop? List the windows you are allowed to see'],
    ['Drive an app', 'In Calculator, compute 847 * 39 and tell me the result shown on screen'],
    ['Delegate', 'Ask a subagent to research our Node version constraints, then summarise it'],
  ];
  return h(
    'div',
    { class: 'welcome' },
    h('h2', { text: 'beeCode is ready.' }),
    h('p', {
      text: 'It can see and drive the applications your permission policy allows, and hand work to subagents. Ask for something below, or describe your own task.',
    }),
    h(
      'div',
      { class: 'examples' },
      ...examples.map(([title, prompt]) =>
        h(
          'button',
          {
            class: 'example',
            on: {
              click: () => {
                els.input.value = prompt;
                els.input.focus();
              },
            },
          },
          h('strong', { text: title }),
          document.createTextNode(prompt),
        ),
      ),
    ),
  );
}

const entryNodes = new Map<string, HTMLElement>();

function appendEntryElement(entry: TranscriptEntry): void {
  const node = buildEntry(entry);
  entryNodes.set(entry.id, node);
  els.transcript.append(node);
}

function upsertEntry(entry: TranscriptEntry): void {
  const existing = entryNodes.get(entry.id);
  if (existing) {
    const rebuilt = buildEntry(entry);
    existing.replaceWith(rebuilt);
    entryNodes.set(entry.id, rebuilt);
    return;
  }
  // A tool result for a call we rendered optimistically: replace by call id.
  if (entry.role === 'tool' && entry.toolCallId) {
    const optimistic = document.getElementById(`pending-${entry.toolCallId}`);
    if (optimistic) {
      const node = buildEntry(entry);
      optimistic.replaceWith(node);
      entryNodes.set(entry.id, node);
      return;
    }
  }
  appendEntryElement(entry);
  if (entry.role === 'assistant' || entry.role === 'tool' || entry.role === 'system') scrollToBottom();
}

function buildEntry(entry: TranscriptEntry): HTMLElement {
  if (entry.role === 'tool') return buildToolCard(entry);
  const role = entry.role;
  const wrapper = h('div', { class: `msg ${role}`, dataset: { entryId: entry.id } });
  if (role !== 'assistant') {
    wrapper.append(h('div', { class: 'role', text: role === 'system' ? 'beeCode' : 'you' }));
  }
  const body = h('div', { class: 'body' });
  if (role === 'assistant') body.innerHTML = renderMarkdown(entry.text || '');
  else body.textContent = entry.text;
  wrapper.append(body);

  if (entry.actions?.length) wrapper.append(buildEntryActions(entry.actions));

  if (entry.toolCalls?.length) {
    for (const call of entry.toolCalls) {
      wrapper.append(
        h(
          'details',
          { class: 'tool-card', id: `pending-${call.id}` },
          h(
            'summary',
            null,
            h('span', { class: 'tname', text: call.name }),
            h('span', { class: 'tbadge', text: 'running…' }),
          ),
          h('div', { class: 'tbody' }, h('pre', { text: formatJsonForDisplay(JSON.stringify(call.args), 1500) })),
        ),
      );
    }
  }
  return wrapper;
}

/**
 * Render the buttons an entry offers. Today that is one: raise `agent.maxSteps`, shown on
 * the "stopped after N steps" note so the fix is a click instead of a trip to Settings.
 */
function buildEntryActions(actions: TranscriptAction[]): HTMLElement {
  const row = h('div', { class: 'msg-actions' });
  for (const action of actions) {
    if (action.kind !== 'raise-max-steps') continue;
    // A transcript outlives the config: once the limit already covers this action, say so
    // instead of offering a button that would write the same number again.
    const current = state.config?.agent.maxSteps;
    if (current !== undefined && current >= action.next) {
      row.append(h('span', { class: 'note', text: `Step limit already raised to ${current}.` }));
      continue;
    }
    const button = h('button', {
      class: 'btn primary small',
      text: `Raise step limit to ${action.next}`,
      title: `Sets agent.maxSteps from ${action.current} to ${action.next}`,
    });
    button.addEventListener('click', () => void applyStepLimit(action, button, row));
    row.append(button);
  }
  return row;
}

/**
 * Save the higher step limit through the same `config.set` path the Settings panel uses,
 * so the next turn of every session picks it up and the panel shows the new value.
 */
async function applyStepLimit(
  action: TranscriptAction,
  button: HTMLButtonElement,
  row: HTMLElement,
): Promise<void> {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'raising…';
  try {
    const config = state.config ?? (await api.getConfig());
    state.config = await api.saveConfig({ ...config, agent: { ...config.agent, maxSteps: action.next } });
    button.remove();
    row.append(
      h('span', {
        class: 'note',
        text: `Step limit raised to ${state.config.agent.maxSteps} — send “continue” to resume.`,
      }),
    );
    if (state.panel === 'settings') renderPanelBody();
    setHint(`agent.maxSteps raised to ${state.config.agent.maxSteps}`);
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
    setHint(`Could not raise the step limit: ${(error as Error).message}`);
  }
}

function buildToolCard(entry: TranscriptEntry): HTMLElement {
  const failed = entry.failed === true;
  const result = entry.toolResult ?? entry.text;
  return h(
    'details',
    { class: `tool-card${failed ? ' failed' : ''}`, dataset: { entryId: entry.id } },
    h(
      'summary',
      null,
      h('span', { class: 'tname', text: entry.toolName ?? 'tool' }),
      h('span', { class: 'tbadge', text: failed ? 'error' : 'done' }),
    ),
    h(
      'div',
      { class: 'tbody' },
      h('div', { class: 'label', text: 'result' }),
      h('pre', { text: formatJsonForDisplay(result, 6000) }),
    ),
  );
}

function appendDelta(entryId: string, text: string): void {
  let node = entryNodes.get(entryId);
  if (!node) {
    node = h(
      'div',
      { class: 'msg assistant', dataset: { entryId } },
      h('div', { class: 'body', html: '<span class="thinking">thinking…</span>' }),
    );
    entryNodes.set(entryId, node);
    els.transcript.append(node);
    scrollToBottom();
  }
  const body = node.querySelector('.body') as HTMLElement | null;
  if (!body) return;
  const accumulated = (body.dataset.raw ?? '') + text;
  body.dataset.raw = accumulated;
  body.innerHTML = renderMarkdown(accumulated);
  scrollToBottom();
}

function addSystemEntry(text: string): void {
  const entry: TranscriptEntry = {
    id: `sys_${Date.now()}`,
    role: 'system',
    text,
    at: new Date().toISOString(),
  };
  appendEntryElement(entry);
  scrollToBottom();
}

function clearQuestion(): void {
  if (!state.question) return;
  state.question = undefined;
  renderQuestion();
}

function setQuestion(question: PendingQuestion): void {
  state.question = question;
  renderQuestion();
  els.input.focus();
  setHint('The agent is waiting for an answer — click an option or type a reply.');
}

async function answerQuestion(answer: string): Promise<void> {
  els.input.value = answer;
  await sendPrompt();
}

function renderQuestion(): void {
  clear(els.questionSlot);
  const pending = state.question;
  if (!pending) return;

  const card = h(
    'div',
    { class: 'question' },
    h('h3', null, h('span', { text: '?' }), h('span', { text: 'The agent needs an answer' })),
    h('p', { class: 'summary', text: pending.question }),
  );

  if (pending.options.length) {
    const actions = h('div', { class: 'question-actions' });
    for (const option of pending.options) {
      actions.append(
        h('button', {
          class: 'q-option',
          text: option,
          on: { click: () => void answerQuestion(option) },
        }),
      );
    }
    card.append(actions);
  }

  els.questionSlot.append(card);
}

function renderApproval(): void {
  clear(els.approvalSlot);
  const approval = state.approval;
  if (!approval) return;

  const card = h(
    'div',
    { class: 'approval' },
    h('h3', null, h('span', { text: '⚠' }), h('span', { text: 'Approval required' })),
    h('div', { class: 'summary', text: approval.summary }),
    h('div', { class: 'reason', text: approval.reason }),
    h('pre', { text: formatJsonForDisplay(JSON.stringify(approval.toolArgs), 1200) }),
    h(
      'div',
      { class: 'actions' },
      h('button', {
        class: 'btn primary small',
        text: 'Allow once',
        on: { click: () => void respondApproval(approval.id, 'allow') },
      }),
      h('button', {
        class: 'btn ok small',
        text: `Always allow “${approval.toolName}”`,
        on: { click: () => void respondApproval(approval.id, 'allow-session') },
      }),
      h('button', {
        class: 'btn danger small',
        text: 'Deny',
        on: { click: () => void respondApproval(approval.id, 'deny') },
      }),
    ),
  );
  els.approvalSlot.append(card);
}

function renderPanelBody(): void {
  const callbacks = {
    savePolicy,
    saveConfig: async (next: BeeCodeConfig) => {
      state.config = await api.saveConfig(next);
      populateModels();
      // The service reconnects servers whose definition changed while saving, so read
      // the resulting statuses back instead of reconnecting a second time here.
      const mcp = await api.invoke('mcp.list', {});
      state.mcpServers = mcp.servers;
      // The goal/to-do switch changes the panel immediately; the service rebuilt the
      // tool catalogue in the same save.
      renderGoalPanel();
      renderPanelBody();
    },
    pickDirectory: async () => api.pickDirectory(),
    cancelSubagent: async (runId: string) => {
      await api.invoke('subagent.cancel', { runId });
    },
    refreshAudit: async () => {
      state.audit = await api.invoke('audit.list', { limit: 80 });
      renderPanelBody();
    },
    reloadIntegrations: async () => {
      const [mcp, skills, plugins] = await Promise.all([
        api.invoke('mcp.reload', {}),
        api.invoke('skill.reload', {}),
        api.invoke('plugin.reload', {}),
      ]);
      state.mcpServers = mcp.servers;
      state.skills = skills.skills;
      state.plugins = plugins.plugins;
      renderPanelBody();
    },
    togglePlugin: async (id: string, enabled: boolean) => {
      const result = await api.invoke('plugin.setEnabled', { id, enabled });
      state.plugins = result.plugins;
      renderPanelBody();
    },
    detectAgents: async () => {
      const result = await api.invoke('agents.detect', {});
      state.detectedAgents = result.agents;
      state.agents = result.agents;
      renderPanelBody();
      return result.agents;
    },
    saveAgents: async (next: CliAgentEntry[]) => {
      const result = await api.invoke('agents.save', { agents: next });
      state.detectedAgents = result.agents;
      state.agents = result.agents;
      state.config = await api.getConfig();
      // No `renderPanelBody()` here: rebuilding Settings on every checkbox click threw
      // away the caret in the command box and the scroll position. The card keeps its
      // own enable state and re-renders only on an explicit detect.
      return result.agents;
    },
    setWorkspace: async (path: string) => {
      await applyWorkspace(path);
    },
    forgetWorkspace: async (path: string) => {
      state.workspace = await api.invoke('workspace.forget', { path });
      state.config = await api.getConfig();
      paintWorkspaceGate();
      renderPanelBody();
    },
  };

  const explorerCallbacks = {
    open: (path?: string) => void openExplorer(path),
    preview: (path: string) => void previewFile(path),
    close: () => {
      state.explorer = { ...state.explorer, file: undefined };
      renderPanelBody();
    },
  };

  if (state.panel === 'permissions') renderPermissions(els.panelBody, state.policy, state.config, callbacks);
  else if (state.panel === 'subagents') renderSubagents(els.panelBody, state.subagents, state.agents, callbacks);
  else if (state.panel === 'integrations')
    renderIntegrations(els.panelBody, state.mcpServers, state.skills, state.plugins, state.config, callbacks);
  else if (state.panel === 'settings') {
    if (state.config) renderSettings(els.panelBody, state.config, callbacks, state.detectedAgents);
    else {
      clear(els.panelBody);
      els.panelBody.append(h('div', { class: 'empty', text: 'Reading the configuration…' }));
      // Boot skips the bulk load until a workspace exists, so Settings fetches what it
      // needs itself rather than showing an empty panel on a fresh profile.
      void api
        .getConfig()
        .then((config) => {
          state.config = config;
          if (state.panel === 'settings') renderPanelBody();
        })
        .catch((error: unknown) => setHint(`Could not read the config: ${(error as Error).message}`));
    }
  }
  else if (state.panel === 'explorer') {
    // First visit reads the workspace root; the listing is cached until a switch or reload.
    if (state.explorer.listing || state.explorer.error) renderExplorer(els.panelBody, state.explorer, explorerCallbacks);
    else void openExplorer();
  } else renderActivity(els.panelBody, state.audit, callbacks);
}

/* -------------------------------------------------------------------- plan */

/** Mirrors the goal/to-do stores of the current session into the panel above the composer. */
function renderGoalPanel(): void {
  renderPlan(
    els.goalSlot,
    {
      enabled: state.config?.features?.goalTodo !== false,
      goal: state.goal,
      todos: state.todos,
    },
    {
      setGoal: async (text: string) => {
        if (!state.current) return;
        // The `session.goal` event repaints the panel; nothing is assumed locally.
        await api.invoke('goal.set', { sessionId: state.current.id, text });
      },
      clearGoal: async () => {
        if (!state.current) return;
        await api.invoke('goal.clear', { sessionId: state.current.id });
      },
    },
  );
}

const workspaceActions: WorkspaceActions = {
  choose: async () => {
    const picked = await api.pickDirectory({
      title: 'Choose a workspace folder',
      defaultPath: state.workspace?.root || state.workspace?.recent[0],
    });
    if (picked) await applyWorkspace(picked);
  },
  useRecent: (path) => applyWorkspace(path),
  forget: async (path) => {
    state.workspace = await api.invoke('workspace.forget', { path });
    state.config = await api.getConfig();
    paintWorkspaceGate();
    renderPanelBody();
  },
};

function paintWorkspaceGate(): void {
  renderWorkspaceGate(els.workspaceGate, state.workspace, workspaceActions);
  // The gate covers the chat column visually, but a hidden composer is still reachable
  // with Tab — `inert` is what keeps focus and the screen-reader cursor out of the
  // surfaces the service would refuse anyway. Settings stays live so the workspace and
  // the agent catalogue can still be configured.
  const gated = !state.workspace?.configured;
  for (const node of [els.transcript, els.goalSlot, els.approvalSlot, els.questionSlot, els.composer]) {
    node.toggleAttribute('inert', gated);
    if (gated) node.setAttribute('aria-hidden', 'true');
    else node.removeAttribute('aria-hidden');
  }
  // The composer's disabled state follows the gate, including on the first paint (the
  // early-return path in loadAll never reached renderBusy before).
  renderBusy();
}

/**
 * Switch the workspace folder (validated and persisted by the service). Sessions keep the
 * directory they were created in, so a conversation rooted somewhere else is not silently
 * re-pointed: the user gets a fresh session inside the new folder instead.
 */
async function applyWorkspace(path: string): Promise<void> {
  try {
    state.workspace = await api.invoke('workspace.set', { path });
    state.config = await api.getConfig();
    // The explorer is rooted in the workspace, so its cache belongs to the previous one.
    state.explorer = {};
    if (state.current?.cwd !== state.workspace.root) {
      state.current = undefined;
      state.entries = [];
      state.goal = undefined;
      state.todos = [];
      state.approval = undefined;
      state.question = undefined;
      await newSession();
    }
    paintWorkspaceGate();
    renderHeader();
    renderGoalPanel();
    renderPanelBody();
    setHint(`Workspace: ${state.workspace.root}`);
  } catch (error) {
    setHint(`Could not use that folder: ${(error as Error).message}`);
  }
}

/* -------------------------------------------------------------- explorer */

/** List one directory of the workspace; no path means the workspace root. */
async function openExplorer(path?: string): Promise<void> {
  try {
    const listing = await api.invoke('fs.list', path ? { path } : {});
    state.explorer = { path: listing.path, listing };
  } catch (error) {
    state.explorer = { ...state.explorer, error: (error as Error).message };
  }
  if (state.panel === 'explorer') renderPanelBody();
}

/** Preview one file, clipped to the service's preview budget. */
async function previewFile(path: string): Promise<void> {
  try {
    const file = await api.invoke('fs.read', { path });
    state.explorer = { ...state.explorer, file, error: undefined };
  } catch (error) {
    state.explorer = { ...state.explorer, error: (error as Error).message };
  }
  if (state.panel === 'explorer') renderPanelBody();
}

/* ------------------------------------------------------------- workspace menu */

/**
 * The workspace switcher: the folders this app has opened, most recent first, plus a way to
 * pick a new one. The list is the service's MRU (workspace.state), so it reflects what was
 * actually used rather than a guess the renderer keeps locally.
 */
function toggleWorkspaceMenu(): void {
  const existing = document.getElementById('workspace-menu');
  if (existing) {
    existing.remove();
    return;
  }
  const menu = h('div', { class: 'workspace-menu', id: 'workspace-menu' });
  const root = state.workspace?.root ?? '';
  menu.append(h('div', { class: 'workspace-menu-title', text: root || 'No workspace yet' }));
  for (const path of state.workspace?.recent ?? []) {
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    menu.append(
      h(
        'button',
        {
          class: `workspace-menu-item${path === root ? ' active' : ''}`,
          type: 'button',
          title: path,
          on: {
            click: () => {
              menu.remove();
              void applyWorkspace(path);
            },
          },
        },
        h('span', { class: 'workspace-menu-name', text: name }),
        h('span', { class: 'workspace-menu-path', text: path }),
      ),
    );
  }
  if (!(state.workspace?.recent ?? []).length) {
    menu.append(h('div', { class: 'workspace-menu-empty', text: 'Folders you open show up here.' }));
  }
  menu.append(
    h(
      'button',
      {
        class: 'workspace-menu-item action',
        type: 'button',
        on: {
          click: () => {
            menu.remove();
            void workspaceActions.choose();
          },
        },
      },
      h('span', { class: 'workspace-menu-name', text: 'Open another folder…' }),
    ),
  );
  // Anchor the menu to the button it came from: the topbar layout is free to change.
  const button = document.getElementById('workspace-btn');
  if (button) {
    const rect = button.getBoundingClientRect();
    menu.style.top = `${Math.round(rect.bottom + 6)}px`;
    menu.style.left = `${Math.round(Math.min(rect.left, window.innerWidth - 320))}px`;
  }
  els.app.append(menu);
  // One-shot dismissal: any click outside the menu closes it, like every other popup here.
  setTimeout(() => {
    const close = (event: Event): void => {
      if (menu.contains(event.target as Node)) return;
      menu.remove();
      document.removeEventListener('click', close, true);
    };
    document.addEventListener('click', close, true);
  }, 0);
}

function scrollToBottom(): void {
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function setHint(text: string): void {
  els.hint.textContent = text;
}
