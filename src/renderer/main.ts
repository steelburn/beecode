import type { AppInfo, BeeCodeBridge, ServiceStatusPayload } from '../shared/bridge';
import type {
  AgentInfo,
  ApprovalRequest,
  AuditEntry,
  BeeCodeConfig,
  CliAgentEntry,
  PolicyDocument,
  Schedule,
  ScheduleInput,
  SessionGoal,
  SessionSnapshot,
  SessionStatus,
  SessionSummary,
  PluginInfo,
  SkillInfo,
  SkillInstallInput,
  McpServerStatus,
  SubagentRunInfo,
  TodoItem,
  ToolInfo,
  TranscriptAction,
  TranscriptEntry,
  WorkspaceState,
  SlateRef,
  SlateSummary,
} from '../shared/protocol';
import { slateCardVersionLabel, slateRefOf } from './slateRef';
import { slateDocFromPath, slateExportName } from './slateDoc';
import { copyText } from './clipboard';
import type { DocTab } from './docTabs';
import { initColumns } from './columns';
import { clear, formatJsonForDisplay, h, renderMarkdown } from './dom';
import { mountBrowserDock, type BrowserDock, type DockMode } from './browserDock';
import { renderExplorer, type ExplorerState } from './explorer';
import { mountMainArea, type MainArea } from './mainArea';
import { groupSessions, workspaceKey } from './sessionGroups';
import {
  BROWSER_TAB,
  CHAT_TAB,
  activateTab,
  closeDoc,
  emptyDocTabs,
  openDoc,
  setDocView,
  toggleTheme,
  type DocTheme,
  type DocTabsState,
} from './docTabs';
import type { TerminalState } from '../shared/terminal';
import { renderTerminal } from './terminal';
import type { FileView } from './preview';
import {
  renderActivity,
  renderIntegrations,
  renderPermissions,
  renderScheduler,
  renderSettings,
  renderSlates,
  renderSubagents,
  renderTools,
} from './panels';
import { renderPlan, renderWorkspaceGate, type WorkspaceActions } from './plan';

