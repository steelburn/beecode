import type { SkillInfo } from '../../shared/protocol';
import type { ToolDefinition } from '../../shared/tools';
import type { AuditLog } from '../audit';
import type { DesktopController } from '../desktop/controller';
import type { McpManager } from '../mcp/manager';
import type { PolicyEngine } from '../policy';
import type { SkillStore } from '../skills/store';
import type { SlateStore } from '../slates';
import type { GoalStore, MemoryStore, TodoStore } from '../stores';
import type { SubagentRunner } from '../subagents/runner';
import type { BrowserController } from '../browser/controller';
import { agentTools } from './agents';
import { browserTools } from './browser';
import { controlTools } from './control';
import { desktopTools } from './desktop';
import { fileTools } from './files';
import { ToolRegistry } from './registry';
import { schedulerTools, type SchedulerToolDeps } from './scheduler';
import { shellTools } from './shell';
import { skillTools } from './skills';
import { slateTools } from './slates';

export interface ToolDeps {
  controller: DesktopController;
  browser: BrowserController;
  policy: PolicyEngine;
  audit: AuditLog;
  subagents: SubagentRunner;
  goals: GoalStore;
  todos: TodoStore;
  memory: MemoryStore;
  /** Goal/to-do feature switch: when false the planning tools are not registered. */
  goalTodoEnabled: boolean;
  /**
   * Tool names the user switched off (Settings → Tools). They stay registered so the
   * settings list can offer them back, but the model never sees or calls them.
   */
  disabledTools: Iterable<string>;
  skills: SkillStore;
  /** Slate store behind create_slate / update_slate and the slate tab. */
  slates: SlateStore;
  /** Rescans the skill roots for a working directory (config-aware). */
  scanSkills: (cwd: string) => Promise<SkillInfo[]>;
  /** Scheduler store + runner behind the `schedule` tool; absent when scheduling is off. */
  scheduler?: SchedulerToolDeps;
  /** MCP servers; when present their tools join the catalogue. */
  mcp?: McpManager;
  /**
   * Plugins; when present their tools join the catalogue exactly like MCP tools. The
   * host is given the names already taken so a plugin can never shadow a core tool.
   */
  plugins?: { toolDefinitions(reserved: Iterable<string>): ToolDefinition[] };
}

/** Read-only tools a nested (internal) subagent is allowed to use. */
export const SUBAGENT_TOOL_ALLOWLIST = new Set([
  'desktop_list_apps',
  'desktop_list_windows',
  'desktop_ui_tree',
  'desktop_screenshot',
  'browser_snapshot',
  'browser_tabs',
  'fs_list',
  'fs_read',
  'fs_search',
  'todo_write',
  'todo_read',
  'goal_read',
  'memory_read',
  'skill',
]);

export function buildToolRegistry(deps: ToolDeps, options: { allowDelegation: boolean; readOnly?: boolean }): ToolRegistry {
  const registry = new ToolRegistry().register(
    ...desktopTools({ controller: deps.controller, policy: deps.policy }),
    ...browserTools({ controller: deps.browser, policy: deps.policy }),
    ...fileTools({ policy: deps.policy, audit: deps.audit }),
    ...shellTools({ policy: deps.policy, audit: deps.audit }),
    ...controlTools({
      goals: deps.goals,
      todos: deps.todos,
      memory: deps.memory,
      goalTodoEnabled: deps.goalTodoEnabled,
    }),
    ...skillTools({ store: deps.skills, scan: deps.scanSkills }),
    ...slateTools({ store: deps.slates, policy: deps.policy }),
    ...(deps.scheduler ? schedulerTools(deps.scheduler) : []),
    ...agentTools({ subagents: deps.subagents, allowDelegation: options.allowDelegation }),
    ...(deps.mcp ? deps.mcp.toolDefinitions() : []),
  );

  // Plugin tools are appended after the core ones, and the names taken so far are
  // handed over as reserved: a plugin tool therefore never shadows a core tool, and
  // a rebuild triggered by `plugins.reload()` cannot make a plugin tool collide with
  // the copy of itself that the previous registry still reports.
  if (deps.plugins) registry.register(...deps.plugins.toolDefinitions(registry.names()));

  registry.setDisabled(deps.disabledTools);
  if (!options.readOnly) return registry;
  return registry.subset((tool) => SUBAGENT_TOOL_ALLOWLIST.has(tool.name));
}

export { ToolRegistry } from './registry';
