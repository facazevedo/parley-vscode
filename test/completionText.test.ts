import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampEnd, clampStart, extendFromCache, stopAtBlankLine } from '../src/completion/completionText';

test('stopAtBlankLine cuts at the first blank line', () => {
  assert.equal(stopAtBlankLine('const a = 1;\nconst b = 2;'), 'const a = 1;\nconst b = 2;');
  assert.equal(stopAtBlankLine('block one\n\nblock two'), 'block one');
  assert.equal(stopAtBlankLine('a\n \t \nb'), 'a', 'whitespace-only line counts as blank');
});

test('clampStart keeps the tail nearest the cursor; clampEnd keeps the head', () => {
  assert.equal(clampStart('abcdef', 3), 'def');
  assert.equal(clampStart('ab', 3), 'ab');
  assert.equal(clampEnd('abcdef', 3), 'abc');
  assert.equal(clampEnd('ab', 3), 'ab');
});

test('extendFromCache serves the untyped remainder while the user follows the suggestion', () => {
  const cached = { docKey: 'file://x', prefix: 'const total = ', completion: 'items.reduce((a, b) => a + b, 0);' };
  // User has typed the first few chars of the suggestion.
  assert.equal(extendFromCache(cached, 'file://x', 'const total = items.re'), 'duce((a, b) => a + b, 0);');
});

test('extendFromCache declines when the cache no longer applies', () => {
  const cached = { docKey: 'file://x', prefix: 'const total = ', completion: 'items.length;' };
  assert.equal(extendFromCache(undefined, 'file://x', 'anything'), undefined);
  assert.equal(extendFromCache(cached, 'file://OTHER', 'const total = it'), undefined, 'different doc');
  assert.equal(extendFromCache(cached, 'file://x', 'const total = xyz'), undefined, 'diverged from suggestion');
  assert.equal(extendFromCache(cached, 'file://x', 'const total = '), undefined, 'nothing typed yet');
  assert.equal(extendFromCache(cached, 'file://x', 'const total = items.length;'), undefined, 'fully typed');
});
