/**
 * Lexical (keyword) ranking for `@codebase` retrieval — keyless, private, offline.
 * Scores each file by how many query terms it contains (plus a path-match boost),
 * so the most relevant files can be pulled in without embeddings. Pure + tested.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'have', 'how', 'does', 'where', 'what', 'which',
  'are', 'was', 'can', 'you', 'your', 'into', 'use', 'using', 'add', 'fix', 'the', 'about', 'when', 'why',
  'should', 'would', 'could', 'there', 'their', 'then', 'than', 'will'
]);

/** Split a query into distinct lowercase keyword tokens (≥3 chars, no stopwords). */
export function tokenize(query: string): string[] {
  const words = query.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  return [...new Set(words.filter((w) => !STOPWORDS.has(w)))];
}

export interface RankDoc {
  readonly id: string;
  readonly path: string;
  readonly text: string;
}

/** Rank documents by lexical relevance to the query. Returns matches (score > 0), best first. */
export function lexicalRank(query: string, docs: readonly RankDoc[]): Array<{ id: string; score: number }> {
  const terms = tokenize(query);
  if (terms.length === 0) {
    return [];
  }
  const scored = docs.map((doc) => {
    const text = doc.text.toLowerCase();
    const pathLower = doc.path.toLowerCase();
    let score = 0;
    for (const term of terms) {
      let idx = 0;
      let count = 0;
      while (count < 50 && (idx = text.indexOf(term, idx)) !== -1) {
        count += 1;
        idx += term.length;
      }
      score += count;
      if (pathLower.includes(term)) {
        score += 8; // a path/filename match is a strong signal
      }
    }
    return { id: doc.id, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
}
