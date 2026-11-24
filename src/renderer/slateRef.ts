import type { SlateKind, SlateRef } from '../shared/protocol';

const SLATE_KINDS: readonly SlateKind[] = ['markdown', 'html', 'csv'];

const isKind = (value: unknown): value is SlateKind =>
  typeof value === 'string' && (SLATE_KINDS as readonly string[]).includes(value);

/**
 * Reads a tool result's `meta.slate`. Every other tool result has none, and a malformed one
 * has to fall back to the plain tool card instead of breaking the transcript — this runs on
 * data the model produced, so nothing here may throw.
 */
export function slateRefOf(meta: Record<string, unknown> | undefined): SlateRef | undefined {
  const raw = meta?.slate;
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || !value.id) return undefined;
  if (typeof value.title !== 'string' || !value.title) return undefined;
  if (!isKind(value.kind)) return undefined;
  const version = typeof value.version === 'number' && value.version >= 1 ? value.version : 1;
  const versions = typeof value.versions === 'number' && value.versions >= version ? value.versions : version;
  return { id: value.id, title: value.title, kind: value.kind, version, versions };
}

/** The one-line meta label of a transcript card: `v2 of 3`, or `v1` for a single version. */
export function slateCardVersionLabel(slate: SlateRef): string {
  return slate.versions > 1 ? `v${slate.version} of ${slate.versions}` : `v${slate.version}`;
}
