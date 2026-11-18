import type { SkillInfo } from '../../shared/protocol';
import type { AuditLog } from '../audit';
import type { DesktopController } from '../desktop/controller';
import type { McpManager } from '../mcp/manager';
import type { PolicyEngine } from '../policy';
import type { SkillStore } from '../skills/store';
import type { MemoryStore, TodoStore } from '../stores';
import type { SubagentRunner } from '../subagents/runner';
import { agentTools } from './agents';
import { controlTools } from './control';
import { desktopTools } from './desktop';
import { fileTools } from './files';
import { ToolRegistry } from './registry';
import { shellTools } from './shell';
import { skillTools } from './skills';

export interface ToolDeps {
  controller: DesktopController;
  policy: PolicyEngine;
  audit: AuditLog;
  subagents: SubagentRunner;
  todos: TodoStore;
  memory: MemoryStore;
  skills: SkillStore;
  /** Rescans the skill roots for a working directory (config-aware). */
  scanSkills: (cwd: string) => Promise<SkillInfo[]>;
  /** MCP servers; when present their tools join the catalogue. */
  mcp?: McpManager;
}

/** Read-only tools a nested (internal) subagent is allowed to use. */
export const SUBAGENT_TOOL_ALLOWLIST = new Set([
  'desktop_list_apps',
  'desktop_list_windows',
  'desktop_ui_tree',
  'desktop_screenshot',
  'fs_list',
  'fs_read',
  'fs_search',
  'todo_write',
  'todo_read',
  'memory_read',
  'skill',
]);

export function buildToolRegistry(deps: ToolDeps, options: { allowDelegation: boolean; readOnly?: boolean }): ToolRegistry {
  const registry = new ToolRegistry().register(
    ...desktopTools({ controller: deps.controller, policy: deps.policy }),
    ...fileTools({ policy: deps.policy, audit: deps.audit }),
    ...shellTools({ policy: deps.policy, audit: deps.audit }),
    ...controlTools({ todos: deps.todos, memory: deps.memory }),
    ...skillTools({ store: deps.skills, scan: deps.scanSkills }),
    ...agentTools({ subagents: deps.subagents, allowDelegation: options.allowDelegation }),
    ...(deps.mcp ? deps.mcp.toolDefinitions() : []),
  );

  if (!options.readOnly) return registry;
  return registry.subset((tool) => SUBAGENT_TOOL_ALLOWLIST.has(tool.name));
}

export { ToolRegistry } from './registry';
