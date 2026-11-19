import type { SessionGoal, TodoItem, WorkspaceState } from '../shared/protocol';
import { clear, h } from './dom';

/**
 * The plan panel and the workspace setup gate.
 *
 * Both surfaces are pure DOM over state the service owns: the plan mirrors `session.goal` /
 * `session.todos` events, the gate mirrors `workspace.state`. Nothing here decides what the
 * agent may do — the service refuses workspace-less work on its own.
 */

export interface PlanState {
  /** `config.features.goalTodo` — off hides the panel entirely. */
  enabled: boolean;
  goal?: SessionGoal;
  todos: TodoItem[];
}

export interface PlanActions {
  setGoal(text: string): Promise<void>;
  clearGoal(): Promise<void>;
}

const STATUS_MARK: Record<TodoItem['status'], string> = {
  pending: '○',
  in_progress: '▸',
  completed: '✓',
};

/**
 * Goal + to-do panel above the composer.
 *
 * Hidden when the feature is off or nothing is planned yet, so an ordinary chat keeps the
 * full height of the transcript. The goal is editable here; the write goes through the same
 * `goal.set` RPC the agent's `goal_write` tool uses.
 */
export function renderPlan(host: HTMLElement, state: PlanState, actions: PlanActions): void {
  clear(host);
  if (!state.enabled) {
    host.classList.add('hidden');
    return;
  }
  host.classList.remove('hidden');
  const todos = state.todos;
  if (!state.goal && !todos.length) return;

  const card = h('div', { class: 'plan' });

  /* ----- the one-line goal ----- */
  const goalRow = h('div', { class: 'plan-goal' });
  const editGoal = (): void => {
    const input = h('input', {
      class: 'plan-input',
      type: 'text',
      placeholder: 'One line: what should this session achieve?',
      maxlength: '500',
    });
    input.value = state.goal?.text ?? '';
    const commit = (): void => {
      const text = input.value.trim();
      if (text === (state.goal?.text ?? '')) {
        renderPlan(host, state, actions);
        return;
      }
      // The resulting `session.goal` event repaints this panel.
      void actions.setGoal(text).catch(() => renderPlan(host, state, actions));
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        renderPlan(host, state, actions);
      }
    });
    clear(goalRow);
    goalRow.append(h('span', { class: 'plan-label', text: 'GOAL' }), input);
    input.focus();
    input.select();
  };

  goalRow.append(h('span', { class: 'plan-label', text: 'GOAL' }));
  if (state.goal) {
    goalRow.append(
      h('span', { class: 'plan-goal-text', text: state.goal.text, title: state.goal.text }),
      h('button', {
        class: 'plan-btn',
        type: 'button',
        text: '✎',
        title: 'Edit the goal',
        on: { click: () => editGoal() },
      }),
      h('button', {
        class: 'plan-btn',
        type: 'button',
        text: '✕',
        title: 'Clear the goal',
        on: { click: () => void actions.clearGoal() },
      }),
    );
  } else {
    goalRow.append(
      h('button', {
        class: 'plan-btn',
        type: 'button',
        text: '+ set a goal',
        on: { click: () => editGoal() },
      }),
    );
  }
  card.append(goalRow);

  /* ----- the plan ----- */
  if (todos.length) {
    const done = todos.filter((item) => item.status === 'completed').length;
    const percent = Math.round((done / todos.length) * 100);
    card.append(
      h(
        'div',
        { class: 'plan-head' },
        h('span', { class: 'plan-label', text: 'PLAN' }),
        h('span', { class: 'plan-count', text: `${done}/${todos.length}` }),
        h('span', { class: 'plan-bar' }, h('span', { class: 'plan-bar-fill', style: `width:${percent}%` })),
      ),
    );
    const list = h('ol', { class: 'plan-list' });
    for (const item of todos) {
      // The in-progress item shows its present-participle form, like the ADO Code to-do view.
      const label = item.status === 'in_progress' && item.activeForm ? item.activeForm : item.content;
      list.append(
        h(
          'li',
          { class: `plan-item ${item.status}` },
          h('span', { class: 'plan-mark', text: STATUS_MARK[item.status] }),
          h('span', { class: 'plan-text', text: label, title: item.content }),
        ),
      );
    }
    card.append(list);
  }

  host.append(card);
}

export interface WorkspaceActions {
  choose(): Promise<void>;
  useRecent(path: string): Promise<void>;
  forget(path: string): Promise<void>;
}

/**
 * First-run setup: no workspace folder means no file tools, no shell and no session, so the
 * whole chat column is replaced by the picker. A saved root that has since disappeared is
 * reported instead of being treated as configured.
 */
export function renderWorkspaceGate(
  host: HTMLElement,
  workspace: WorkspaceState | undefined,
  actions: WorkspaceActions,
): void {
  clear(host);
  if (workspace?.configured) {
    host.classList.add('hidden');
    return;
  }
  host.classList.remove('hidden');

  const stale = Boolean(workspace?.root);
  const recent = workspace?.recent ?? [];

  host.append(
    h(
      'div',
      { class: 'gate' },
      h('h2', { text: 'Choose a workspace folder' }),
      h('p', {
        text:
          'beeCode reads and writes files, runs commands and remembers notes inside one folder — your workspace. It never picks one for you, and it will not work in the directory the app happens to be installed in.',
      }),
      stale
        ? h('p', {
            class: 'gate-warn',
            text: `The saved workspace folder is not available: ${workspace?.root}`,
          })
        : null,
      h(
        'div',
        { class: 'gate-actions' },
        h('button', {
          class: 'btn primary',
          type: 'button',
          text: 'Choose folder…',
          on: { click: () => void actions.choose() },
        }),
        stale
          ? h('button', {
              class: 'btn danger',
              type: 'button',
              text: 'Forget it',
              on: { click: () => void actions.forget(String(workspace?.root ?? '')) },
            })
          : null,
      ),
      recent.length
        ? h(
            'div',
            { class: 'gate-recent' },
            h('span', { class: 'plan-label', text: 'RECENT' }),
            ...recent.map((path) =>
              h('button', {
                class: 'gate-recent-item',
                type: 'button',
                text: path,
                title: `Use ${path}`,
                on: { click: () => void actions.useRecent(path) },
              }),
            ),
          )
        : null,
    ),
  );
}
