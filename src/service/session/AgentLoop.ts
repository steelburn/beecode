import type {
  AgentMode,
  ApprovalRequest,
  SessionSnapshot,
  SessionStatus,
  SessionSummary,
  TranscriptEntry,
  ServiceEvent,
  ToolCallRecord,
  BeeCodeConfig,
} from '../../shared/protocol';
import type { ToolContext } from '../../shared/tools';
import { buildSystemPrompt } from '../llm/prompts';
import { streamChat } from '../llm/client';
import type { LlmChunk, LlmImage, LlmMessage, LlmToolSchema } from '../llm/types';
import type { Logger } from '../logger';
import type { MemoryStore } from '../stores';
import type { ToolRegistry } from '../tools/registry';

export interface SessionState {
  id: string;
  title: string;
  cwd: string;
  mode: AgentMode;
  model: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  entries: TranscriptEntry[];
  messages: LlmMessage[];
  usage: { inputTokens: number; outputTokens: number };
  parentSessionId?: string;
  depth: number;
  /** Tool names auto-approved for the rest of this session ("allow for session"). */
  autoApprovedTools: Set<string>;
  pendingApproval?: ApprovalRequest;
  abort?: AbortController;
  busy: boolean;
  /** True when this session was rehydrated from disk rather than created this run. */
  restored?: boolean;
}

export interface AgentLoopDeps {
  tools: (session: SessionState) => ToolRegistry;
  config: () => BeeCodeConfig;
  emit: (event: ServiceEvent) => void;
  log: Logger;
  memory: MemoryStore;
  /** Permission policy rendered for the system prompt. */
  describePolicy: () => string;
  listAgents: () => import('../../shared/protocol').AgentInfo[];
  /** Skill catalogue for the current working directory, rendered for the prompt. */
  listSkills: (cwd: string) => Promise<string>;
  /** MCP server catalogue, rendered for the prompt. */
  describeMcp: () => string;
  requestApproval: (session: SessionState, request: Omit<ApprovalRequest, 'id' | 'sessionId' | 'requestedAt'>) => Promise<'allow' | 'allow-session' | 'deny'>;
}

const MAX_TOOL_RESULT_CHARS = 24_000;

/** Ceiling for the "raise the step limit" button, so a runaway loop cannot be uncapped. */
export const MAX_STEP_LIMIT = 400;

/**
 * The limit the transcript's bump button offers: double the current limit so a long
 * task can finish in one go, capped at {@link MAX_STEP_LIMIT}. Returns the current
 * limit unchanged when there is nothing left to give, which also hides the button.
 */
export function nextStepLimit(current: number): number {
  const safe = Number.isFinite(current) ? Math.max(1, Math.floor(current)) : 1;
  return Math.min(safe * 2, Math.max(safe, MAX_STEP_LIMIT));
}

/**
 * The note the loop leaves when it runs out of steps, with the bump button attached when
 * there is room left to raise the limit.
 */
export function stepLimitNote(maxSteps: number): Omit<TranscriptEntry, 'id' | 'at'> {
  const limit = nextStepLimit(maxSteps);
  const canRaise = limit > maxSteps;
  return {
    role: 'system',
    text: canRaise
      ? `Stopped after ${maxSteps} steps without finishing. Continue the task or raise the step limit.`
      : `Stopped after ${maxSteps} steps without finishing. Continue the task or raise agent.maxSteps in settings.`,
    actions: canRaise ? [{ kind: 'raise-max-steps', current: maxSteps, next: limit }] : undefined,
  };
}

/**
 * The agentic loop: stream a completion, execute the requested tools under the
 * permission gate, feed results back, repeat until the model stops asking for tools.
 *
 * All side effects funnel through `executeTool`, which is also where every approval
 * decision is made — the model cannot bypass it because it never executes anything
 * itself.
 */
export class AgentLoop {
  constructor(private readonly deps: AgentLoopDeps) {}

