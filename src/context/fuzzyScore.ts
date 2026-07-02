/**
 * Fuzzy path matching for the composer's @-mention autocomplete.
 * Pure string logic (no vscode imports) so it is unit-testable.
 *
 * Scoring is a small fzy-style dynamic program: every query character must
 * appear in order in the candidate; matches earn bonuses for landing on a word
 * boundary (start of a path segment, after `.`/`_`/`-`/space, or a camelCase
 * hump) and for extending a consecutive run; starting a gap costs a little.
 * A query that fits entirely inside the basename gets a large bonus, and
 * shorter paths win ties — so "chpanel" finds `src/webview/ChatPanel.ts` and
 * "chat.js" prefers `media/chat.js` over deeper incidental matches.
 */

const SCORE_MATCH = 16;
const BONUS_BOUNDARY_PATH = 12; // match right after '/'
const BONUS_BOUNDARY_WORD = 9; // match right after '.', '_', '-' or ' '
const BONUS_CAMEL = 8; // lower→Upper hump
const BONUS_CONSECUTIVE = 10; // extending the previous match by one
const BONUS_BASENAME = 24; // whole query fits in the basename
const PENALTY_GAP_START = -6; // resuming after skipped characters
const PENALTY_PER_CHAR = 0.05; // slight preference for shorter paths
const NEG = -1e9;

/**
 * Score `candidate` against `query` (case-insensitive subsequence match).
 * Returns `undefined` when the query is not a subsequence of the candidate;
 * higher scores are better matches. An empty query matches everything with 0.
 */
export function fuzzyScore(query: string, candidate: string): number | undefined {
  const n = query.length;
  const m = candidate.length;
  if (n === 0) {
    return 0;
  }
  if (n > m) {
    return undefined;
  }
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();

  // Fast reject: the query must be a subsequence of the candidate.
  let k = 0;
  for (let j = 0; j < m && k < n; j += 1) {
    if (c[j] === q[k]) {
      k += 1;
    }
  }
  if (k < n) {
    return undefined;
  }

  // Positional bonus for a match beginning at each candidate position.
  const bonus = new Float64Array(m);
  let prev = '/';
  for (let j = 0; j < m; j += 1) {
    const ch = candidate[j];
    if (prev === '/' || prev === '\\') {
      bonus[j] = BONUS_BOUNDARY_PATH;
    } else if (prev === '.' || prev === '_' || prev === '-' || prev === ' ') {
      bonus[j] = BONUS_BOUNDARY_WORD;
    } else if (ch >= 'A' && ch <= 'Z' && prev >= 'a' && prev <= 'z') {
      bonus[j] = BONUS_CAMEL;
    }
    prev = ch;
  }

  // M[j]: best score with query[0..i] matched and query[i] matched AT candidate[j].
  // D[j]: best score with query[0..i] matched anywhere within candidate[0..j].
  let matched = new Float64Array(m).fill(NEG);
  let best = new Float64Array(m).fill(NEG);
  for (let i = 0; i < n; i += 1) {
    const nextMatched = new Float64Array(m).fill(NEG);
    const nextBest = new Float64Array(m).fill(NEG);
    for (let j = i; j < m; j += 1) {
      if (q[i] === c[j]) {
        if (i === 0) {
          nextMatched[j] = SCORE_MATCH + bonus[j];
        } else if (j > 0) {
          nextMatched[j] = Math.max(
            matched[j - 1] + SCORE_MATCH + Math.max(BONUS_CONSECUTIVE, bonus[j]),
            best[j - 1] + SCORE_MATCH + bonus[j] + PENALTY_GAP_START
          );
        }
      }
      nextBest[j] = Math.max(nextMatched[j], j > 0 ? nextBest[j - 1] : NEG);
    }
    matched = nextMatched;
    best = nextBest;
  }
  let score = best[m - 1];
  if (score <= NEG / 2) {
    return undefined;
  }

  // Whole-query-in-basename bonus: "chat.js" should rank media/chat.js first.
  const base = c.slice(c.lastIndexOf('/') + 1);
  let bi = 0;
  for (let j = 0; j < base.length && bi < n; j += 1) {
    if (base[j] === q[bi]) {
      bi += 1;
    }
  }
  if (bi === n) {
    score += BONUS_BASENAME;
  }
  return score - m * PENALTY_PER_CHAR;
}

export interface RankOptions {
  /** Maximum number of results (default 8). */
  readonly limit?: number;
  /** Paths to prefer on ties/near-ties (e.g. files open in the editor). */
  readonly boost?: ReadonlySet<string>;
}

/**
 * Rank candidate paths against a mention query, best first. With an empty
 * query, boosted (open) paths come first, then the shortest paths.
 */
export function rankMentionPaths(query: string, paths: readonly string[], options?: RankOptions): string[] {
  const limit = options?.limit ?? 8;
  const boost = options?.boost;
  if (!query) {
    const boosted = boost ? paths.filter((p) => boost.has(p)) : [];
    const rest = (boost ? paths.filter((p) => !boost.has(p)) : [...paths]).sort(
      (a, b) => a.length - b.length || a.localeCompare(b)
    );
    return [...boosted, ...rest].slice(0, limit);
  }
  const scored: Array<{ path: string; score: number }> = [];
  for (const p of paths) {
    const s = fuzzyScore(query, p);
    if (s !== undefined) {
      scored.push({ path: p, score: s + (boost?.has(p) ? 20 : 0) });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((s) => s.path);
}
