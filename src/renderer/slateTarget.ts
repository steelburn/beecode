import type { SlateKind } from '../shared/protocol';

/**
 * The path a slate offers when the user promotes it: its slug plus the extension its kind
 * implies. The slug is already unique in the session, so the default name is never one the
 * store would have refused — and promoting twice overwrites the same file instead of
 * scattering near-duplicates.
 */
export function defaultSlatePath(slate: { id: string; kind: SlateKind }): string {
  const ext = slate.kind === 'html' ? 'html' : slate.kind === 'csv' ? 'csv' : 'md';
  return `${slate.id}.${ext}`;
}
