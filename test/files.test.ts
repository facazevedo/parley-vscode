import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentProviderFor } from '../src/parley/files';

test('documentProviderFor routes OpenAI and Google models to the upload endpoint', () => {
  assert.equal(documentProviderFor('openai/gpt-5'), 'openai');
  assert.equal(documentProviderFor('openai/gpt-5.4'), 'openai');
  assert.equal(documentProviderFor('google/gemini-3.1-pro'), 'google');
});

test('documentProviderFor returns undefined (inline) for Bedrock/Anthropic and others', () => {
  // Bedrock Claude has no /v1/files support, so documents go inline.
  assert.equal(documentProviderFor('bedrock/claude-sonnet-4-6'), undefined);
  assert.equal(documentProviderFor('anthropic/claude-opus-4-6'), undefined);
  assert.equal(documentProviderFor('mystery/model'), undefined);
});