  async run(session: SessionState, userText: string): Promise<void> {
    const config = this.deps.config();
    const maxSteps = Math.max(1, config.agent.maxSteps);
    session.abort = new AbortController();
    session.busy = true;

    const userEntry = this.appendEntry(session, { role: 'user', text: userText });
    session.messages.push({ role: 'user', content: userText });
    this.setStatus(session, 'thinking');

    try {
      for (let step = 0; step < maxSteps; step += 1) {
        const preset = config.models.find((m) => m.id === session.model) ?? config.models[0];
        if (!preset) throw new Error('no model presets configured — add one in the Models panel');

        const tools = this.deps.tools(session);
        const schemas: LlmToolSchema[] = tools.schemas();
        const system = buildSystemPrompt({
          mode: session.mode,
          cwd: session.cwd,
          platform: process.platform,
          allowedApps: this.deps.describePolicy(),
          agentName: 'beeCode',
          subagents: this.deps.listAgents(),
          memory: await this.deps.memory.describe(session.cwd),
          skills: await this.deps.listSkills(session.cwd),
          mcp: this.deps.describeMcp(),
          isSubagent: session.depth > 0,
        });

        const messages: LlmMessage[] = [{ role: 'system', content: system }, ...session.messages];
        const assistantEntry = this.appendEntry(session, { role: 'assistant', text: '' });
        const textParts: string[] = [];
        const reasoningParts: string[] = [];
        const calls: ToolCallRecord[] = [];

        for await (const chunk of streamChat({
          preset,
          messages,
          tools: schemas,
          signal: session.abort.signal,
        })) {
          this.handleChunk(session, chunk, assistantEntry, textParts, reasoningParts, calls);
        }

        if (calls.length === 0) {
          assistantEntry.text = textParts.join('').trim() || '(no response)';
          session.messages.push({
            role: 'assistant',
            content: assistantEntry.text,
            ...(assistantEntry.reasoning ? { reasoning: assistantEntry.reasoning } : {}),
          });
          this.deps.emit({ type: 'session.entry', payload: { sessionId: session.id, entry: { ...assistantEntry } } });
          this.setStatus(session, 'idle');
          return;
        }

        assistantEntry.text = textParts.join('').trim();
        if (reasoningParts.length) assistantEntry.reasoning = reasoningParts.join('');
        assistantEntry.toolCalls = calls;
        session.messages.push({
          role: 'assistant',
          content: assistantEntry.text,
          toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
          // Reasoning models (DeepSeek thinking mode) require their own reasoning to come
          // back on the next request; dropping it is a hard 400.
          ...(assistantEntry.reasoning ? { reasoning: assistantEntry.reasoning } : {}),
        });
        this.deps.emit({ type: 'session.entry', payload: { sessionId: session.id, entry: { ...assistantEntry } } });

        let stopTurn = false;
        const executed = new Set<string>();
        const images: LlmImage[] = [];
        for (const call of calls) {
          if (session.abort.signal.aborted) break;
          executed.add(call.id);
          try {
            const outcome = await this.executeTool(session, call, tools);
            if (outcome.images?.length) images.push(...outcome.images);
            if (outcome.stopTurn) stopTurn = true;
          } catch (err) {
            // A throwing tool must still answer its tool_call — see the filler loop below.
            const message = err instanceof Error ? err.message : String(err);
            const outcome = this.finishTool(session, call, {
              content: JSON.stringify({ error: `tool failed: ${message}` }),
              failed: true,
            });
            if (outcome.stopTurn) stopTurn = true;
          }
        }
        // One tool message per tool_call, always: strict OpenAI-compatible providers
        // (DeepSeek behind litellm, Azure) reject the whole history with a 400 when a call
        // is left unanswered, and the error only appears on the *following* request.
        for (const call of calls) {
          if (executed.has(call.id)) continue;
          this.finishTool(session, call, {
            content: JSON.stringify({ error: 'not executed: the turn was cancelled before this call ran' }),
            failed: true,
          });
        }
        // Images come last so they cannot split the call/result block.
        if (images.length) {
          session.messages.push({ role: 'user', content: '(screenshot captured by desktop_screenshot)', images });
        }
        if (stopTurn) {
          this.setStatus(session, 'idle');
          return;
        }
        this.setStatus(session, 'thinking');
      }

      // Offer the bump where the user finds out they need it: the renderer turns the
      // action into a button, so nobody has to hunt for the setting behind the message.
      const note = this.appendEntry(session, stepLimitNote(maxSteps));
      this.deps.emit({ type: 'session.entry', payload: { sessionId: session.id, entry: note } });
      this.setStatus(session, 'idle');
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError' || session.abort?.signal.aborted;
      const message = aborted ? 'Aborted by user' : err instanceof Error ? err.message : String(err);
      this.deps.log.error('agent loop failed', { sessionId: session.id, message });
      if (!aborted) {
        const entry = this.appendEntry(session, { role: 'system', text: `Error: ${message}` });
        this.deps.emit({ type: 'session.entry', payload: { sessionId: session.id, entry } });
      }
      this.setStatus(session, aborted ? 'aborted' : 'error');
      if (!aborted) this.deps.emit({ type: 'error', payload: { sessionId: session.id, message } });
    } finally {
      session.busy = false;
      session.abort = undefined;
      if (session.status === 'aborted') this.setStatus(session, 'idle');
      void userEntry;
    }
  }

  private handleChunk(
    session: SessionState,
    chunk: LlmChunk,
    entry: TranscriptEntry,
    textParts: string[],
    reasoningParts: string[],
    calls: ToolCallRecord[],
  ): void {
    switch (chunk.type) {
      case 'text':
        textParts.push(chunk.text);
        entry.text = textParts.join('');
        this.deps.emit({
          type: 'assistant.delta',
          payload: { sessionId: session.id, entryId: entry.id, text: chunk.text },
        });
        break;
      case 'reasoning':
        reasoningParts.push(chunk.text);
        break;
      case 'tool-call':
        calls.push(chunk.call);
        this.deps.emit({ type: 'tool.call', payload: { sessionId: session.id, call: chunk.call } });
        break;
      case 'usage':
        session.usage.inputTokens += chunk.inputTokens;
        session.usage.outputTokens += chunk.outputTokens;
        break;
    }
  }

