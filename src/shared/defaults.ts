import type {
  BeeCodeConfig,
  McpServerConfig,
  ModelPreset,
  PolicyDocument,
  SkillsConfig,
} from './protocol';
import { POLICY_DOCUMENT_VERSION } from './protocol';

/**
 * Curated model presets. Keys are read from env vars — api keys are never persisted
 * in config.json (it is world-readable user state).
 */
export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'claude-sonnet',
    label: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    contextWindow: 200_000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    provider: 'openai',
    model: 'gpt-4o',
    apiKeyEnv: 'OPENAI_API_KEY',
    contextWindow: 128_000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'gpt-4.1',
    label: 'GPT-4.1',
    provider: 'openai',
    model: 'gpt-4.1',
    apiKeyEnv: 'OPENAI_API_KEY',
    contextWindow: 1_000_000,
    supportsVision: true,
    supportsTools: true,
  },
  {
    id: 'local',
    label: 'Local (Ollama / LM Studio)',
    provider: 'openai-compatible',
    model: 'qwen2.5-coder:14b',
    baseUrl: 'http://127.0.0.1:11434/v1',
    contextWindow: 32_000,
    supportsVision: false,
    supportsTools: true,
  },
];

export function defaultConfig(): BeeCodeConfig {
  return {
    version: 1,
    models: MODEL_PRESETS,
    defaultModelId: 'claude-sonnet',
    service: { httpPort: 4870, autoStart: true },
    mcpServers: {},
    skills: { enabled: true, dirs: [], maxBytes: 65_536 },
    agent: {
      defaultMode: 'ask',
      maxSteps: 24,
      autoApproveTools: [],
      workingDir: process.cwd(),
    },
    desktop: { enabled: true, driver: 'windows', allowInput: true },
    subagents: {
      enabled: true,
      maxConcurrent: 3,
      cliAgents: [
        { id: 'codex', label: 'Codex CLI', command: 'codex', args: ['exec', '--full-auto'], enabled: true },
        { id: 'claude', label: 'Claude CLI', command: 'claude', args: ['-p'], enabled: true },
        { id: 'gemini', label: 'Gemini CLI', command: 'gemini', args: ['-p'], enabled: true },
        { id: 'aider', label: 'Aider', command: 'aider', args: ['--message'], enabled: false },
      ],
    },
  };
}

/**
 * Default desktop policy: deny-by-default with a small, safe starter set.
 * Everything the agent can touch on the desktop must appear here first.
 */
