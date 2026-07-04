import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankByQueryDetailed, type FileEntry } from '../src/codebase/embeddingIndexCore';
import { buildCodebaseRegion } from '../src/codebase/region';

test('rankByQueryDetailed reports the best-matching chunk start line', () => {
  const files = new Map<string, FileEntry>([
    [
      'a.ts',
      {
        hash: 'x',
        chunks: [
          { s: 1, vec: [1, 0] },
          { s: 51, vec: [0, 1] } // this chunk matches the query direction
        ]
      }
    ],
    ['b.ts', { hash: 'y', chunks: [{ s: 1, vec: [0.2, 0.2] }] }]
  ]);
  const ranked = rankByQueryDetailed([0, 1], files, 5);
  assert.equal(ranked[0].path, 'a.ts');
  assert.equal(ranked[0].startLine, 51, 'picks the higher-scoring chunk, not the first');
});

test('buildCodebaseRegion attaches the matched region for a large file', () => {
  const raw = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
  const region = buildCodebaseRegion(raw, 100, 100000);
  assert.equal(region.range, '95-160', '5 lines of leading context + a 60-line window');
  assert.ok(region.content.startsWith('line 95'));
  assert.ok(region.content.includes('line 100'));
  assert.ok(region.truncated, 'a sub-region of a bigger file is marked truncated');
});

test('buildCodebaseRegion falls back to the head for small files or no location', () => {
  const small = 'a\nb\nc';
  assert.deepEqual(buildCodebaseRegion(small, 2, 100), { content: 'a\nb\nc', truncated: false });
  const raw = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
  const head = buildCodebaseRegion(raw, undefined, 100000);
  assert.equal(head.range, undefined, 'no semantic location → no sub-range');
  assert.ok(head.content.startsWith('line 1'));
});

test('buildCodebaseRegion respects the character cap', () => {
  const raw = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
  const region = buildCodebaseRegion(raw, 100, 20);
  assert.ok(region.content.length <= 20);
  assert.ok(region.truncated);
});
