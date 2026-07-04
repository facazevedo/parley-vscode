/**
 * Pick the slice of a `@codebase` file to attach. Pure — unit-testable.
 */

const WINDOW_LINES = 60; // matches chunk.ts CHUNK_LINES
const CONTEXT_BEFORE = 5;

export interface CodebaseRegion {
  readonly content: string;
  /** "from-to" (1-based, inclusive) when a sub-region was extracted; undefined for a head slice. */
  readonly range?: string;
  readonly truncated: boolean;
}

/**
 * With a semantic match location (`startLine`) in a large file, extract the matched
 * chunk's region (a little leading context + one chunk window) so the model sees the
 * relevant code, not the top of the file. Otherwise (no location, or a small file)
 * attach the file head, as before. Always capped at `cap` characters.
 */
export function buildCodebaseRegion(raw: string, startLine: number | undefined, cap: number): CodebaseRegion {
  const lines = raw.split('\n');
  if (startLine && startLine > 1 && lines.length > WINDOW_LINES) {
    const from = Math.max(1, startLine - CONTEXT_BEFORE);
    const to = Math.min(lines.length, startLine + WINDOW_LINES);
    let content = lines.slice(from - 1, to).join('\n');
    let truncated = from > 1 || to < lines.length;
    if (content.length > cap) {
      content = content.slice(0, cap);
      truncated = true;
    }
    return { content, range: `${from}-${to}`, truncated };
  }
  const content = raw.length > cap ? raw.slice(0, cap) : raw;
  return { content, truncated: raw.length > content.length };
}
