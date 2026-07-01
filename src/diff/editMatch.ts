/**
 * Snippet-edit matching for the agent's `edit_file` tool.
 *
 * Matching runs in tiers, strictest first:
 *   1. exact string match (must be unique)
 *   2. line-by-line with trimmed lines (tolerates indentation / trailing whitespace)
 *   3. line-by-line with all whitespace runs collapsed (tolerates re-wrapped spacing)
 *
 * When nothing matches, the file is scanned for the *closest* window of lines and
 * that region is returned as a hint (with real line numbers and content), so the
 * model can repair its `old_text` in one round instead of re-reading blind.
 */

export interface ClosestMatch {
  /** 1-based first line of the closest region in the file. */
  readonly startLine: number;
  /** 1-based last line of the closest region. */
  readonly endLine: number;
  /** Fraction of lines that matched (0..1). */
  readonly similarity: number;
  /** The actual file content of that region, numbered `NN | text`. */
  readonly excerpt: string;
}

export type EditMatchResult =
  | { readonly kind: 'ok'; readonly newText: string }
  | { readonly kind: 'ambiguous'; readonly startLines: readonly number[] }
  | { readonly kind: 'notfound'; readonly hint?: ClosestMatch };

/** Don't scan for a closest-match hint in enormous files. */
const MAX_HINT_SCAN_LINES = 20000;
/** Minimum line-match fraction for a hint to be worth showing. */
const MIN_HINT_SIMILARITY = 0.4;
/** Cap the hint excerpt so the error stays compact. */
const MAX_HINT_LINES = 30;

const trimNorm = (line: string): string => line.trim();
const collapseNorm = (line: string): string => line.replace(/\s+/g, ' ').trim();

/** Apply `oldText` → `newText` inside `original`, using the tiered matching above. */
export function applySnippetEdit(original: string, oldText: string, newText: string): EditMatchResult {
  // Tier 1 — exact byte match on the raw string (preserves the file untouched around it).
  const idx = original.indexOf(oldText);
  if (oldText.length > 0 && idx !== -1) {
    if (original.indexOf(oldText, idx + oldText.length) !== -1) {
      return { kind: 'ambiguous', startLines: exactMatchLines(original, oldText) };
    }
    return { kind: 'ok', newText: original.slice(0, idx) + newText + original.slice(idx + oldText.length) };
  }

  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const fileLines = original.split(/\r?\n/);
  const oldLines = trimBlankEdges(oldText.split(/\r?\n/));
  if (oldLines.length === 0) {
    return { kind: 'notfound' };
  }

  // Tiers 2 & 3 — normalized line-window matching.
  for (const norm of [trimNorm, collapseNorm]) {
    const matches = findWindows(fileLines, oldLines, norm);
    if (matches.length === 1) {
      const at = matches[0];
      const replaced = [...fileLines.slice(0, at), ...newText.split(/\r?\n/), ...fileLines.slice(at + oldLines.length)];
      return { kind: 'ok', newText: replaced.join(eol) };
    }
    if (matches.length > 1) {
      return { kind: 'ambiguous', startLines: matches.map((m) => m + 1) };
    }
  }

  return { kind: 'notfound', hint: closestWindow(fileLines, oldLines) };
}

/** 1-based line numbers where the exact `oldText` occurrences start. */
function exactMatchLines(original: string, oldText: string): number[] {
  const lines: number[] = [];
  let from = 0;
  for (;;) {
    const at = original.indexOf(oldText, from);
    if (at === -1) {
      break;
    }
    lines.push(countLines(original, at));
    from = at + Math.max(1, oldText.length);
  }
  return lines;
}

function countLines(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function trimBlankEdges(lines: string[]): string[] {
  const out = [...lines];
  while (out.length && out[0].trim() === '') {
    out.shift();
  }
  while (out.length && out[out.length - 1].trim() === '') {
    out.pop();
  }
  return out;
}

/** 0-based start indexes of windows whose normalized lines all equal the normalized snippet. */
function findWindows(fileLines: string[], oldLines: string[], norm: (line: string) => string): number[] {
  const fileNorm = fileLines.map(norm);
  const oldNorm = oldLines.map(norm);
  const matches: number[] = [];
  for (let i = 0; i + oldNorm.length <= fileNorm.length; i += 1) {
    let ok = true;
    for (let j = 0; j < oldNorm.length; j += 1) {
      if (fileNorm[i + j] !== oldNorm[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      matches.push(i);
    }
  }
  return matches;
}

/** Best-scoring window by collapsed-whitespace line equality — the repair hint. */
function closestWindow(fileLines: string[], oldLines: string[]): ClosestMatch | undefined {
  if (fileLines.length > MAX_HINT_SCAN_LINES) {
    return undefined;
  }
  const fileNorm = fileLines.map(collapseNorm);
  const oldNorm = oldLines.map(collapseNorm);
  const len = Math.min(oldNorm.length, fileNorm.length);
  if (len === 0) {
    return undefined;
  }

  let bestStart = -1;
  let bestScore = 0;
  for (let i = 0; i + len <= fileNorm.length; i += 1) {
    let hits = 0;
    for (let j = 0; j < len; j += 1) {
      if (fileNorm[i + j] === oldNorm[j] && oldNorm[j] !== '') {
        hits += 1;
      }
    }
    if (hits > bestScore) {
      bestScore = hits;
      bestStart = i;
    }
  }

  const similarity = bestScore / len;
  if (bestStart === -1 || similarity < MIN_HINT_SIMILARITY) {
    return undefined;
  }

  const shownLen = Math.min(len, MAX_HINT_LINES);
  const width = String(bestStart + shownLen).length;
  const excerptLines = fileLines
    .slice(bestStart, bestStart + shownLen)
    .map((line, i) => `${String(bestStart + 1 + i).padStart(width)} | ${line}`);
  if (len > shownLen) {
    excerptLines.push(`… (+${len - shownLen} more lines in this region)`);
  }
  return {
    startLine: bestStart + 1,
    endLine: bestStart + len,
    similarity,
    excerpt: excerptLines.join('\n')
  };
}
