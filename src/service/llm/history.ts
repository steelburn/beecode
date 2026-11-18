import type { LlmMessage } from './types';

/**
 * Repair a transcript before it goes over the wire.
 *
 * Strict OpenAI-compatible servers (DeepSeek behind litellm, Azure OpenAI, several
 * gateways) validate the whole history and reject a request outright when an assistant
 * message carrying `tool_calls` is not followed — immediately — by exactly one `tool`
 * message per call id:
 *
 *   "An assistant message with 'tool_calls' must be followed by tool messages responding
 *    to each 'tool_call_id'. (insufficient tool messages following tool_calls message)"
 *
 * The failure surfaces on the request *after* the offending turn, which makes it look
 * like an unrelated bug. Two shapes can produce it, so repair rather than trust:
 *  - a screenshot travels as a separate `user` message with an image, which used to be
 *    inserted before its own tool result;
 *  - a turn that was aborted (or a tool that threw) left later calls unanswered.
 *
 * Verbatim history is preserved when it is already well-formed, so the pass is safe to
 * run on every request, and it degrades gracefully on a history that is dead on arrival
 * (orphan tool replies are dropped, missing ones are synthesized) instead of 400-ing.
 */
export function repairToolHistory(messages: LlmMessage[]): LlmMessage[] {
  const involved = messages.some((m) => m.role === 'tool' || (m.role === 'assistant' && m.toolCalls?.length));
  if (!involved) return messages;

  const out: LlmMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;

    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      out.push(msg);
      const open = new Map(msg.toolCalls.map((call) => [call.id, call] as const));
      // Messages that sat *inside* the call/result block: they keep their order relative
      // to each other but are re-emitted after the replies they were interrupting.
      const deferred: LlmMessage[] = [];
      let j = i + 1;
      while (j < messages.length && open.size > 0) {
        const next = messages[j]!;
        if (next.role === 'tool') {
          if (next.toolCallId && open.has(next.toolCallId)) {
            out.push(next);
            open.delete(next.toolCallId);
          }
          // Otherwise an orphan reply (or a duplicate id): dropping it is what keeps the
          // server from rejecting the request.
          j += 1;
          continue;
        }
        // A second tool-calling assistant turn is a hard boundary — never move messages
        // across it, or an earlier turn could borrow the next turn's results.
        if (next.role === 'assistant' && next.toolCalls?.length) break;
        deferred.push(next);
        j += 1;
      }
      for (const [id, call] of open) {
        out.push({
          role: 'tool',
          content: JSON.stringify({ error: `no result recorded for tool call "${call.name}"` }),
          toolCallId: id,
          toolName: call.name,
          toolFailed: true,
        });
      }
      out.push(...deferred);
      i = j;
      continue;
    }

    if (msg.role === 'tool') {
      // A reply with no live assistant request in front of it is rejected just as hard.
      i += 1;
      continue;
    }

    out.push(msg);
    i += 1;
  }
  return out;
}