declare global {
  interface Window {
    beeCode: BeeCodeBridge;
    /** Smoke-check hook (see scripts/smoke.mjs): counts what a sample message rendered. */
    __renderMessageSample?: () => Record<string, number>;
    /** Smoke-check hook: rolls the session rail up around two sample workspaces and reports it. */
    __renderRailSample?: () => Record<string, number>;
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

/**
 * The right column is the session's own surface: what it may touch, who it delegated to, what
 * it did, and the workspace files it can reach. Everything app-wide — models, integrations,
 * scheduled runs — lives in the settings dialog, and the shell in the bottom drawer.
 */
type PanelTab = 'subagents' | 'activity' | 'explorer' | 'slates';

/** Settings dialog sections: one per card group that used to be a panel tab of its own. */
type SettingsSection = 'general' | 'tools' | 'permissions' | 'integrations' | 'automation';

interface State {
  info?: AppInfo;
  /** Workspace terminal scrollback; undefined until the first fetch answers. */
  terminal?: TerminalState;
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
  /** Absolute paths attached to the next prompt; cleared once it is sent. */
  attachments: string[];
  approval?: ApprovalRequest;
  /** Pending `ask_user` question, shown above the composer until answered. */
  question?: PendingQuestion;
  policy?: PolicyDocument;
  config?: BeeCodeConfig;
  /** Workspace folder state — `configured: false` shows the setup gate. */
  workspace?: WorkspaceState;
  audit: AuditEntry[];
  subagents: SubagentRunInfo[];
  /** Timed agent runs — the same list the `schedule` tool edits. */
  schedules: Schedule[];
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
  /** Main-area tabs: the open documents, the active view and the rendered theme. */
  docs: DocTabsState;
  /** Slates of the current session, as the SLATE_TAB gallery lists them. */
  slates: SlateSummary[];
  /** Set when `slate.list` failed, so the gallery can say why it is empty. */
  slateError?: string;
  panel: PanelTab;
  /** App-wide configuration: it opens over the session instead of taking a panel tab. */
  settings: { open: boolean; section: SettingsSection };
  /** The terminal drawer at the bottom of the chat column. */
  terminalOpen: boolean;
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
  attachments: [],
  todos: [],
  audit: [],
  subagents: [],
  schedules: [],
  agents: [],
  detectedAgents: [],
  tools: [],
  mcpServers: [],
  skills: [],
  plugins: [],
  statuses: {},
  unread: new Set<string>(),
  explorer: {},
  docs: emptyDocTabs(readDocTheme()),
  slates: [],
  panel: 'subagents',
  settings: { open: false, section: 'general' },
  terminalOpen: false,
  ready: false,
};

const els = {
  app: document.getElementById('app') as HTMLElement,
  sessionList: document.getElementById('session-list') as HTMLElement,
  transcript: document.getElementById('transcript') as HTMLElement,
  browserDock: document.getElementById('browser-dock') as HTMLElement,
  workspace: document.querySelector('.workspace') as HTMLElement,
  viewTabs: document.getElementById('view-tabs') as HTMLElement,
  docPane: document.getElementById('doc-pane') as HTMLElement,
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
  attach: document.getElementById('attach') as HTMLButtonElement,
  attachments: document.getElementById('composer-attachments') as HTMLElement,
  serviceDot: document.getElementById('service-dot') as HTMLElement,
  serviceText: document.getElementById('service-text') as HTMLElement,
  restart: document.getElementById('restart-service') as HTMLButtonElement,
  newSession: document.getElementById('new-session') as HTMLButtonElement,
  panel: document.getElementById('panel') as HTMLElement,
  panelBody: document.getElementById('panel-body') as HTMLElement,
  togglePanel: document.getElementById('toggle-panel') as HTMLButtonElement,
  settingsModal: document.getElementById('settings-modal') as HTMLElement,
  settingsNav: document.getElementById('settings-nav') as HTMLElement,
  settingsBody: document.getElementById('settings-body') as HTMLElement,
  openSettings: document.getElementById('open-settings') as HTMLButtonElement,
  closeSettings: document.getElementById('close-settings') as HTMLButtonElement,
  drawer: document.getElementById('drawer') as HTMLElement,
  drawerBody: document.getElementById('drawer-body') as HTMLElement,
  toggleTerminal: document.getElementById('toggle-terminal') as HTMLButtonElement,
  toggleRail: document.getElementById('toggle-rail') as HTMLButtonElement,
  revealRail: document.getElementById('reveal-rail') as HTMLButtonElement,
  revealPanel: document.getElementById('reveal-panel') as HTMLButtonElement,
  railResizer: document.getElementById('resizer-rail') as HTMLElement,
  panelResizer: document.getElementById('resizer-panel') as HTMLElement,
};

/* ------------------------------------------------- main-area tab handles */

/** Created in `boot()`, before the first render; every reader tolerates "not yet". */
let dock: BrowserDock | undefined;
let mainArea: MainArea | undefined;
/** Whether the host currently has a browser panel on screen, so the tab list can offer it. */
let browserShown = false;
/** The dock mode to restore when the user leaves the browser tab. */
let dockModeBeforeTab: DockMode = 'normal';

/* ------------------------------------------------------------------ boot */

void boot();

async function boot(): Promise<void> {
  bindUi();
  dock = mountBrowserDock(els.browserDock, api.browser);
  mainArea = mountMainArea(
    { workspace: els.workspace, strip: els.viewTabs, pane: els.docPane },
    {
      activate: activateMainTab,
      openSlate: (id, version) => void openSlate(id, version),
      removeSlate: (id) => void removeSlate(id),
      promoteSlate: (id, version, path) => void promoteSlate(id, version, path),
      close: closeDocTab,
      setView: setDocTabView,
      copyDoc: (path) => void copyDocToClipboard(path),
      downloadDoc: (path) => void saveDocAs(path),
      toggleTheme: toggleDocTheme,
    },
  );
  renderMainArea();
  api.browser.onState((next) => {
    browserShown = next.visible;
    // A browser the host closed cannot stay the active tab: go back to the chat.
    if (!next.visible && state.docs.active === BROWSER_TAB) state.docs = activateTab(state.docs, CHAT_TAB);
    dock?.render(next);
    renderMainArea();
  });
  api.terminal.onState(applyTerminal);
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

/**
 * `agents.detect` and `agents.save` answer with the *CLI* catalogue only, while
 * `agents.list` — the list the Subagents panel is fed — also carries the internal runner.
 * Merge that entry back in, or ticking an agent in Settings makes the internal agent
 * disappear from the panel even though it is still available.
 */
function withInternalAgent(catalogue: AgentInfo[]): AgentInfo[] {
  return [...state.agents.filter((agent) => agent.kind === 'internal'), ...catalogue];
}

async function loadAll(): Promise<void> {
  if (loadingAll) return;
  loadingAll = true;
  try {
    const [
      sessions,
      config,
      policy,
      audit,
      subagents,
      schedules,
      agents,
      tools,
      mcp,
      skills,
      plugins,
      workspace,
    ] =
      await Promise.all([
      api.invoke('session.list', {}),
      api.getConfig(),
      api.getPolicy(),
      api.invoke('audit.list', { limit: 80 }),
      api.invoke('subagent.list', {}),
      api.invoke('scheduler.list', {}),
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
    state.schedules = schedules.schedules;
    state.agents = agents;
    // The Settings agent card toggles *external CLI* agents, so it needs the probe
    // catalogue. This used to hold `agents.list` (the registered agent types), which has no
    // cli entries at all — the card therefore rendered nothing to enable or disable until
    // the user found the Detect button. Cheap by default: the probe runs when Settings opens.
    state.detectedAgents = (await api.invoke('agents.detect', { probe: false })).agents;
    state.tools = tools;
    state.mcpServers = mcp.servers;
    state.skills = skills.skills;
    state.plugins = plugins.plugins;
    state.workspace = workspace;
    state.sessions = sessions;
    state.ready = true;
    // The bulk load is observable from outside: the smoke probes wait for it instead of
    // racing a fan-out that includes CLI agent detection.
    document.body.dataset.ready = 'true';

    populateModels();
    renderSessions();
    paintWorkspaceGate();
    renderPanels();
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

  els.attach.addEventListener('click', () => {
    void pickAttachments();
  });
  bindDragAndDrop();

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
    rememberMode(mode);
    await api.invoke('session.setMode', { sessionId: state.current.id, mode });
    state.current.mode = mode;
  });

  els.modelSelect.addEventListener('change', async () => {
    if (!state.current) return;
    await api.invoke('session.setModel', { sessionId: state.current.id, model: els.modelSelect.value });
    state.current.model = els.modelSelect.value;
  });

  // Both side columns are dragged, collapsed and remembered by the columns module.
  initColumns({
    app: els.app,
    railResizer: els.railResizer,
    panelResizer: els.panelResizer,
    toggleRail: els.toggleRail,
    togglePanel: els.togglePanel,
    revealRail: els.revealRail,
    revealPanel: els.revealPanel,
  });

  for (const tab of document.querySelectorAll<HTMLButtonElement>('.panel-tabs .tab')) {
    tab.addEventListener('click', () => {
      state.panel = (tab.dataset.panel as PanelTab) ?? 'subagents';
      // The panel lists the session's slates, so it re-reads them on every visit.
      if (state.panel === 'slates') {
        const open = state.current?.id;
        if (open) void loadSlates(open).then(() => renderPanels());
        else renderPanels();
      }
      for (const other of document.querySelectorAll('.panel-tabs .tab')) other.classList.toggle('active', other === tab);
      // A boot load that failed — a transient RPC, a service that was still starting — left
      // every panel empty while the composer kept working. Opening a tab is the user asking
      // for that data, so retry instead of showing an empty card until the next restart.
      if (!state.ready) void loadAll();
      renderPanels();
      // Re-opening a tab re-reads what it shows: the Files listing and the CLI catalogue
      // are snapshots, so a second click was the only way to ask for a fresh one and it
      // did nothing before this.
      if (state.panel === 'explorer') void openExplorer(state.explorer.path);
    });
  }

  els.openSettings.addEventListener('click', () => setSettingsOpen(!state.settings.open));
  els.closeSettings.addEventListener('click', () => setSettingsOpen(false));
  // The backdrop is the dialog element itself, so only a click outside the card closes it.
  els.settingsModal.addEventListener('click', (event) => {
    if (event.target === els.settingsModal) setSettingsOpen(false);
  });
  for (const item of els.settingsNav.querySelectorAll<HTMLButtonElement>('.modal-nav-item')) {
    item.addEventListener('click', () => {
      const section = item.dataset.settings as SettingsSection | undefined;
      setSettingsOpen(true, section);
    });
  }

  els.toggleTerminal.addEventListener('click', () => setTerminalOpen(!state.terminalOpen));

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      void newSession();
      return;
    }
    // Esc closes whatever the top layer is — the dialog first, then the drawer.
    if (event.key === 'Escape') {
      if (state.settings.open) setSettingsOpen(false);
      else if (state.terminalOpen) setTerminalOpen(false);
      return;
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    // Ctrl+, is the customary settings shortcut; the drawer gets the backtick beside it.
    if (event.key === ',') {
      event.preventDefault();
      setSettingsOpen(!state.settings.open);
    } else if (event.key === '`') {
      event.preventDefault();
      setTerminalOpen(!state.terminalOpen);
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
  const snapshot = await api.invoke('session.create', { cwd, mode: rememberedMode() });
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
  void loadSlates(sessionId);
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

/** Absolute path → the label shown on a chip: the file name, unique enough in a row. */
function attachmentLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length ? (parts[parts.length - 1] as string) : path;
}

/** Add paths to the pending prompt, ignoring the ones already attached. */
function setAttachments(paths: string[]): void {
  const seen = new Set<string>();
  state.attachments = paths.filter((path) => {
    const key = path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  renderAttachments();
}

/**
 * The gallery lists what the store holds right now rather than accumulating events: a
 * slate created before this window opened has to appear too.
 */
async function loadSlates(sessionId: string): Promise<void> {
  try {
    const { slates } = await api.invoke('slate.list', { sessionId });
    if (state.current?.id !== sessionId) return;
    state.slates = slates;
    state.slateError = undefined;
  } catch (error) {
    if (state.current?.id !== sessionId) return;
    state.slates = [];
    state.slateError = (error as Error).message;
  }
  renderMainArea();
}

/**
 * Open one slate version as a document tab. The service returns the version's file and
 * text, which is exactly what a tab holds, so there is no second read and no slate-only
 * viewer: the markdown and sandboxed-HTML renderers already exist.
 */
async function openSlate(id: string, version?: number): Promise<void> {
  const sessionId = state.current?.id;
  if (!sessionId) return;
  try {
    const slate = await api.invoke('slate.read', { id, sessionId, version });
    state.docs = openDoc(state.docs, {
      path: slate.path,
      name: slate.version.file,
      size: slate.version.bytes,
      truncated: false,
      binary: false,
      text: slate.content,
    });
    renderMainArea();
  } catch (error) {
    setHint(`Could not open the slate: ${(error as Error).message}`);
  }
}

/** Delete a slate and close any tab that was showing one of its versions. */
/**
 * Write one slate version into the workspace tree as an ordinary file. The copy is what the
 * user commits or keeps editing; the slate folder stays the source of truth and keeps its
 * history. The service applies the same file policy a tool write would.
 */
async function promoteSlate(id: string, version: number, path: string): Promise<void> {
  const sessionId = state.current?.id;
  if (!sessionId) return;
  try {
    const promoted = await api.invoke('slate.promote', { id, sessionId, version, path });
    const title = state.slates.find((candidate) => candidate.id === id)?.title ?? id;
    setHint(`Promoted ${title} v${promoted.version} to ${promoted.path} — open it from the file tree.`);
  } catch (error) {
    setHint(`Could not promote the slate: ${(error as Error).message}`);
  }
}

async function removeSlate(id: string): Promise<void> {
  const sessionId = state.current?.id;
  if (!sessionId) return;
  const removed = state.slates.find((candidate) => candidate.id === id);
  try {
    const { slates } = await api.invoke('slate.remove', { id, sessionId });
    state.slates = slates;
    state.slateError = undefined;
    for (const version of removed?.versions ?? []) state.docs = closeDoc(state.docs, version.path);
    renderMainArea();
  } catch (error) {
    setHint(`Could not remove the slate: ${(error as Error).message}`);
  }
}

function addAttachments(paths: string[]): void {
  if (!paths.length) return;
  setAttachments([...state.attachments, ...paths]);
  setHint(`${state.attachments.length} file${state.attachments.length === 1 ? '' : 's'} attached — Send to hand them to the agent.`);
}

function renderAttachments(): void {
  clear(els.attachments);
  els.attachments.classList.toggle('hidden', state.attachments.length === 0);
  for (const path of state.attachments) {
    const chip = h('span', { class: 'attachment-chip', title: path });
    chip.append(h('span', { class: 'attachment-name', text: attachmentLabel(path) }));
    chip.append(
      h('button', {
        class: 'attachment-remove',
        text: '✕',
        attrs: { type: 'button', 'aria-label': `Remove ${attachmentLabel(path)}` },
        on: { click: () => setAttachments(state.attachments.filter((entry) => entry !== path)) },
      }),
    );
    els.attachments.append(chip);
  }
}

/** Attach the files of a drop/selection; nothing to do when the OS gave no paths. */
function attachPaths(paths: string[]): void {
  if (!paths.length) {
    setHint('The dropped item did not resolve to a file path.');
    return;
  }
  addAttachments(paths);
}

async function pickAttachments(): Promise<void> {
  const paths = await api.pickFiles({ title: 'Attach files to the prompt' });
  attachPaths(paths);
  els.input.focus();
}

/* ------------------------------------------------------- drag and drop */

/** True only for a drag that carries files, so dragging a selection inside the window is ignored. */
function isFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Files dropped on the composer are attached to the prompt; files dropped anywhere else are
 * copied into the workspace. Both routes need the main process — the renderer has no
 * file-system access. The counter keeps the highlight steady while the pointer crosses
 * child elements, each of which fires its own dragleave.
 */
function bindDragAndDrop(): void {
  let depth = 0;

  window.addEventListener('dragenter', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    depth += 1;
    document.body.classList.add('drag-files');
  });

  window.addEventListener('dragover', (event) => {
    if (!isFileDrag(event)) return;
    // Without preventDefault the browser never reports a drop at all.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    const overComposer =
      event.target instanceof Element && Boolean(event.target.closest('.composer'));
    document.body.classList.toggle('drag-files-over-composer', overComposer);
  });

  window.addEventListener('dragleave', (event) => {
    if (!isFileDrag(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      document.body.classList.remove('drag-files', 'drag-files-over-composer');
    }
  });

  window.addEventListener('drop', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    depth = 0;
    document.body.classList.remove('drag-files', 'drag-files-over-composer');
    const files = Array.from(event.dataTransfer?.files ?? []);
    const paths = files.length ? api.pathsForFiles(files) : [];
    if (!paths.length) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.composer')) {
      attachPaths(paths);
      return;
    }
    // A drop on the file panel lands in the folder it shows; anywhere else, in the root.
    const targetDir = target?.closest('#panel') ? state.explorer.path : undefined;
    void copyDroppedPaths(paths, targetDir);
  });
}

/** Copy dropped paths into the workspace and point the explorer at where they landed. */
async function copyDroppedPaths(paths: string[], targetDir?: string): Promise<void> {
  if (!state.workspace?.configured) {
    setHint('Choose a workspace folder first — beeCode will not copy files into an unset directory.');
    return;
  }
  try {
    const result = await api.copyIntoWorkspace(paths, targetDir);
    const copied = result.copied.length;
    const parts = [
      `${copied} file${copied === 1 ? '' : 's'} copied into the workspace`,
    ];
    if (result.skipped.length) parts.push(`${result.skipped.length} already there`);
    if (result.errors.length) {
      parts.push(`${result.errors.length} could not be copied: ${result.errors[0]?.error ?? 'unknown error'}`);
    }
    setHint(parts.join(' · '));
    if (state.panel === 'explorer') await openExplorer(state.explorer.path);
  } catch (error) {
    setHint(`Could not copy those files: ${(error as Error).message}`);
  }
}

async function sendPrompt(): Promise<void> {
  const text = els.input.value.trim();
  const attachments = [...state.attachments];
  // An attachment on its own is a valid prompt ("here is the file, look at it").
  if (!text && !attachments.length) return;
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
  // The chips move to the transcript with the prompt, so the composer starts empty.
  setAttachments([]);
  try {
    await api.invoke('session.prompt', {
      sessionId: session.id,
      text: text || '(see the attached file)',
      attachments: attachments.length ? attachments : undefined,
    });
  } catch (err) {
    // Nothing was accepted: put the paths back so the user does not re-attach them.
    setAttachments(attachments);
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
  renderPanels();
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
    case 'workspace.state': {
      // Another window or a direct RPC changed the workspace: adopt it and drop a copy
      // target that no longer exists.
      state.workspace = event.payload;
      const shelves = event.payload.knowledge ?? [];
      const target = state.explorer.copyTarget;
      if (target && !shelves.some((shelf) => shelf.path === target)) {
        state.explorer = { ...state.explorer, copyTarget: undefined };
      }
      renderPanels();
      break;
    }

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

    case 'slate.update': {
      if (event.payload.sessionId !== state.current?.id) return;
      // The gallery refreshes from the service, not from the payload: one order of truth.
      void loadSlates(event.payload.sessionId);
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
        slate: slateRefOf(event.payload.meta),
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

    case 'scheduler.changed':
      state.schedules = event.payload.schedules;
      if (state.settings.open && state.settings.section === 'automation') renderPanels();
      break;

    case 'subagent.update': {
      const index = state.subagents.findIndex((r) => r.id === event.payload.id);
      if (index >= 0) state.subagents[index] = event.payload;
      else state.subagents.push(event.payload);
      if (state.panel === 'subagents') renderPanels();
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
      if (state.panel === 'activity') renderPanels();
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
  if (session?.mode) {
    // Whatever mode this session is in is the one the next session should start in.
    rememberMode(session.mode);
    els.modeSelect.value = session.mode;
  } else els.modeSelect.value = rememberedMode();
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

/** Rail sections collapsed by the user: `{ workspaceKey: true }`, remembered across restarts. */
const COLLAPSED_WORKSPACES_KEY = 'beecode.rail.collapsedWorkspaces';

function collapsedGroups(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_WORKSPACES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const map: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'boolean') map[key] = value;
    }
    return map;
  } catch {
    return {};
  }
}

function toggleWorkspaceGroup(key: string, collapsed: boolean): void {
  const map = collapsedGroups();
  map[key] = collapsed;
  try {
    localStorage.setItem(COLLAPSED_WORKSPACES_KEY, JSON.stringify(map));
  } catch {
    // A full or disabled store only costs the remembered collapse state.
  }
  renderSessions();
}

/** One row of the rail: title, workspace path, live status and its delete button. */
function sessionItem(session: SessionSummary): HTMLElement {
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
  return item;
}

/**
 * The rail, rolled up per workspace: the folder the app has open comes first and expanded,
 * the others stay collapsed — a session from another project is one click away but never in
 * the way of the work in front of you.
 */
function renderSessions(currentRoot: string | undefined = state.workspace?.root): void {
  clear(els.sessionList);
  if (!state.sessions.length) {
    els.sessionList.append(h('div', { class: 'empty', text: 'No sessions yet' }));
    return;
  }
  const collapsed = collapsedGroups();
  for (const group of groupSessions(state.sessions, currentRoot)) {
    const key = workspaceKey(group.root);
    const isCollapsed = collapsed[key] ?? !group.current;
    const busy = group.sessions.filter(
      (session) => (state.statuses[session.id] ?? session.status) !== 'idle',
    ).length;
    const unread = group.sessions.filter((session) => state.unread.has(session.id)).length;
    const head = h(
      'button',
      {
        class: `session-group-head${group.current ? ' current' : ''}`,
        title: `${group.detail}\nClick to ${isCollapsed ? 'expand' : 'collapse'} these ${group.sessions.length} session(s)`,
        on: { click: () => toggleWorkspaceGroup(key, !isCollapsed) },
      },
      h('span', { class: 'sg-chevron', text: isCollapsed ? '▸' : '▾' }),
      h('span', { class: 'sg-label', text: group.label }),
      group.current ? h('span', { class: 'sg-tag', text: 'open' }) : null,
      busy ? h('span', { class: 'sg-tag busy', text: `${busy} busy` }) : null,
      unread ? h('span', { class: 'sg-tag unread', text: '●' }) : null,
      h('span', { class: 'sg-count', text: String(group.sessions.length) }),
    );
    const body = h('div', { class: 'session-group-body' });
    body.hidden = isCollapsed;
    if (!isCollapsed) {
      for (const session of group.sessions) body.append(sessionItem(session));
    }
    els.sessionList.append(h('div', { class: 'session-group' }, head, body));
  }
}

/**
 * Smoke-check hook: roll the rail up around two sample workspaces, report what the grouping
 * produced, then put the real list back. Keeps the rail's rules under the end-to-end check
 * without pulling a UI testing framework into the renderer.
 */
window.__renderRailSample = (): Record<string, number> => {
  const saved = state.sessions;
  const at = new Date().toISOString();
  const sample = (id: string, workspace: string): SessionSummary => ({
    id,
    title: id,
    cwd: workspace,
    workspace,
    mode: 'act',
    model: 'smoke',
    status: 'idle',
    createdAt: at,
    updatedAt: at,
    messageCount: 0,
  });
  state.sessions = [
    sample('smoke-open-1', 'D:\\smoke\\open'),
    sample('smoke-open-2', 'D:\\smoke\\open'),
    sample('smoke-closed', 'D:\\smoke\\closed'),
  ];
  renderSessions('D:\\smoke\\open');
  const groups = [...els.sessionList.querySelectorAll('.session-group')];
  const heads = groups.map((group) => group.querySelector('.session-group-head'));
  const result: Record<string, number> = {
    groups: groups.length,
    headers: heads.length,
    currentHeaders: heads.filter((head) => head?.classList.contains('current')).length,
    labels: heads.filter((head) => (head?.querySelector('.sg-label')?.textContent ?? '').length > 0).length,
    // Only the open workspace's sessions are on screen; the other group is collapsed.
    expandedItems: els.sessionList.querySelectorAll('.session-group-body:not([hidden]) .session-item').length,
    collapsedBodies: els.sessionList.querySelectorAll('.session-group-body[hidden]').length,
  };
  state.sessions = saved;
  renderSessions();
  return result;
};

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
  if (role === 'assistant' || role === 'user') body.innerHTML = renderMarkdown(entry.text || '');
  else body.textContent = entry.text;
  wrapper.append(body);
  if (entry.attachments?.length) wrapper.append(buildEntryAttachments(entry.attachments));

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
 * One line per slate in the transcript: `Sales Q3 · v2 · Open`. The version travels with
 * the entry, so a resumed session shows the card it showed when the tool ran.
 */
function buildSlateCard(entry: TranscriptEntry, slate: SlateRef): HTMLElement {
  const open = h('button', {
    type: 'button',
    class: 'btn ghost small slate-open',
    text: 'Open',
    title: 'Open this slate in its own tab',
  });
  open.addEventListener('click', () => void openSlate(slate.id, slate.version));
  return h(
    'div',
    { class: 'slate-card', dataset: { entryId: entry.id, slateId: slate.id } },
    h('span', { class: 'slate-card-title', text: slate.title }),
    h('span', {
      class: 'slate-card-meta',
      text: slateCardVersionLabel(slate),
    }),
    open,
  );
}

/** The files a user entry was sent with; the prompt already ran, so these are read-only. */
function buildEntryAttachments(paths: string[]): HTMLElement {
  const row = h('div', { class: 'msg-attachments' });
  for (const path of paths) {
    row.append(h('span', { class: 'attachment-chip static', text: attachmentLabel(path), title: path }));
  }
  return row;
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
    if (state.settings.open) renderPanels();
    setHint(`agent.maxSteps raised to ${state.config.agent.maxSteps}`);
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
    setHint(`Could not raise the step limit: ${(error as Error).message}`);
  }
}

function buildToolCard(entry: TranscriptEntry): HTMLElement {
  const failed = entry.failed === true;
  // A slate is a document, and a document belongs in a tab: the transcript keeps one line
  // pointing at it instead of the body the model just wrote.
  if (entry.slate && !failed) return buildSlateCard(entry, entry.slate);
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

/**
 * Draw the terminal in the bottom drawer of the chat column. The actions are rebuilt per
 * render because the drawer re-mounts whenever its body is rebuilt, and they close over
 * nothing else.
 */
function renderTerminalDrawer(next: TerminalState): void {
  renderTerminal(els.drawerBody, next, {
    run: (command) => void api.terminal.run(command).then(applyTerminal),
    cancel: () => void api.terminal.cancel().then(applyTerminal),
    clear: () => void api.terminal.clear().then(applyTerminal),
    hide: () => setTerminalOpen(false),
  });
}

/**
 * One entry point for every terminal state: the answer to run/cancel/clear, and the updates
 * the main process pushes while a command is still producing output.
 */
function applyTerminal(next: TerminalState): void {
  state.terminal = next;
  // A closed drawer needs no painting: opening it reads the state back.
  if (state.terminalOpen) renderTerminalDrawer(next);
}

function renderPanels(): void {
  const callbacks = {
    savePolicy,
    listModels: (input: {
      presetId?: string;
      provider?: string;
      baseUrl?: string;
      apiKeyEnv?: string;
      apiKey?: string;
    }) => api.invoke('models.list', input),
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
      renderPanels();
    },
    pickDirectory: async () => api.pickDirectory(),
    cancelSubagent: async (runId: string) => {
      await api.invoke('subagent.cancel', { runId });
    },
    refreshAudit: async () => {
      state.audit = await api.invoke('audit.list', { limit: 80 });
      renderPanels();
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
      renderPanels();
    },
    installPlugins: async (paths: string[]) => {
      const result = await api.invoke('plugin.install', { paths });
      state.plugins = result.plugins;
      renderPanels();
      return result;
    },
    removeSkill: async (name: string) => {
      const result = await api.invoke('skill.remove', { name });
      state.skills = result.skills;
      renderPanels();
      return result.skills;
    },
    togglePlugin: async (id: string, enabled: boolean) => {
      const result = await api.invoke('plugin.setEnabled', { id, enabled });
      state.plugins = result.plugins;
      renderPanels();
    },
    installSkill: async (input: SkillInstallInput) => {
      const result = await api.invoke('skill.install', input);
      state.skills = result.skills;
      // Rebuilding the panel is how the new card list appears; the note lives in the card.
      renderPanels();
      return result.installed;
    },
    detectAgents: async () => {
      const result = await api.invoke('agents.detect', {});
      state.detectedAgents = result.agents;
      state.agents = withInternalAgent(result.agents);
      renderPanels();
      return result.agents;
    },
    saveAgents: async (next: CliAgentEntry[]) => {
      const result = await api.invoke('agents.save', { agents: next });
      state.detectedAgents = result.agents;
      state.agents = withInternalAgent(result.agents);
      state.config = await api.getConfig();
      // No `renderPanels()` here: rebuilding Settings on every checkbox click threw
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
      renderPanels();
    },
  };

  const explorerCallbacks = {
    open: (path?: string) => void openExplorer(path),
    preview: (path: string) => void previewFile(path),
    openDoc: (path: string) => void openDocTab(path),
    addKnowledge: () => void addKnowledgeFolder(),
    removeKnowledge: (path: string) => void detachKnowledgeFolder(path),
    selectKnowledge: (path: string) => {
      state.explorer = { ...state.explorer, copyTarget: path };
      renderPanels();
    },
    editKnowledgeName: (name: string) => {
      // Re-rendering on every keystroke would fight the caret; only the value is kept.
      state.explorer = { ...state.explorer, newFolder: name };
    },
    createKnowledgeFolder: (path: string) => void createKnowledgeSubfolder(path),
    openSlate: (id: string, version?: number) => void openSlate(id, version),
    removeSlate: (id: string) => void removeSlate(id),
    promoteSlate: (id: string, version: number, path: string) => void promoteSlate(id, version, path),
    copyToKnowledge: (path: string) => void copyFileToKnowledge(path),
    close: () => {
      state.explorer = { ...state.explorer, file: undefined, view: undefined };
      renderPanels();
    },
    saveSchedule: async (input: ScheduleInput) => {
      const saved = await api.invoke('scheduler.save', input);
      state.schedules = saved.schedules;
      renderPanels();
    },
    removeSchedule: async (id: string) => {
      const removed = await api.invoke('scheduler.remove', { id });
      state.schedules = removed.schedules;
      renderPanels();
    },
    runSchedule: async (id: string) => {
      const started = await api.invoke('scheduler.run', { id });
      return started.sessionId;
    },
    setView: (view: FileView) => {
      state.explorer = { ...state.explorer, view };
      renderPanels();
    },
  };

  const host = state.settings.open ? els.settingsBody : els.panelBody;

  /**
   * The settings dialog hosts what used to be four panel tabs — General, Permissions,
   * MCP & skills and Scheduled runs — so they keep their render functions and change only
   * their host. The side panel keeps the session surfaces: subagents, activity and files.
   */
  const renderSettingsSection = (): void => {
    const section = state.settings.section;
    if (section === 'tools' && state.config) {
      renderTools(host, state.tools, state.config, async (disabled) => {
        state.config = await api.saveConfig({
          ...state.config!,
          tools: { ...(state.config!.tools ?? { disabled: [] }), disabled },
        });
        // The service rebuilt its catalogue — re-read the flags so a reopen tells the truth.
        state.tools = await api.invoke('tools.list', {});
      });
      // A fresh profile skips the bulk load, so the catalogue may not have arrived yet.
      if (state.tools.length === 0) {
        void api
          .invoke('tools.list', {})
          .then((tools) => {
            state.tools = tools;
            renderPanels();
          })
          .catch((error: unknown) =>
            setHint(`Could not read the tool catalogue: ${(error as Error).message}`),
          );
      }
      return;
    }
    if (section === 'permissions') {
      renderPermissions(host, state.policy, state.config, callbacks);
      return;
    }
    if (section === 'integrations') {
      renderIntegrations(host, state.mcpServers, state.skills, state.plugins, state.config, callbacks);
      return;
    }
    if (section === 'automation') {
      renderScheduler(host, state.schedules, callbacks);
      return;
    }
    if (state.config) {
      renderSettings(host, state.config, callbacks, state.detectedAgents);
      return;
    }
    clear(host);
    host.append(h('div', { class: 'empty', text: 'Reading the configuration…' }));
    // Boot skips the bulk load until a workspace exists, so Settings fetches what it needs
    // itself rather than showing an empty dialog on a fresh profile.
    void api
      .getConfig()
      .then((config) => {
        state.config = config;
        renderPanels();
      })
      .catch((error: unknown) => setHint(`Could not read the config: ${(error as Error).message}`));
  };

  if (state.settings.open) renderSettingsSection();
  else if (state.panel === 'subagents') renderSubagents(host, state.subagents, state.agents, callbacks);
  else if (state.panel === 'explorer') {
    // First visit reads the workspace root; after that the listing is re-read when the tab
    // is opened again (see the tab handler) or when the user navigates.
    if (state.explorer.listing || state.explorer.error) {
      renderExplorer(
        host,
        { ...state.explorer, knowledge: state.workspace?.knowledge ?? [] },
        explorerCallbacks,
      );
    } else void openExplorer(state.explorer.path);
  } else if (state.panel === 'slates') renderSlates(host, state.slates, state.slateError, callbacks);
  else renderActivity(host, state.audit, callbacks);
}

/**
 * Open or close the settings dialog. Configuration belongs to the app rather than to a
 * session, so it is a single modal instead of three more tabs in the side panel.
 */
function setSettingsOpen(open: boolean, section?: SettingsSection): void {
  state.settings = { open, section: section ?? state.settings.section };
  els.settingsModal.classList.toggle('hidden', !open);
  els.openSettings.setAttribute('aria-pressed', String(open));
  paintSettingsNav();
  // Repaint whichever surface is on screen: opening paints the dialog, closing paints the tab
  // strip again, because an edit made in the dialog can change what a tab shows.
  renderPanels();
  if (!open) return;
  // The catalogue is a probe, so it is refreshed on open rather than kept warm.
  if (state.settings.section === 'general') void refreshAgentCatalogue();
}

/** Mark the section the dialog is showing; also run on open so the state survives a reload. */
function paintSettingsNav(): void {
  for (const item of els.settingsNav.querySelectorAll<HTMLButtonElement>('.modal-nav-item')) {
    const active = item.dataset.settings === state.settings.section;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', String(active));
  }
}

/**
 * Open or close the terminal drawer. It takes the bottom of the chat column instead of a
 * 360px side tab, because a shell needs the width and belongs to the session's work.
 */
function setTerminalOpen(open: boolean): void {
  state.terminalOpen = open;
  els.drawer.classList.toggle('hidden', !open);
  els.toggleTerminal.setAttribute('aria-pressed', String(open));
  if (open) void api.terminal.state().then(applyTerminal);
  else clear(els.drawerBody);
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
    renderPanels();
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
    // Document tabs are rooted in the old folder, so they no longer describe the workspace.
    state.docs = emptyDocTabs(state.docs.theme);
    renderMainArea();
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
    renderPanels();
    setHint(`Workspace: ${state.workspace.root}`);
  } catch (error) {
    setHint(`Could not use that folder: ${(error as Error).message}`);
  }
}

/* -------------------------------------------------------------- explorer */

/* ------------------------------------------------------------ knowledge */

/** The knowledge folder copies land in: the selected one, else the first attached. */
function knowledgeTarget(): string | undefined {
  return state.explorer.copyTarget ?? state.workspace?.knowledge?.[0]?.path;
}

/** Adopt a returned workspace state and repaint both surfaces that show knowledge. */
function applyKnowledge(next: WorkspaceState): void {
  state.workspace = next;
  const selected = state.explorer.copyTarget;
  state.explorer = {
    ...state.explorer,
    knowledge: next.knowledge,
    copyTarget: next.knowledge.some((folder) => folder.path === selected)
      ? selected
      : next.knowledge[0]?.path,
  };
  renderPanels();
}

/**
 * Attach a shared knowledge folder. The picker is the whole write path: the service refuses
 * a path that is not an existing folder, and the agent can never call this at all.
 */
async function addKnowledgeFolder(): Promise<void> {
  try {
    const picked = await api.pickDirectory({
      title: 'Attach a read-only knowledge folder',
      defaultPath: state.workspace?.root || state.workspace?.recent[0],
    });
    if (!picked) return;
    applyKnowledge(await api.invoke('knowledge.add', { path: picked }));
    setHint(`Knowledge folder attached (read-only for the agent): ${picked}`);
  } catch (error) {
    setHint(`Could not attach that folder: ${(error as Error).message}`);
  }
}

/** Detach a knowledge folder. Nothing on disk is touched. */
async function detachKnowledgeFolder(path: string): Promise<void> {
  try {
    applyKnowledge(await api.invoke('knowledge.remove', { path }));
    setHint(`Knowledge folder detached: ${path}`);
  } catch (error) {
    setHint(`Could not detach that folder: ${(error as Error).message}`);
  }
}

/** Create the subfolder typed into the panel's field, inside the selected knowledge folder. */
async function createKnowledgeSubfolder(parent: string): Promise<void> {
  const name = (state.explorer.newFolder ?? '').trim();
  if (!name) {
    setHint('Type a subfolder name first.');
    return;
  }
  try {
    const created = await api.invoke('knowledge.mkdir', { path: parent, name });
    state.explorer = { ...state.explorer, newFolder: '' };
    setHint(`Created ${created.path}`);
    if (state.explorer.path === parent) await openExplorer(parent);
    else renderPanels();
  } catch (error) {
    setHint(`Could not create that folder: ${(error as Error).message}`);
  }
}

/** Copy a workspace file into the selected knowledge folder (the agent cannot do this). */
async function copyFileToKnowledge(path: string): Promise<void> {
  const target = knowledgeTarget();
  if (!target) {
    setHint('Attach a knowledge folder before copying into it.');
    return;
  }
  try {
    const copied = await api.invoke('knowledge.copy', { from: path, to: target });
    setHint(`Copied to ${copied.path} (read-only for the agent from now on)`);
    if (state.explorer.path === target) await openExplorer(target);
  } catch (error) {
    setHint(`Could not copy into knowledge: ${(error as Error).message}`);
  }
}

/** List one directory of the workspace; no path means the workspace root. */
async function openExplorer(path?: string): Promise<void> {
  try {
    const listing = await api.invoke('fs.list', path ? { path } : {});
    // `copyTarget`/`newFolder` belong to the panel, not to the folder being listed, so
    // navigating keeps them.
    state.explorer = {
      ...state.explorer,
      path: listing.path,
      listing,
      file: undefined,
      view: undefined,
      error: undefined,
    };
  } catch (error) {
    // Drop the listing: keeping it showed a folder that no longer matched the path, and
    // the panel had no way back out of the error state.
    state.explorer = { path: state.explorer.path, error: (error as Error).message };
  }
  if (state.panel === 'explorer') renderPanels();
}

/** Preview one file, clipped to the service's preview budget. */
/* ------------------------------------------------------------ main-area tabs */

const DOC_THEME_KEY = 'beecode.docTheme';

/**
 * The theme belongs to this machine, not to the agent service: it says how *this* user reads
 * a rendered document, so it is kept in the renderer's own storage.
 */
function readDocTheme(): DocTheme {
  try {
    return localStorage.getItem(DOC_THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function writeDocTheme(theme: DocTheme): void {
  try {
    localStorage.setItem(DOC_THEME_KEY, theme);
  } catch {
    /* storage can be unavailable; the theme still holds for this run */
  }
}

function renderMainArea(): void {
  mainArea?.render(state.docs, { browserVisible: browserShown, slates: state.slates, error: state.slateError });
}

/**
 * Switch the main-area view. The browser tab and the dock are the same page view: entering
 * the tab fills the column with it, leaving restores the size the user had chosen.
 */
function activateMainTab(id: string): void {
  const previous = state.docs.active;
  state.docs = activateTab(state.docs, id);
  if (dock && previous !== state.docs.active) {
    if (state.docs.active === BROWSER_TAB) {
      dockModeBeforeTab = dock.currentMode();
      dock.setMode('maximized');
    } else if (previous === BROWSER_TAB) {
      dock.setMode(dockModeBeforeTab);
    }
  }
  renderMainArea();
}

/** Open a file as a main-area tab, reusing the text the panel already fetched. */
async function openDocTab(path: string): Promise<void> {
  try {
    const file =
      state.explorer.file?.path === path ? state.explorer.file : await api.invoke('fs.read', { path });
    state.docs = openDoc(state.docs, file);
    renderMainArea();
  } catch (error) {
    state.explorer = { ...state.explorer, error: (error as Error).message };
    renderPanels();
  }
}

function closeDocTab(path: string): void {
  state.docs = closeDoc(state.docs, path);
  renderMainArea();
}

function setDocTabView(path: string, view: FileView): void {
  state.docs = setDocView(state.docs, path, view);
  renderMainArea();
}

/** The open document tab for a path, for the tab actions that work on its text. */
function docTabByPath(path: string): DocTab | undefined {
  return state.docs.tabs.find((tab) => tab.path === path);
}

/**
 * Copy a document tab's text to the clipboard. The tab already holds the text its viewer
 * rendered, so the copy matches the screen and nothing is re-read from disk.
 */
async function copyDocToClipboard(path: string): Promise<void> {
  const tab = docTabByPath(path);
  if (tab?.text == null) {
    setHint('Nothing to copy: this tab has no text.');
    return;
  }
  const copied = await copyText(tab.text);
  setHint(copied ? `Copied ${tab.name}` : `Could not copy ${tab.name}`);
}

/**
 * Download a document tab: the user picks the path in the native save dialog and the text
 * the tab holds is written there. A slate is named `<slug>-v<N>.<ext>`, so two versions
 * of one slate never land on the same file.
 */
async function saveDocAs(path: string): Promise<void> {
  const tab = docTabByPath(path);
  if (tab?.text == null) {
    setHint('Nothing to save: this tab has no text.');
    return;
  }
  const slate = slateDocFromPath(tab.path);
  try {
    const result = await api.saveFile({
      suggestedName: slate ? slateExportName(slate) : tab.name,
      content: tab.text,
      title: `Save ${tab.name}`,
    });
    setHint(result.saved ? `Saved to ${result.path ?? tab.name}` : 'Save cancelled.');
  } catch (error) {
    setHint(`Could not save ${tab.name}: ${(error as Error).message}`);
  }
}


function toggleDocTheme(): void {
  state.docs = toggleTheme(state.docs);
  writeDocTheme(state.docs.theme);
  renderMainArea();
}

async function previewFile(path: string): Promise<void> {
  try {
    const file = await api.invoke('fs.read', { path });
    state.explorer = { ...state.explorer, file, view: undefined, error: undefined };
  } catch (error) {
    state.explorer = { ...state.explorer, error: (error as Error).message };
  }
  if (state.panel === 'explorer') renderPanels();
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

/* -------------------------------------------------------------- preferences */

const MODE_KEY = 'beecode:last-mode';
const MODES: readonly SessionSnapshot['mode'][] = ['ask', 'plan', 'act', 'autonomous'];

/**
 * The permission mode the user last chose.
 *
 * The service falls back to `config.agent.defaultMode` on `session.create`, so a new
 * session used to snap back to the default — clicking "New session" or restarting the app
 * silently dropped "act". The renderer remembers the last mode instead and sends it along.
 */
function rememberedMode(): SessionSnapshot['mode'] {
  const stored = localStorage.getItem(MODE_KEY);
  return MODES.includes(stored as SessionSnapshot['mode'])
    ? (stored as SessionSnapshot['mode'])
    : 'ask';
}

/** Remember a mode as the one the next session starts in. */
function rememberMode(mode: SessionSnapshot['mode'] | undefined): void {
  if (mode && MODES.includes(mode)) localStorage.setItem(MODE_KEY, mode);
}

let catalogueProbedAt = 0;

/** Re-detect the external CLI agents; the Settings card shows that list. */
async function refreshAgentCatalogue(): Promise<void> {
  if (Date.now() - catalogueProbedAt < 15_000) return;
  catalogueProbedAt = Date.now();
  try {
    const result = await api.invoke('agents.detect', { probe: true });
    state.detectedAgents = result.agents;
    if (state.settings.open) renderPanels();
  } catch (error) {
    setHint(`Could not probe the external agents: ${(error as Error).message}`);
  }
}
