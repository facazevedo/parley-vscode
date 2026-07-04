import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampEnd,
  clampStart,
  extendFromCache,
  stopAtBlankLine,
  trimSuffixOverlap,
  LruCache
} from '../src/completion/completionText';

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

test('trimSuffixOverlap drops a closing brace the suffix already has', () => {
  assert.equal(trimSuffixOverlap('  return x;\n}', '\n}'), '  return x;', 'trims the duplicated \n}');
  assert.equal(trimSuffixOverlap('foo()', ');'), 'foo(', 'trims a duplicated close paren');
  assert.equal(trimSuffixOverlap('const a = 1;', '\nconst b = 2;'), 'const a = 1;', 'no overlap → unchanged');
  assert.equal(trimSuffixOverlap('doThing()', ''), 'doThing()', 'empty suffix → unchanged');
  assert.equal(trimSuffixOverlap('x + y', 'z'), 'x + y', 'non-closer chars are never trimmed');
});

test('LruCache returns stored values and evicts the oldest past capacity', () => {
  const c = new LruCache<string>(2);
  c.set('a', '1');
  c.set('b', '2');
  assert.equal(c.get('a'), '1');
  c.set('c', '3'); // 'b' is now oldest (a was just read) → evicted
  assert.equal(c.get('b'), undefined, 'least-recently-used entry evicted');
  assert.equal(c.get('a'), '1');
  assert.equal(c.get('c'), '3');
});
