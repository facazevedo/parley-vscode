import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexOfUserMessage, truncateBeforeUserMessage, type TranscriptEntry } from '../src/transcript/transcript';

const AT = '2026-01-01T00:00:00.000Z';
const entries: TranscriptEntry[] = [
  { kind: 'user', text: 'first question', at: AT },
  { kind: 'assistant', text: 'first answer', at: AT },
  { kind: 'tool', action: 'Read a.ts', at: AT },
  { kind: 'user', text: 'second question', at: AT },
  { kind: 'note', text: 'a note', at: AT },
  { kind: 'user', text: 'third question', at: AT },
  { kind: 'assistant', text: 'third answer', at: AT }
];

test('truncating at the first user message empties the transcript', () => {
  assert.deepEqual(truncateBeforeUserMessage(entries, 0), []);
});

test('truncating at a middle user message keeps everything before it', () => {
  const out = truncateBeforeUserMessage(entries, 1);
  assert.ok(out);
  assert.equal(out!.length, 3);
  assert.equal(out![2].kind, 'tool');
});

test('truncating at the last user message drops it and its answer', () => {
  const out = truncateBeforeUserMessage(entries, 2);
  assert.ok(out);
  assert.equal(out!.length, 5);
  assert.deepEqual(
    out!.map((e) => e.kind),
    ['user', 'assistant', 'tool', 'user', 'note']
  );
});

test('an out-of-range ordinal returns undefined (nothing rewound)', () => {
  assert.equal(truncateBeforeUserMessage(entries, 3), undefined);
  assert.equal(truncateBeforeUserMessage([], 0), undefined);
});

test('the original array is never mutated', () => {
  const before = entries.length;
  truncateBeforeUserMessage(entries, 1);
  assert.equal(entries.length, before);
});

test('indexOfUserMessage locates each user entry by ordinal', () => {
  assert.equal(indexOfUserMessage(entries, 0), 0);
  assert.equal(indexOfUserMessage(entries, 1), 3);
  assert.equal(indexOfUserMessage(entries, 2), 5);
  assert.equal(indexOfUserMessage(entries, 3), undefined);
});
