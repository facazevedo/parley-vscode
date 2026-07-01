/**
 * Line-based chunking for the semantic index: ~60-line windows with a 10-line
 * overlap, so a match near a boundary is still found. Pure — unit-testable.
 */

export interface TextChunk {
  /** 1-based first line of the chunk. */
  readonly startLine: number;
  readonly text: string;
}

const CHUNK_LINES = 60;
const OVERLAP_LINES = 10;
const MAX_CHUNKS_PER_FILE = 40;
const MAX_CHUNK_CHARS = 4000;

export function chunkText(text: string): TextChunk[] {
  const lines = text.split('\n');
  if (lines.length <= CHUNK_LINES) {
    const whole = text.slice(0, MAX_CHUNK_CHARS).trim();
    return whole ? [{ startLine: 1, text: whole }] : [];
  }
  const chunks: TextChunk[] = [];
  const step = CHUNK_LINES - OVERLAP_LINES;
  for (let start = 0; start < lines.length && chunks.length < MAX_CHUNKS_PER_FILE; start += step) {
    const slice = lines
      .slice(start, start + CHUNK_LINES)
      .join('\n')
      .slice(0, MAX_CHUNK_CHARS)
      .trim();
    if (slice) {
      chunks.push({ startLine: start + 1, text: slice });
    }
    if (start + CHUNK_LINES >= lines.length) {
      break;
    }
  }
  return chunks;
}
