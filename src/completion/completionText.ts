/**
 * Pure text helpers for the inline-completion provider — no `vscode`, so they are
 * unit-testable in isolation from the editor/API surface.
 */

/** Trim a suggestion at the first blank line, so it stays one coherent block. */
export function stopAtBlankLine(text: string): string {
  const at = text.search(/\n[ \t]*\n/);
  return at === -1 ? text : text.slice(0, at);
}

/** Keep the LAST `max` chars (the prefix nearest the cursor is what matters). */
export function clampStart(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

/** Keep the FIRST `max` chars (the suffix just after the cursor). */
export function clampEnd(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

export interface CachedCompletion {
  readonly docKey: string;
  readonly prefix: string;
  readonly completion: string;
}

/**
 * Prefix-extension cache: while the user keeps typing exactly what the last
 * completion suggested, serve the remaining tail locally (zero latency, zero API
 * call). Returns the still-unwritten remainder, or undefined if the cache no
 * longer applies (different doc, diverged from the suggestion, or fully typed).
 */
export function extendFromCache(
  cached: CachedCompletion | undefined,
  docKey: string,
  fullPrefix: string
): string | undefined {
  if (!cached || cached.docKey !== docKey || !fullPrefix.startsWith(cached.prefix)) {
    return undefined;
  }
  const typed = fullPrefix.slice(cached.prefix.length);
  if (typed.length > 0 && cached.completion.startsWith(typed) && cached.completion.length > typed.length) {
    return cached.completion.slice(typed.length);
  }
  return undefined;
}
