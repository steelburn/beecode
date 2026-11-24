/**
 * A line diff between two slate versions.
 *
 * Append-only versions are only useful if you can see what changed, and the answer has to
 * be readable: a unified-style hunk list with line numbers on both sides. Pure string
 * work, no fs — the service feeds it two version texts and the renderer draws the result.
 */

export interface SlateDiffLine {
  kind: 'context' | 'add' | 'del';
  text: string;
  /** 1-based line number in the older version; absent on an added line. */
  from?: number;
  /** 1-based line number in the newer version; absent on a removed line. */
  to?: number;
}

export interface SlateDiffHunk {
  fromStart: number;
  fromCount: number;
  toStart: number;
  toCount: number;
  lines: SlateDiffLine[];
}

export interface SlateDiff {
  /** 1-based version numbers the diff was taken between. */
  from: number;
  to: number;
  hunks: SlateDiffHunk[];
  added: number;
  removed: number;
  /** True when the two versions hold the same lines. */
  identical: boolean;
}

type Op = { kind: SlateDiffLine['kind']; text: string };

/** Lines of `text`, ignoring a trailing newline. */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n');
}

/**
 * LCS over lines. Past ~4M comparisons the table stops being worth its memory and the
 * caller gets a whole-file replacement, which is still a correct (if coarse) diff.
 */
function computeOps(a: string[], b: string[]): Op[] {
  if (a.length * b.length > 4_000_000) {
    return [
      ...a.map((text): Op => ({ kind: 'del', text })),
      ...b.map((text): Op => ({ kind: 'add', text })),
    ];
  }

  const width = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'context', text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ kind: 'del', text: a[i] });
      i += 1;
    } else {
      ops.push({ kind: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) {
    ops.push({ kind: 'del', text: a[i] });
    i += 1;
  }
  while (j < b.length) {
    ops.push({ kind: 'add', text: b[j] });
    j += 1;
  }
  return ops;
}

function numberLines(ops: Op[]): SlateDiffLine[] {
  let from = 1;
  let to = 1;
  return ops.map((op) => {
    const line: SlateDiffLine = { kind: op.kind, text: op.text };
    if (op.kind !== 'add') {
      line.from = from;
      from += 1;
    }
    if (op.kind !== 'del') {
      line.to = to;
      to += 1;
    }
    return line;
  });
}

/** Change clusters less than `2 * context + 1` lines apart belong to the same hunk. */
function groupHunks(lines: SlateDiffLine[], context: number): SlateDiffHunk[] {
  const changed: number[] = [];
  lines.forEach((line, index) => {
    if (line.kind !== 'context') changed.push(index);
  });
  if (changed.length === 0) return [];

  const ranges: Array<[number, number]> = [];
  let start = changed[0];
  let end = changed[0];
  for (const index of changed.slice(1)) {
    if (index - end > context * 2 + 1) {
      ranges.push([start, end]);
      start = index;
    }
    end = index;
  }
  ranges.push([start, end]);

  return ranges.map(([first, last]) => {
    const slice = lines.slice(Math.max(0, first - context), Math.min(lines.length - 1, last + context) + 1);
    const fromLines = slice.filter((line) => line.kind !== 'add');
    const toLines = slice.filter((line) => line.kind !== 'del');
    return {
      fromStart: fromLines[0]?.from ?? 0,
      fromCount: fromLines.length,
      toStart: toLines[0]?.to ?? 0,
      toCount: toLines.length,
      lines: slice,
    };
  });
}

/** A unified-style diff between two version texts. */
export function diffSlateText(from: number, to: number, fromText: string, toText: string, context = 3): SlateDiff {
  const lines = numberLines(computeOps(splitLines(fromText), splitLines(toText)));
  const hunks = groupHunks(lines, Math.max(0, context));
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'add') added += 1;
    if (line.kind === 'del') removed += 1;
  }
  return { from, to, hunks, added, removed, identical: added === 0 && removed === 0 };
}
