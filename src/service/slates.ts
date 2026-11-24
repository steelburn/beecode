import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SLATE_LIMITS } from '../shared/protocol';

/**
 * A slate is a document the agent writes for the app to render in its own tab, next to
 * the chat — instead of pasting the whole document into the transcript.
 *
 * Versions are append-only files (`001-<id>.md`, `002-<id>.md`, …) and `meta.json` holds
 * the pointer to the version the UI shows, so pinning an old version stays possible and
 * two versions can be compared without a shadow history:
 *
 *   <cwd>/.beecode/slates/<session>/<id>/001-<id>.md
 *                                        002-<id>.md
 *                                        meta.json
 *
 * The kind is fixed at creation: the version file's extension follows it, so a folder
 * with mixed extensions would render differently version to version.
 */
export type SlateKind = 'markdown' | 'html' | 'csv';

export const SLATE_KINDS: readonly SlateKind[] = ['markdown', 'html', 'csv'];

const EXTENSION: Record<SlateKind, string> = { markdown: 'md', html: 'html', csv: 'csv' };

/** One immutable version file. `n` is 1-based and matches the `NNN-` prefix. */
export interface SlateVersion {
  n: number;
  file: string;
  bytes: number;
  createdAt: string;
}

export interface SlateMeta {
  id: string;
  title: string;
  kind: SlateKind;
  /** Version the UI renders; moves with every update. */
  current: number;
  versions: SlateVersion[];
  createdAt: string;
  updatedAt: string;
  /** Origins an `html` slate may reach. Never a wildcard. */
  origins?: string[];
}

export interface SlateLocation {
  /** Workspace folder the slate belongs to — slates never live outside it. */
  cwd: string;
  sessionId: string;
}

export interface SlateRead extends SlateLocation {
  id: string;
  /** Defaults to `meta.current`. */
  version?: number;
}

/** One version with its body. `path` is the absolute file the UI renders as a tab. */
export interface SlateContent {
  meta: SlateMeta;
  version: SlateVersion;
  path: string;
  content: string;
}

/**
 * The three hard caps (`SLATE_LIMITS`): a slate is a document, not an archive, a log or a
 * database. They are refusals, never pruning — nothing the agent was told to keep vanishes
 * silently, and the refusal says which slate to remove.
 */
export const MAX_SLATE_BYTES = SLATE_LIMITS.versionBytes;
export const MAX_SLATE_VERSIONS = SLATE_LIMITS.versions;
export const MAX_SLATES_PER_SESSION = SLATE_LIMITS.slates;

const MAX_ID_LENGTH = 64;

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeSegment(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned.slice(0, MAX_ID_LENGTH) : fallback;
}

/** `Sales Q3` → `sales-q3`; an unusable title falls back to `slate`. */
export function slateIdFrom(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'slate';
}

/**
 * Rejects an id that could escape its folder. Ids reach us from the model and from the
 * renderer, so separators, `..` and absolute paths are refused rather than normalised.
 */
export function assertSlateId(id: string): string {
  const value = id.trim();
  if (!value) throw new Error('slate id is empty');
  if (value.length > MAX_ID_LENGTH) throw new Error('slate id is too long (limit is 64 characters)');
  if (value.includes('/') || value.includes('\\') || value.includes('..') || isAbsolute(value)) {
    throw new Error(`refusing slate id "${id}": path separators and ".." are not allowed`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`refusing slate id "${id}": only letters, digits, ".", "_" and "-" are allowed`);
  }
  return value;
}

function normaliseKind(kind: string): SlateKind {
  const value = kind.trim().toLowerCase();
  if (value === 'md') return 'markdown';
  if ((SLATE_KINDS as readonly string[]).includes(value)) return value as SlateKind;
  throw new Error(`unsupported slate kind "${kind}" — use ${SLATE_KINDS.join(', ')}`);
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function assertSize(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_SLATE_BYTES) {
    throw new Error(
      `slate content is ${formatBytes(bytes)} — the limit is ${formatBytes(MAX_SLATE_BYTES)} per version; split it or trim it`,
    );
  }
}

