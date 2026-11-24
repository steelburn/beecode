/**
 * Copying text out of the renderer.
 *
 * `navigator.clipboard` is the API that actually maintains the clipboard, but it needs a
 * secure context — and a sandboxed `file://` renderer does not always get one. The
 * hidden-textarea + `execCommand` path is the fallback, deprecated as it is, so a Copy
 * button never silently does nothing on a platform that refuses both.
 */

/** Put `text` on the clipboard; false when the renderer refused every path. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // A refused permission is not a hard failure — try the legacy path.
  }
  return copyWithTextarea(text);
}

function copyWithTextarea(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const area = document.createElement('textarea');
  area.value = text;
  // Off-screen rather than hidden: a `display: none` field cannot be selected.
  area.setAttribute('readonly', 'readonly');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
