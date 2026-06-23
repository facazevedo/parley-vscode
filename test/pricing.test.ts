import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateCostUsd, formatUsd, rateFor } from '../src/parley/pricing';

test('rateFor matches specific GPT-5 variants before the GPT-5 fallback', () => {
  assert.deepEqual(rateFor('openai/gpt-5-nano'), { input: 0.1, output: 0.5 });
  assert.deepEqual(rateFor('openai/gpt-5-mini'), { input: 0.25, output: 2.0 });
  assert.deepEqual(rateFor('openai/gpt-5.5'), { input: 5.0, output: 30.0 });
  assert.deepEqual(rateFor('openai/gpt-5.4'), { input: 2.5, output: 15.0 });
  // GPT-5 / 5.1 / 5.2 fall back to the base GPT-5 rate.
  assert.deepEqual(rateFor('openai/gpt-5'), { input: 1.25, output: 10.0 });
  assert.deepEqual(rateFor('openai/gpt-5.2-codex'), { input: 1.25, output: 10.0 });
});

test('rateFor matches Claude and Gemini families by id', () => {
  assert.deepEqual(rateFor('bedrock/claude-haiku-4-5'), { input: 1.0, output: 5.0 });
  assert.deepEqual(rateFor('bedrock/claude-sonnet-4-6'), { input: 3.0, output: 15.0 });
  assert.deepEqual(rateFor('bedrock/claude-opus-4-7'), { input: 5.0, output: 25.0 });
  assert.deepEqual(rateFor('google/gemini-3.1-pro'), { input: 4.0, output: 18.0 });
  assert.deepEqual(rateFor('google/gemini-3.0-flash'), { input: 0.5, output: 3.0 });
});

test('rateFor returns undefined for unknown models', () => {
  assert.equal(rateFor('someprovider/mystery-model'), undefined);
});

test('estimateCostUsd applies input and output rates per million tokens', () => {
  // Sonnet: 1000 in * $3/M + 2000 out * $15/M = 0.003 + 0.030 = 0.033
  const cost = estimateCostUsd('bedrock/claude-sonnet-4-6', { prompt: 1000, completion: 2000 });
  assert.ok(cost !== undefined);
  assert.ok(Math.abs(cost - 0.033) < 1e-9);
  // Llama Maverick is free.
  assert.equal(estimateCostUsd('bedrock/llama-4-maverick-17b', { prompt: 5000, completion: 5000 }), 0);
  // Unknown model => undefined (don't show a misleading number).
  assert.equal(estimateCostUsd('x/y', { prompt: 100, completion: 100 }), undefined);
});

test('formatUsd is compact and handles small/zero amounts', () => {
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(-1), '$0.00');
  assert.equal(formatUsd(0.004), '<$0.01');
  assert.equal(formatUsd(0.041), '$0.04');
  assert.equal(formatUsd(12.5), '$12.50');
});
