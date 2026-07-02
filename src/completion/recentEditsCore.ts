/**
 * Pure ring-buffer + formatting for the recent-edits completion context —
 * separated from the vscode event wiring so the coalescing and summary logic
 * is unit-testable.
 */

export interface RecentEdit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Record an edit into the ring (mutates `edits`). Consecutive edits on the same
 * file+line coalesce (typing fires many events), and the ring is capped at `max`.
 */
export function pushEdit(edits: RecentEdit[], edit: RecentEdit, max: number): void {
  const last = edits[edits.length - 1];
  if (last && last.file === edit.file && last.line === edit.line) {
    edits[edits.length - 1] = edit;
    return;
  }
  edits.push(edit);
  if (edits.length > max) {
    edits.splice(0, edits.length - max);
  }
}

/** Recent edit lines outside `excludeBasename`, oldest first, as `file:line: text`. */
export function formatRecentEdits(edits: readonly RecentEdit[], excludeBasename: string): string | undefined {
  const rows = edits.filter((e) => e.file !== excludeBasename).map((e) => `${e.file}:${e.line + 1}: ${e.text}`);
  return rows.length > 0 ? rows.join('\n') : undefined;
}
