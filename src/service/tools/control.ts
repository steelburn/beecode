import type { ToolDefinition } from '../../shared/tools';
import type { MemoryStore, TodoStore, TodoStatus } from '../stores';
import { errorResult, jsonResult, str } from './registry';

interface ControlToolDeps {
  todos: TodoStore;
  memory: MemoryStore;
}

export function controlTools(deps: ControlToolDeps): ToolDefinition[] {
  const { todos, memory } = deps;

  return [
    {
      name: 'todo_write',
      description:
        'Replace the task list for this session. Use it for multi-step desktop work so progress is visible to the user: exactly one item in_progress at a time.',
      mutating: false,
      group: 'control',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              },
              required: ['content'],
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const raw = Array.isArray(args.items) ? (args.items as Array<Record<string, unknown>>) : [];
        const items = todos.write(
          ctx.sessionId,
          raw.map((i) => ({ content: String(i.content ?? ''), status: (i.status as TodoStatus) ?? 'pending' })),
        );
        return jsonResult({ items });
      },
    },
    {
      name: 'todo_read',
      description: 'Read the current task list for this session.',
      mutating: false,
      group: 'control',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async handler(_args, ctx) {
        return jsonResult({ items: todos.read(ctx.sessionId) });
      },
    },
    {
      name: 'memory_write',
      description:
        'Persist a short note for this workspace (app quirks, selectors that worked, user preferences). Survives across sessions.',
      mutating: false,
      group: 'control',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Short identifier, e.g. "notepad-save-shortcut".' },
          value: { type: 'string', description: 'The note (max 4000 chars).' },
        },
        required: ['key', 'value'],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const key = str(args, 'key');
        const value = str(args, 'value');
        if (!key || value === undefined) return errorResult('key and value are required');
        await memory.set(ctx.cwd, key, value);
        return jsonResult({ ok: true, key });
      },
    },
    {
      name: 'memory_read',
      description: 'Read workspace notes (all, or one by key).',
      mutating: false,
      group: 'control',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Optional note key.' } },
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const all = await memory.read(ctx.cwd);
        const key = str(args, 'key');
        if (key) return jsonResult({ key, value: all[key] ?? null });
        return jsonResult({ notes: all });
      },
    },
    {
      name: 'ask_user',
      description:
        'Ask the user a question and end this turn. Use it when the task is ambiguous or a needed capability is denied by policy.',
      mutating: false,
      group: 'control',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask.' },
          options: { type: 'array', items: { type: 'string' }, description: 'Optional suggested answers.' },
        },
        required: ['question'],
        additionalProperties: false,
      },
      async handler(args) {
        const question = str(args, 'question') ?? '';
        const options = Array.isArray(args.options) ? (args.options as unknown[]).map(String) : [];
        return {
          content: JSON.stringify({ asked: question, options }),
          meta: { awaitingUser: true, question, options },
        };
      },
    },
  ];
}