function versionFile(n: number, id: string, kind: SlateKind): string {
  return `${String(n).padStart(3, '0')}-${id}.${EXTENSION[kind]}`;
}

export class SlateStore {
  /** `<cwd>/.beecode/slates` — the parent of the per-session folders. */
  root(cwd: string): string {
    if (!cwd) throw new Error('no workspace folder is selected — a slate lives in the workspace');
    return join(cwd, '.beecode', 'slates');
  }

  /** `<cwd>/.beecode/slates/<session>`. */
  sessionRoot(location: SlateLocation): string {
    return join(this.root(location.cwd), safeSegment(location.sessionId, 'session'));
  }

  slateDir(location: SlateLocation & { id: string }): string {
    const sessionRoot = this.sessionRoot(location);
    const dir = join(sessionRoot, assertSlateId(location.id));
    if (!isWithin(sessionRoot, dir)) {
      throw new Error(`refusing slate id "${location.id}": it resolves outside the session folder`);
    }
    return dir;
  }

  /**
   * Slates are folders, so the cap is a directory count: parsing every meta.json would make
   * creating the hundredth slate read the other ninety-nine first.
   */
  private async countSlates(sessionRoot: string): Promise<number> {
    const entries = await readdir(sessionRoot, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).length;
  }

  /** Creates the slate and its first version, `001-<id>.<ext>`. */
  async create(
    input: SlateLocation & { title: string; kind: string; content: string; origins?: string[] },
  ): Promise<SlateMeta> {
    const kind = normaliseKind(input.kind);
    assertSize(input.content);
    const title = input.title.trim() || 'Untitled slate';
    const sessionRoot = this.sessionRoot(input);
    await mkdir(sessionRoot, { recursive: true });
    const existing = await this.countSlates(sessionRoot);
    if (existing >= MAX_SLATES_PER_SESSION) {
      throw new Error(
        `this session already holds ${existing} slates — the limit is ${MAX_SLATES_PER_SESSION}; remove one with slate.remove before creating another`,
      );
    }
    const id = await this.freeId(sessionRoot, slateIdFrom(title));
    const dir = join(sessionRoot, id);
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    const file = versionFile(1, id, kind);
    await writeFile(join(dir, file), input.content, 'utf8');
    const meta: SlateMeta = {
      id,
      title,
      kind,
      current: 1,
      versions: [{ n: 1, file, bytes: Buffer.byteLength(input.content, 'utf8'), createdAt: now }],
      createdAt: now,
      updatedAt: now,
    };
    const origins = (input.origins ?? []).map((origin) => origin.trim()).filter(Boolean);
    if (origins.length) meta.origins = origins;
    await this.writeMeta(dir, meta);
    return meta;
  }

  /**
   * Appends the next version and moves `meta.current` to it. Existing version files are
   * never rewritten, so an older version stays byte-identical.
   */
  async update(input: SlateLocation & { id: string; content: string }): Promise<SlateMeta> {
    assertSize(input.content);
    const meta = await this.meta(input);
    if (meta.versions.length >= MAX_SLATE_VERSIONS) {
      throw new Error(
        `slate "${meta.id}" already has ${meta.versions.length} versions — the limit is ${MAX_SLATE_VERSIONS}; create a new slate for a fresh document`,
      );
    }
    const dir = this.slateDir(input);
    const now = new Date().toISOString();
    const n = meta.versions.reduce((max, version) => Math.max(max, version.n), 0) + 1;
    const file = versionFile(n, meta.id, meta.kind);
    await writeFile(join(dir, file), input.content, 'utf8');
    meta.versions.push({ n, file, bytes: Buffer.byteLength(input.content, 'utf8'), createdAt: now });
    meta.current = n;
    meta.updatedAt = now;
    await this.writeMeta(dir, meta);
    return meta;
  }

