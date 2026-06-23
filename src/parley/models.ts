/**
 * Static model capabilities, derived from the Parley models docs. Used for the
 * context-usage meter, percentage-based auto-compaction, and the extended-thinking
 * capability gate. All pure and unit-tested.
 */

/** Context-window sizes (tokens) by model-id regex, most-specific first. */
const CONTEXT_WINDOWS: ReadonlyArray<readonly [RegExp, number]> = [
  [/gpt-5\.4|gpt-5\.5/i, 1_000_000],
  [/gpt-5/i, 400_000], // gpt-5, 5.1, 5.2, nano, mini, codex
  [/claude-haiku-4-\d/i, 200_000],
  [/claude-(sonnet|opus)-4-\d/i, 1_000_000],
  [/llama-4-maverick/i, 1_000_000],
  [/gemini-2\.5-pro|gemini-3\.1-pro/i, 1_000_000],
  [/gemini-3\.0-flash/i, 200_000]
];

/** Context window (in tokens) for a model id, or `undefined` if unknown. */
export function contextWindowFor(model: string): number | undefined {
  for (const [re, size] of CONTEXT_WINDOWS) {
    if (re.test(model)) {
      return size;
    }
  }
  return undefined;
}

/**
 * Whether a model accepts the `thinking` parameter. Extended thinking is
 * supported on Claude, Gemini, and OpenAI GPT-5 reasoning models — but not on
 * Llama or image models. Unknown models are treated as capable (lenient) so we
 * don't nag about models we simply don't recognize.
 */
export function modelSupportsThinking(model: string): boolean {
  return !/llama|gpt-image/i.test(model);
}
