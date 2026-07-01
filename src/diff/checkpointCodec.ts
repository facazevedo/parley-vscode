/**
 * On-disk encoding for checkpoint records (JSONL, one record per line). Pure —
 * no vscode/fs — so it is unit-testable. `previous === undefined` means the file
 * did not exist before the write (reverting deletes it); it round-trips as null.
 */

export interface CheckpointRecord {
  /** Absolute path of the file that was written. */
  readonly fsPath: string;
  /** File contents before the write, or undefined if it did not exist. */
  readonly previous: string | undefined;
  readonly label: string;
  /** Transcript length at write time — anchors rewind to a conversation position. */
  readonly marker: number;
  readonly at: string;
}

export function serializeCheckpoint(cp: CheckpointRecord): string {
  return JSON.stringify({ p: cp.fsPath, v: cp.previous ?? null, l: cp.label, m: cp.marker, at: cp.at });
}

/** Lenient parse: corrupt lines are skipped rather than losing the whole log. */
export function parseCheckpointLines(text: string): CheckpointRecord[] {
  const out: CheckpointRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const raw = JSON.parse(trimmed) as { p?: string; v?: string | null; l?: string; m?: number; at?: string };
      if (typeof raw.p !== 'string' || raw.p.length === 0) {
        continue;
      }
      out.push({
        fsPath: raw.p,
        previous: raw.v === null || raw.v === undefined ? undefined : String(raw.v),
        label: typeof raw.l === 'string' ? raw.l : 'edit',
        marker: typeof raw.m === 'number' ? raw.m : 0,
        at: typeof raw.at === 'string' ? raw.at : ''
      });
    } catch {
      // Skip the corrupt line.
    }
  }
  return out;
}
