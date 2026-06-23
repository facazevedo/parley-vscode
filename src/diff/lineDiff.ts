/**
 * Minimal line-level diff used for per-hunk accept/reject. Pure (no vscode), so it
 * is unit-tested directly.
 */
export interface Hunk {
  /** Original lines this hunk would remove. */
  readonly removed: string[];
  /** Proposed lines this hunk would add. */
  readonly added: string[];
  /** 0-based index in the original where the removed lines begin. */
  readonly origStart: number;
}

type Op = { type: 'eq' | 'del' | 'ins'; line: string };

function diffMiddle(a: string[], b: string[]): Op[] {
  if (a.length === 0) {
    return b.map((line) => ({ type: 'ins', line }));
  }
  if (b.length === 0) {
    return a.map((line) => ({ type: 'del', line }));
  }
  // Guard against O(n*m) blowups on huge fully-different regions: treat as full replace.
  if (a.length * b.length > 4_000_000) {
    return [...a.map((line) => ({ type: 'del' as const, line })), ...b.map((line) => ({ type: 'ins' as const, line }))];
  }

  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'eq', line: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', line: a[i] });
      i += 1;
    } else {
      ops.push({ type: 'ins', line: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', line: a[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'ins', line: b[j] });
    j += 1;
  }
  return ops;
}

/** Group the differences between two line arrays into hunks (common prefix/suffix trimmed first). */
export function computeHunks(a: string[], b: string[]): Hunk[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const ops = diffMiddle(a.slice(start, endA), b.slice(start, endB));
  const hunks: Hunk[] = [];
  let origIdx = start;
  let removed: string[] = [];
  let added: string[] = [];
  let hunkStart = start;
  const flush = () => {
    if (removed.length || added.length) {
      hunks.push({ removed, added, origStart: hunkStart });
      removed = [];
      added = [];
    }
  };

  for (const op of ops) {
    if (op.type === 'eq') {
      flush();
      origIdx += 1;
      hunkStart = origIdx;
    } else if (op.type === 'del') {
      if (!removed.length && !added.length) {
        hunkStart = origIdx;
      }
      removed.push(op.line);
      origIdx += 1;
    } else {
      if (!removed.length && !added.length) {
        hunkStart = origIdx;
      }
      added.push(op.line);
    }
  }
  flush();
  return hunks;
}

export interface DiffRow {
  /** `ctx` = unchanged context, `add`/`del` = changed lines, `gap` = collapsed unchanged region. */
  readonly kind: 'ctx' | 'add' | 'del' | 'gap';
  readonly oldNo?: number;
  readonly newNo?: number;
  readonly text: string;
}

export interface UnifiedDiff {
  readonly rows: DiffRow[];
  readonly added: number;
  readonly removed: number;
}

/**
 * Build a GitHub-style unified diff between two texts, keeping `context` unchanged
 * lines around each change and collapsing the rest into `gap` markers. Pure, so the
 * webview can render a Claude-Code-style diff card from the rows. Line numbers are
 * 1-based (`oldNo` for removed/context, `newNo` for added/context).
 */
export function formatUnifiedDiff(originalText: string, proposedText: string, context = 3): UnifiedDiff {
  const a = originalText.length ? originalText.split('\n') : [];
  const b = proposedText.length ? proposedText.split('\n') : [];
  const ops = diffMiddle(a, b);

  const all: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'eq') {
      oldNo += 1;
      newNo += 1;
      all.push({ kind: 'ctx', oldNo, newNo, text: op.line });
    } else if (op.type === 'del') {
      oldNo += 1;
      removed += 1;
      all.push({ kind: 'del', oldNo, text: op.line });
    } else {
      newNo += 1;
      added += 1;
      all.push({ kind: 'add', newNo, text: op.line });
    }
  }

  // Keep context lines near changes; collapse longer unchanged runs into a single gap.
  const keep = new Array<boolean>(all.length).fill(false);
  for (let i = 0; i < all.length; i += 1) {
    if (all[i].kind !== 'ctx') {
      for (let j = Math.max(0, i - context); j <= Math.min(all.length - 1, i + context); j += 1) {
        keep[j] = true;
      }
    }
  }

  const rows: DiffRow[] = [];
  for (let i = 0; i < all.length; i += 1) {
    if (all[i].kind !== 'ctx' || keep[i]) {
      rows.push(all[i]);
    } else if (rows.length === 0 || rows[rows.length - 1].kind !== 'gap') {
      rows.push({ kind: 'gap', text: '⋯' });
    }
  }
  return { rows, added, removed };
}

/** Rebuild the file applying only the accepted hunks (rejected hunks keep the original lines). */
export function applyHunks(original: string[], hunks: Hunk[], accepted: boolean[]): string[] {
  const out: string[] = [];
  let idx = 0;
  hunks.forEach((hunk, k) => {
    while (idx < hunk.origStart) {
      out.push(original[idx]);
      idx += 1;
    }
    if (accepted[k]) {
      out.push(...hunk.added);
    } else {
      out.push(...hunk.removed);
    }
    idx += hunk.removed.length;
  });
  while (idx < original.length) {
    out.push(original[idx]);
    idx += 1;
  }
  return out;
}
