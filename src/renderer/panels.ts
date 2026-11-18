import type {
  AgentInfo,
  AppRule,
  AuditEntry,
  BeeCodeConfig,
  DesktopAction,
  PolicyDocument,
  SubagentRunInfo,
} from '../shared/protocol';
import { DESKTOP_ACTIONS } from '../shared/protocol';
import { clear, h } from './dom';

export interface PanelCallbacks {
  savePolicy(next: PolicyDocument): Promise<void>;
  saveConfig?(next: BeeCodeConfig): Promise<void>;
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
