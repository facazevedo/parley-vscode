import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatRecentEdits, pushEdit, type RecentEdit } from '../src/completion/recentEditsCore';

test('pushEdit coalesces consecutive edits on the same file+line', () => {
  const edits: RecentEdit[] = [];
  pushEdit(edits, { file: 'a.ts', line: 3, text: 'const x = 1' }, 5);
  pushEdit(edits, { file: 'a.ts', line: 3, text: 'const x = 12' }, 5);
  assert.equal(edits.length, 1, 'same file+line updates in place');
  assert.equal(edits[0].text, 'const x = 12');
});

test('pushEdit preserves the original before across a coalesced burst', () => {
  const edits: RecentEdit[] = [];
  pushEdit(edits, { file: 'a.ts', line: 3, text: 'const x = 1', before: 'const x = 0' }, 5);
  pushEdit(edits, { file: 'a.ts', line: 3, text: 'const x = 12', before: 'const x = 1' }, 5);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].text, 'const x = 12');
  assert.equal(edits[0].before, 'const x = 0', 'keeps the pre-burst original, not the intermediate');
});

test('formatRecentEdits renders a before → after delta when known and changed', () => {
  const edits: RecentEdit[] = [{ file: 'a.ts', line: 4, text: 'return b;', before: 'return a;' }];
  assert.equal(formatRecentEdits(edits, 'z.ts'), 'a.ts:5: return a; → return b;');
});

test('formatRecentEdits omits the delta when before is absent or unchanged', () => {
  assert.equal(formatRecentEdits([{ file: 'a.ts', line: 0, text: 'x' }], 'z.ts'), 'a.ts:1: x');
  assert.equal(formatRecentEdits([{ file: 'a.ts', line: 0, text: 'x', before: 'x' }], 'z.ts'), 'a.ts:1: x');
});

test('pushEdit keeps distinct locations and caps the ring at max (oldest dropped)', () => {
  const edits: RecentEdit[] = [];
  for (let i = 1; i <= 7; i += 1) {
    pushEdit(edits, { file: `f${i}.ts`, line: i, text: `line ${i}` }, 5);
  }
  assert.equal(edits.length, 5);
  assert.deepEqual(
    edits.map((e) => e.file),
    ['f3.ts', 'f4.ts', 'f5.ts', 'f6.ts', 'f7.ts'],
    'oldest two evicted'
  );
});

test('formatRecentEdits excludes the completed file and formats file:line: text (1-based)', () => {
  const edits: RecentEdit[] = [
    { file: 'a.ts', line: 0, text: 'first' },
    { file: 'b.ts', line: 41, text: 'second' }
  ];
  assert.equal(formatRecentEdits(edits, 'b.ts'), 'a.ts:1: first');
  assert.equal(formatRecentEdits(edits, 'a.ts'), 'b.ts:42: second');
  assert.equal(formatRecentEdits([], 'x.ts'), undefined);
  assert.equal(
    formatRecentEdits([{ file: 'a.ts', line: 0, text: 'x' }], 'a.ts'),
    undefined,
    'all excluded → undefined'
  );
});
