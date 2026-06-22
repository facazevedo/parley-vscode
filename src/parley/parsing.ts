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

/** Recognize API errors that indicate the request/context exceeded the model's token limit. */
export function isContextLengthError(status: number, detail: string): boolean {
  if (status !== 400 && status !== 413 && status !== 422) {
    return false;
  }
  return /context length|context window|maximum context|too many tokens|token limit|maximum.*tokens|reduce the length/i.test(
    detail
  );
}
