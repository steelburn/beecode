import type {
  AgentInfo,
  AppRule,
  AuditEntry,
  BeeCodeConfig,
  CliAgentEntry,
  DesktopAction,
  McpServerConfig,
  McpServerStatus,
  ModelPreset,
  PolicyDocument,
  ProviderId,
  PluginInfo,
  SkillInfo,
  SubagentRunInfo,
} from '../shared/protocol';
import { DESKTOP_ACTIONS } from '../shared/protocol';
import type { DirectoryPickerOptions } from '../shared/bridge';
import { clear, h } from './dom';

export interface PanelCallbacks {
  savePolicy(next: PolicyDocument): Promise<void>;
  saveConfig?(next: BeeCodeConfig): Promise<void>;
  pickDirectory?(options?: DirectoryPickerOptions): Promise<string | undefined>;
  cancelSubagent(runId: string): Promise<void>;
  refreshAudit(): Promise<void>;
  /** Re-read MCP servers and skills from the service after a reload. */
  reloadIntegrations?(): Promise<void>;
  /** Enable or disable a plugin; the service rebuilds the tool catalogue. */
  togglePlugin?(id: string, enabled: boolean): Promise<void>;
  /** Probe the CLI catalogue (`agents.detect`). */
  detectAgents?(): Promise<AgentInfo[]>;
  /** Persist the CLI agent list (`agents.save`); returns the refreshed catalogue. */
  saveAgents?(agents: CliAgentEntry[]): Promise<AgentInfo[]>;
  /** Validate, persist and activate a workspace folder (`workspace.set`). */
  setWorkspace?(path: string): Promise<void>;
  /** Drop a folder from the recents, or clear the active root (`workspace.forget`). */
  forgetWorkspace?(path: string): Promise<void>;
}

/* ---------------------------------------------------------------- permissions */

/**
 * Permission editor. Every change is written straight through to the service policy,
 * which is the same document the PolicyEngine enforces — there is no second source of
 * truth, and nothing here can grant an action the tool layer does not re-check.
 */
export function renderPermissions(
  host: HTMLElement,
  policy: PolicyDocument | undefined,
  config: BeeCodeConfig | undefined,
  cb: PanelCallbacks,
): void {
  clear(host);
  if (!policy) {
    host.append(h('div', { class: 'empty', text: 'Loading policy…' }));
    return;
  }

  const update = (mutate: (draft: PolicyDocument) => void) => {
    const draft: PolicyDocument = JSON.parse(JSON.stringify(policy)) as PolicyDocument;
    mutate(draft);
    void cb.savePolicy(draft);
  };

  const appsCard = h(
    'div',
    { class: 'card' },
    h('h4', { text: 'Permissible applications' }),
    h('p', {
      class: 'sub',
      text: 'Deny by default. The agent can only see and drive the apps listed here, and only the actions you tick. Enforced in the service, not by the prompt.',
    }),
    ...policy.allowedApps.map((rule) => renderAppRule(rule, update)),
    renderAddApp(update),
  );
  host.append(appsCard);

  host.append(
    h(
      'div',
      { class: 'card' },
      h('h4', { text: 'Denied executables' }),
      h('p', { class: 'sub', text: 'Always refused, even if an app rule would match. One per line.' }),
      textArea(policy.deniedExe.join('\n'), (value) =>
        update((draft) => {
          draft.deniedExe = value
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
        }),
      ),
    ),
  );

  host.append(
    h(
      'div',
      { class: 'card' },
      h('h4', { text: 'Shell' }),
      toggle('Enabled', policy.shell.enabled, (checked) =>
        update((draft) => {
          draft.shell.enabled = checked;
        }),
      ),
      h('p', { class: 'sub', text: 'Allowed command prefixes (one per line). Every run is still confirmed unless the session is autonomous.' }),
      textArea(policy.shell.allowedCommands.join('\n'), (value) =>
        update((draft) => {
          draft.shell.allowedCommands = value
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
        }),
      ),
      h('p', { class: 'sub', text: 'Blocked substrings' }),
      textArea(policy.shell.blocked.join('\n'), (value) =>
        update((draft) => {
          draft.shell.blocked = value
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
        }),
      ),
    ),
  );

  host.append(
    h(
      'div',
      { class: 'card' },
      h('h4', { text: 'Filesystem' }),
      toggle('Workspace only', policy.filesystem.workspaceOnly, (checked) =>
        update((draft) => {
          draft.filesystem.workspaceOnly = checked;
        }),
      ),
      toggle('Allow writes', policy.filesystem.writable, (checked) =>
        update((draft) => {
          draft.filesystem.writable = checked;
        }),
      ),
      ...(policy.filesystem.workspaceOnly
        ? []
        : [
            h('p', { class: 'sub', text: 'Allowed roots (one per line)' }),
            textArea(policy.filesystem.allowedRoots.join('\n'), (value) =>
              update((draft) => {
                draft.filesystem.allowedRoots = value
                  .split(/\r?\n/)
                  .map((s) => s.trim())
                  .filter(Boolean);
              }),
            ),
          ]),
    ),
  );

  if (config) {
    host.append(
      h(
        'div',
        { class: 'card' },
        h('h4', { text: 'Runtime' }),
        h('p', {
          class: 'sub',
          text: `Driver: ${config.desktop.driver} · workspace: ${config.agent.workingDir}`,
        }),
        toggle('Allow synthetic input', config.desktop.allowInput, (checked) => {
          if (!cb.saveConfig) return;
          void cb.saveConfig({ ...config, desktop: { ...config.desktop, allowInput: checked } });
        }),
        toggle('Subagents enabled', config.subagents.enabled, (checked) => {
          if (!cb.saveConfig) return;
          void cb.saveConfig({ ...config, subagents: { ...config.subagents, enabled: checked } });
        }),
        h('p', { class: 'sub', text: 'Auto-approved tools (comma separated)' }),
        textArea(config.agent.autoApproveTools.join(', '), (value) => {
          if (!cb.saveConfig) return;
          void cb.saveConfig({
            ...config,
            agent: {
              ...config.agent,
              autoApproveTools: value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            },
          });
        }),
      ),
    );
  }
}

