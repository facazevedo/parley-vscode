/**
 * Pure text helpers for the inline-completion provider — no `vscode`, so they are
 * unit-testable in isolation from the editor/API surface.
 */

/** Trim a suggestion at the first blank line, so it stays one coherent block.
 *  Handles both LF and CRLF line endings. */
export function stopAtBlankLine(text: string): string {
  const at = text.search(/\r?\n[ \t]*\r?\n/);
  return at === -1 ? text : text.slice(0, at);
}

const OPENERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * For each character in `s`, mark whether a closing bracket there is matched by an
 * opener *within `s` itself*. A closer that is NOT matched within `s` is one that
 * closes something opened before it (e.g. in the prefix) — a genuine duplicate of
 * what's already after the cursor, and therefore safe to trim.
 */
function closersMatchedWithin(s: string): boolean[] {
  const matched = new Array<boolean>(s.length).fill(false);
  const stack: string[] = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') {
      stack.push(c);
    } else if (c === ')' || c === ']' || c === '}') {
      if (stack.length > 0 && stack[stack.length - 1] === OPENERS[c]) {
        stack.pop();
        matched[i] = true; // this closer balances an opener inside the completion → needed
      }
    }
  }
  return matched;
}

/**
 * Drop a trailing run of the completion that merely repeats what's already just
 * after the cursor — trailing whitespace, `;`/`,`, and closing brackets the `suffix`
 * already contains. A closing bracket is trimmed ONLY when it is not balancing an
 * opener within the completion itself (otherwise removing it would unbalance the
 * insertion — e.g. never turn `fn(x)` into `fn(x`).
 */
export function trimSuffixOverlap(completion: string, suffix: string): string {
  if (!completion || !suffix) {
    return completion;
  }
  const run = (completion.match(/[\s)}\];,]*$/)?.[0] ?? '').length;
  if (run === 0) {
    return completion;
  }
  const matched = closersMatchedWithin(completion);
  for (let k = run; k >= 1; k -= 1) {
    const start = completion.length - k;
    if (!suffix.startsWith(completion.slice(start))) {
      continue;
    }
    // Safe only if no bracket-closer being removed is matched within the completion.
    let safe = true;
    for (let i = start; i < completion.length; i += 1) {
      const c = completion[i];
      if ((c === ')' || c === ']' || c === '}') && matched[i]) {
        safe = false;
        break;
      }
    }
    if (safe) {
      return completion.slice(0, start);
    }
  }
  return completion;
}

/** A tiny insertion-ordered LRU (Map-backed) for caching recent completions. */
export class LruCache<V> {
  private readonly map = new Map<string, V>();
  public constructor(private readonly max = 50) {}
  public get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value); // bump to most-recent
    }
    return value;
  }
  public set(key: string, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.map.delete(oldest);
    }
  }
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
