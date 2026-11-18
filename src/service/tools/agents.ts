import type { ToolDefinition } from '../../shared/tools';
import type { SubagentRunner } from '../subagents/runner';
import { errorResult, jsonResult, requireStr, str } from './registry';

interface AgentToolDeps {
  subagents: SubagentRunner;
  /** Delegation is disabled inside a subagent to prevent runaway fan-out. */
  allowDelegation: boolean;
}

export function agentTools(deps: AgentToolDeps): ToolDefinition[] {
  const { subagents } = deps;

  return [
    {
      name: 'subagent_delegate',
      description:
        'Delegate self-contained work to a subagent. "internal" runs a nested beeCode session with read-only desktop/file access; other ids are external coding-agent CLIs working in the workspace. The subagent does NOT see this conversation — the task must be a complete, standalone instruction. Pass `tasks` to fan out several parallel runs.',
      mutating: true,
      group: 'agents',
      inputSchema: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description: 'Agent id from agents_list, e.g. "internal" or a CLI agent id.',
          },
          task: { type: 'string', description: 'Complete instruction for the subagent.' },
          tasks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Alternative to `task`: several independent instructions run in parallel.',
          },
        },
        required: ['agent'],
        additionalProperties: false,
      },
      preview: (args, ctx) => {
        const tasks = Array.isArray(args.tasks) ? (args.tasks as unknown[]) : [];
        const count = tasks.length || 1;
        const first = tasks[0] ? String(tasks[0]) : String(args.task ?? '');
        return {
          requiresApproval: ctx.mode !== 'autonomous',
          summary: `Delegate ${count > 1 ? `${count} tasks` : 'a task'} to "${String(args.agent ?? '')}": ${first.slice(0, 100)}`,
          reason: 'subagents consume tokens and act on your behalf',
        };
      },
      async handler(args, ctx) {
        if (!deps.allowDelegation) {
          return errorResult('delegation is not available inside a subagent');
        }
        const agent = requireStr(args, 'agent');
        const tasks = Array.isArray(args.tasks) ? (args.tasks as unknown[]).map(String).filter(Boolean) : [];
        const single = str(args, 'task');
        const list = tasks.length ? tasks : single ? [single] : [];
        if (!list.length) return errorResult('provide `task` or `tasks`');

        const known = subagents.availableAgents().filter((a) => a.available).map((a) => a.id);
        if (!known.includes(agent)) {
          return errorResult(`agent "${agent}" is not available`, { available: known });
        }

        const base = { parentSessionId: ctx.sessionId, cwd: ctx.cwd, depth: ctx.depth, signal: ctx.signal };
        if (list.length === 1) {
          const res = await subagents.delegate({ ...base, agent, task: list[0]! });
          return jsonResult({
            runId: res.runId,
            agent: res.agent,
            status: res.status,
            error: res.error,
            output: truncate(res.output),
          });
        }
        const results = await subagents.delegateMany(agent, list, base);
        return jsonResult({
          runs: results.map((r) => ({
            runId: r.runId,
            status: r.status,
            error: r.error,
            output: truncate(r.output),
          })),
        });
      },
    },
    {
      name: 'agents_list',
      description: 'List the subagents that can be delegated to and whether each one is available.',
      mutating: false,
      group: 'agents',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async handler() {
        return jsonResult({ agents: subagents.availableAgents() });
      },
    },
    {
      name: 'subagent_list',
      description: 'List subagent runs for this service, newest first, with status and output tail.',
      mutating: false,
      group: 'agents',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async handler() {
        const runs = subagents
          .list()
          .slice(-20)
          .map((r) => ({
            id: r.id,
            agent: r.agent,
            status: r.status,
            task: r.task.slice(0, 160),
            outputTail: r.output.slice(-1200),
            error: r.error,
          }));
        return jsonResult({ runs });
      },
    },
    {
      name: 'subagent_cancel',
      description: 'Cancel a running subagent by run id.',
      mutating: true,
      group: 'agents',
      inputSchema: {
        type: 'object',
        properties: { runId: { type: 'string', description: 'Run id from subagent_list.' } },
        required: ['runId'],
        additionalProperties: false,
      },
      preview: (args) => ({
        requiresApproval: false,
        summary: `Cancel subagent run ${String(args.runId ?? '')}`,
        reason: 'cancellation is always safe',
      }),
      async handler(args) {
        const runId = requireStr(args, 'runId');
        const cancelled = subagents.cancel(runId);
        return cancelled ? jsonResult({ cancelled: true }) : errorResult(`no running subagent with id ${runId}`);
      },
    },
  ];
}

function truncate(output: string, max = 8000): string {
  return output.length > max ? `${output.slice(0, max)}\n…[truncated ${output.length - max} chars]` : output;
}
