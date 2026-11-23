import type {
  AgentInfo,
  AgentMode,
  AppRule,
  AuditEntry,
  BeeCodeConfig,
  CliAgentEntry,
  DesktopAction,
  DesktopConfig,
  McpServerConfig,
  McpServerStatus,
  ModelPreset,
  PluginInstallResult,
  PolicyDocument,
  ProviderId,
  Schedule,
  ScheduleInput,
  PluginInfo,
  SkillInfo,
  SkillInstallInput,
  SubagentRunInfo,
  ToolInfo,
} from '../shared/protocol';
import { DESKTOP_ACTIONS } from '../shared/protocol';
import { describeSchedule, formatMoment } from '../shared/schedule';
import type { DirectoryPickerOptions } from '../shared/bridge';
import { clear, h } from './dom';

export interface PanelCallbacks {
  savePolicy(next: PolicyDocument): Promise<void>;
  saveConfig?(next: BeeCodeConfig): Promise<void>;
  /** Probe the configured endpoint for the models it advertises (Settings model picker). */
  listModels?(input: {
    presetId?: string;
    provider?: string;
    baseUrl?: string;
    apiKeyEnv?: string;
    apiKey?: string;
  }): Promise<{ models: string[]; warning?: string }>;
  pickDirectory?(options?: DirectoryPickerOptions): Promise<string | undefined>;
  /** Create (no `id`) or update (with `id`) a schedule; `scheduler.changed` carries it back. */
  saveSchedule?(input: ScheduleInput): Promise<void>;
  removeSchedule?(id: string): Promise<void>;
  /** Fire a schedule immediately, returning the session it started. */
  runSchedule?(id: string): Promise<string>;
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
  /** Install a dropped skill (SKILL.md text or a base64 ZIP); returns the new folder names. */
  installSkill?(input: SkillInstallInput): Promise<string[]>;
  /** Install a plugin folder or .zip (`plugin.install`); returns the refreshed catalogue. */
  installPlugins?(paths: string[]): Promise<PluginInstallResult>;
  /** Delete one installed skill (`skill.remove`); returns the re-scanned list. */
  removeSkill?(name: string): Promise<SkillInfo[]>;
  /** Validate, persist and activate a workspace folder (`workspace.set`). */
  setWorkspace?(path: string): Promise<void>;
  /** Drop a folder from the recents, or clear the active root (`workspace.forget`). */
  forgetWorkspace?(path: string): Promise<void>;
}

/* -------------------------------------------------------------------- tools */

/** Order the catalogue is grouped in; a group no tool uses simply never renders. */
const TOOL_GROUP_ORDER: Array<ToolInfo['group']> = [
  'control',
  'files',
  'shell',
  'desktop',
  'browser',
  'agents',
  'skills',
  'scheduler',
  'mcp',
  'plugins',
];

const TOOL_GROUP_LABELS: Record<ToolInfo['group'], string> = {
  control: 'Session & planning',
  files: 'Files',
  shell: 'Shell',
  desktop: 'Desktop',
  browser: 'Browser',
  agents: 'Subagents',
  skills: 'Skills & memory',
  scheduler: 'Scheduled runs',
  mcp: 'MCP servers',
  plugins: 'Plugins',
};

/**
 * Settings → Tools: the per-tool switches. This is the only place a tool can be taken out
 * of the model's catalogue; `tools.list` keeps reporting switched-off tools so they can be
 * turned back on, and the service refuses an in-band call to one that is off.
 */
