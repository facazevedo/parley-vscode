/**
 * Client-side cost estimation for Parley models.
 *
 * Parley charges per token. The gateway returns an exact per-request figure in
 * the `x-parley-v1-cost` response header for NON-streaming requests, but not on
 * streaming responses (which this extension uses by default). So we estimate
 * cost from the reported token usage and the published per-model rates from the
 * Parley cost-guidance docs. Estimates ignore prompt caching (we don't track
 * cache tokens), so the real cost is usually a touch lower — hence "~$".
 */

export interface ModelRate {
  /** USD per 1,000,000 input (prompt) tokens. */
  readonly input: number;
  /** USD per 1,000,000 output (completion) tokens. */
  readonly output: number;
}

/**
 * Rates per 1,000,000 tokens. Matched against the full `provider/model` id by
 * regex, most-specific first (the first match wins).
 */
const RATES: ReadonlyArray<readonly [RegExp, ModelRate]> = [
  // Claude (Bedrock / Anthropic)
  [/claude-haiku-4-5/i, { input: 1.0, output: 5.0 }],
  [/claude-sonnet-4-6/i, { input: 3.0, output: 15.0 }],
  [/claude-opus-4-[67]/i, { input: 5.0, output: 25.0 }],
  // OpenAI GPT-5 family (specific variants before the GPT-5 fallback)
  [/gpt-5-nano/i, { input: 0.1, output: 0.5 }],
  [/gpt-5-mini/i, { input: 0.25, output: 2.0 }],
  [/gpt-5\.5/i, { input: 5.0, output: 30.0 }],
  [/gpt-5\.4/i, { input: 2.5, output: 15.0 }],
  [/gpt-5/i, { input: 1.25, output: 10.0 }],
  // Google Gemini
  [/gemini-3\.1-pro/i, { input: 4.0, output: 18.0 }],
  [/gemini-2\.5-pro/i, { input: 2.5, output: 15.0 }],
  [/gemini-3\.0-flash/i, { input: 0.5, output: 3.0 }],
  // Other
  [/llama-4-maverick/i, { input: 0.0, output: 0.0 }],
  [/gpt-image-1/i, { input: 10.0, output: 40.0 }]
];

/** Look up the per-1M-token rate for a model id, or `undefined` if unknown. */
export function rateFor(model: string): ModelRate | undefined {
  for (const [re, rate] of RATES) {
    if (re.test(model)) {
      return rate;
    }
  }
  return undefined;
}

/** Estimate the USD cost of a request from its token usage, or `undefined` for unknown models. */
export function estimateCostUsd(model: string, usage: { prompt: number; completion: number }): number | undefined {
  const rate = rateFor(model);
  if (!rate) {
    return undefined;
  }
  return (usage.prompt * rate.input + usage.completion * rate.output) / 1_000_000;
}

/** Format a USD amount compactly for the chat UI. */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) {
    return '$0.00';
  }
  if (amount < 0.01) {
    return '<$0.01';
  }
  return `$${amount.toFixed(2)}`;
}
