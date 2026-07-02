/**
 * Pure bookkeeping for the semantic index — parsing/migration, the incremental
 * build decision, serialization, and search ranking — separated from the model,
 * filesystem, and vscode so it is unit-testable. `EmbeddingIndex` delegates here.
 */

export interface ChunkEntry {
  /** 1-based first line of the chunk. */
  s: number;
  vec: number[];
}

export interface FileEntry {
  /** Content hash — unchanged files are reused instead of re-embedded. */
  hash: string;
  chunks: ChunkEntry[];
}

/** v2 index: per-file hash + chunk vectors (v1 was one vector per file). */
export interface IndexFileFormat {
  root: string;
  version?: number;
  files?: Record<string, FileEntry>;
  /** Legacy v1 entries — migrated to single-chunk files with a stale hash. */
  entries?: Array<{ path: string; vec: number[] }>;
}

/** Dot product; vectors are L2-normalized, so this is cosine similarity. */
export function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * Parse a loaded index file into a files map. A v2 file loads directly; a legacy
 * v1 file is migrated — each whole-file vector becomes a single chunk with a
 * stale (empty) hash, so search works immediately and the next build re-embeds it.
 */
export function parseIndex(parsed: IndexFileFormat): Map<string, FileEntry> {
  const files = new Map<string, FileEntry>();
  if (parsed.files) {
    for (const [p, entry] of Object.entries(parsed.files)) {
      files.set(p, entry);
    }
  } else if (Array.isArray(parsed.entries)) {
    for (const e of parsed.entries) {
      files.set(e.path, { hash: '', chunks: [{ s: 1, vec: e.vec }] });
    }
  }
  return files;
}

/** The on-disk payload for a files map. */
export function serializeIndex(root: string, files: Map<string, FileEntry>): IndexFileFormat {
  return { root, version: 2, files: Object.fromEntries(files) };
}

/**
 * Split docs into those whose content is unchanged (reuse the existing chunks)
 * and those that must be (re-)embedded. A file is reused only when its hash
 * matches AND it has chunks — so a stale-hash v1 migration re-embeds.
 */
export function planBuild(
  docs: ReadonlyArray<{ path: string; text: string }>,
  existing: Map<string, FileEntry>,
  hashOf: (text: string) => string
): { reuse: Array<[string, FileEntry]>; embed: Array<{ path: string; text: string; hash: string }> } {
  const reuse: Array<[string, FileEntry]> = [];
  const embed: Array<{ path: string; text: string; hash: string }> = [];
  for (const doc of docs) {
    const hash = hashOf(doc.text);
    const current = existing.get(doc.path);
    if (current && current.hash === hash && current.chunks.length > 0) {
      reuse.push([doc.path, current]);
    } else {
      embed.push({ path: doc.path, text: doc.text, hash });
    }
  }
  return { reuse, embed };
}

/** Rank files by their best chunk's cosine similarity to the query; return the top-N paths. */
export function rankByQuery(queryVec: readonly number[], files: Map<string, FileEntry>, topN: number): string[] {
  const scored: Array<{ path: string; score: number }> = [];
  for (const [p, entry] of files) {
    let best = -Infinity;
    for (const chunk of entry.chunks) {
      const score = dot(queryVec, chunk.vec);
      if (score > best) {
        best = score;
      }
    }
    if (best > -Infinity) {
      scored.push({ path: p, score: best });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((s) => s.path);
}