export function renderTools(
  host: HTMLElement,
  tools: ToolInfo[],
  config: BeeCodeConfig,
  onDisabledChange: (disabled: string[]) => Promise<void>,
): void {
  clear(host);
  const off = new Set(config.tools?.disabled ?? []);
  let query = '';

  const summary = h('p', { class: 'sub', text: '' });
  const note = h('p', { class: 'sub', text: '' });
  const list = h('div', {});
  const filter = h('input', { class: 'settings-input', type: 'search', placeholder: 'Filter tools…' });
  filter.addEventListener('input', () => {
    query = filter.value;
    render();
  });

  const save = async (): Promise<void> => {
    try {
      await onDisabledChange([...off].sort());
      note.textContent = '';
    } catch (err) {
      note.textContent = `Could not save the switches: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  const summaryText = (on: number): string =>
    `${on} of ${tools.length} tools are on. A switched-off tool is not offered to the model ` +
    'and refuses to run if it is called anyway; the next turn already sees the change.';

  const groupHeaders = new Map<string, HTMLElement>();

  /** Recount after a toggle without rebuilding the list, so the row keeps its focus. */
  const refreshCounts = (): void => {
    summary.textContent = summaryText(tools.filter((tool) => !off.has(tool.name)).length);
    for (const [group, header] of groupHeaders) {
      const inGroup = tools.filter((tool) => tool.group === group);
      const groupOn = inGroup.filter((tool) => !off.has(tool.name)).length;
      const label = TOOL_GROUP_LABELS[group as ToolInfo['group']];
      header.textContent = `${label} · ${groupOn}/${inGroup.length}`;
    }
  };

  const flip = (name: string, on: boolean): void => {
    if (on) off.delete(name);
    else off.add(name);
    refreshCounts();
    void save();
  };

  function render(): void {
    groupHeaders.clear();
    summary.textContent = summaryText(tools.filter((tool) => !off.has(tool.name)).length);
    clear(list);
    const needle = query.trim().toLowerCase();
    const visible = tools.filter(
      (tool) =>
        !needle ||
        tool.name.toLowerCase().includes(needle) ||
        tool.description.toLowerCase().includes(needle),
    );
    if (visible.length === 0) {
      list.append(
        h('p', {
          class: 'sub',
          text: tools.length ? 'No tool matches that filter.' : 'The service reported no tools.',
        }),
      );
      return;
    }
    for (const group of TOOL_GROUP_ORDER) {
      const inGroup = visible.filter((tool) => tool.group === group);
      if (inGroup.length === 0) continue;
      const groupOn = inGroup.filter((tool) => !off.has(tool.name)).length;
      const header = h('h4', {
        text: `${TOOL_GROUP_LABELS[group]} · ${groupOn}/${inGroup.length}`,
      });
      groupHeaders.set(group, header);
      const card = h('div', { class: 'card' }, header);
      for (const tool of inGroup) {
        const box = h('input', { type: 'checkbox' });
        box.checked = !off.has(tool.name);
        box.addEventListener('change', () => flip(tool.name, box.checked));
        card.append(
          h(
            'label',
            { class: 'tool-switch', title: tool.description },
            box,
            h('span', { class: 'tool-switch-name', text: tool.name }),
            tool.mutating ? h('span', { class: 'badge', text: 'mutating' }) : null,
            h('span', { class: 'sub', text: tool.description }),
          ),
        );
      }
      list.append(card);
    }
  }

  host.append(
    h(
      'div',
      { class: 'card' },
      h('h4', { text: 'Tools' }),
      summary,
      filter,
      note,
    ),
    list,
  );
  render();
}

/* -------------------------------------------------------------- permissions */

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
 * The delete control for one skill.
 *
 * Deleting a playbook is destructive, so the first press only arms the button and the
 * second one — within four seconds — removes it. Whether the folder may go at all is the
 * service's call; its refusal (a skill outside the scanned roots) lands in the card note
 * rather than a dialog nobody reads.
 */
function renderSkillRemove(
  skill: SkillInfo,
  cb: PanelCallbacks,
  note: HTMLElement,
): HTMLElement {
  let timer = 0;
  const button = h('button', {
    class: 'btn ghost small skill-remove',
    type: 'button',
    text: 'Delete',
    on: {
      click: async () => {
        if (!timer) {
          button.textContent = 'Confirm delete';
          timer = window.setTimeout(() => {
            timer = 0;
            button.textContent = 'Delete';
          }, 4000);
          return;
        }

        window.clearTimeout(timer);
        timer = 0;
        button.disabled = true;
        try {
          await cb.removeSkill?.(skill.name);
          note.textContent = `Removed ${skill.name} ✓`;
        } catch (error) {
          note.textContent = `Could not remove ${skill.name}: ${
            error instanceof Error ? error.message : String(error)
          }`;
          button.disabled = false;
          button.textContent = 'Delete';
        }
      },
    },
  }) as HTMLButtonElement;
  return button;
}

/**
 * The install controls for plugins: one drop target, two native pickers.
 *
 * A dropped folder or `.zip` goes to the service, which validates the manifest, copies it
 * into the plugin root, switches external plugins on and reloads — so installing is one
 * gesture instead of writing files by hand, editing config and pressing reload.
 */
function renderPluginInstallZone(cb: PanelCallbacks, note: HTMLElement): HTMLElement {
  const install = async (paths: string[]): Promise<void> => {
    if (!cb.installPlugins) return;
    if (!paths.length) {
      note.textContent = 'Nothing to install — a plugin folder or a .zip is needed.';
      return;
    }

    note.textContent = 'Installing…';
    try {
      const result = await cb.installPlugins(paths);
      const installed = result.installed.length ? [`Installed ${result.installed.join(', ')} ✓`] : [];
      const refused = result.skipped.map((skip) => {
        const name = skip.path.split(/[\\/]/).pop() ?? skip.path;
        return `${name}: ${skip.reason}`;
      });
      note.textContent = [...installed, ...refused].join(' · ') || 'Nothing was installed.';
    } catch (error) {
      note.textContent = `Install failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  const zone = h(
    'div',
    { class: 'skill-drop-zone plugin-drop' },
    h('div', {
      class: 'skill-drop-hint',
      text: 'Drop a plugin folder or a plugin .zip here to install it',
    }),
    h('button', {
      class: 'btn ghost small',
      type: 'button',
      text: 'Choose folder…',
      on: {
        click: async () => {
          const picked = await window.beeCode.pickDirectory({ title: 'Choose a plugin folder' });
          if (picked) await install([picked]);
        },
      },
    }),
    h('button', {
      class: 'btn ghost small',
      type: 'button',
      text: 'Choose .zip…',
      on: {
        click: async () => {
          const picked = await window.beeCode.pickFiles({
            title: 'Choose a plugin .zip',
            extensions: ['zip'],
            multiple: false,
          });
          if (picked.length) await install(picked);
        },
      },
    }),
  );

  zone.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    // Claim the drop: the window-level handler would otherwise copy it into the workspace.
    event.preventDefault();
    event.stopPropagation();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (event) => {
    const files = event.dataTransfer?.files;
    if (!files?.length) return;
    event.preventDefault();
    event.stopPropagation();
    zone.classList.remove('over');
    void install(window.beeCode.pathsForFiles([...files]));
  });

  return zone;
}

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
      text: 'Plugins add tools to the agent. The bundled starters cover PDF viewing, PDF generation and Excel export; install your own by dropping a plugin folder or .zip below.',
    }),
  );
  const installNote = h('p', { class: 'sub plugin-drop-note' });
  card.append(renderPluginInstallZone(cb, installNote), installNote);
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

  host.append(renderSkillsCard(skills, cb));
}

