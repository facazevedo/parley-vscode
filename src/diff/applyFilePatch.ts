export interface PatchHunkInput {
  /** Hunk body lines, each prefixed with ' ', '-', or '+'. */
  readonly lines: readonly string[];
  /** 1-based start line from the `@@ -start` header, used to pick between duplicate matches. */
  readonly oldStart?: number;
}

export function applyFilePatch(originalText: string, hunks: readonly PatchHunkInput[]): string {
  const hasTrailingNewline = originalText.endsWith('\n');
  const lines = originalText.replace(/\r\n/g, '\n').split('\n');
  if (hasTrailingNewline) {
    lines.pop();
  }

  const output: string[] = [];
  let sourceIndex = 0;

  for (const hunk of hunks) {
    const context = hunk.lines
      .filter((line) => line.startsWith(' ') || line.startsWith('-'))
      .map((line) => line.slice(1));
    // Where the @@ header claims the hunk lives (never before already-consumed lines).
    const expected = Math.max(sourceIndex, (hunk.oldStart ?? 1) - 1);
    const hunkIndex = findSubsequence(lines, context, sourceIndex, expected);
    if (hunkIndex < 0) {
      throw new Error('Patch hunk did not match the current file.');
    }

    output.push(...lines.slice(sourceIndex, hunkIndex));
    for (const line of hunk.lines) {
      if (line.startsWith(' ') || line.startsWith('+')) {
        output.push(line.slice(1));
      }
    }
    sourceIndex = hunkIndex + context.length;
  }

  output.push(...lines.slice(sourceIndex));
  return `${output.join('\n')}${hasTrailingNewline ? '\n' : ''}`;
}

/**
 * Find `needle` in `source` at or after `startAt`. When the needle occurs more than
 * once (duplicate blocks), prefer the occurrence closest to `expected` — the position
 * claimed by the hunk's `@@` header — with ties going to the earlier occurrence.
 */
function findSubsequence(
  source: readonly string[],
  needle: readonly string[],
  startAt: number,
  expected: number
): number {
  if (needle.length === 0) {
    return Math.min(Math.max(startAt, expected), source.length);
  }

  let best = -1;
  for (let index = startAt; index <= source.length - needle.length; index += 1) {
    if (needle.every((line, offset) => source[index + offset] === line)) {
      if (best < 0 || Math.abs(index - expected) < Math.abs(best - expected)) {
        best = index;
      }
      if (index >= expected) {
        break; // Any later match is farther from `expected` than this one.
      }
    }
  }

  return best;
}
