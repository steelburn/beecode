import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SkillInstallInput } from '../../shared/protocol';
import { beeCodeHome } from '../../shared/tools';
import { downloadSkill } from './download';
import { slug } from './store';
import { readZip } from './zip';

/** Cap on a dropped file, in bytes: the same spirit as `skills.maxBytes`, but generous. */
const MAX_INSTALL_BYTES = 5 * 1024 * 1024;

interface InstallFile {
  /** Path relative to the skill folder. */
  path: string;
  data: Buffer | string;
}

/** `name:` from the front matter, else the first heading, else the file/folder name. */
export function skillNameFromMarkdown(text: string, fallback: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const named = front ? /^[ \t]*name[ \t]*:[ \t]*(.+)$/im.exec(front[1]) : null;
  if (named) return cleanup(named[1]);
  const heading = /^#[ \t]+(.+)$/m.exec(text);
  if (heading) return cleanup(heading[1]);
  const base = (fallback.split(/[\\/]/).pop() ?? '').replace(/\.(md|markdown|zip)$/i, '');
  return base && base.toLowerCase() !== 'skill' ? base : 'skill';
}

function cleanup(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '').trim();
}

/** Resolve `rel` under `base`, refusing anything that escapes it. */
function safePath(base: string, rel: string): string {
  const target = resolve(base, rel.replace(/\\/g, '/'));
  const inside = relative(base, target);
  if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) {
    throw new Error(`refusing to write outside the skills folder: ${rel}`);
  }
  return target;
}

async function writeSkill(root: string, name: string, files: InstallFile[]): Promise<string> {
  const folder = slug(name);
  const dir = join(root, folder);
  for (const file of files) {
    const target = safePath(dir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.data);
  }
  return folder;
}

/** Archive paths are attacker-controlled: normalize and drop anything suspicious. */
function cleanName(name: string): string | undefined {
  const normalized = name.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length) return undefined;
  if (parts.some((part) => part === '..' || part === '.')) return undefined;
  return parts.join('/');
}

/**
 * Install skills from a dropped file.
 *
 * A `SKILL.md` installs as `~/.beecode/skills/<name>/SKILL.md`; a ZIP installs every
 * folder that carries a `SKILL.md`, keeping its files (scripts, references) alongside it.
 * Reads are read-only elsewhere, so this is the only write path into the skills roots and
 * it stays inside the user-level folder the loader already scans.
 */
export async function installSkills(input: SkillInstallInput): Promise<{ installed: string[] }> {
  const root = join(beeCodeHome(), 'skills');
  const installed: string[] = [];

  // A URL install is downloaded first and then handed to the same code a dropped file
  // takes, so naming, validation and the /skills/<slug>/ layout cannot drift apart.
  if (typeof input.url === 'string' && input.url.trim() && !input.text && !input.base64) {
    const artifact = await downloadSkill(input.url.trim());
    return installSkills(
      artifact.zip
        ? { fileName: artifact.fileName, base64: artifact.data.toString('base64') }
        : { fileName: artifact.fileName, text: artifact.data.toString('utf8') },
    );
  }

  if (typeof input.text === 'string' && input.text.trim()) {
    if (Buffer.byteLength(input.text) > MAX_INSTALL_BYTES) throw new Error('that skill file is too large');
    const name = skillNameFromMarkdown(input.text, input.fileName ?? '');
    installed.push(await writeSkill(root, name, [{ path: 'SKILL.md', data: input.text }]));
    return { installed };
  }

  if (!input.base64) throw new Error('drop a SKILL.md file or a .zip archive');

  const buffer = Buffer.from(input.base64, 'base64');
  if (buffer.length > MAX_INSTALL_BYTES) throw new Error('that archive is too large');
  const entries = readZip(buffer)
    .map((entry) => ({ name: cleanName(entry.name), data: entry.data }))
    .filter((entry): entry is { name: string; data: Buffer } => Boolean(entry.name));
  const total = entries.reduce((sum, entry) => sum + entry.data.length, 0);
  if (total > MAX_INSTALL_BYTES) throw new Error('that archive expands beyond the install limit');

  // A skill is a folder holding a SKILL.md; the sibling files travel with it.
  const groups = new Map<string, Array<{ name: string; data: Buffer }>>();
  for (const entry of entries) {
    const parts = entry.name.split('/');
    const at = parts.findIndex((part) => part.toLowerCase() === 'skill.md');
    if (at < 0) continue;
    const dir = parts.slice(0, at).join('/');
    const bucket = groups.get(dir) ?? [];
    bucket.push(entry);
    groups.set(dir, bucket);
  }
  for (const entry of entries) {
    if (groups.size === 0) break;
    for (const [dir, bucket] of groups) {
      if (dir && entry.name.startsWith(`${dir}/`) && !bucket.some((file) => file.name === entry.name)) {
        bucket.push(entry);
      }
    }
  }

  if (groups.size) {
    for (const [dir, bucket] of groups) {
      const markdown = bucket.find((file) => file.name.toLowerCase().endsWith('skill.md'));
      const prefix = dir ? `${dir}/` : '';
      const files = bucket.map((file) => ({ path: file.name.slice(prefix.length), data: file.data }));
      const fallback = dir ? dir.split('/').pop() ?? '' : input.fileName ?? '';
      const name = skillNameFromMarkdown(markdown ? markdown.data.toString('utf8') : '', fallback);
      installed.push(await writeSkill(root, name, files));
    }
    return { installed };
  }

  // No SKILL.md anywhere: a loose markdown file at the archive root is still a skill.
  const loose = entries.filter((entry) => !entry.name.includes('/') && /\.(md|markdown)$/i.test(entry.name));
  if (!loose.length) throw new Error('the archive holds no SKILL.md');
  for (const entry of loose) {
    const text = entry.data.toString('utf8');
    const name = skillNameFromMarkdown(text, entry.name);
    installed.push(await writeSkill(root, name, [{ path: 'SKILL.md', data: entry.data }]));
  }
  return { installed };
}