/**
 * The skills card: what is installed plus the drop target that installs more.
 *
 * A dropped `SKILL.md` is written to `~/.beecode/skills/<name>/SKILL.md`; a dropped ZIP
 * installs every folder in it that carries a `SKILL.md`, scripts and references included.
 * The service owns the writing and answers with the re-scanned list, so the card never has
 * to guess which roots were read.
 */
function renderSkillsCard(skills: SkillInfo[], cb: PanelCallbacks): HTMLElement {
  const card = h('div', { class: 'card skill-drop', style: 'margin-top:18px' });
  const note = h('p', { class: 'sub skill-drop-note' });
  const picker = h('input', { class: 'skill-drop-file', type: 'file' }) as HTMLInputElement;
  picker.multiple = true;
  picker.accept = '.md,.markdown,.zip';

  const install = async (files: FileList | File[]): Promise<void> => {
    const list = Array.from(files);
    if (!list.length) return;
    const installed: string[] = [];
    for (const file of list) {
      try {
        const input: SkillInstallInput = /\.zip$/i.test(file.name)
          ? { fileName: file.name, base64: await base64Of(file) }
          : { fileName: file.name, text: await file.text() };
        installed.push(...((await cb.installSkill?.(input)) ?? []));
      } catch (error) {
        note.textContent = `Could not install ${file.name}: ${(error as Error).message}`;
        return;
      }
    }
    note.textContent = installed.length
      ? `Installed ${installed.join(', ')} ✓`
      : 'Nothing installable in that drop.';
  };

  const urlInput = h('input', { class: 'skill-url-input settings-input', type: 'text', placeholder: 'https://…/SKILL.md or …/skill.zip' }) as HTMLInputElement;
  const urlButton = h('button', { class: 'btn ghost small', type: 'button', text: 'Install from URL' }) as HTMLButtonElement;
  const installFromUrl = async (): Promise<void> => {
    const url = urlInput.value.trim();
    if (!url) {
      note.textContent = 'Paste an https:// URL of a SKILL.md or a skill .zip first.';
      return;
    }
    urlButton.disabled = true;
    note.textContent = `Downloading ${url}…`;
    try {
      const installed = (await cb.installSkill?.({ url })) ?? [];
      note.textContent = installed.length
        ? `Installed ${installed.join(', ')} ✓`
        : 'Nothing installable at that URL.';
      if (installed.length) urlInput.value = '';
    } catch (error) {
      note.textContent = `Could not install from ${url}: ${(error as Error).message}`;
    } finally {
      urlButton.disabled = false;
    }
  };
  urlButton.addEventListener('click', () => void installFromUrl());
  urlInput.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') void installFromUrl();
  });

  picker.addEventListener('change', () => {
    if (picker.files) void install(picker.files);
    picker.value = '';
  });
  card.addEventListener('dragover', (event) => {
    event.preventDefault();
    card.classList.add('over');
  });
  card.addEventListener('dragleave', () => card.classList.remove('over'));
  card.addEventListener('drop', (event) => {
    event.preventDefault();
    card.classList.remove('over');
    if (event.dataTransfer?.files) void install(event.dataTransfer.files);
  });

  card.append(
    h('h4', { text: 'Skills' }),
    h('p', {
      class: 'sub',
      text: 'SKILL.md playbooks from ~/.beecode/skills, the workspace and any configured skills.dirs. Only names and descriptions sit in the prompt; the body loads when a task matches.',
    }),
    h(
      'div',
      { class: 'skill-drop-zone' },
      h('div', { class: 'skill-drop-hint', text: 'Drop a SKILL.md or a skill .zip here to install it' }),
      h('button', { class: 'btn ghost small', type: 'button', text: 'Choose file…', on: { click: () => picker.click() } }),
      picker,
      note,
    ),
  );

  card.append(h('div', { class: 'skill-url' }, urlInput, urlButton));

  if (!skills.length) card.append(h('div', { class: 'empty', text: 'No skills found.' }));
  for (const skill of skills) {
    const row = h(
      'div',
      { class: 'skill-row' },
      h('h4', {}, skill.name, ' ', h('span', { class: 'badge', text: skill.source })),
      h('p', { class: 'sub', text: skill.description }),
    );
    if (cb.removeSkill) row.append(renderSkillRemove(skill, cb, note));
    card.append(row);
  }
  return card;
}

