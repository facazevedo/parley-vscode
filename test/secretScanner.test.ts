import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  redactContextAttachments,
  redactSecrets,
  scanForSecrets,
  summarizeFindings
} from '../src/context/secretScanner';

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

test('PEM redaction removes the key BODY and footer, not just the header (regression)', () => {
  // Clearly-fake body — not a real key. Before the fix only the BEGIN header was
  // redacted and the key material itself survived.
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkqELIDEDBODY\n-----END RSA PRIVATE KEY-----';
  const { text, findings } = redactSecrets('prefix ' + pem + ' suffix');
  assert.ok(!text.includes('MIIEvQIBADANBgkqELIDEDBODY'), 'key body is removed');
  assert.ok(!text.includes('-----END'), 'footer is removed');
  assert.ok(text.includes('«redacted:'), 'replaced with a redaction marker');
  assert.ok(text.startsWith('prefix ') && text.endsWith(' suffix'), 'surrounding text survives');
  // Detection: the block-spanning pattern fires exactly once on the full PEM.
  assert.ok(
    findings.some((f) => f.type === 'private key block' && f.count === 1),
    'full block is detected as one finding'
  );
  assert.equal(scanForSecrets(pem).filter((f) => f.type === 'private key block').length, 1);
});

test('redactSecrets is a no-op on clean text (same string, no findings)', () => {
  const clean = 'export const timeout = 30_000;';
  const { text, findings } = redactSecrets(clean);
  assert.equal(text, clean);
  assert.deepEqual(findings, []);
});

test('redactContextAttachments redacts across items and merges findings by type', () => {
  const items = [
    { content: `a ${AWS}`, characterCount: 10 },
    { content: 'nothing here', characterCount: 12 },
    { content: `b ${AWS} ${GH}`, characterCount: 20 }
  ];
  const { items: out, findings } = redactContextAttachments(items, 'redact');
  assert.ok(!out[0].content!.includes(AWS) && !out[2].content!.includes(AWS));
  assert.equal(out[1].content, 'nothing here', 'clean item is untouched');
  assert.equal(out[0].characterCount, out[0].content!.length, 'characterCount is updated');
  // Two AWS keys (one per dirty item) merged, plus one GitHub token.
  assert.deepEqual(
    findings.sort((a, b) => a.type.localeCompare(b.type)),
    [
      { type: 'AWS access key', count: 2 },
      { type: 'GitHub token', count: 1 }
    ]
  );
});

test('redactContextAttachments: warn reports findings but leaves content unchanged; off is a pass-through', () => {
  const items = [{ content: `key ${AWS}`, characterCount: 20 }];
  const warned = redactContextAttachments(items, 'warn');
  assert.equal(warned.items[0].content, `key ${AWS}`, 'warn does not modify content');
  assert.equal(warned.findings.length, 1, 'warn still reports');

  const off = redactContextAttachments(items, 'off');
  assert.equal(off.items[0].content, `key ${AWS}`);
  assert.deepEqual(off.findings, []);
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
