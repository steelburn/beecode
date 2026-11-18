import type { BeeCodeConfig, ModelPreset, PolicyDocument } from './protocol';
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
export function normalizeConfig(input: BeeCodeConfig): BeeCodeConfig {
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
    const apiKeyEnv = raw.apiKeyEnv?.trim();
    models.push({
      ...raw,
      id,
      label: (raw.label ?? '').trim() || id,
      model,
      baseUrl: baseUrl || undefined,
      apiKeyEnv: apiKeyEnv || undefined,
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
    agent: {
      ...fallback.agent,
      ...input.agent,
      workingDir: (input.agent?.workingDir ?? '').trim() || fallback.agent.workingDir,
    },
  };
}
