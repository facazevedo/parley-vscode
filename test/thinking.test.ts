import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildThinkingRequest, normalizeThinkingLevel, resolveThinking } from '../src/parley/thinking';

test('normalizeThinkingLevel only accepts known levels, else off', () => {
  assert.equal(normalizeThinkingLevel('adaptive'), 'adaptive');
  assert.equal(normalizeThinkingLevel('low'), 'low');
  assert.equal(normalizeThinkingLevel('medium'), 'medium');
  assert.equal(normalizeThinkingLevel('high'), 'high');
  assert.equal(normalizeThinkingLevel('off'), 'off');
  assert.equal(normalizeThinkingLevel('minimal'), 'off'); // legacy effort value is no longer valid
  assert.equal(normalizeThinkingLevel(undefined), 'off');
});

test('resolveThinking maps levels to wire config', () => {
  assert.equal(resolveThinking('off'), undefined);
  assert.deepEqual(resolveThinking('adaptive'), { type: 'adaptive' });
  assert.deepEqual(resolveThinking('low'), { type: 'enabled', budgetTokens: 4096 });
  assert.deepEqual(resolveThinking('medium'), { type: 'enabled', budgetTokens: 8192 });
  assert.deepEqual(resolveThinking('high'), { type: 'enabled', budgetTokens: 16000 });
});

test('buildThinkingRequest is undefined when no config', () => {
  assert.equal(buildThinkingRequest('bedrock/claude-sonnet-4-6', undefined), undefined);
});

test('buildThinkingRequest sets a max_tokens larger than the budget for enabled mode', () => {
  const req = buildThinkingRequest('bedrock/claude-sonnet-4-6', { type: 'enabled', budgetTokens: 8192 })!;
  assert.deepEqual(req, { thinking: { type: 'enabled', budget_tokens: 8192 }, max_tokens: 8192 + 8192 });
  assert.ok(req.max_tokens! > 8192);
});

test('buildThinkingRequest emits adaptive payload with a max_tokens ceiling', () => {
  const req = buildThinkingRequest('bedrock/claude-opus-4-6', { type: 'adaptive' })!;
  assert.equal(req.thinking!.type, 'adaptive');
  assert.equal(req.thinking!.budget_tokens, undefined);
  assert.ok(req.max_tokens! > 0);
});

test('Bedrock Opus 4.7 coerces enabled thinking to adaptive (its only supported mode)', () => {
  const req = buildThinkingRequest('bedrock/claude-opus-4-7', { type: 'enabled', budgetTokens: 16000 })!;
  assert.equal(req.thinking!.type, 'adaptive');
  assert.equal(req.thinking!.budget_tokens, undefined);
});

test('other models keep enabled thinking as requested', () => {
  const req = buildThinkingRequest('bedrock/claude-opus-4-6', { type: 'enabled', budgetTokens: 4096 })!;
  assert.equal(req.thinking!.type, 'enabled');
  assert.equal(req.thinking!.budget_tokens, 4096);
});

test('OpenAI models use reasoning_effort, never the thinking block (which 400s)', () => {
  const high = buildThinkingRequest('openai/gpt-5.5', { type: 'enabled', budgetTokens: 16000 })!;
  assert.equal(high.thinking, undefined);
  assert.equal(high.max_tokens, undefined);
  assert.equal(high.reasoning_effort, 'high');

  const med = buildThinkingRequest('openai/gpt-5', { type: 'enabled', budgetTokens: 8192 })!;
  assert.equal(med.reasoning_effort, 'medium');
  const low = buildThinkingRequest('openai/gpt-5-mini', { type: 'enabled', budgetTokens: 4096 })!;
  assert.equal(low.reasoning_effort, 'low');
  const adaptive = buildThinkingRequest('openai/gpt-5', { type: 'adaptive' })!;
  assert.equal(adaptive.reasoning_effort, 'medium');
  assert.equal(adaptive.thinking, undefined);
});

test('Google/Gemini models also use reasoning_effort (not the thinking block)', () => {
  const req = buildThinkingRequest('google/gemini-3.1-pro', { type: 'enabled', budgetTokens: 16000 })!;
  assert.equal(req.reasoning_effort, 'high');
  assert.equal(req.thinking, undefined);
  assert.equal(req.max_tokens, undefined);
});

test('models without a reasoning mode (e.g. Llama) send nothing', () => {
  assert.equal(
    buildThinkingRequest('bedrock/llama-4-maverick-17b', { type: 'enabled', budgetTokens: 8192 }),
    undefined
  );
});

test('capMaxTokens caps output at half the known context window', async () => {
  const { capMaxTokens } = await import('../src/parley/thinking');
  assert.equal(capMaxTokens('bedrock/claude-haiku-4-5', 999999), 100000); // 200K window → 100K cap
  assert.equal(capMaxTokens('bedrock/claude-haiku-4-5', 24192), 24192); // normal budgets unaffected
  assert.equal(capMaxTokens('totally/unknown-model', 999999), 999999); // unknown window → uncapped
});