  /** Permission gate + execution + transcript bookkeeping for one tool call. */
  private async executeTool(
    session: SessionState,
    call: ToolCallRecord,
    tools: ToolRegistry,
  ): Promise<{ stopTurn: boolean; images?: LlmImage[] }> {
    const tool = tools.get(call.name);
    if (!tool) {
      return this.finishTool(session, call, {
        content: JSON.stringify({ error: `unknown tool "${call.name}"`, available: tools.names() }),
        failed: true,
      });
    }

    // Plan mode never mutates: refuse before any approval prompt so the model adapts.
    if (session.mode === 'plan' && tool.mutating) {
      return this.finishTool(session, call, {
        content: JSON.stringify({
          error: `plan mode is read-only — "${call.name}" was not executed. Present the plan instead.`,
        }),
        failed: true,
      });
    }

    const ctx: ToolContext = {
      sessionId: session.id,
      cwd: session.cwd,
      mode: session.mode,
      // An empty cwd stays empty: the registry refuses workspace-less file/shell calls
      // instead of letting them resolve against the process directory.
      workspaceRoots: session.cwd ? [session.cwd] : [],
      signal: session.abort?.signal ?? new AbortController().signal,
      parentSessionId: session.parentSessionId,
      depth: session.depth,
    };

    const preview = tool.preview
      ? await tool.preview(call.args, ctx)
      : {
          requiresApproval: tool.mutating,
          summary: `${call.name} ${JSON.stringify(call.args).slice(0, 160)}`,
          reason: 'mutating tool',
        };

    const config = this.deps.config();
    const autoApproved =
      session.mode === 'autonomous' ||
      session.autoApprovedTools.has(call.name) ||
      config.agent.autoApproveTools.includes(call.name);

    if (preview.requiresApproval && !autoApproved) {
      this.setStatus(session, 'awaiting-approval');
      const decision = await this.deps.requestApproval(session, {
        toolName: call.name,
        toolArgs: call.args,
        summary: preview.summary,
        reason: preview.reason,
        options: ['allow', 'allow-session', 'deny'],
      });
      session.pendingApproval = undefined;
      if (decision === 'deny') {
        this.setStatus(session, 'running-tool');
        return this.finishTool(session, call, {
          content: JSON.stringify({ error: 'the user denied this action', denied: true }),
          failed: true,
        });
      }
      if (decision === 'allow-session') session.autoApprovedTools.add(call.name);
    }

    this.setStatus(session, 'running-tool');
    const result = await tools.execute(call.name, call.args, ctx);

    // A screenshot payload travels as an image message (vision models), not as text.
    // It is deliberately NOT pushed here: the caller appends images only after every tool
    // reply of the turn, because a user message inside a tool_calls block is rejected by
    // strict OpenAI-compatible servers (DeepSeek/litellm) with a 400 on the next request.
    const images = (result.meta?.images as LlmImage[] | undefined) ?? [];

    const stopTurn = result.meta?.awaitingUser === true;
    const finished = this.finishTool(session, call, result);
    return { stopTurn: stopTurn || finished.stopTurn, images };
  }

  private finishTool(
    session: SessionState,
    call: ToolCallRecord,
    result: { content: string; failed?: boolean; meta?: Record<string, unknown> },
  ): { stopTurn: boolean } {
    const text = result.content.length > MAX_TOOL_RESULT_CHARS
      ? `${result.content.slice(0, MAX_TOOL_RESULT_CHARS)}…[truncated]`
      : result.content;
    const entry = this.appendEntry(session, {
      role: 'tool',
      text,
      toolCallId: call.id,
      toolName: call.name,
      toolResult: text,
      failed: result.failed === true,
    });
    session.messages.push({
      role: 'tool',
      content: text,
      toolCallId: call.id,
      toolName: call.name,
      toolFailed: result.failed === true,
    });
    this.deps.emit({ type: 'tool.result', payload: { sessionId: session.id, callId: call.id, name: call.name, result: text, failed: result.failed === true, meta: result.meta } });
    void entry;
    return { stopTurn: false };
  }

  private appendEntry(session: SessionState, entry: Omit<TranscriptEntry, 'id' | 'at'>): TranscriptEntry {
    const full: TranscriptEntry = {
      id: `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      at: new Date().toISOString(),
      ...entry,
    };
    session.entries.push(full);
    session.updatedAt = full.at;
    return full;
  }

  private setStatus(session: SessionState, status: SessionStatus): void {
    session.status = status;
    session.updatedAt = new Date().toISOString();
    this.deps.emit({ type: 'session.status', payload: { sessionId: session.id, status } });
  }
}

export function summarizeSession(session: SessionState): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    mode: session.mode,
    model: session.model,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.entries.filter((e) => e.role === 'user' || e.role === 'assistant').length,
    parentSessionId: session.parentSessionId,
  };
}

export function snapshotSession(session: SessionState): SessionSnapshot {
  return {
    ...summarizeSession(session),
    entries: session.entries.map((e) => ({ ...e })),
    pendingApproval: session.pendingApproval ? { ...session.pendingApproval } : undefined,
    usage: { ...session.usage },
    restored: session.restored === true ? true : undefined,
  };
}