function renderAppRule(rule: AppRule, update: (mutate: (draft: PolicyDocument) => void) => void): HTMLElement {
  const chips = DESKTOP_ACTIONS.map((action) => {
    const on = rule.actions.includes(action);
    return h(
      'label',
      { class: `chip${on ? ' on' : ''}` },
      h('input', {
        type: 'checkbox',
        checked: on,
        on: {
          change: (event: Event) => {
            const checked = (event.target as HTMLInputElement).checked;
            update((draft) => {
              const target = draft.allowedApps.find((a) => a.id === rule.id);
              if (!target) return;
              target.actions = checked
                ? [...new Set([...target.actions, action as DesktopAction])]
                : target.actions.filter((a) => a !== action);
            });
          },
        },
      }),
      document.createTextNode(action),
    );
  });

  return h(
    'div',
    { class: 'app-rule' },
    h(
      'div',
      { class: 'head' },
      h('div', null, h('div', { class: 'name', text: rule.name }), h('div', { class: 'exe', text: rule.exe.join(', ') })),
      h('button', {
        class: 'btn ghost small',
        text: '✕',
        title: 'Remove app',
        on: {
          click: () =>
            update((draft) => {
              draft.allowedApps = draft.allowedApps.filter((a) => a.id !== rule.id);
            }),
        },
      }),
    ),
    h('div', { class: 'actions-grid' }, ...chips),
    h(
      'label',
      { class: 'chip' + (rule.autoApprove ? ' on' : '') },
      h('input', {
        type: 'checkbox',
        checked: rule.autoApprove === true,
        on: {
          change: (event: Event) => {
            const checked = (event.target as HTMLInputElement).checked;
            update((draft) => {
              const target = draft.allowedApps.find((a) => a.id === rule.id);
              if (target) target.autoApprove = checked;
            });
          },
        },
      }),
      document.createTextNode('auto-approve (skip prompt)'),
    ),
  );
}

function renderAddApp(update: (mutate: (draft: PolicyDocument) => void) => void): HTMLElement {
  const id = h('input', { type: 'text', placeholder: 'id (e.g. excel)' });
  const name = h('input', { type: 'text', placeholder: 'name (e.g. Excel)' });
  const exe = h('input', { type: 'text', placeholder: 'exe(s): excel.exe, EXCEL.EXE' });
  Object.assign(id.style, inputStyle);
  Object.assign(name.style, inputStyle);
  Object.assign(exe.style, inputStyle);

  return h(
    'div',
    { class: 'app-rule' },
    h('div', { class: 'head' }, h('div', { class: 'name', text: 'Add application' })),
    id,
    name,
    exe,
    h(
      'div',
      { class: 'actions-grid', style: 'margin-top:8px' },
      h('button', {
        class: 'btn small',
        text: 'Add with focus + read',
        on: {
          click: () => {
            const appId = id.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
            const exes = exe.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            if (!appId || !exes.length) return;
            update((draft) => {
              draft.allowedApps.push({
                id: appId,
                name: name.value.trim() || appId,
                exe: exes,
                actions: ['launch', 'focus', 'read', 'screenshot'],
              });
            });
            id.value = '';
            name.value = '';
            exe.value = '';
          },
        },
      }),
    ),
  );
}

/* ------------------------------------------------------------- mcp & skills */

/**
 * External integrations: which MCP servers the service managed to connect, which tools
 * they contribute and which skills exist on disk. Server definitions are editable here,
 * but an edit only *proposes* a change: it goes back through `config.set`, where the
 * service normalizes it, reconnects and reports what actually came up. The panel renders
 * that report, so it cannot advertise a server or a tool the agent loop does not have.
 */
