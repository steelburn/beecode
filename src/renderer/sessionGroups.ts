import type { SessionSummary } from '../shared/protocol';

/**
 * Grouping the session rail by workspace.
 *
 * A session belongs to the folder beeCode had open when it was created, and the rail shows
 * every workspace's sessions in one list. That is useful (an old conversation stays
 * reachable) and noisy (most of them belong to a folder you are not looking at), so the rail
 * rolls them up: one header per workspace, the open workspace first and expanded, the others
 * collapsed until you open them.
 *
 * Pure and DOM-free, so the ordering rules can be tested without a renderer.
 */
export interface SessionGroup {
  /** Workspace root the group stands for. '' when the session carried no workspace at all. */
  root: string;
  /** Folder name shown as the header. */
  label: string;
  /** Full path, for the tooltip (falls back to the label when the root is empty). */
  detail: string;
  /** True for the workspace the app currently has open. */
  current: boolean;
  /** The group's sessions, in the order they came in (newest first). */
  sessions: SessionSummary[];
}

/** The workspace a session belongs to: its own root, else its working directory. */
export function workspaceOf(session: Pick<SessionSummary, 'workspace' | 'cwd'>): string {
  return (session.workspace ?? session.cwd ?? '').trim();
}

/** Windows compares paths case-insensitively and ignores a trailing separator. */
export function workspaceKey(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Folder name of a workspace root — the short form the rail shows. */
export function workspaceLabel(root: string): string {
  const parts = root.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? '';
}

/**
 * Sessions rolled up per workspace: the open workspace first, then the rest by recency. A
 * session with no workspace is kept in its own group rather than dropped — it is still a
 * conversation the user may want to reopen.
 */
export function groupSessions(sessions: SessionSummary[], currentRoot?: string): SessionGroup[] {
  const currentKey = workspaceKey((currentRoot ?? '').trim());
  const groups = new Map<string, SessionGroup>();
  for (const session of sessions) {
    const root = workspaceOf(session);
    const key = workspaceKey(root);
    let group = groups.get(key);
    if (!group) {
      group = {
        root,
        label: workspaceLabel(root) || 'No workspace',
        detail: root || 'Sessions that were never bound to a folder',
        current: key === currentKey && key !== '',
        sessions: [],
      };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }
  const latest = (group: SessionGroup): string =>
    group.sessions.reduce((newest, session) => (session.updatedAt > newest ? session.updatedAt : newest), '');
  return [...groups.values()].sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    return latest(right).localeCompare(latest(left));
  });
}
