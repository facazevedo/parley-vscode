import type { TokenUsage } from './types';

/** Parse an OpenAI-style `usage` object from a chat/completions payload or stream chunk. */
export function parseUsage(payload: unknown): TokenUsage | undefined {
  const usage = (payload as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } })
    ?.usage;
  if (!usage || (usage.prompt_tokens == null && usage.completion_tokens == null && usage.total_tokens == null)) {
    return undefined;
  }
  return {
    prompt: usage.prompt_tokens ?? 0,
    completion: usage.completion_tokens ?? 0,
    total: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)
  };
}

/** Strip a single wrapping code fence and trailing whitespace from a model completion. */
export function cleanCompletion(raw: string): string {
  const fenceMatch = raw.match(/^```[\w.+-]*\n([\s\S]*?)```\s*$/);
  const text = fenceMatch ? fenceMatch[1] : raw;
  return text.replace(/\s+$/, '');
}

/**
 * Extract unique `@path` mention tokens from a prompt (trailing punctuation removed).
 * Pure string logic; the caller decides which resolve to real workspace files.
 */
export function extractMentionPaths(prompt: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const pattern = /(?:^|\s)@([^\s@]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(prompt))) {
    const rel = match[1].replace(/[.,;:)]+$/, '');
    if (rel.length > 0 && !seen.has(rel)) {
      seen.add(rel);
      out.push(rel);
    }
  }
  return out;
}

export interface MentionRange {
  readonly path: string;
  /** 1-based first line, when the token carried a `#12` / `#12-40` suffix. */
  readonly startLine?: number;
  /** 1-based last line (inclusive); equals startLine for a single-line range. */
  readonly endLine?: number;
}

/**
 * Split an `@path` mention token into its path and an optional line-range
 * suffix: `file.ts#12`, `file.ts#12-40`, or `file.ts#L12-L40` (1-based,
 * inclusive). Tokens without a numeric suffix come back as just the path.
 */
export function parseMentionRange(token: string): MentionRange {
  const match = token.match(/^(.+)#L?(\d+)(?:-L?(\d+))?$/i);
  if (!match) {
    return { path: token };
  }
  const startLine = Math.max(1, parseInt(match[2], 10));
  const endLine = match[3] ? Math.max(startLine, parseInt(match[3], 10)) : startLine;
  return { path: match[1], startLine, endLine };
}

/** Recognize API errors that indicate the request/context exceeded the model's token limit. */
export function isContextLengthError(status: number, detail: string): boolean {
  if (status !== 400 && status !== 413 && status !== 422) {
    return false;
  }
  return /context length|context window|maximum context|too many tokens|token limit|maximum.*tokens|reduce the length/i.test(
    detail
  );
}