function renderPluginsCard(plugins: PluginInfo[] | undefined, cb: PanelCallbacks): HTMLElement {
  const card = h(
    'div',
    { class: 'card', style: 'margin-top:18px' },
    h('h4', { text: 'Plugins' }),
    h('p', {
      class: 'sub',
      text: 'Plugins add tools to the agent. The bundled starters cover PDF viewing, PDF generation and Excel export; drop your own into ~/.beecode/plugins, then reload.',
    }),
  );
  if (!plugins) {
    card.append(h('div', { class: 'empty', text: 'Loading plugins…' }));
    return card;
  }
  if (!plugins.length) {
    card.append(
      h('div', {
        class: 'empty',
        text: 'No plugins loaded — plugins.enabled is off, or the plugin failed to activate.',
      }),
    );
    return card;
  }

  for (const plugin of plugins) {
    const button = h('button', { class: 'btn', text: plugin.enabled ? 'Disable' : 'Enable' });
    button.addEventListener('click', () => {
      if (!cb.togglePlugin) return;
      button.disabled = true;
      void cb.togglePlugin(plugin.id, !plugin.enabled).catch(() => {
        button.disabled = false;
      });
    });

    const body = h('div', { class: 'grow' });
    const title = h('strong', {}, plugin.name, ' ', h('span', { class: 'badge', text: plugin.source }));
    if (!plugin.enabled) title.append(' ', h('span', { class: 'badge', text: 'disabled' }));
    if (plugin.error) title.append(' ', h('span', { class: 'badge', text: 'error' }));
    body.append(title);
    body.append(h('div', { class: 'sub', text: plugin.description || 'No description.' }));
    body.append(
      h('div', {
        class: 'sub',
        text: `v${plugin.version} · ${plugin.permissions.length ? plugin.permissions.join(', ') : 'no permissions'}`,
      }),
    );
    body.append(
      h('div', {
        class: 'sub',
        text: plugin.tools.length ? `tools: ${plugin.tools.map((tool) => tool.name).join(', ')}` : 'no tools',
      }),
    );
    if (plugin.error) body.append(h('div', { class: 'sub', text: plugin.error }));
    card.append(h('div', { class: 'row', style: 'align-items:flex-start;gap:12px' }, body, button));
  }

  return card;
}

