import {
  formatUpdateSize,
  updateBadgeLabel,
  updateNotice,
  type UpdateStatus,
} from '../shared/update';

/** The two lines the Settings → General row shows. Pure, so the wording is testable. */
export interface UpdateSectionText {
  note: string;
  /** Label for the download button, or undefined when there is nothing to download. */
  download?: string;
}

export function updateSectionText(status: UpdateStatus, version: string): UpdateSectionText {
  const head = `beeCode ${version}`;
  switch (status.state) {
    case 'available': {
      const size = formatUpdateSize(status.release.asset?.size ?? 0);
      return {
        note: `${head} · ${status.release.version} is available${size ? ` (${size})` : ''}`,
        download: `Download ${status.release.version}`,
      };
    }
    case 'current':
      return { note: `${head} · up to date (latest published: ${status.latest})` };
    case 'error':
      return { note: `${head} · ${updateNotice(status) ?? 'the check failed'}` };
    case 'checking':
      return { note: `${head} · checking…` };
    default:
      return { note: `${head} · updates have not been checked yet` };
  }
}

/**
 * The rail-foot badge. It exists only while there is something to act on — a permanent
 * "0.1.3" would be a second version number in the chrome for no decision to make. The
 * element is passed in structurally so the hiding rule can be read in a test.
 */
export function paintUpdateBadge(
  badge: { hidden: boolean; textContent: string | null; title: string },
  status: UpdateStatus,
): void {
  const label = updateBadgeLabel(status);
  badge.hidden = !label;
  badge.textContent = label ?? '';
  badge.title = updateNotice(status) ?? 'A newer beeCode installer has been published — click to download';
}

/**
 * Settings → General gets one row about the app itself. Appended after the config form is
 * painted rather than woven into it: this row writes no config, and the form is rebuilt from
 * a draft on every keystroke.
 */
export function renderUpdateSection(
  host: HTMLElement,
  status: UpdateStatus,
  options: { version: string; onCheck: () => void; onDownload: () => void },
): void {
  host.querySelector('#settings-updates')?.remove();
  const text = updateSectionText(status, options.version);

  const section = document.createElement('section');
  section.id = 'settings-updates';
  section.className = 'settings-section';

  const head = document.createElement('div');
  head.className = 'settings-section-head';
  const title = document.createElement('h3');
  title.textContent = 'Updates';
  head.append(title);

  const note = document.createElement('p');
  note.className = 'settings-note';
  note.id = 'update-note';
  note.textContent = text.note;

  const actions = document.createElement('div');
  actions.className = 'settings-actions';

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'btn ghost small';
  check.id = 'update-check-now';
  check.textContent = status.state === 'checking' ? 'Checking…' : 'Check for updates';
  check.disabled = status.state === 'checking';
  check.addEventListener('click', () => options.onCheck());

  actions.append(check);

  if (text.download) {
    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'btn small';
    download.id = 'update-download';
    download.textContent = text.download;
    download.addEventListener('click', () => options.onDownload());
    actions.append(download);
  }

  section.append(head, note, actions);
  host.append(section);
}
