import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig } from '../../shared/defaults';
import { AGENT_PRESETS } from './adapters';

/**
 * Regression: the seeded CLI agents in `defaultConfig()` and the `AGENT_PRESETS` catalogue
 * had drifted apart (`claude` label `Claude CLI` vs `Claude Code`, `codex` args
 * `['exec', '--full-auto']` vs `['exec']`). Saving the External agents card rebuilds an
 * entry from the catalogue, so the first save silently rewrote those fields — a visible
 * label rename and a behaviour change (codex lost `--full-auto`).
 */
test('seeded CLI agents match the AGENT_PRESETS catalogue', () => {
  const presets = new Map(AGENT_PRESETS.map((preset) => [preset.id, preset]));
  const seeded = defaultConfig().subagents.cliAgents;

  assert.ok(seeded.length > 0, 'default config seeds no CLI agents');
  for (const agent of seeded) {
    const preset = presets.get(agent.id);
    assert.ok(preset, `seeded agent "${agent.id}" is missing from AGENT_PRESETS`);
    assert.deepEqual(
      { label: agent.label, command: agent.command, args: agent.args },
      { label: preset.label, command: preset.command, args: preset.args },
      `seeded agent "${agent.id}" drifted from AGENT_PRESETS`,
    );
  }
});