export function renderIntegrations(
  host: HTMLElement,
  servers: McpServerStatus[] | undefined,
  skills: SkillInfo[] | undefined,
  plugins: PluginInfo[] | undefined,
  config: BeeCodeConfig | undefined,
  cb: PanelCallbacks,
): void {
  clear(host);
  if (!servers || !skills) {
    host.append(h('div', { class: 'empty', text: 'Loading integrations…' }));
    return;
  }

  const configured = config?.mcpServers ?? {};
  const editable = Boolean(config && cb.saveConfig);
  const statusFor = (name: string) => servers.find((entry) => entry.name === name);

  /** Apply one change to a copy of the server map; the service owns it from there. */
  const saveServers = (mutate: (draft: Record<string, McpServerConfig>) => void): void => {
    if (!config || !cb.saveConfig) return;
    const draft = JSON.parse(JSON.stringify(configured)) as Record<string, McpServerConfig>;
    mutate(draft);
    void cb.saveConfig({ ...config, mcpServers: draft });
  };

  const textInput = (value: string, placeholder: string): HTMLInputElement => {
    const input = h('input', { type: 'text', placeholder });
    Object.assign(input.style, inputStyle);
    input.value = value;
    return input;
  };

  const transportSelect = (value: McpServerConfig['transport']): HTMLSelectElement => {
    const select = h(
      'select',
      null,
      h('option', { value: 'stdio', text: 'stdio — spawn a command' }),
      h('option', { value: 'http', text: 'http — streamable HTTP' }),
    );
    Object.assign(select.style, inputStyle);
    select.value = value;
    return select;
  };

  const asTransport = (select: HTMLSelectElement): McpServerConfig['transport'] =>
    select.value === 'http' ? 'http' : 'stdio';

  /** Server names double as tool-name segments, so keep them to the safe alphabet. */
  const asName = (value: string): string => value.trim().replace(/[^A-Za-z0-9._-]+/g, '-');

  function renderServerCard(
    name: string,
    server: McpServerConfig,
    status: McpServerStatus | undefined,
  ): HTMLElement {
    const nameInput = textInput(name, 'server name');
    const transport = transportSelect(server.transport);
    const commandInput = textInput(server.command ?? '', 'command (e.g. npx)');
    const argsInput = textInput((server.args ?? []).join(' '), 'arguments, space separated');
    const urlInput = textInput(server.url ?? '', 'https://host/mcp');
    const envArea = h('textarea', { rows: 3 });
    Object.assign(envArea.style, inputStyle);
    envArea.placeholder = 'KEY=VALUE per line';
    envArea.value = formatEnv(server.env);

    const save = (): void => {
      const nextName = asName(nameInput.value);
      if (!nextName) return;
      const cfg: McpServerConfig = {
        ...server,
        transport: asTransport(transport),
        args: argsInput.value.split(/\s+/).filter(Boolean),
      };
      const command = commandInput.value.trim();
      if (command) cfg.command = command;
      else delete cfg.command;
      const url = urlInput.value.trim();
      if (url) cfg.url = url;
      else delete cfg.url;
      const env = parseEnvLines(envArea.value);
      if (env) cfg.env = env;
      else delete cfg.env;
      saveServers((draft) => {
        delete draft[name];
        draft[nextName] = cfg;
      });
    };

    return h(
      'div',
      { class: 'card' },
      h(
        'h4',
        {},
        name,
        ' ',
        h('span', { class: 'badge', text: status?.state ?? (server.enabled ? 'starting' : 'disabled') }),
        ' ',
        h('span', { class: 'badge', text: server.enabled ? 'enabled' : 'disabled' }),
      ),
      status
        ? h('p', {
            class: 'sub',
            text: [
              status.transport,
              status.serverName ? `${status.serverName} ${status.version ?? ''}`.trim() : '',
              `${status.tools.length} tool${status.tools.length === 1 ? '' : 's'}`,
            ]
              .filter(Boolean)
              .join(' · '),
          })
        : null,
      status?.error ? h('p', { class: 'sub', text: `error: ${status.error}` }) : null,
      ...(status?.tools ?? []).map((tool) =>
        h('p', {
          class: 'sub',
          text: `${tool.tool} — ${tool.description}${tool.mutating ? ' (needs approval)' : ' (read-only)'}`,
        }),
      ),
      editable ? h('p', { class: 'sub', text: 'Definition' }) : null,
      ...(editable ? [nameInput, transport, commandInput, argsInput, urlInput, envArea] : []),
      editable
        ? h(
            'div',
            { class: 'actions', style: 'margin-top:8px' },
            h('button', { class: 'btn small', text: 'Save', on: { click: save } }),
            h('button', {
              class: 'btn small',
              text: server.enabled ? 'Disable' : 'Enable',
              on: {
                click: () =>
                  saveServers((draft) => {
                    const entry = draft[name];
                    if (entry) entry.enabled = !entry.enabled;
                  }),
              },
            }),
            h('button', {
              class: 'btn small danger',
              text: 'Remove',
              on: {
                click: () =>
                  saveServers((draft) => {
                    delete draft[name];
                  }),
              },
            }),
          )
        : null,
    );
  }

  /** A status with no config entry is left over from an earlier config — show, don't hide. */
  function renderOrphan(status: McpServerStatus): HTMLElement {
    return h(
      'div',
      { class: 'card' },
      h('h4', {}, status.name, ' ', h('span', { class: 'badge', text: status.state })),
      h('p', {
        class: 'sub',
        text: `${status.transport} · ${status.tools.length} tools · not in config.json`,
      }),
    );
  }

  function renderAddServer(): HTMLElement {
    const nameInput = textInput('', 'server name (e.g. files)');
    const transport = transportSelect('stdio');
    const commandInput = textInput('', 'command (e.g. npx)');
    const urlInput = textInput('', 'https://host/mcp');
    return h(
      'div',
      { class: 'card' },
      h('h4', { text: 'Add a server' }),
      h('p', {
        class: 'sub',
        text: 'Added disabled: review the definition, then enable it to let the service spawn it.',
      }),
      nameInput,
      transport,
      commandInput,
      urlInput,
      h(
        'div',
        { class: 'actions', style: 'margin-top:8px' },
        h('button', {
          class: 'btn small',
          text: 'Add disabled',
          on: {
            click: () => {
              const key = asName(nameInput.value);
              if (!key) return;
              // 30s mirrors the normalizer default in shared/defaults.ts.
              const cfg: McpServerConfig = {
                enabled: false,
                transport: asTransport(transport),
                timeoutMs: 30_000,
                args: [],
              };
              const command = commandInput.value.trim();
              if (command) cfg.command = command;
              const url = urlInput.value.trim();
              if (url) cfg.url = url;
              saveServers((draft) => {
                draft[key] = cfg;
              });
            },
          },
        }),
      ),
    );
  }

  host.append(
    h(
      'div',
      { class: 'card' },
      h('h4', { text: 'MCP servers' }),
      h('p', {
        class: 'sub',
        text: 'Stored under "mcpServers" in config.json and editable below. Their tools reach the agent as mcp__<server>__<tool>; anything without readOnlyHint needs approval, and a server only starts once it is enabled.',
      }),
      h(
        'div',
        { class: 'actions' },
        h('button', {
          class: 'btn small',
          text: 'Reconnect',
          on: { click: () => void cb.reloadIntegrations?.() },
        }),
      ),
    ),
  );

  for (const [name, server] of Object.entries(configured)) {
    host.append(renderServerCard(name, server, statusFor(name)));
  }
  if (!Object.keys(configured).length) {
    host.append(h('div', { class: 'empty', text: 'No MCP servers configured.' }));
  }
  for (const status of servers.filter((entry) => !(entry.name in configured))) {
    host.append(renderOrphan(status));
  }
  if (editable) host.append(renderAddServer());

  host.append(renderPluginsCard(plugins, cb));

  host.append(
    h(
      'div',
      { class: 'card', style: 'margin-top:18px' },
      h('h4', { text: 'Skills' }),
      h('p', {
        class: 'sub',
        text: 'SKILL.md playbooks from ~/.beecode/skills, the workspace and any configured skills.dirs. Only names and descriptions sit in the prompt; the body loads when a task matches.',
      }),
    ),
  );
  if (!skills.length) {
    host.append(h('div', { class: 'empty', text: 'No skills found.' }));
  }
  for (const skill of skills) {
    host.append(
      h(
        'div',
        { class: 'card' },
        h('h4', {}, skill.name, ' ', h('span', { class: 'badge', text: skill.source })),
        h('p', { class: 'sub', text: skill.description }),
      ),
    );
  }
}

