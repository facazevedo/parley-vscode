import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkText } from '../src/codebase/chunk';

const line = (i: number): string => `line ${i}`;
const make = (n: number): string => Array.from({ length: n }, (_, i) => line(i + 1)).join('\n');

test('short files are one chunk starting at line 1', () => {
  const chunks = chunkText(make(30));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].startLine, 1);
  assert.ok(chunks[0].text.includes('line 30'));
});

test('long files chunk with overlap so boundaries are covered', () => {
  const chunks = chunkText(make(150));
  assert.ok(chunks.length >= 3, `expected >=3 chunks, got ${chunks.length}`);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[1].startLine, 51); // 60-line window, 10-line overlap → step 50
  // Overlap: line 55 appears in both chunk 0 and chunk 1.
  assert.ok(chunks[0].text.includes('line 55'));
  assert.ok(chunks[1].text.includes('line 55'));
});

test('every line of a long file is inside some chunk', () => {
  const chunks = chunkText(make(205));
  for (const probe of [1, 60, 61, 100, 150, 205]) {
    assert.ok(
      chunks.some((c) => c.text.split('\n').includes(line(probe))),
      `line ${probe} missing from all chunks`
    );
  }
});

test('empty/whitespace files produce no chunks', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n  \n'), []);
});
