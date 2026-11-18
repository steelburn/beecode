import type { AppInfo, BeeCodeBridge, ServiceStatusPayload } from '../shared/bridge';
import type {
  AgentInfo,
  ApprovalRequest,
  AuditEntry,
  BeeCodeConfig,
  PolicyDocument,
  SessionSnapshot,
  SessionSummary,
  SubagentRunInfo,
  ToolInfo,
  TranscriptEntry,
} from '../shared/protocol';
import { clear, formatJsonForDisplay, h, renderMarkdown } from './dom';
import { renderActivity, renderPermissions, renderSubagents } from './panels';

declare global {
  interface Window {
    beeCode: BeeCodeBridge;
  }
}

const api = window.beeCode;

// Surface renderer crashes in the main-process log (and in the smoke report).
const rendererErrors: string[] = [];
(window as unknown as { __rendererErrors: string[] }).__rendererErrors = rendererErrors;
window.addEventListener('error', (event) => rendererErrors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => rendererErrors.push(String((event as PromiseRejectionEvent).reason)));

type PanelTab = 'permissions' | 'subagents' | 'activity';

interface State {
  info?: AppInfo;
  status: ServiceStatusPayload['supervisor'];
  health?: ServiceStatusPayload['health'];
  sessions: SessionSummary[];
  current?: SessionSnapshot;
  entries: TranscriptEntry[];
  approval?: ApprovalRequest;
  policy?: PolicyDocument;
  config?: BeeCodeConfig;
  audit: AuditEntry[];
  subagents: SubagentRunInfo[];
  agents: AgentInfo[];
  tools: ToolInfo[];
  panel: PanelTab;
  ready: boolean;
}

const state: State = {
  status: 'starting',
  sessions: [],
  entries: [],
  audit: [],
  subagents: [],
  agents: [],
  tools: [],
  panel: 'permissions',
  ready: false,
};

const els = {
  app: document.getElementById('app') as HTMLElement,
  sessionList: document.getElementById('session-list') as HTMLElement,
  transcript: document.getElementById('transcript') as HTMLElement,
  approvalSlot: document.getElementById('approval-slot') as HTMLElement,
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
    const [sessions, config, policy, audit, subagents, agents, tools] = await Promise.all([
      api.invoke('session.list', {}),
      api.getConfig(),
      api.getPolicy(),
      api.invoke('audit.list', { limit: 80 }),
      api.invoke('subagent.list', {}),
      api.invoke('agents.list', {}),
      api.invoke('tools.list', {}),
    ]);
    state.config = config;
    state.policy = policy;
    state.audit = audit;
    state.subagents = subagents;
    state.agents = agents;
    state.tools = tools;
    state.sessions = sessions;
    state.ready = true;

    populateModels();
    if (sessions.length && !state.current) {
      await openSession(sessions[0]!.id);
    } else if (!sessions.length) {
      await newSession();
      return;
    }
    renderSessions();
    renderPanelBody();
  } catch (err) {
    setHint(`failed to load: ${(err as Error).message}`);
  } finally {
    loadingAll = false;
  }
}

/* ------------------------------------------------------------------ ui bindings */

function bindUi(): void {
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
  const snapshot = await api.invoke('session.create', {});
  state.sessions = await api.invoke('session.list', {});
  await openSession(snapshot.id);
  els.input.focus();
}

async function openSession(sessionId: string): Promise<void> {
  const snapshot = await api.invoke('session.get', { sessionId });
  state.current = snapshot;
  state.entries = snapshot.entries;
  state.approval = snapshot.pendingApproval;
  els.modeSelect.value = snapshot.mode;
  els.modelSelect.value = snapshot.model;
  state.sessions = await api.invoke('session.list', {});
  renderSessions();
  renderHeader();
  renderTranscript(true);
  renderApproval();
  renderBusy();
}

async function sendPrompt(): Promise<void> {
  const text = els.input.value.trim();
  if (!text) return;
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
    els.input.disabled = false;
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
        renderSessions();
      });
      break;

    case 'session.entry':
      if (event.payload.sessionId !== state.current?.id) return;
      upsertEntry(event.payload.entry);
      break;

    case 'assistant.delta': {
      if (event.payload.sessionId !== state.current?.id) return;
      appendDelta(event.payload.entryId, event.payload.text);
      break;
    }

    case 'tool.result': {
      if (event.payload.sessionId !== state.current?.id) return;
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
      break;
    }

    case 'session.status':
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
  els.cwd.textContent = session?.cwd ?? state.info?.workspace ?? '';
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
    const item = h(
      'div',
      {
        class: `session-item${session.id === state.current?.id ? ' active' : ''}`,
        on: { click: () => void openSession(session.id) },
        title: session.cwd,
      },
      h('div', { class: 's-title', text: session.parentSessionId ? `↳ ${session.title}` : session.title }),
      h('div', { class: 's-meta', text: session.status === 'idle' ? '' : session.status }),
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
  els.stop.classList.toggle('hidden', !busy);
  els.send.disabled = busy || Boolean(state.approval);
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
      renderPanelBody();
    },
    cancelSubagent: async (runId: string) => {
      await api.invoke('subagent.cancel', { runId });
    },
    refreshAudit: async () => {
      state.audit = await api.invoke('audit.list', { limit: 80 });
      renderPanelBody();
    },
  };

  if (state.panel === 'permissions') renderPermissions(els.panelBody, state.policy, state.config, callbacks);
  else if (state.panel === 'subagents') renderSubagents(els.panelBody, state.subagents, state.agents, callbacks);
  else renderActivity(els.panelBody, state.audit, callbacks);
}

function scrollToBottom(): void {
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function setHint(text: string): void {
  els.hint.textContent = text;
}