/* ----------------------------------------------------------------- subagents */

export function renderSubagents(
  host: HTMLElement,
  runs: SubagentRunInfo[],
  agents: AgentInfo[],
  cb: PanelCallbacks,
): void {
  clear(host);

  host.append(
    h(
      'div',
      { class: 'card' },
      h('h4', { text: 'Available agents' }),
      h('p', { class: 'sub', text: 'The agent can delegate to these. External CLIs must be on PATH.' }),
      ...agents.map((agent) =>
        h(
          'div',
          { class: 'audit-row' },
          h('span', { class: `badge ${agent.available ? 'allowed' : 'denied'}`, text: agent.kind }),
          h(
            'span',
            null,
            h('strong', { text: agent.label }),
            h('div', { class: 'sub', text: agent.detail ?? (agent.available ? 'ready' : 'unavailable') }),
          ),
        ),
      ),
    ),
  );

  const card = h('div', { class: 'card' }, h('h4', { text: `Runs (${runs.length})` }));
  if (!runs.length) {
    card.append(h('div', { class: 'empty', text: 'No subagent runs yet. Ask beeCode to delegate something.' }));
  }
  for (const run of [...runs].reverse()) {
    card.append(
      h(
        'div',
        { class: 'sub-run app-rule' },
        h(
          'div',
          { class: 'head' },
          h('div', null, h('div', { class: 'name', text: run.agent }), h('div', { class: 'exe', text: run.task })),
          h('span', { class: `badge ${run.status}`, text: run.status }),
        ),
        run.output ? h('pre', { text: run.output.slice(-2000) }) : null,
        run.error ? h('div', { class: 'sub', text: run.error }) : null,
        ['queued', 'running'].includes(run.status)
          ? h('button', {
              class: 'btn danger small',
              text: 'Cancel',
              on: { click: () => void cb.cancelSubagent(run.id) },
            })
          : null,
      ),
    );
  }
  host.append(card);
}

/* ------------------------------------------------------------------ activity */

export function renderActivity(host: HTMLElement, audit: AuditEntry[], cb: PanelCallbacks): void {
  clear(host);
  const card = h(
    'div',
    { class: 'card' },
    h('h4', { text: 'Desktop activity' }),
    h('p', { class: 'sub', text: 'Every gated action, newest first — also appended to ~/.beecode/audit.jsonl.' }),
    h('button', { class: 'btn small', text: 'Refresh', on: { click: () => void cb.refreshAudit() } }),
  );
  if (!audit.length) card.append(h('div', { class: 'empty', text: 'Nothing yet.' }));
  for (const entry of audit) {
    card.append(
      h(
        'div',
        { class: 'audit-row' },
        h('span', { class: 'time', text: new Date(entry.at).toLocaleTimeString() }),
        h(
          'span',
          { class: 'what' },
          h('span', { class: `badge ${entry.outcome}`, text: entry.action }),
          h('span', { text: entry.app ?? entry.target ?? entry.tool ?? '' }),
          entry.detail ? h('div', { class: 'sub', text: entry.detail }) : null,
        ),
      ),
    );
  }
  host.append(card);
}

/* ------------------------------------------------------------------- widgets */

const inputStyle = {
  width: '100%',
  marginTop: '6px',
  padding: '6px 8px',
  background: '#0a0d12',
  color: '#e7ecf3',
  border: '1px solid #222a36',
  borderRadius: '7px',
  fontFamily: 'inherit',
  fontSize: '12px',
} as const;

