import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { SkillInfo } from '../../shared/protocol';
import { paths } from '../../shared/tools';

/** A skill as loaded from disk: metadata plus the markdown instructions. */
export interface SkillRecord {
  info: SkillInfo;
  /** Markdown body with the YAML front matter stripped. */
  body: string;
}

export interface SkillScanOptions {
  cwd: string;
  /** Extra roots from config (`skills.dirs`); relative paths resolve against `cwd`. */
  extraDirs?: string[];
  /** Hard cap on a single SKILL.md so one file cannot flood the context window. */
  maxBytes?: number;
}

interface SkillRoot {
  dir: string;
  source: 'user' | 'project';
}

/** Default cap for a skill file (64 KiB is far more than a playbook needs). */
export const DEFAULT_SKILL_MAX_BYTES = 64 * 1024;

const CANDIDATE_FILES = ['SKILL.md', 'skill.md', 'README.md'];

/**
 * Discovers `SKILL.md` playbooks on disk and hands their instructions to the agent.
 *
 * Roots, in override order (later wins):
 *   ~/.beecode/skills/<name>/SKILL.md      (user)
 *   <cwd>/.beecode/skills/<name>/SKILL.md  (project)
 *   <extra dirs from config>               (project)
 *
 * A flat `<root>/<name>.md` works too. Front matter is a small `key: value` subset
 * (`name`, `description`) — no YAML parser is pulled in for that.
 */
export class SkillStore {
  private skills = new Map<string, SkillRecord>();
  private scannedCwd = '';

  /** Re-scans every root. Cheap enough to run once per session/tool call. */
  async load(options: SkillScanOptions): Promise<SkillInfo[]> {
    const maxBytes = options.maxBytes ?? DEFAULT_SKILL_MAX_BYTES;
    const found = new Map<string, SkillRecord>();
    for (const root of this.roots(options)) {
      for (const record of await scanRoot(root, maxBytes)) {
        // Later roots are more specific, so a project skill overrides a user one.
        found.set(record.info.name, record);
      }
    }
    this.skills = found;
    this.scannedCwd = options.cwd;
    return this.list();
  }

  /** Scans only when the working directory changed since the last scan. */
  async ensure(options: SkillScanOptions): Promise<SkillInfo[]> {
    if (this.scannedCwd === options.cwd) return this.list();
    return this.load(options);
  }

  list(): SkillInfo[] {
    return [...this.skills.values()]
      .map((record) => record.info)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): SkillRecord | undefined {
    const key = slug(name);
    const direct = this.skills.get(key);
    if (direct) return direct;
    const lowered = name.trim().toLowerCase();
    return [...this.skills.values()].find((record) => record.info.name === lowered);
  }

  /**
   * Deletes one installed skill and re-scans.
   *
   * The target is the folder that holds the `SKILL.md` — so scripts and references next
   * to it go too — or the `.md` file itself for a skill that sits flat in a root. Only a
   * path inside a scan root is ever removed: a name that vanished since the last scan, or a
   * record pointing somewhere else, is refused instead of guessed at.
   */
  async remove(name: string, options: SkillScanOptions): Promise<{ removed: string; skills: SkillInfo[] }> {
    const record = this.get(name);
    if (!record) throw new Error(`no skill named "${name}"`);

    const file = resolve(record.info.path);
    const folder = dirname(file);
    const root = this.roots(options).find((entry) => within(entry.dir, file));
    if (!root) throw new Error(`"${name}" lives outside the skill folders — refusing to delete it`);

    const target = folder === resolve(root.dir) ? file : folder;
    await rm(target, { recursive: true, force: true });
    return { removed: target, skills: await this.load(options) };
  }

  /** System-prompt section; empty string when no skill is installed. */
  describe(): string {
    const skills = this.list();
    if (!skills.length) return '';
    const lines = [
      '## Skills',
      'Reusable playbooks are installed on disk. When one matches the task, call the',
      '`skill` tool with its name FIRST and follow the returned instructions.',
      '',
      ...skills.map((skill) => `- ${skill.name} (${skill.source}) — ${skill.description}`),
    ];
    return lines.join('\n');
  }

  private roots(options: SkillScanOptions): SkillRoot[] {
    const roots: SkillRoot[] = [{ dir: join(paths().home, 'skills'), source: 'user' }];
    roots.push({ dir: join(options.cwd, '.beecode', 'skills'), source: 'project' });
    for (const dir of options.extraDirs ?? []) {
      const trimmed = (dir ?? '').trim();
      if (trimmed) roots.push({ dir: resolve(options.cwd, trimmed), source: 'project' });
    }
    return roots;
  }
}

async function scanRoot(root: SkillRoot, maxBytes: number): Promise<SkillRecord[]> {
  let entries;
  try {
    entries = await readdir(root.dir, { withFileTypes: true });
  } catch {
    return []; // Missing root is normal: most users have no skills yet.
  }

  const records: SkillRecord[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const file = entry.isDirectory()
      ? findSkillFile(join(root.dir, entry.name))
      : entry.isFile() && entry.name.toLowerCase().endsWith('.md')
        ? join(root.dir, entry.name)
        : undefined;
    if (!file) continue;

    try {
      const text = await readFile(file, 'utf8');
      if (text.length > maxBytes) continue;
      const parsed = parseSkill(text, entry.name.replace(/\.md$/i, ''));
      records.push({
        info: {
          name: parsed.name,
          description: parsed.description,
          source: root.source,
          path: file,
        },
        body: parsed.body,
      });
    } catch {
      // An unreadable skill must never break discovery of the others.
    }
  }
  return records;
}

function findSkillFile(dir: string): string | undefined {
  for (const candidate of CANDIDATE_FILES) {
    const file = join(dir, candidate);
    if (existsSync(file)) return file;
  }
  return undefined;
}

function parseSkill(text: string, fallbackName: string): { name: string; description: string; body: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  let body = normalized;
  let name = '';
  let description = '';

  const front = /^---\n([\s\S]*?)\n---[ \t]*\n?/.exec(normalized);
  if (front) {
    body = normalized.slice(front[0].length);
    for (const line of front[1].split('\n')) {
      const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
      if (!match) continue;
      const key = match[1].toLowerCase();
      const value = match[2].trim().replace(/^["'](.*)["']$/, '$1');
      if (key === 'name' && value) name = value;
      else if (key === 'description' && value) description = value;
    }
  }

  const trimmedBody = body.trim();
  if (!name) {
    const heading = /^#\s+(.+)$/m.exec(trimmedBody);
    name = heading ? heading[1].trim() : fallbackName;
  }
  if (!description) description = firstParagraph(trimmedBody) || `${slug(name)} skill`;

  return { name: slug(name), description: truncate(description, 300), body: trimmedBody };
}

function firstParagraph(body: string): string {
  for (const block of body.split(/\n\s*\n/)) {
    const text = block.trim();
    if (!text || text.startsWith('#') || text.startsWith('```')) continue;
    return text.replace(/\s+/g, ' ');
  }
  return '';
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** True when `file` sits inside `dir` (or is `dir` itself). */
function within(dir: string, file: string): boolean {
  const rel = relative(resolve(dir), resolve(file));
  return !rel || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Skill names double as tool arguments, so they must be stable and URL-ish. */
export function slug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '') || 'skill'
  );
}
