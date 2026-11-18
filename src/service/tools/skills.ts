import type { SkillInfo } from '../../shared/protocol';
import type { ToolDefinition } from '../../shared/tools';
import type { SkillStore } from '../skills/store';
import { errorResult, jsonResult, str } from './registry';

interface SkillToolDeps {
  store: SkillStore;
  /** Rescans the skill roots for a working directory (config-aware). */
  scan: (cwd: string) => Promise<SkillInfo[]>;
}

export function skillTools(deps: SkillToolDeps): ToolDefinition[] {
  return [
    {
      name: 'skill',
      description:
        'Load an installed skill (a reusable playbook stored as SKILL.md on disk). ' +
        'Call it with the skill name to receive the full instructions, then follow them. ' +
        'Omit the name to list the available skills. Read-only.',
      mutating: false,
      group: 'skills',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Skill name as listed in the system prompt (or omit to list every skill).',
          },
          input: {
            type: 'string',
            description: 'Optional task context the skill instructions should be applied to.',
          },
        },
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        await deps.scan(ctx.cwd);

        const name = str(args, 'name');
        if (!name) {
          const skills = deps.store.list();
          return jsonResult({
            skills: skills.map((skill) => ({
              name: skill.name,
              description: skill.description,
              source: skill.source,
            })),
            hint: skills.length
              ? 'Call skill with one of these names to load its instructions.'
              : 'No skills are installed.',
          });
        }

        const record = deps.store.get(name);
        if (!record) {
          return errorResult(`unknown skill "${name}"`, {
            available: deps.store.list().map((skill) => skill.name),
          });
        }

        const input = str(args, 'input');
        const content = [
          `<skill name="${record.info.name}" source="${record.info.source}">`,
          record.body,
          '</skill>',
          input ? `\nTask input to apply this skill to:\n${input}` : '',
          input
            ? ''
            : '\nFollow the skill instructions above for the current task.',
        ]
          .filter(Boolean)
          .join('\n');

        return {
          content: content.trim(),
          meta: { skill: record.info.name, path: record.info.path, source: record.info.source },
        };
      },
    },
  ];
}