/** Env map → `KEY=VALUE` lines for the editor textarea. */
function formatEnv(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/** `KEY=VALUE` lines → env map. Blank lines and `#` comments are ignored. */
function parseEnvLines(text: string): Record<string, string> | undefined {
  const entries: Array<[string, string]> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at > 0) entries.push([trimmed.slice(0, at).trim(), trimmed.slice(at + 1).trim()]);
  }
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function textArea(value: string, onChange: (value: string) => void): HTMLElement {
  const area = h('textarea', { rows: Math.min(6, Math.max(2, value.split('\n').length)) });
  Object.assign(area.style, inputStyle, { resize: 'vertical', fontFamily: 'ui-monospace, monospace' });
  area.value = value;
  area.addEventListener('change', () => onChange(area.value));
  return area;
}

function toggle(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
  return h(
    'label',
    { class: `chip${checked ? ' on' : ''}`, style: 'margin-bottom:8px' },
    h('input', {
      type: 'checkbox',
      checked,
      on: {
        change: (event: Event) => onChange((event.target as HTMLInputElement).checked),
      },
    }),
    document.createTextNode(label),
  );
}

/* ---------------------------------------------------------- agent catalogue */

/**
 * External coding agents. The presets are always listed (a CLI found on PATH is offered
 * even when it is not enabled yet); enabling one persists a `subagents.cliAgents` entry
 * through `agents.save`, which probes again and returns the refreshed catalogue.
 */
function renderAgentsCard(
  agents: AgentInfo[],
  cb: PanelCallbacks,
  setNote: (text: string) => void,
): HTMLElement {
  const catalogue = agents.filter((agent) => agent.kind === 'cli');
  const configured = (agent: AgentInfo): CliAgentEntry => ({
    id: agent.id,
    label: agent.label,
    command: agent.command ?? agent.id,
    args: agent.args ?? [],
    enabled: true,
    ...(agent.custom ? { custom: true } : {}),
  });

  const save = async (next: CliAgentEntry[]): Promise<void> => {
    setNote('saving agents…');
    try {
      await cb.saveAgents?.(next);
      setNote('agents saved ✓');
    } catch (error) {
      setNote(`agents failed: ${(error as Error).message}`);
    }
  };

  const toggled = (agent: AgentInfo, enabled: boolean): CliAgentEntry[] => {
    const others = catalogue
      .filter((other) => other.id !== agent.id && other.enabled)
      .map((other) => configured(other));
    return enabled ? [...others, configured(agent)] : others;
  };

  const rows = catalogue.map((agent) =>
    h(
      'div',
      { class: 'agent-row' },
      h('label', { class: 'agent-name' },
        h('input', {
          type: 'checkbox',
          checked: agent.enabled === true,
          on: { change: (event: Event) => void save(toggled(agent, (event.target as HTMLInputElement).checked)) },
        }),
        h('span', { text: agent.label }),
        agent.custom ? h('span', { class: 'badge', text: 'custom' }) : null,
      ),
      h('span', { class: 'agent-detail' },
        h('span', { class: `badge ${agent.onPath ? 'allowed' : 'denied'}`, text: agent.onPath ? 'on PATH' : 'not found' }),
        h('span', { class: 'mono sub', text: agent.command ?? agent.id }),
        agent.version ? h('span', { class: 'sub', text: agent.version }) : null,
      ),
    ),
  );

  const customInput = h('input', {
    class: 'settings-input',
    type: 'text',
    placeholder: 'C:\\tools\\my-agent.cmd',
  });
  const addCustom = (): void => {
    const command = customInput.value.trim();
    if (!command) return;
    const others = catalogue.filter((agent) => agent.enabled).map((agent) => configured(agent));
    const label = command.split(/[\\/]/).pop() || command;
    void save([...others, { id: label, label, command, args: [], enabled: true, custom: true }]);
  };

  return h(
    'div',
    { class: 'card' },
    h('h4', { text: 'External agents (CLI)' }),
    h('p', {
      class: 'sub',
      text: 'beeCode probes these commands on PATH and reads their version. An enabled agent can be delegated to by subagent_delegate; a missing binary is simply unavailable.',
    }),
    h('div', { class: 'settings-row' },
      h('button', {
        class: 'btn small',
        type: 'button',
        text: 'Detect agents',
        on: {
          click: async () => {
            setNote('probing PATH…');
            try {
              await cb.detectAgents?.();
              setNote('detection finished');
            } catch (error) {
              setNote(`detection failed: ${(error as Error).message}`);
            }
          },
        },
      }),
    ),
    ...rows,
    h('div', { class: 'settings-row' },
      customInput,
      h('button', { class: 'btn small', type: 'button', text: 'Add command', on: { click: addCustom } }),
    ),
  );
}

/* ---------------------------------------------------------------- settings */

const PROVIDER_IDS: ProviderId[] = ['openai', 'anthropic', 'azure-openai', 'ollama', 'openai-compatible'];

function settingsInput(
  value: string,
  onChange: (next: string) => void,
  placeholder = '',
): HTMLInputElement {
  const input = h('input', { class: 'settings-input', type: 'text', placeholder });
  input.value = value;
  input.addEventListener('change', () => onChange(input.value.trim()));
  return input;
}

function settingsField(label: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'settings-field' }, h('span', { text: label }), control);
}