  /** Reads one version's text — the current one unless `version` pins another. */
  async read(input: SlateRead): Promise<SlateContent> {
    const meta = await this.meta(input);
    const n = input.version ?? meta.current;
    const version = meta.versions.find((candidate) => candidate.n === n);
    if (!version) throw new Error(`slate "${meta.id}" has no version ${n}`);
    const dir = this.slateDir(input);
    const file = join(dir, version.file);
    if (!isWithin(dir, file)) throw new Error(`slate "${meta.id}" version ${n} points outside its folder`);
    const content = await readFile(file, 'utf8');
    return { meta, version, path: file, content };
  }

  async meta(location: SlateLocation & { id: string }): Promise<SlateMeta> {
    const dir = this.slateDir(location);
    let raw: string;
    try {
      raw = await readFile(join(dir, 'meta.json'), 'utf8');
    } catch {
      throw new Error(`unknown slate "${location.id}" in this session`);
    }
    let parsed: SlateMeta;
    try {
      parsed = JSON.parse(raw) as SlateMeta;
    } catch {
      throw new Error(`slate "${location.id}" has an unreadable meta.json`);
    }
    if (!parsed || typeof parsed.id !== 'string' || !Array.isArray(parsed.versions)) {
      throw new Error(`slate "${location.id}" has an unreadable meta.json`);
    }
    return parsed;
  }

  /** Every slate in the session, oldest first. Folders without meta.json are skipped. */
  async list(location: SlateLocation): Promise<SlateMeta[]> {
    const sessionRoot = this.sessionRoot(location);
    const names = await readdir(sessionRoot).catch(() => [] as string[]);
    const metas: SlateMeta[] = [];
    for (const name of names) {
      try {
        metas.push(await this.meta({ ...location, id: name }));
      } catch {
        // A stray folder in the session root is not a slate.
      }
    }
    return metas.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  /**
   * Deletes a slate whole — every version file and its meta.json. Removing the folder in
   * one step is what keeps a stale version from outliving the pointer that names it.
   */
  async remove(location: SlateLocation & { id: string }): Promise<SlateMeta[]> {
    const meta = await this.meta(location);
    await rm(this.slateDir({ ...location, id: meta.id }), { recursive: true, force: true });
    return this.list(location);
  }

  /** `sales-q3`, then `sales-q3-2`, … so two slates may share a title. */
  private async freeId(sessionRoot: string, base: string): Promise<string> {
    const taken = new Set(await readdir(sessionRoot).catch(() => [] as string[]));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 100; i += 1) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw new Error(`too many slates named "${base}" in this session`);
  }

  /**
   * Drops one version file — the escape hatch for the version cap. Survivors keep their
   * numbers and `current` moves to the newest of them; the next append takes max+1, so it can
   * only reuse the number of a version removed from the top. The last version cannot be
   * dropped: that document is the slate.
   */
  async removeVersion(
    location: SlateLocation & { id: string; version: number },
  ): Promise<SlateMeta> {
    const meta = await this.meta(location);
    const version = meta.versions.find((candidate) => candidate.n === location.version);
    if (!version) throw new Error(`slate "${meta.id}" has no version ${location.version}`);
    if (meta.versions.length === 1) {
      throw new Error(`slate "${meta.id}" has one version left — remove the slate instead`);
    }
    const dir = this.slateDir(location);
    await rm(join(dir, version.file), { force: true });
    meta.versions = meta.versions.filter((candidate) => candidate.n !== version.n);
    if (meta.current === version.n) {
      meta.current = meta.versions.reduce((max, candidate) => Math.max(max, candidate.n), 0);
    }
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(dir, meta);
    return meta;
  }

  /**
   * Writes one version into the real workspace tree, so the document outlives the
   * conversation. The slate folder stays the source of truth and keeps its history; the
   * promoted copy is a plain file the user can commit.
   */
  async promote(
    input: SlateLocation & { id: string; path: string; version?: number },
  ): Promise<{ path: string; version: number }> {
    const target = resolve(input.cwd, input.path);
    if (!isWithin(input.cwd, target)) {
      throw new Error(`refusing to promote outside the workspace: ${input.path}`);
    }
    const slate = await this.read(input);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, slate.content, 'utf8');
    return { path: target, version: slate.version.n };
  }

  private async writeMeta(dir: string, meta: SlateMeta): Promise<void> {
    await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  }
}
