import type { AgentMode, Schedule, ScheduleInput } from '../../shared/protocol';
import { describeSchedule, formatMoment } from '../../shared/schedule';
import type { ToolDefinition } from '../../shared/tools';
import type { SchedulerRunner } from '../scheduler/runner';
import type { ScheduleStore } from '../scheduler/store';
import { errorResult, jsonResult, str } from './registry';

/**
 * The `schedule` tool — the chat half of the scheduler, so "remind me every morning at
 * 9 to triage the inbox" becomes a real timer instead of a promise. Writes go through the
 * same store as the Scheduler panel, and every mutation re-broadcasts the list so an open
 * panel follows along without a refresh.
 */

/** What the `schedule` tool needs: the shared store, the runner, a way to broadcast. */
export interface SchedulerToolDeps {
  store: ScheduleStore;
  runner: SchedulerRunner;
  notify: (schedules: Schedule[]) => void;
}

const MODES: readonly AgentMode[] = ['ask', 'plan', 'act', 'autonomous'];

/** The panel's view of a schedule, for the model: what, when, next, last. */
function view(schedule: Schedule): Record<string, unknown> {
  return {
    id: schedule.id,
    name: schedule.name,
    when: describeSchedule(schedule),
    prompt: schedule.prompt,
    mode: schedule.mode,
    enabled: schedule.enabled,
    nextRunAt: schedule.nextRunAt ?? null,
    lastRunAt: schedule.lastRunAt ?? null,
    lastResult: schedule.lastResult ?? null,
    runs: schedule.runCount,
    ...(schedule.cwd ? { cwd: schedule.cwd } : {}),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The payload a tool call carries; omitted fields keep the stored values. */
function inputFrom(args: Record<string, unknown>): ScheduleInput {
  const enabled = typeof args.enabled === 'boolean' ? args.enabled : undefined;
  const mode = MODES.includes(args.mode as AgentMode) ? (args.mode as AgentMode) : undefined;
  return {
    id: str(args, 'id'),
    name: str(args, 'name'),
    prompt: str(args, 'prompt'),
    when: str(args, 'when'),
    mode,
    cwd: str(args, 'cwd'),
    enabled,
  };
}

export function schedulerTools(deps: SchedulerToolDeps): ToolDefinition[] {
  return [
    {
      name: 'schedule',
      description:
        'Create, change, list, run or delete scheduled agent runs (beeCode\'s scheduler). ' +
        'A schedule fires on a timer and starts a fresh session whose first message is the ' +
        'schedule prompt — use it for "every morning summarize the build", "in two hours ' +
        'check the deploy". Timing rules: once:2025-04-01 09:00, once:18:30, every:30m, ' +
        'every:2h, every:1d, daily:09:00, weekly:mon,thu@17:30 (weekdays also accepted). ' +
        'Actions: list (default), add, update, remove, run (fire now), pause, resume.',
      mutating: true,
      group: 'scheduler',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'add', 'update', 'remove', 'run', 'pause', 'resume'],
            description: 'What to do. Defaults to list.',
          },
          id: { type: 'string', description: 'Schedule id — required for update/remove/run/pause/resume.' },
          name: { type: 'string', description: 'Short human name, shown in the Scheduler tab.' },
          prompt: {
            type: 'string',
            description: 'The task the scheduled session starts with, written as a user message.',
          },
          when: {
            type: 'string',
            description:
              'Timing rule: once:<date or clock>, every:<interval>, daily:HH:MM, weekly:<days>@HH:MM.',
          },
          mode: {
            type: 'string',
            enum: ['ask', 'plan', 'act', 'autonomous'],
            description: 'Mode the scheduled session runs in (default act).',
          },
          cwd: { type: 'string', description: 'Working directory for the run; defaults to the workspace.' },
          enabled: { type: 'boolean', description: 'Pause (false) or resume (true) without deleting.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const action = (str(args, 'action') ?? 'list').trim().toLowerCase();
        try {
          switch (action) {
            case 'list': {
              const schedules = await deps.store.list();
              return jsonResult({
                schedules: schedules.map(view),
                hint: schedules.length
                  ? 'Call schedule with action "run" and an id to fire one now.'
                  : 'No schedules yet — add one with action "add", name, prompt and when.',
              });
            }

            case 'add': {
              const { schedule, schedules } = await deps.store.save(inputFrom(args));
              deps.notify(schedules);
              return jsonResult({
                created: view(schedule),
                hint: schedule.enabled
                  ? `Next run ${formatMoment(schedule.nextRunAt)}.`
                  : 'Saved but paused — resume it to let it fire.',
              });
            }

            case 'update': {
              const id = str(args, 'id');
              if (!id) return errorResult('update needs the schedule id (call schedule with action "list")');
              const { schedule, schedules } = await deps.store.save({ ...inputFrom(args), id });
              deps.notify(schedules);
              return jsonResult({ updated: view(schedule) });
            }

            case 'remove': {
              const id = str(args, 'id');
              if (!id) return errorResult('remove needs the schedule id');
              const schedules = await deps.store.remove(id);
              deps.notify(schedules);
              return jsonResult({ removed: id, remaining: schedules.length });
            }

            case 'run': {
              const id = str(args, 'id');
              if (!id) return errorResult('run needs the schedule id');
              const sessionId = await deps.runner.runNow(id);
              return jsonResult({
                started: sessionId,
                hint: 'The run continues in its own session; the Scheduler tab shows its result.',
              });
            }

            case 'pause':
            case 'resume': {
              const id = str(args, 'id');
              if (!id) return errorResult(`${action} needs the schedule id`);
              const { schedule, schedules } = await deps.store.save({ id, enabled: action === 'resume' });
              deps.notify(schedules);
              return jsonResult({ updated: view(schedule) });
            }

            default:
              return errorResult(
                `unknown action "${action}" — use list, add, update, remove, run, pause or resume`,
              );
          }
        } catch (error) {
          return errorResult(message(error));
        }
      },
    },
  ];
}
