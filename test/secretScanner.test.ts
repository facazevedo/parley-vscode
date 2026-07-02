import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSecrets, scanForSecrets, summarizeFindings } from '../src/context/secretScanner';

// Test fixtures are assembled from parts so this test file itself trips no scanner.
const AWS = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const GH = 'ghp_' + 'a'.repeat(36);
const OPENAI = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2';
const ANTHROPIC = 'sk-ant-' + 'x'.repeat(40);

test('detects distinctive-prefix credentials', () => {
  assert.deepEqual(scanForSecrets(`key=${AWS}`), [{ type: 'AWS access key', count: 1 }]);
  assert.equal(scanForSecrets(`token: ${GH}`)[0].type, 'GitHub token');
  assert.equal(scanForSecrets(`bearer ${ANTHROPIC}`)[0].type, 'Anthropic key');
  assert.match(scanForSecrets(`AUTH=${OPENAI}`)[0].type, /OpenAI\/Parley/);
});

test('detects a PEM private key header and counts multiple hits', () => {
  const two = `${AWS}\nand also ${AWS}`;
  assert.deepEqual(scanForSecrets(two), [{ type: 'AWS access key', count: 2 }]);
  assert.equal(scanForSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\n...').length, 1);
});

test('does NOT flag ordinary code / prose (low false-positive)', () => {
  assert.deepEqual(scanForSecrets('const skipCount = items.length; // sk marker'), []);
  assert.deepEqual(scanForSecrets('function makeApiKey() { return "placeholder"; }'), []);
  assert.deepEqual(scanForSecrets('AKIA is a prefix but AKIA123 is too short'), []);
  assert.deepEqual(scanForSecrets(''), []);
});

test('redactSecrets replaces every hit with a typed marker and preserves surrounding text', () => {
  const { text, findings } = redactSecrets(`aws=${AWS} gh=${GH}`);
  assert.ok(!text.includes(AWS) && !text.includes(GH), 'no secret survives redaction');
  assert.match(text, /aws=«redacted:AWS access key» gh=«redacted:GitHub token»/);
  assert.equal(findings.length, 2);
});

test('redactSecrets is a no-op on clean text (same string, no findings)', () => {
  const clean = 'export const timeout = 30_000;';
  const { text, findings } = redactSecrets(clean);
  assert.equal(text, clean);
  assert.deepEqual(findings, []);
});

test('summarizeFindings pluralizes', () => {
  assert.equal(
    summarizeFindings([
      { type: 'AWS access key', count: 2 },
      { type: 'GitHub token', count: 1 }
    ]),
    '2 AWS access keys, 1 GitHub token'
  );
});
