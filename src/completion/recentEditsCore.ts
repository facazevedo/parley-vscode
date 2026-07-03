/**
 * Pure ring-buffer + formatting for the recent-edits completion context —
 * separated from the vscode event wiring so the coalescing and summary logic
 * is unit-testable.
 */

export interface RecentEdit {
  readonly file: string;
  readonly line: number;
  /** The changed line's current (post-edit) text. */
  readonly text: string;
  /** The line's text BEFORE this edit, when known — enables a diff-aware hint. */
  readonly before?: string;
}

/**
 * Record an edit into the ring (mutates `edits`). Consecutive edits on the same
 * file+line coalesce (typing fires many events) while PRESERVING the original
 * `before` from the first edit in that run — so a burst of keystrokes still shows
 * the true was→now delta, not now→now. The ring is capped at `max`.
 */
export function pushEdit(edits: RecentEdit[], edit: RecentEdit, max: number): void {
  const last = edits[edits.length - 1];
  if (last && last.file === edit.file && last.line === edit.line) {
    edits[edits.length - 1] = { ...edit, before: last.before ?? edit.before };
    return;
  }
  edits.push(edit);
  if (edits.length > max) {
    edits.splice(0, edits.length - max);
  }
}

/**
 * Recent edit lines outside `excludeBasename`, oldest first. Diff-aware: when the
 * pre-edit text is known and differs, renders `file:line: before → after` so the
 * model sees what actually changed; otherwise `file:line: text`.
 */
export function formatRecentEdits(edits: readonly RecentEdit[], excludeBasename: string): string | undefined {
  const rows = edits
    .filter((e) => e.file !== excludeBasename)
    .map((e) => {
      const b = e.before?.trim();
      return b !== undefined && b.length > 0 && b !== e.text
        ? `${e.file}:${e.line + 1}: ${b} → ${e.text}`
        : `${e.file}:${e.line + 1}: ${e.text}`;
    });
  return rows.length > 0 ? rows.join('\n') : undefined;
}
