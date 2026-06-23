/**
 * Extended thinking (a.k.a. reasoning) support for the Parley gateway.
 *
 * Parley exposes extended thinking through the `thinking` request parameter
 * (NOT `reasoning_effort`, which the gateway ignores). Two modes are documented:
 *
 *   { "type": "enabled", "budget_tokens": N }  — a fixed reasoning budget
 *   { "type": "adaptive" }                     — the model decides how much to think
 *
 * Thinking is supported on Claude, OpenAI reasoning models, and Gemini. On
 * AWS Bedrock, Claude Opus 4.7 only supports the adaptive mode, so an
 * `enabled` request to that model is coerced to adaptive here.
 *
 * When thinking is on, `max_tokens` must be larger than `budget_tokens` so the
 * model has room for the actual answer after it finishes reasoning.
 */

/** UI-level thinking selection. `off` means "don't send the parameter". */
export type ThinkingLevel = 'off' | 'adaptive' | 'low' | 'medium' | 'high';

export interface ThinkingConfig {
  readonly type: 'enabled' | 'adaptive';
  /** Reasoning budget in tokens; only meaningful for `type: 'enabled'`. */
  readonly budgetTokens?: number;
}

/** Reasoning budgets for the fixed `enabled` levels. */
const BUDGETS: Record<'low' | 'medium' | 'high', number> = {
  low: 4096,
  medium: 8192,
  high: 16000
};

/** Extra tokens added on top of the reasoning budget so the answer has room. */
const RESPONSE_HEADROOM = 8192;

/** `max_tokens` ceiling used for adaptive thinking, where the budget is model-decided. */
const ADAPTIVE_MAX_TOKENS = 16000;

/** Map a stored/setting value to a valid {@link ThinkingLevel}. */
export function normalizeThinkingLevel(value: string | undefined): ThinkingLevel {
  return value === 'adaptive' || value === 'low' || value === 'medium' || value === 'high' ? value : 'off';
}

/** Map a UI level to the wire config, or `undefined` when thinking is off. */
export function resolveThinking(level: ThinkingLevel): ThinkingConfig | undefined {
  if (level === 'adaptive') {
    return { type: 'adaptive' };
  }
  if (level === 'low' || level === 'medium' || level === 'high') {
    return { type: 'enabled', budgetTokens: BUDGETS[level] };
  }
  return undefined;
}

export interface ThinkingPayload {
  readonly thinking: { type: 'enabled' | 'adaptive'; budget_tokens?: number };
  readonly max_tokens: number;
}

/**
 * Build the request fields for extended thinking, applying provider quirks.
 * Returns `undefined` when no thinking should be sent.
 */
export function buildThinkingRequest(model: string, config: ThinkingConfig | undefined): ThinkingPayload | undefined {
  if (!config) {
    return undefined;
  }
  // Bedrock Claude Opus 4.7 only supports adaptive thinking.
  const effective: ThinkingConfig =
    config.type === 'enabled' && /opus-4-7/i.test(model) ? { type: 'adaptive' } : config;

  if (effective.type === 'adaptive') {
    return { thinking: { type: 'adaptive' }, max_tokens: ADAPTIVE_MAX_TOKENS };
  }
  const budget = effective.budgetTokens ?? BUDGETS.low;
  return { thinking: { type: 'enabled', budget_tokens: budget }, max_tokens: budget + RESPONSE_HEADROOM };
}
