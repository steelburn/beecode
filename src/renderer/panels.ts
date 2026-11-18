import type {
  AgentInfo,
  AppRule,
  AuditEntry,
  BeeCodeConfig,
  DesktopAction,
  ModelPreset,
  PolicyDocument,
  ProviderId,
  SubagentRunInfo,
} from '../shared/protocol';
import { DESKTOP_ACTIONS } from '../shared/protocol';
import { clear, h } from './dom';

export interface PanelCallbacks {
  savePolicy(next: PolicyDocument): Promise<void>;
  saveConfig?(next: BeeCodeConfig): Promise<void>;
  pickDirectory?(): Promise<string | undefined>;
  cancelSubagent(runId: string): Promise<void>;
  refreshAudit(): Promise<void>;
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
export function renderSettings(host: HTMLElement, config: BeeCodeConfig, cb: PanelCallbacks): void {
  const draft: BeeCodeConfig = {
    ...config,
    agent: { ...config.agent },
    models: config.models.map((model) => ({ ...model })),
  };
  let note: HTMLElement = h('span', { class: 'settings-note' });

  const setNote = (text: string): void => {
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

    /* ----- working directory ----- */
    host.append(
      h(
        'div',
        { class: 'card' },
        h('h4', { text: 'Working directory' }),
        h('p', {
          class: 'sub',
          text: 'New sessions start here and the file tools cannot leave it. Existing sessions keep the directory they were created with.',
        }),
        h(
          'div',
          { class: 'settings-row' },
          settingsInput(draft.agent.workingDir, (next) => {
            draft.agent.workingDir = next;
            setNote('unsaved changes — press Save');
          }, 'D:\\projects\\my-app'),
          h('button', {
            class: 'btn small',
            type: 'button',
            text: 'Browse…',
            on: {
              click: async () => {
                const picked = await cb.pickDirectory?.();
                if (!picked) return;
                draft.agent.workingDir = picked;
                await save();
              },
            },
          }),
        ),
      ),
    );
  };

  paint();
}