/** Base64 of a dropped file, chunked so a large archive cannot blow the argument limit. */
async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

/* ----------------------------------------------------------------- subagents */

/**
 * Agents the Subagents panel may list: installed (the probe found the CLI on PATH) *and*
 * enabled in Settings — `available` is exactly that conjunction, computed by the service.
 * The whole catalogue stays reachable from the Settings card, so a CLI that is installed
 * but unticked can still be offered there.
 */
export function usableAgents(agents: AgentInfo[]): AgentInfo[] {
  return agents.filter((agent) => agent.available);
}

export function renderSubagents(
  host: HTMLElement,
  runs: SubagentRunInfo[],
  agents: AgentInfo[],
  cb: PanelCallbacks,
): void {
  clear(host);

  // This panel answers "who would run right now", not "what could be installed".
  const usable = usableAgents(agents);

  host.append(
    h(
      'div',
      { class: 'card' },
      h('h4', { text: 'Available agents' }),
      h(
        'p',
        {
          class: 'sub',
          text: 'Installed and enabled agents the agent can delegate to. Tick more under Settings → External agents (CLI).',
        },
      ),
      ...(usable.length
        ? usable.map((agent) =>
            h(
              'div',
              { class: 'audit-row' },
              h('span', { class: 'badge allowed', text: agent.kind }),
              h(
                'span',
                null,
                h('strong', { text: agent.label }),
                h('div', { class: 'sub', text: agent.detail ?? 'ready' }),
              ),
            ),
          )
        : // An empty catalogue means the first probe is still running: stay quiet rather
          // than claim nothing is installed.
          agents.length
          ? [
              h('div', {
                class: 'empty',
                text: 'No agent is installed and enabled yet — tick one under Settings → External agents (CLI).',
              }),
            ]
          : []),
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
  /**
   * Enable state of the catalogue, held locally and mutated in place. The card used to
   * rebuild every save from the `agents` snapshot it was rendered with, so a second
   * click that landed before the save round-trip finished reverted the first one.
   */
  const on = new Map(catalogue.map((agent) => [agent.id, agent.enabled === true]));
  /** Commands added in this card that the probed catalogue does not know yet. */
  const extra: CliAgentEntry[] = [];
  /** Checkbox per agent id, so a rejected entry can be put back without a re-render. */
  const boxes = new Map<string, HTMLInputElement>();
  /** Bumped on every click; a save only reconciles a response nobody has superseded. */
  let version = 0;

  const entryFor = (agent: AgentInfo): CliAgentEntry => ({
    id: agent.id,
    label: agent.label,
    command: agent.command ?? agent.id,
    args: agent.args ?? [],
    enabled: on.get(agent.id) === true,
    ...(agent.custom ? { custom: true } : {}),
  });

  /**
   * The list to persist: every enabled agent, plus the user’s own commands even when
   * they are off (`enabled: false`). The old code dropped them, so unticking a custom
   * command deleted it from config.json the next time any other agent was toggled.
   */
  const buildEntries = (): CliAgentEntry[] => {
    const list: CliAgentEntry[] = [];
    for (const agent of catalogue) {
      const entry = entryFor(agent);
      if (!entry.enabled && agent.custom !== true) continue;
      list.push(entry);
    }
    return [...list, ...extra];
  };

  let queue: Promise<void> = Promise.resolve();
  let refreshPending = false;

  /**
   * Persist the model, one request at a time: overlapping `agents.save` calls raced and
   * the slower answer won. A save never re-renders the panel — the checkbox keeps its
   * own state and only an explicit detect (or a new custom row) refreshes the card.
   */
  const persist = (refresh = false): Promise<void> => {
    if (refresh) refreshPending = true;
    queue = queue.then(async () => {
      const stamp = version;
      setNote('saving agents…');
      let saved: AgentInfo[] | undefined;
      try {
        saved = await cb.saveAgents?.(buildEntries());
      } catch (error) {
        setNote(`agents failed: ${(error as Error).message}`);
        return;
      }
      // The service normalises what it is given (duplicate commands and reserved ids are
      // dropped), so the echo is the truth — but only for a list nobody has superseded:
      // applying an older echo would undo the click that came after it.
      if (saved && stamp === version) {
        const live = new Set(saved.map((agent) => agent.id));
        for (const agent of saved) {
          if (agent.kind !== 'cli' || typeof agent.enabled !== 'boolean') continue;
          on.set(agent.id, agent.enabled);
          const box = boxes.get(agent.id);
          if (box) box.checked = agent.enabled;
        }
        for (const agent of catalogue) {
          if (live.has(agent.id) || on.get(agent.id) !== true) continue;
          on.set(agent.id, false);
          const box = boxes.get(agent.id);
          if (box) box.checked = false;
        }
        for (let index = extra.length - 1; index >= 0; index -= 1) {
          if (live.has(extra[index].id)) extra.splice(index, 1);
        }
      }
      setNote('agents saved ✓');
      if (refreshPending) {
        refreshPending = false;
        await cb.detectAgents?.();
      }
    });
    return queue;
  };

  const toggle = (agent: AgentInfo, enabled: boolean): void => {
    version += 1;
    on.set(agent.id, enabled);
    void persist();
  };

  const agentRow = (agent: AgentInfo): HTMLElement => {
    const box = h('input', {
      type: 'checkbox',
      checked: agent.enabled === true,
      on: { change: (event: Event) => toggle(agent, (event.target as HTMLInputElement).checked) },
    });
    boxes.set(agent.id, box);
    return h(
      'div',
      { class: 'agent-row' },
      h('label', { class: 'agent-name' },
        box,
        h('span', { text: agent.label }),
        agent.custom ? h('span', { class: 'badge', text: 'custom' }) : null,
      ),
      h('span', { class: 'agent-detail' },
        h('span', { class: `badge ${agent.onPath ? 'allowed' : 'denied'}`, text: agent.onPath ? 'on PATH' : 'not found' }),
        h('span', { class: 'mono sub', text: agent.command ?? agent.id }),
        agent.version ? h('span', { class: 'sub', text: agent.version }) : null,
      ),
    );
  };

  const rows = catalogue.map(agentRow);

  const customInput = h('input', {
    class: 'settings-input',
    type: 'text',
    placeholder: 'C:\\tools\\my-agent.cmd',
  });
  const addCustom = (): void => {
    const command = customInput.value.trim();
    if (!command) return;
    const label = command.split(/[\\/]/).pop() || command;
    customInput.value = '';
    // Kept aside until the service reports it back, then folded into the catalogue.
    extra.push({ id: label, label, command, args: [], enabled: true, custom: true });
    void persist(true);
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

/** Model ids last reported per preset id, kept across repaints so a save does not empty the picker. */
const modelLists = new Map<string, string[]>();

/**
 * Model field for one preset: a text input backed by a <datalist> of the models the endpoint
 * reports, plus a Refresh button. The list is re-read whenever the Base URL or a key changes,
 * and a model the endpoint does not advertise can still be typed (self-hosted names, aliases).
 */
function modelPicker(options: {
  preset: { id: string; provider: string; model: string; baseUrl?: string; apiKeyEnv?: string; hasKey?: boolean };
  draftKey(): string | undefined;
  listModels?: PanelCallbacks['listModels'];
  setNote(text: string): void;
}): { el: HTMLElement; schedule(): void } {
  const { preset, setNote } = options;
  const listId = 'model-list-' + preset.id;
  const list = h('datalist', { id: listId });
  const input = h('input', {
    class: 'settings-input',
    type: 'text',
    autocomplete: 'off',
    placeholder: 'model id',
    on: {
      input: (event: Event) => {
        preset.model = (event.target as HTMLInputElement).value.trim();
        setNote('unsaved changes');
      },
    },
  }) as HTMLInputElement;
  input.value = preset.model;
  // `list` is a readonly element property, so bind the datalist by attribute.
  input.setAttribute('list', listId);
  const status = h('span', { class: 'sub' });
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const fill = (models: string[]): void => {
    clear(list);
    for (const model of models) list.append(h('option', { value: model }));
  };
  fill(modelLists.get(preset.id) ?? []);

  const load = async (): Promise<void> => {
    if (!options.listModels) return;
    const mine = (generation += 1);
    status.textContent = 'loading models...';
    try {
      const result = await options.listModels({
        presetId: preset.id,
        provider: preset.provider,
        baseUrl: preset.baseUrl,
        apiKeyEnv: preset.apiKeyEnv,
        apiKey: options.draftKey(),
      });
      if (mine !== generation) return; // a newer probe already started
      modelLists.set(preset.id, result.models);
      fill(result.models);
      status.textContent = result.warning ?? result.models.length + ' models';
    } catch (error) {
      if (mine === generation) status.textContent = (error as Error).message;
    }
  };

  /** Debounced re-probe: typing a base URL or a key fires one request, not one per keystroke. */
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void load(), 700);
  };

  // A key that already resolves (stored, or from the env var) is worth probing straight away;
  // without one the endpoint would only answer 401.
  if (preset.hasKey) void load();

  return {
    el: h(
      'div',
      { class: 'settings-row' },
      input,
      list,
      h('button', { class: 'btn small', type: 'button', text: 'Refresh', on: { click: () => void load() } }),
      status,
    ),
    schedule,
  };
}

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
/* ------------------------------------------- config cards (non-policy state) */

type Note = (text: string) => void;

/** Clamped number input: config.json values are user-editable, so the UI pins the range. */
function settingsNumber(
  value: number,
  onChange: (next: number) => void,
  limits: { min: number; max: number } = { min: 0, max: Number.MAX_SAFE_INTEGER },
): HTMLInputElement {
  const input = h('input', {
    class: 'settings-input',
    type: 'number',
    min: String(limits.min),
    max: String(limits.max),
  });
  input.value = Number.isFinite(value) ? String(value) : String(limits.min);
  input.addEventListener('change', () => {
    const parsed = Number(input.value);
    if (!Number.isFinite(parsed)) {
      input.value = String(value);
      return;
    }
    const clamped = Math.min(limits.max, Math.max(limits.min, Math.round(parsed)));
    input.value = String(clamped);
    onChange(clamped);
  });
  return input;
}

function settingsText(
  value: string,
  onChange: (next: string) => void,
  placeholder = '',
): HTMLInputElement {
  const input = h('input', { class: 'settings-input', type: 'text', placeholder });
  input.value = value;
  input.addEventListener('change', () => onChange(input.value.trim()));
  return input;
}

function settingsChoice<T extends string>(
  values: ReadonlyArray<{ value: T; label: string }>,
  current: T,
  onChange: (next: T) => void,
): HTMLSelectElement {
  const select = h('select', { class: 'settings-input' });
  for (const entry of values) {
    const option = h('option', { text: entry.label });
    option.value = entry.value;
    option.selected = entry.value === current;
    select.append(option);
  }
  select.addEventListener('change', () => onChange(select.value as T));
  return select;
}

/**
 * Every config.json field the Permissions section does not own, editable here.
 *
 * The point is discoverability: an error message may say "raise agent.maxSteps in settings",
 * and settings must then actually contain that field. Rules (what the agent may do) stay in
 * the Permissions section; preferences (how it runs) live here.
 */
function renderConfigCards(draft: BeeCodeConfig, note: Note): HTMLElement[] {
  const touch = (): void => note('unsaved changes');

  const agentCard = h(
    'div',
    { class: 'card' },
    h('h4', { text: 'Agent' }),
    h('p', {
      class: 'sub',
      text: 'How the loop behaves. Max steps is the cap behind "Stopped after N steps without finishing": raise it here for long tasks. Approval rules and the auto-approved tool list stay in Settings → Permissions.',
    }),
    settingsField(
      'Default mode',
      settingsChoice<AgentMode>(
        [
          { value: 'ask', label: 'ask — read only' },
          { value: 'plan', label: 'plan — plan, then ask' },
          { value: 'act', label: 'act — act, with approvals' },
          { value: 'autonomous', label: 'autonomous — act, no approvals' },
        ],
        draft.agent.defaultMode,
        (next) => {
          draft.agent.defaultMode = next;
          touch();
        },
      ),
    ),
    settingsField(
      'Max steps',
      settingsNumber(
        draft.agent.maxSteps,
        (next) => {
          draft.agent.maxSteps = next;
          touch();
        },
        { min: 1, max: 500 },
      ),
    ),
    settingsField(
      'Working directory',
      settingsText(
        draft.agent.workingDir,
        (next) => {
          draft.agent.workingDir = next;
          touch();
        },
        draft.workspace.root || 'uses the workspace folder',
      ),
    ),
  );

  const serviceCard = h(
    'div',
    { class: 'card' },
    h('h4', { text: 'Service' }),
    h('p', {
      class: 'sub',
      text: 'The background agent service. It speaks JSON-RPC over stdio to this window; the HTTP transport is for headless use and other clients.',
    }),
    toggle('Start the service with the app', draft.service.autoStart, (checked) => {
      draft.service.autoStart = checked;
      touch();
    }),
    settingsField(
      'HTTP port (0 = ephemeral)',
      settingsNumber(
        draft.service.httpPort,
        (next) => {
          draft.service.httpPort = next;
          touch();
        },
        { min: 0, max: 65535 },
      ),
    ),
  );

  const desktopCard = h(
    'div',
    { class: 'card' },
    h('h4', { text: 'Desktop control' }),
    h('p', {
      class: 'sub',
      text: 'Whether the agent may see and drive windows at all. The hard stop for input is in Settings → Permissions; this switch puts the driver in mock mode, so the tools see no real window; switch the desktop_* tools themselves off in Settings → Tools.',
    }),
    toggle('Desktop tools enabled', draft.desktop.enabled, (checked) => {
      draft.desktop.enabled = checked;
      touch();
    }),
    settingsField(
      'Driver',
      settingsChoice<DesktopConfig['driver']>(
        [
          { value: 'windows', label: 'windows — UI Automation + CDP' },
          { value: 'mock', label: 'mock — tests and CI' },
        ],
        draft.desktop.driver,
        (next) => {
          draft.desktop.driver = next;
          touch();
        },
      ),
    ),
  );

  const browserCard = h(
    'div',
    { class: 'card' },
    h('h4', { text: 'Internal browser' }),
    h('p', {
      class: 'sub',
      text: 'Cookies and cache are kept per workspace: two workspaces never share a login, and switching back to a workspace restores its session.',
    }),
    toggle('Browser tools enabled', draft.browser.enabled, (checked) => {
      draft.browser.enabled = checked;
      touch();
    }),
    toggle('Keep cookies and cache (per workspace)', draft.browser.persistSession, (checked) => {
      draft.browser.persistSession = checked;
      touch();
    }),
    toggle('Run page scripts', draft.browser.allowScripts, (checked) => {
      draft.browser.allowScripts = checked;
      touch();
    }),
    toggle('Show the AI cursor', draft.browser.showCursor, (checked) => {
      draft.browser.showCursor = checked;
      touch();
    }),
    settingsField(
      'Max open tabs',
      settingsNumber(
        draft.browser.maxTabs,
        (next) => {
          draft.browser.maxTabs = next;
          touch();
        },
        { min: 1, max: 32 },
      ),
    ),
    settingsField(
      'Home page',
      settingsText(
        draft.browser.homeUrl,
        (next) => {
          draft.browser.homeUrl = next;
          touch();
        },
        'https://example.com',
      ),
    ),
  );

  const subagentCard = h(
    'div',
    { class: 'card' },
    h('h4', { text: 'Subagents' }),
    h('p', {
      class: 'sub',
      text: 'Delegated runs the parent agent can spawn. Sessions run in parallel too — one slow turn in a session no longer blocks the others.',
    }),
    toggle('Subagent tools enabled', draft.subagents.enabled, (checked) => {
      draft.subagents.enabled = checked;
      touch();
    }),
    settingsField(
      'Max concurrent runs',
      settingsNumber(
        draft.subagents.maxConcurrent,
        (next) => {
          draft.subagents.maxConcurrent = next;
          touch();
        },
        { min: 1, max: 16 },
      ),
    ),
  );

  return [agentCard, serviceCard, desktopCard, browserCard, subagentCard];
}

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
    service: { ...config.service },
    desktop: { ...config.desktop },
    browser: { ...config.browser },
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
      const picker = modelPicker({
        preset,
        draftKey: () => keys[preset.id],
        listModels: cb.listModels,
        setNote,
      });
      provider.addEventListener('change', () => {
        preset.provider = provider.value as ProviderId;
        picker.schedule();
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
            settingsField('Model', picker.el),
            settingsField(
              'Base URL',
              settingsInput(preset.baseUrl ?? '', (next) => {
                preset.baseUrl = next || undefined;
                setNote('unsaved changes');
                picker.schedule();
              }, 'https://api.example.com/v1'),
            ),
            settingsField(
              'API key env var (optional)',
              settingsInput(preset.apiKeyEnv ?? '', (next) => {
                preset.apiKeyEnv = next || undefined;
                setNote('unsaved changes');
                picker.schedule();
              }, 'optional, e.g. OPENAI_API_KEY'),
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
                    picker.schedule();
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
              : 'Key: not set — paste one above; a stored key wins over the env var and .env.llm API_KEY',
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

    /* ----- everything else in config.json ----- */
    host.append(...renderConfigCards(draft, setNote));

    /* ----- external CLI agents ----- */
    host.append(renderAgentsCard(agents, cb, setNote));
  };

  paint();
}
/* ---------------------------------------------------------------- scheduler */

/** The four modes a scheduled run can start in — the same set the composer offers. */
const SCHEDULE_MODES: AgentMode[] = ['ask', 'plan', 'act', 'autonomous'];

/** Weekday tokens the compact weekly rule uses, indexed like `Schedule.days`. */
const SCHEDULE_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** What the form starts with — a rule anyone can read at a glance. */
const DEFAULT_WHEN = 'daily:09:00';

/** Render a schedule back into the compact rule the form and the chat tool accept. */
function whenRule(schedule: Schedule): string {
  switch (schedule.kind) {
    case 'once':
      return `once:${schedule.at ?? ""}`;
    case 'interval':
      return `every:${schedule.everyMinutes ?? 60}m`;
    case 'weekly':
      return `weekly:${(schedule.days ?? []).map((day) => SCHEDULE_DAYS[day] ?? String(day)).join(",")}@${schedule.time ?? "09:00"}`;
    case 'daily':
    default:
      return `daily:${schedule.time ?? "09:00"}`;
  }
}

function scheduleError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Scheduler panel: the same list the `schedule` tool edits, so a schedule created
 * in chat shows up here and one created here is visible to the model.
 *
 * One form above the list instead of a modal: a schedule is a prompt plus a rule, so
 * editing in place keeps the whole set readable while one of them is open.
 */
export function renderScheduler(host: HTMLElement, schedules: Schedule[], cb: PanelCallbacks): void {
  clear(host);

  let editing: string | undefined;

  const title = h('h4', { text: 'New schedule' });
  const nameInput = h('input', {
    class: 'settings-input',
    type: 'text',
    placeholder: 'Morning triage',
  }) as HTMLInputElement;
  const whenInput = h('input', {
    class: 'settings-input',
    type: 'text',
    placeholder: 'daily:09:00',
  }) as HTMLInputElement;
  whenInput.value = DEFAULT_WHEN;
  const promptInput = h('textarea', {
    class: 'settings-input',
    placeholder: 'Summarise my inbox and list what needs a reply',
  }) as HTMLTextAreaElement;
  promptInput.rows = 3;
  const modeInput = h(
    'select',
    { class: 'settings-input' },
    ...SCHEDULE_MODES.map((mode) => h('option', { value: mode, text: mode })),
  ) as HTMLSelectElement;
  modeInput.value = 'act';
  const cwdInput = h('input', {
    class: 'settings-input',
    type: 'text',
    placeholder: 'working folder (optional)',
  }) as HTMLInputElement;
  const feedback = h('div', { class: 'hint', text: '' });

  const submit = h('button', { class: 'btn primary small', text: 'Add schedule' });
  const cancel = h('button', { class: 'btn ghost small', text: 'Cancel edit' });
  cancel.hidden = true;

  function reset(): void {
    editing = undefined;
    title.textContent = 'New schedule';
    submit.textContent = 'Add schedule';
    cancel.hidden = true;
    nameInput.value = '';
    promptInput.value = '';
    whenInput.value = DEFAULT_WHEN;
    cwdInput.value = '';
    modeInput.value = 'act';
    feedback.textContent = '';
  }

  function beginEdit(schedule: Schedule): void {
    editing = schedule.id;
    title.textContent = `Edit “${schedule.name}”`;
    submit.textContent = 'Save changes';
    cancel.hidden = false;
    nameInput.value = schedule.name;
    promptInput.value = schedule.prompt;
    whenInput.value = whenRule(schedule);
    cwdInput.value = schedule.cwd ?? '';
    modeInput.value = schedule.mode;
    feedback.textContent = '';
    nameInput.focus();
  }

  async function save(): Promise<void> {
    const cwd = cwdInput.value.trim();
    const input: ScheduleInput = {
      ...(editing ? { id: editing } : {}),
      name: nameInput.value.trim(),
      prompt: promptInput.value.trim(),
      when: whenInput.value.trim(),
      mode: modeInput.value as AgentMode,
      ...(cwd ? { cwd } : {}),
    };
    try {
      await cb.saveSchedule?.(input);
      reset();
    } catch (error) {
      feedback.textContent = scheduleError(error);
    }
  }

  submit.addEventListener('click', () => void save());
  cancel.addEventListener('click', () => reset());

  const actionButton = (
    label: string,
    cls: string,
    onClick: () => void | Promise<void>,
  ): HTMLButtonElement => {
    const button = h('button', { class: cls, text: label });
    button.addEventListener('click', () => void onClick());
    return button;
  };

  const row = (schedule: Schedule): HTMLElement => {
    const actions = h(
      'div',
      { class: 'actions' },
      actionButton('Run now', 'btn small', async () => {
        try {
          const sessionId = await cb.runSchedule?.(schedule.id);
          feedback.textContent = sessionId ? `Started session ${sessionId}` : 'Started';
        } catch (error) {
          feedback.textContent = scheduleError(error);
        }
      }),
      actionButton(schedule.enabled ? 'Pause' : 'Resume', 'btn ghost small', async () => {
        try {
          await cb.saveSchedule?.({ id: schedule.id, enabled: !schedule.enabled });
        } catch (error) {
          feedback.textContent = scheduleError(error);
        }
      }),
      actionButton('Edit', 'btn ghost small', () => beginEdit(schedule)),
      actionButton('Delete', 'btn danger small', async () => {
        try {
          await cb.removeSchedule?.(schedule.id);
        } catch (error) {
          feedback.textContent = scheduleError(error);
        }
      }),
    );

    const status = schedule.enabled
      ? `next ${formatMoment(schedule.nextRunAt)}`
      : 'paused';
    const last = schedule.lastResult
      ? `${schedule.runCount} run${schedule.runCount === 1 ? '' : 's'} · last ${schedule.lastResult}`
      : 'never run';

    return h(
      'div',
      { class: 'app-rule' },
      h('div', { class: 'row' }, h('strong', { class: 'name', text: schedule.name }), h('span', { class: 'badge', text: schedule.kind })),
      h('div', { class: 'sub', text: describeSchedule(schedule) }),
      h('div', { class: 'sub', text: `${status} · ${last}` }),
      schedule.prompt ? h('div', { class: 'sub mono', text: schedule.prompt }) : null,
      actions,
    );
  };

  host.append(
    h(
      'div',
      { class: 'card' },
      h('h4', { text: 'Scheduled runs' }),
      h('p', {
        class: 'hint',
        text: 'Timed agent runs. Each fire opens its own session, so a background run never interrupts your chat.',
      }),
      schedules.length === 0
        ? h('p', { class: 'hint', text: 'No schedules yet — add one below, or just ask in chat: “every weekday at 8, summarise my inbox”.' })
        : h('div', { class: 'settings-row' }, ...schedules.map(row)),
    ),
    h(
      'div',
      { class: 'card' },
      title,
      h(
        'div',
        { class: 'settings-field' },
        h('label', { text: 'Name' }),
        nameInput,
      ),
      h(
        'div',
        { class: 'settings-field' },
        h('label', { text: 'Prompt' }),
        promptInput,
      ),
      h(
        'div',
        { class: 'settings-field' },
        h('label', { text: 'When' }),
        whenInput,
        h('p', {
          class: 'hint',
          text: 'once:2025-04-01 09:00 · every:30m · daily:09:00 · weekly:mon,thu@17:30',
        }),
      ),
      h(
        'div',
        { class: 'settings-field' },
        h('label', { text: 'Mode' }),
        modeInput,
      ),
      h(
        'div',
        { class: 'settings-field' },
        h('label', { text: 'Working folder' }),
        cwdInput,
      ),
      h('div', { class: 'actions' }, submit, cancel),
      feedback,
    ),
  );
}
