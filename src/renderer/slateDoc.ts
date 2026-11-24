/**
 * Recovering the slate behind a document tab.
 *
 * A slate version is opened as an ordinary document tab: `mountFileView` renders it from
 * its real extension, so markdown, HTML and CSV get exactly the viewers the rest of the
 * app uses and a slate needs no renderer of its own. The tab therefore knows only the
 * absolute path the store wrote:
 *
 *     <cwd>/.beecode/slates/<session>/<id>/001-<id>.md
 *
 * These helpers read that path back, so the tab can offer what only a slate has — Code ⇄
 * Preview, Copy and Download — and can name what it downloads. Pure string work, no DOM,
 * so the rules hold in node.
 */

export interface SlateDocRef {
  /** Session folder the slate belongs to. */
  session: string;
  /** Slate slug, the same id `meta.json` records. */
  id: string;
  /** 1-based version number decoded from the `NNN-` file prefix. */
  version: number;
  /** Extension without the dot: `md`, `html` or `csv`. */
  ext: string;
}

/** A slug the store could have produced; also rejects `..` and anything with a separator. */
const SLUG = /^[a-z0-9][a-z0-9-]*$/i;
const VERSION_FILE = /^(\d{3,})-([a-z0-9][a-z0-9-]*)\.([a-z0-9]+)$/i;

/**
 * The slate a document path belongs to, or `undefined` for any other file.
 *
 * Windows and POSIX separators are both accepted because the path comes from the service.
 * The file name must repeat the folder name — the store always writes `NNN-<id>.<ext>`,
 * so a file dropped into the folder by hand is not a version and gets no slate controls.
 */
export function slateDocFromPath(path: string): SlateDocRef | undefined {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 5) return undefined;
  const file = parts[parts.length - 1];
  const id = parts[parts.length - 2];
  const session = parts[parts.length - 3];
  if (parts[parts.length - 4] !== 'slates') return undefined;
  if (parts[parts.length - 5] !== '.beecode') return undefined;
  if (!SLUG.test(id) || !session) return undefined;
  const match = VERSION_FILE.exec(file);
  if (!match) return undefined;
  const [, digits, slug, ext] = match;
  if (slug !== id) return undefined;
  const version = Number(digits);
  if (!Number.isSafeInteger(version) || version < 1) return undefined;
  return { session, id, version, ext: ext.toLowerCase() };
}

/**
 * The name a downloaded version gets on the user's disk: `sales-q3-v2.md`.
 *
 * It keeps the version number, which the in-store file name (`002-sales-q3.md`) buries one
 * prefix deep, so two downloads of the same slate do not overwrite each other.
 */
export function slateExportName(ref: SlateDocRef): string {
  return `${ref.id}-v${ref.version}.${ref.ext}`;
}
