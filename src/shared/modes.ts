import type { AgentMode } from './protocol';

/**
 * Plain-language names for the four agent modes.
 *
 * "ask / plan / act / autonomous" is prompt engineering vocabulary: it means nothing to
 * the person deciding whether beeCode may touch their computer. The mode ids stay on the
 * wire — only what the user reads changes here.
 */
export interface ModeLabel {
  /** Short name in a selector. */
  label: string;
  /** One sentence: what this mode means for the user. */
  hint: string;
}

export const MODE_LABELS: Record<AgentMode, ModeLabel> = {
  ask: {
    label: 'Ask first',
    hint: 'BeeCode reads and explains, and stops to ask before it changes anything.',
  },
  plan: {
    label: 'Plan only',
    hint: 'BeeCode writes a step-by-step plan and changes nothing at all.',
  },
  act: {
    label: 'Work on it',
    hint: 'BeeCode does the work and asks whenever the permission rules say it must.',
  },
  autonomous: {
    label: 'Hands off',
    hint: 'BeeCode finishes the task without stopping to ask. Only for work you trust.',
  },
};

/** Every mode id, in the order the selectors show them. */
export const AGENT_MODES: AgentMode[] = ['ask', 'plan', 'act', 'autonomous'];

/** `"Ask first — BeeCode reads …"`, for a hover tooltip. */
export function describeMode(mode: AgentMode): string {
  const entry = MODE_LABELS[mode];
  return `${entry.label} — ${entry.hint}`;
}