function uniqueModelId(models: ModelPreset[], seed: string): string {
  const taken = new Set(models.map((model) => model.id));
  if (!taken.has(seed)) return seed;
  let index = 2;
  while (taken.has(`${seed}-${index}`)) index += 1;
  return `${seed}-${index}`;
}

/**
 * Settings panel — the LLM endpoint and the working directory.
 *
 * Edits are staged in a draft and committed with one Save, so a half-typed base URL
 * never reaches the agent service. No key material is collected here: a preset can
 * only NAME the environment variable holding the key, because config.json is world
 * readable user state and must stay shareable.
 */
export function renderSettings(
  host: HTMLElement,
  config: BeeCodeConfig,
  cb: PanelCallbacks,
  agents: AgentInfo[] = [],
): void {
  const draft: BeeCodeConfig = {
    ...config,
    agent: { ...config.agent },
    workspace: { ...config.workspace, root: config.workspace?.root ?? '', recent: [...(config.workspace?.recent ?? [])] },
    features: { ...config.features, goalTodo: config.features?.goalTodo ?? true },
    subagents: { ...config.subagents, cliAgents: (config.subagents.cliAgents ?? []).map((agent) => ({ ...agent })) },
    models: config.models.map((model) => ({ ...model })),
  };
  let note: HTMLElement = h('span', { class: 'settings-note' });

  const setNote = (text: string): void => {
    if (!note.isConnected) {
      const live = host.querySelector<HTMLElement>('.settings-note');
      if (live) note = live;
    }
    note.textContent = text;
  };

  const save = async (): Promise<void> => {
    if (!cb.saveConfig) return;
    setNote('saving…');
    try {
      await cb.saveConfig({
        ...draft,
        // A key travels only when the user typed one; a blank field keeps the stored key.
        models: draft.models.map((preset) => {
          const typed = keys[preset.id];
          return typed ? { ...preset, apiKey: typed } : { ...preset };
        }),
      });
      for (const id of Object.keys(keys)) delete keys[id];
      paint();
      setNote('saved ✓');
    } catch (error) {
      setNote(`save failed: ${(error as Error).message}`);
    }
  };

  /** Keys typed but not yet saved, by preset id. Write-only: never rendered back. */
  const keys: Record<string, string> = {};

  const paint = (): void => {
    clear(host);
    note = h('span', { class: 'settings-note' });

    /* ----- header ----- */
    host.append(
      h(
        'div',
        { class: 'card settings-head' },
        h('h4', { text: 'Settings' }),
        h('p', {
          class: 'sub',
          text: 'Endpoint, model and working directory. Applied immediately. API keys are stored in secrets.json — never in config.json.',
        }),
        h(
          'div',
          { class: 'settings-actions' },
          h('button', { class: 'btn primary small', type: 'button', text: 'Save', on: { click: () => void save() } }),
          note,
        ),
      ),
    );

    /* ----- model presets ----- */
    draft.models.forEach((preset, index) => {
      const radio = h('input', { type: 'radio', class: 'settings-radio-input' });
      radio.name = 'beecode-default-model';
      radio.checked = draft.defaultModelId === preset.id;
      radio.addEventListener('change', () => {
        draft.defaultModelId = preset.id;
        paint();
      });

      const provider = h('select', { class: 'settings-input' });
      for (const id of PROVIDER_IDS) {
        const option = h('option', { text: id });
        option.value = id;
        option.selected = id === preset.provider;
        provider.append(option);
      }
      provider.addEventListener('change', () => {
        preset.provider = provider.value as ProviderId;
        setNote('unsaved changes');
      });

      const contextWindow = h('input', { class: 'settings-input', type: 'number', min: '0' });
      contextWindow.value = preset.contextWindow ? String(preset.contextWindow) : '';
      contextWindow.addEventListener('change', () => {
        const parsed = Number(contextWindow.value);
        preset.contextWindow = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
        setNote('unsaved changes');
      });

      host.append(
        h(
          'div',
          { class: 'card' },
          h(
            'div',
            { class: 'settings-row' },
            h('label', { class: 'settings-default' }, radio, h('span', { text: 'default' })),
            settingsInput(preset.label, (next) => {
              preset.label = next;
              setNote('unsaved changes');
            }, 'Label'),
            h('span', { class: 'sub mono', text: preset.id }),
            h('button', {
              class: 'btn small danger',
              type: 'button',
              text: 'Remove',
              on: {
                click: () => {
                  if (draft.models.length <= 1) {
                    setNote('at least one model preset is required');
                    return;
                  }
                  draft.models.splice(index, 1);
                  if (draft.defaultModelId === preset.id) draft.defaultModelId = draft.models[0].id;
                  paint();
                },
              },
            }),
          ),
          h(
            'div',
            { class: 'settings-grid' },
            settingsField('Provider', provider),
            settingsField(
              'Model',
              settingsInput(preset.model, (next) => {
                preset.model = next;
                setNote('unsaved changes');
              }, 'e.g. deepseek-v4-flash'),
            ),
            settingsField(
              'Base URL',
              settingsInput(preset.baseUrl ?? '', (next) => {
                preset.baseUrl = next || undefined;
                setNote('unsaved changes');
              }, 'https://api.example.com/v1'),
            ),
            settingsField(
              'API key env var',
              settingsInput(preset.apiKeyEnv ?? '', (next) => {
                preset.apiKeyEnv = next || undefined;
                setNote('unsaved changes');
              }, 'BEECODE_LLM_API_KEY'),
            ),
            settingsField(
              'API key',
              h('input', {
                class: 'settings-input',
                type: 'password',
                autocomplete: 'off',
                placeholder: preset.hasKey ? 'stored — leave blank to keep' : 'paste the key to store it',
                on: {
                  input: (event: Event) => {
                    keys[preset.id] = (event.target as HTMLInputElement).value;
                    setNote('unsaved changes');
                  },
                },
              }),
            ),
            settingsField('Context window', contextWindow),
          ),
          h('p', {
            class: 'sub',
            text: preset.baseUrl
              ? `Endpoint: ${preset.baseUrl}`
              : 'Endpoint: provider default. Set a Base URL for a custom or self-hosted gateway.',
          }),
          h('p', {
            class: 'sub',
            text: preset.hasKey
              ? 'Key: stored — leave the field blank to keep it.'
              : 'Key: not set — paste it above, or set the env var / add API_KEY to .env.llm',
          }),
        ),
      );
    });

    host.append(
      h(
        'div',
        { class: 'card' },
        h('button', {
          class: 'btn small',
          type: 'button',
          text: '+ Add model',
          on: {
            click: () => {
              draft.models.push({
                id: uniqueModelId(draft.models, 'custom'),
                label: 'Custom model',
                provider: 'openai-compatible',
                model: '',
                baseUrl: '',
                apiKeyEnv: 'BEECODE_LLM_API_KEY',
              });
              paint();
            },
          },
        }),
        h('p', {
          class: 'sub',
          text: 'The key itself is read from the named environment variable at request time — it is never written to config.json.',
        }),
      ),
    );

    /* ----- workspace ----- */
    const workspace = draft.workspace;
    const pickWorkspace = async (): Promise<void> => {
      const picked = await cb.pickDirectory?.({
        title: 'Choose a workspace folder',
        defaultPath: workspace.root || workspace.recent[0],
      });
      if (!picked) return;
      setNote('applying the workspace…');
      try {
        await cb.setWorkspace?.(picked);
        setNote('workspace saved ✓');
      } catch (error) {
        setNote(`workspace failed: ${(error as Error).message}`);
      }
    };

    host.append(
      h(
        'div',
        { class: 'card' },
        h('h4', { text: 'Workspace' }),
        h('p', {
          class: 'sub',
          text: 'The folder the agent reads, writes and runs commands in. beeCode never falls back to its installation directory: with no workspace the file and shell tools are refused. Existing sessions keep the folder they were created with.',
        }),
        h(
          'div',
          { class: 'settings-row' },
          h('span', {
            class: 'settings-path',
            text: workspace.root || 'no workspace folder selected',
            title: workspace.root,
          }),
          h('button', {
            class: 'btn small',
            type: 'button',
            text: workspace.root ? 'Change…' : 'Choose…',
            on: { click: () => void pickWorkspace() },
          }),
          workspace.root
            ? h('button', {
                class: 'btn small danger',
                type: 'button',
                text: 'Forget',
                on: {
                  click: async () => {
                    await cb.forgetWorkspace?.(workspace.root);
                    setNote('workspace forgotten');
                  },
                },
              })
            : null,
        ),
        workspace.recent.length
          ? h(
              'div',
              { class: 'settings-recent' },
              h('span', { class: 'sub', text: 'Recent' }),
              ...workspace.recent.map((path) =>
                h('button', {
                  class: 'settings-recent-item',
                  type: 'button',
                  text: path,
                  title: `Use ${path}`,
                  on: {
                    click: async () => {
                      await cb.setWorkspace?.(path);
                      setNote('workspace saved ✓');
                    },
                  },
                }),
              ),
            )
          : null,
      ),
    );

    /* ----- feature switches ----- */
    host.append(
      h(
        'div',
        { class: 'card' },
        h('h4', { text: 'Goal & to-do' }),
        h('p', {
          class: 'sub',
          text: 'Adds the goal_write / todo_write tools and the plan panel above the composer. Turning it off removes the tools from the model schema, so the agent cannot plan into a panel that is hidden.',
        }),
        toggle('Show the goal and the plan', draft.features.goalTodo, (checked) => {
          draft.features.goalTodo = checked;
          setNote('unsaved changes — press Save');
        }),
      ),
    );

    /* ----- external CLI agents ----- */
    host.append(renderAgentsCard(agents, cb, setNote));
  };

  paint();
}