export function defaultPolicy(): PolicyDocument {
  return {
    version: POLICY_DOCUMENT_VERSION,
    defaultDecision: 'deny',
    allowedApps: [
      {
        id: 'notepad',
        name: 'Notepad',
        exe: ['notepad.exe'],
        actions: ['launch', 'focus', 'read', 'invoke', 'click', 'type', 'key', 'screenshot', 'resize', 'close'],
        autoApprove: true,
      },
      {
        id: 'calculator',
        name: 'Calculator',
        exe: ['calc.exe', 'CalculatorApp.exe', 'Calculator.exe'],
        actions: ['launch', 'focus', 'read', 'invoke', 'click', 'key', 'screenshot', 'resize', 'close'],
        autoApprove: true,
      },
      {
        id: 'paint',
        name: 'Paint',
        exe: ['mspaint.exe'],
        actions: ['launch', 'focus', 'read', 'invoke', 'click', 'type', 'key', 'screenshot', 'resize', 'close'],
      },
      {
        id: 'explorer',
        name: 'File Explorer',
        exe: ['explorer.exe'],
        // Read-only by default: no typing or clicking inside Explorer.
        actions: ['launch', 'focus', 'read', 'screenshot'],
      },
      {
        id: 'vscode',
        name: 'Visual Studio Code',
        exe: ['Code.exe', 'Code - Insiders.exe'],
        actions: ['launch', 'focus', 'read', 'screenshot'],
        autoApprove: false,
      },
    ],
    deniedExe: [
      'cmd.exe',
      'powershell.exe',
      'pwsh.exe',
      'wsl.exe',
      'regedit.exe',
      'mmc.exe',
      'taskmgr.exe',
      'wscript.exe',
      'cscript.exe',
      'mshta.exe',
      'rundll32.exe',
      'regsvr32.exe',
      'bitsadmin.exe',
      'certutil.exe',
      'schtasks.exe',
      'net.exe',
      'net1.exe',
      'sc.exe',
      'diskpart.exe',
      'bcdedit.exe',
      'vssadmin.exe',
      'lsass.exe',
      'winlogon.exe',
    ],
    shell: {
      enabled: true,
      allowedCommands: ['git status', 'git diff', 'git log', 'git branch', 'dir', 'echo', 'node --version', 'npm run'],
      blocked: [
        'rm -rf',
        'rmdir /s',
        'del /f',
        'format ',
        'shutdown',
        'reg delete',
        'net user',
        'Invoke-WebRequest',
        'curl ',
        'wget ',
        '> c:\\',
        'rd /s',
        'cipher /w',
      ],
    },
    filesystem: { workspaceOnly: true, allowedRoots: [], writable: true },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Trim, de-duplicate and validate a config coming from the settings UI.
 *
 * The renderer is sandboxed but its payload is still untrusted: an empty model list,
 * a duplicate preset id or a dangling defaultModelId would leave the agent loop with
 * no usable model, so the service repairs what it can and refuses the rest.
 */
export function normalizeConfig(
  input: BeeCodeConfig,
  options: { strict?: boolean } = {},
): BeeCodeConfig {
  const strict = options.strict === true;
  const seen = new Set<string>();
  const models: ModelPreset[] = [];
  for (const raw of input.models ?? []) {
    const id = (raw.id ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const model = (raw.model ?? '').trim();
    if (!id || !model || seen.has(id)) continue;
    seen.add(id);
    const baseUrl = raw.baseUrl?.trim().replace(/\/+$/, '');
    const apiKeyEnv = normalizeApiKeyEnv(raw, strict);
    models.push({
      ...raw,
      id,
      label: (raw.label ?? '').trim() || id,
      model,
      baseUrl: baseUrl || undefined,
      apiKeyEnv,
    });
  }
  if (!models.length) throw new Error('at least one model preset is required');

  const fallback = defaultConfig();
  return {
    ...input,
    models,
    defaultModelId: models.some((model) => model.id === input.defaultModelId)
      ? input.defaultModelId
      : models[0].id,
    mcpServers: normalizeMcpServers(input.mcpServers),
    skills: normalizeSkills(input.skills, fallback.skills),
    agent: {
      ...fallback.agent,
      ...input.agent,
      workingDir: (input.agent?.workingDir ?? '').trim() || fallback.agent.workingDir,
    },
  };
}

/**
 * `apiKeyEnv` is a variable *name*. Pasting the key itself into that field used to be
 * persisted verbatim: auth then failed (process.env['sk-…'] is undefined) and the secret
 * ended up in config.json, which is shareable user state. A literal is refused.
 */
function normalizeApiKeyEnv(raw: ModelPreset, strict: boolean): string | undefined {
  const value = raw.apiKeyEnv?.trim();
  if (!value) return undefined;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return value;
  if (strict) {
    throw new Error(
      `model "${raw.id || raw.label || 'preset'}": apiKeyEnv must be an environment variable name, not the key itself — ` +
        'paste the key into the API key field (stored in secrets.json), or put API_KEY in .env.llm',
    );
  }
  // Legacy config from a build that allowed it: drop the literal, never write it back.
  return undefined;
}

/* ------------------------------------------------------------ mcp & skills */

/** Coerces hand-edited `mcpServers` entries into a usable shape; unusable ones are dropped. */
export function normalizeMcpServers(input: unknown): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return servers;

  for (const [rawName, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const name = rawName.trim();
    if (!name || !rawValue || typeof rawValue !== 'object') continue;

    const value = rawValue as Partial<McpServerConfig>;
    const transport = value.transport === 'http' ? 'http' : 'stdio';
    const command = typeof value.command === 'string' ? value.command.trim() : '';
    const url = typeof value.url === 'string' ? value.url.trim() : '';
    if (transport === 'stdio' ? !command : !url) continue;

    servers[name] = {
      enabled: value.enabled !== false,
      transport,
      command: command || undefined,
      args: Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === 'string') : [],
      env: stringRecord(value.env),
      url: url || undefined,
      headers: stringRecord(value.headers),
      timeoutMs:
        typeof value.timeoutMs === 'number' && value.timeoutMs > 0 ? Math.round(value.timeoutMs) : 30_000,
    };
  }
  return servers;
}

function stringRecord(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeSkills(input: Partial<SkillsConfig> | undefined, fallback: SkillsConfig): SkillsConfig {
  return {
    enabled: input?.enabled !== false,
    dirs: Array.isArray(input?.dirs)
      ? input.dirs
          .filter((dir): dir is string => typeof dir === 'string' && !!dir.trim())
          .map((dir) => dir.trim())
      : [],
    maxBytes:
      typeof input?.maxBytes === 'number' && input.maxBytes > 0
        ? Math.round(input.maxBytes)
        : fallback.maxBytes,
  };
}
