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
  assert.ok(req.max_tokens > 8192);
});

test('buildThinkingRequest emits adaptive payload with a max_tokens ceiling', () => {
  const req = buildThinkingRequest('bedrock/claude-opus-4-6', { type: 'adaptive' })!;
  assert.equal(req.thinking.type, 'adaptive');
  assert.equal(req.thinking.budget_tokens, undefined);
  assert.ok(req.max_tokens > 0);
});

test('Bedrock Opus 4.7 coerces enabled thinking to adaptive (its only supported mode)', () => {
  const req = buildThinkingRequest('bedrock/claude-opus-4-7', { type: 'enabled', budgetTokens: 16000 })!;
  assert.equal(req.thinking.type, 'adaptive');
  assert.equal(req.thinking.budget_tokens, undefined);
});

test('other models keep enabled thinking as requested', () => {
  const req = buildThinkingRequest('bedrock/claude-opus-4-6', { type: 'enabled', budgetTokens: 4096 })!;
  assert.equal(req.thinking.type, 'enabled');
  assert.equal(req.thinking.budget_tokens, 4096);
});
