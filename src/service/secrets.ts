import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from '../shared/tools';
import { setSecretResolver } from './llm/types';

/**
 * Write-only store for LLM API keys, keyed by model-preset id.
 *
 * `config.json` is plain user state — it gets shared in bug reports and sits in a
 * world-readable directory — so a key must never live there. The renderer may *send*
 * a key (it is typed into Settings in clear text by necessity), but the service never
 * returns one: `config.get` exposes only a `hasKey` flag.
 */
/** Build a store and make it the source that `resolveApiKey` consults. */
export function installSecrets(file?: string): SecretsStore {
  const store = new SecretsStore(file);
  setSecretResolver((preset) => store.get(preset.id));
  return store;
}

export class SecretsStore {
  private data: Record<string, string> = {};

  constructor(private readonly file: string = paths().secrets) {
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      for (const [presetId, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'string' && value.trim()) this.data[presetId] = value.trim();
      }
    } catch {
      // A corrupt secrets file must not take the service down: treat it as empty.
      this.data = {};
    }
  }

  get(presetId: string): string | undefined {
    return this.data[presetId];
  }

  has(presetId: string): boolean {
    return Boolean(this.data[presetId]);
  }

  /** Store a key, or delete it when the value is empty. */
  set(presetId: string, key: string | null | undefined): void {
    const value = (key ?? '').trim();
    if (value) this.data[presetId] = value;
    else delete this.data[presetId];
    this.save();
  }

  /** Drop keys for presets that no longer exist, so removed models leave no secret behind. */
  prune(keepIds: readonly string[]): void {
    const keep = new Set(keepIds);
    let changed = false;
    for (const id of Object.keys(this.data)) {
      if (!keep.has(id)) {
        delete this.data[id];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    // `mode` is honoured only when the file is created, and that is the point: a brand-new
    // secrets file must never exist with a loose mode, not even for the moment that a
    // create-then-chmod sequence leaves it readable. A umask cannot weaken this: 0600 has no
    // group/other bits for the mask to clear.
    writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    // An existing file keeps the mode it already had through the write above, so tighten it
    // here as well. Best effort: POSIX honours 0600, Windows relies on the per-user profile ACL.
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* ignore */
    }
  }
}
