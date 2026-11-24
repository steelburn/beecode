import type {
  BeeCodeConfig,
  BrowserConfig,
  FeaturesConfig,
  McpServerConfig,
  ModelPreset,
  PluginsConfig,
  PolicyDocument,
  SkillsConfig,
  ToolsConfig,
  WorkspaceConfig,
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
    // The workspace root is deliberately EMPTY: beeCode must never silently adopt
    // the directory the app happens to be installed in. Until the user picks a
    // folder the renderer shows the workspace setup step.
    workspace: { root: '', recent: [], restoreSession: true },
    features: { goalTodo: true },
    tools: { disabled: [] },
    models: MODEL_PRESETS,
    defaultModelId: 'claude-sonnet',
    service: { httpPort: 4870, autoStart: true },
    mcpServers: {},
    skills: { enabled: true, dirs: [], maxBytes: 65_536 },
    plugins: { enabled: true, allowExternal: true, dirs: [], disabled: [] },
    agent: {
      defaultMode: 'ask',
      maxSteps: 24,
      autoApproveTools: [],
      workingDir: '',
    },
    desktop: { enabled: true, driver: 'windows', allowInput: true },
    browser: {
      enabled: true,
      maxTabs: 4,
      homeUrl: 'https://duckduckgo.com',
      persistSession: false,
      showCursor: true,
      allowScripts: true,
    },
    subagents: {
      enabled: true,
      maxConcurrent: 3,
      cliAgents: [
        { id: 'codex', label: 'Codex CLI', command: 'codex', args: ['exec'], enabled: true },
        { id: 'claude', label: 'Claude Code', command: 'claude', args: ['-p'], enabled: true },
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
/**
 * Shell prefixes that must be allowed because beeCode ships or needs the runtime itself.
 *
 * Entries are command *names*, matched by `PolicyEngine.evaluateShell` after it normalises
 * quotes, extensions and absolute paths — not full command lines, so they also cover
 * `python -m venv` and `python -m pip`. Exported so `migratePolicy` can grant exactly these to a
 * `policy.json` written by an older build (see POLICY_DOCUMENT_VERSION 4) without resurrecting
 * other prefixes the user removed on purpose.
 */
export const DEFAULT_SHELL_RUNTIMES: readonly string[] = ['python', 'python3', 'py', 'pip', 'pip3'];

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
      // The bundled Python is allowed by default: the app ships the interpreter, so making the
      // user whitelist the runtime it just installed recreates the "no Python installed" loop.
      // The prefixes cover `python -m venv` and `python -m pip` too, plus the pip shims.
      allowedCommands: [
        'git status',
        'git diff',
        'git log',
        'git branch',
        'dir',
        'echo',
        'node --version',
        'npm run',
        ...DEFAULT_SHELL_RUNTIMES,
      ],
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
    // The internal browser is sandboxed (no OS reach), so it starts permissive but
    // audited: any http(s) host, no denies, and every interaction is logged.
    browser: {
      enabled: true,
      allowAnyHost: true,
      allowedHosts: [],
      deniedHosts: [],
      allowInput: true,
      requireApproval: false,
    },
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
/**
 * Repair the workspace block. A root that no longer exists is kept (the drive may
 * simply be unmounted) — the service reports the problem instead of silently
 * relocating the user's files.
 */
export function normalizeWorkspace(
  input: Partial<WorkspaceConfig> | undefined,
  fallback: WorkspaceConfig,
): WorkspaceConfig {
  const source = input ?? {};
  const clean = (value: unknown): string => {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    // Keep a drive root ("C:\") intact, strip trailing separators elsewhere.
    return /^[A-Za-z]:[\\/]?$/.test(trimmed) ? trimmed : trimmed.replace(/[\\/]+$/, '');
  };

  const root = clean(source.root) || fallback.root;
  const recent: string[] = [];
  const candidates = Array.isArray(source.recent) ? source.recent : fallback.recent;
  for (const candidate of candidates) {
    const dir = clean(candidate);
    if (!dir || dir === root || recent.includes(dir)) continue;
    recent.push(dir);
    if (recent.length >= 8) break;
  }
  return {
    root,
    recent,
    restoreSession:
      typeof source.restoreSession === 'boolean'
        ? source.restoreSession
        : fallback.restoreSession ?? true,
  };
}

/** Feature switches default to ON: an unknown payload must not silently drop a tool. */
export function normalizeFeatures(
  input: Partial<FeaturesConfig> | undefined,
  fallback: FeaturesConfig,
): FeaturesConfig {
  return {
    goalTodo: typeof input?.goalTodo === 'boolean' ? input.goalTodo : fallback.goalTodo,
  };
}

/**
 * Tool switches: names are trimmed, de-duplicated and sorted so the config diff stays
 * readable. Unknown names are kept — an MCP or plugin tool can come back later.
 */
export function normalizeTools(
  input: Partial<ToolsConfig> | undefined,
  fallback: ToolsConfig,
): ToolsConfig {
  const raw = Array.isArray(input?.disabled)
    ? input.disabled
    : Array.isArray(fallback.disabled)
      ? fallback.disabled
      : [];
  const names = raw
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.trim())
    .filter(Boolean);
  return { disabled: [...new Set(names)].sort() };
}

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
  const workspace = normalizeWorkspace(input.workspace, fallback.workspace);
  return {
    ...input,
    workspace,
    features: normalizeFeatures(input.features, fallback.features),
    tools: normalizeTools(input.tools, fallback.tools),
    models,
    defaultModelId: models.some((model) => model.id === input.defaultModelId)
      ? input.defaultModelId
      : models[0].id,
    mcpServers: normalizeMcpServers(input.mcpServers),
    browser: normalizeBrowser(input.browser, fallback.browser),
    skills: normalizeSkills(input.skills, fallback.skills),
    agent: {
      ...fallback.agent,
      ...input.agent,
      // Explicit agent.workingDir wins, then the user's workspace root. Never
      // process.cwd(): that is the installation directory in a packaged app.
      workingDir:
        (input.agent?.workingDir ?? '').trim() || workspace.root || fallback.agent.workingDir,
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

/**
 * Repairs the browser block of a config written by an older build (missing keys) and
 * clamps the tab cap: an unbounded `maxTabs` would let the agent open windows until the
 * process runs out of memory, and 0 would make `browser_open` useless.
 */
function normalizeBrowser(input: BrowserConfig | undefined, fallback: BrowserConfig): BrowserConfig {
  const merged = { ...fallback, ...(input ?? {}) };
  const requested = Math.round(Number(merged.maxTabs));
  return {
    ...merged,
    maxTabs: Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 12) : fallback.maxTabs,
    homeUrl: (merged.homeUrl ?? '').trim() || fallback.homeUrl,
  };
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

/* ----------------------------------------------------------------- plugins */

export function normalizePlugins(
  input: Partial<PluginsConfig> | undefined,
  fallback: PluginsConfig,
): PluginsConfig {
  const source = input ?? {};
  const dirs = Array.isArray(source.dirs)
    ? source.dirs
        .filter((dir): dir is string => typeof dir === 'string' && dir.trim().length > 0)
        .map((dir) => dir.trim())
    : fallback.dirs;
  const disabled = Array.isArray(source.disabled)
    ? [
        ...new Set(
          source.disabled
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
            .map((id) => id.trim().toLowerCase()),
        ),
      ]
    : fallback.disabled;
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
    allowExternal: typeof source.allowExternal === 'boolean' ? source.allowExternal : fallback.allowExternal,
    dirs,
    disabled,
  };
}
