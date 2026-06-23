import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextWindowFor, modelSupportsThinking } from '../src/parley/models';

test('contextWindowFor returns documented windows, specific GPT-5 variants first', () => {
  assert.equal(contextWindowFor('openai/gpt-5.4'), 1_000_000);
  assert.equal(contextWindowFor('openai/gpt-5.5'), 1_000_000);
  assert.equal(contextWindowFor('openai/gpt-5'), 400_000);
  assert.equal(contextWindowFor('openai/gpt-5-nano'), 400_000);
  assert.equal(contextWindowFor('bedrock/claude-haiku-4-5'), 200_000);
  assert.equal(contextWindowFor('bedrock/claude-sonnet-4-6'), 1_000_000);
  assert.equal(contextWindowFor('google/gemini-3.0-flash'), 200_000);
  assert.equal(contextWindowFor('google/gemini-3.1-pro'), 1_000_000);
  assert.equal(contextWindowFor('unknown/model'), undefined);
});

test('modelSupportsThinking excludes Llama and image models', () => {
  assert.equal(modelSupportsThinking('bedrock/claude-opus-4-7'), true);
  assert.equal(modelSupportsThinking('google/gemini-3.1-pro'), true);
  assert.equal(modelSupportsThinking('openai/gpt-5'), true);
  assert.equal(modelSupportsThinking('bedrock/llama-4-maverick-17b'), false);
  assert.equal(modelSupportsThinking('openai/gpt-image-1'), false);
});
