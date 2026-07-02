import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dot,
  parseIndex,
  planBuild,
  rankByQuery,
  serializeIndex,
  type FileEntry
} from '../src/codebase/embeddingIndexCore';

const hashOf = (t: string): string => `h:${t.length}:${t[0] ?? ''}`; // deterministic stand-in

test('dot is the sum of products up to the shorter length', () => {
  assert.equal(dot([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(dot([1, 2, 3], [1, 1]), 3, 'stops at the shorter vector');
});

test('parseIndex loads a v2 file map directly', () => {
  const files = parseIndex({ root: '/r', version: 2, files: { 'a.ts': { hash: 'x', chunks: [{ s: 1, vec: [1] }] } } });
  assert.equal(files.size, 1);
  assert.equal(files.get('a.ts')?.hash, 'x');
});

test('parseIndex migrates a legacy v1 file (whole-file vector → single stale-hash chunk)', () => {
  const files = parseIndex({ root: '/r', entries: [{ path: 'a.ts', vec: [0.1, 0.2] }] });
  const entry = files.get('a.ts')!;
  assert.equal(entry.hash, '', 'stale hash forces a re-embed on next build');
  assert.deepEqual(entry.chunks, [{ s: 1, vec: [0.1, 0.2] }]);
});

test('serializeIndex round-trips through parseIndex', () => {
  const files = new Map<string, FileEntry>([['a.ts', { hash: 'h', chunks: [{ s: 1, vec: [1, 2] }] }]]);
  const payload = serializeIndex('/root', files);
  assert.equal(payload.version, 2);
  assert.equal(payload.root, '/root');
  assert.deepEqual(parseIndex(payload).get('a.ts'), files.get('a.ts'));
});

test('planBuild reuses unchanged files and re-embeds changed / stale-hash / new ones', () => {
  const existing = new Map<string, FileEntry>([
    ['same.ts', { hash: hashOf('AAAA'), chunks: [{ s: 1, vec: [1] }] }],
    ['changed.ts', { hash: hashOf('OLD'), chunks: [{ s: 1, vec: [1] }] }],
    ['migrated.ts', { hash: '', chunks: [{ s: 1, vec: [1] }] }] // v1-migrated: empty hash
  ]);
  const docs = [
    { path: 'same.ts', text: 'AAAA' },
    { path: 'changed.ts', text: 'BBBBBB' },
    { path: 'migrated.ts', text: 'CCCC' },
    { path: 'new.ts', text: 'DDDD' }
  ];
  const { reuse, embed } = planBuild(docs, existing, hashOf);
  assert.deepEqual(
    reuse.map(([p]) => p),
    ['same.ts'],
    'only the unchanged file is reused'
  );
  assert.deepEqual(
    embed.map((e) => e.path).sort(),
    ['changed.ts', 'migrated.ts', 'new.ts'],
    'changed + stale-hash + new are re-embedded'
  );
});

test('rankByQuery returns the top-N paths by best-chunk cosine', () => {
  const files = new Map<string, FileEntry>([
    ['near.ts', { hash: '', chunks: [{ s: 1, vec: [1, 0] }] }],
    ['mid.ts', { hash: '', chunks: [{ s: 1, vec: [0.6, 0.8] }] }],
    ['far.ts', { hash: '', chunks: [{ s: 1, vec: [0, 1] }] }]
  ]);
  assert.deepEqual(rankByQuery([1, 0], files, 2), ['near.ts', 'mid.ts']);
  assert.deepEqual(rankByQuery([1, 0], files, 1), ['near.ts']);
});

test('rankByQuery uses the BEST chunk per file', () => {
  const files = new Map<string, FileEntry>([
    [
      'multi.ts',
      {
        hash: '',
        chunks: [
          { s: 1, vec: [0, 1] },
          { s: 60, vec: [1, 0] }
        ]
      }
    ],
    ['single.ts', { hash: '', chunks: [{ s: 1, vec: [0.9, 0.1] }] }]
  ]);
  assert.deepEqual(rankByQuery([1, 0], files, 1), ['multi.ts'], 'its second chunk is the closest overall');
});
