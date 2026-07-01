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

import { contextWindowFor } from './models';

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
  /** Anthropic/Bedrock/Gemini style reasoning block. */
  readonly thinking?: { type: 'enabled' | 'adaptive'; budget_tokens?: number };
  readonly max_tokens?: number;
  /** OpenAI-style reasoning control (OpenAI rejects the `thinking` block with a 400). */
  readonly reasoning_effort?: 'low' | 'medium' | 'high';
}

/**
 * Build the request fields for extended thinking, applying provider quirks.
 * Returns `undefined` when no thinking should be sent.
 *
 * Each provider exposes reasoning differently:
 * - **OpenAI** and **Google/Gemini** use the OpenAI-style `reasoning_effort`
 *   (`low`/`medium`/`high`). Sending the `thinking` block to them yields
 *   `400 Unknown parameter: 'thinking'`.
 * - **Claude** (Bedrock/Anthropic) uses the Anthropic-style `thinking` block
 *   plus `max_tokens`. Bedrock Claude Opus 4.7 only supports adaptive thinking.
 * - Other models (e.g. Llama) have no reasoning controls, so nothing is sent.
 */
export function buildThinkingRequest(model: string, config: ThinkingConfig | undefined): ThinkingPayload | undefined {
  if (!config) {
    return undefined;
  }

  // OpenAI + Google expose reasoning via the OpenAI-compatible `reasoning_effort`.
  if (/^openai\//i.test(model) || /^google\//i.test(model) || /gemini/i.test(model)) {
    const budget = config.budgetTokens ?? 0;
    const effort: 'low' | 'medium' | 'high' =
      config.type === 'adaptive' ? 'medium' : budget >= 16000 ? 'high' : budget >= 8192 ? 'medium' : 'low';
    return { reasoning_effort: effort };
  }

  // Claude (Anthropic / Bedrock) uses the Anthropic-style `thinking` block.
  if (/claude|anthropic/i.test(model)) {
    const effective: ThinkingConfig =
      config.type === 'enabled' && /opus-4-7/i.test(model) ? { type: 'adaptive' } : config;
    if (effective.type === 'adaptive') {
      return { thinking: { type: 'adaptive' }, max_tokens: capMaxTokens(model, ADAPTIVE_MAX_TOKENS) };
    }
    const budget = effective.budgetTokens ?? BUDGETS.low;
    const maxTokens = capMaxTokens(model, budget + RESPONSE_HEADROOM);
    // budget_tokens must stay BELOW max_tokens (Anthropic requirement) even after capping.
    const safeBudget = Math.min(budget, Math.max(1024, maxTokens - 1024));
    return { thinking: { type: 'enabled', budget_tokens: safeBudget }, max_tokens: maxTokens };
  }

  // Models without a reasoning mode (e.g. Llama) — send nothing.
  return undefined;
}

/**
 * Cap the requested output tokens to half the model's context window (when known),
 * so a thinking budget can never crowd out the prompt on small-window models.
 */
export function capMaxTokens(model: string, desired: number): number {
  const window = contextWindowFor(model);
  return window ? Math.min(desired, Math.max(2048, Math.floor(window / 2))) : desired;
}
