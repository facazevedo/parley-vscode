import assert from 'node:assert/strict';
import { test } from 'node:test';
import { audioFormatFromExt, audioFormatFromMime, modelSupportsAudio } from '../src/parley/audio';

test('audioFormatFromExt recognizes wav and mp3 only', () => {
  assert.equal(audioFormatFromExt('.wav'), 'wav');
  assert.equal(audioFormatFromExt('.MP3'), 'mp3');
  assert.equal(audioFormatFromExt('.ogg'), undefined);
  assert.equal(audioFormatFromExt('.png'), undefined);
});

test('audioFormatFromMime maps common audio MIME types', () => {
  assert.equal(audioFormatFromMime('audio/wav'), 'wav');
  assert.equal(audioFormatFromMime('audio/x-wav'), 'wav');
  assert.equal(audioFormatFromMime('audio/mpeg'), 'mp3');
  assert.equal(audioFormatFromMime('audio/mp3'), 'mp3');
  assert.equal(audioFormatFromMime('image/png'), undefined);
});

test('modelSupportsAudio allows only OpenAI and Google', () => {
  assert.equal(modelSupportsAudio('openai/gpt-5'), true);
  assert.equal(modelSupportsAudio('google/gemini-3.1-pro'), true);
  assert.equal(modelSupportsAudio('bedrock/claude-sonnet-4-6'), false);
  assert.equal(modelSupportsAudio('anthropic/claude-opus-4-6'), false);
});
