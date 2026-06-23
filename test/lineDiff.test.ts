import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyHunks, computeHunks, formatUnifiedDiff } from '../src/diff/lineDiff';

const lines = (s: string) => s.split('\n');

test('computeHunks finds separated change regions', () => {
  const a = lines('a\nb\nc\nd\ne');
  const b = lines('a\nB\nc\nd\nE');
  const hunks = computeHunks(a, b);
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0], { removed: ['b'], added: ['B'], origStart: 1 });
  assert.deepEqual(hunks[1], { removed: ['e'], added: ['E'], origStart: 4 });
});

test('computeHunks handles pure insertion and deletion', () => {
  assert.deepEqual(computeHunks(lines('a\nb'), lines('a\nx\nb')), [{ removed: [], added: ['x'], origStart: 1 }]);
  assert.deepEqual(computeHunks(lines('a\nx\nb'), lines('a\nb')), [{ removed: ['x'], added: [], origStart: 1 }]);
  assert.deepEqual(computeHunks(lines('a\nb'), lines('a\nb')), []);
});

test('applyHunks applies only accepted hunks', () => {
  const a = lines('a\nb\nc\nd\ne');
  const b = lines('a\nB\nc\nd\nE');
  const hunks = computeHunks(a, b);
  // accept none -> original
  assert.equal(applyHunks(a, hunks, [false, false]).join('\n'), 'a\nb\nc\nd\ne');
  // accept all -> proposed
  assert.equal(applyHunks(a, hunks, [true, true]).join('\n'), 'a\nB\nc\nd\nE');
  // accept only the first
  assert.equal(applyHunks(a, hunks, [true, false]).join('\n'), 'a\nB\nc\nd\ne');
  // accept only the second
  assert.equal(applyHunks(a, hunks, [false, true]).join('\n'), 'a\nb\nc\nd\nE');
});

test('round-trips a realistic multi-edit change', () => {
  const a = lines('import x\n\nfunction f() {\n  return 1;\n}\n');
  const b = lines('import x\nimport y\n\nfunction f() {\n  return 2;\n}\n');
  const hunks = computeHunks(a, b);
  assert.ok(hunks.length >= 1);
  assert.equal(applyHunks(a, hunks, hunks.map(() => true)).join('\n'), b.join('\n'));
});

test('formatUnifiedDiff counts add/del and tags rows with line numbers', () => {
  const before = 'a\nb\nc\nd';
  const after = 'a\nB\nc\nd';
  const { rows, added, removed } = formatUnifiedDiff(before, after, 3);
  assert.equal(added, 1);
  assert.equal(removed, 1);
  const del = rows.find((r) => r.kind === 'del')!;
  const add = rows.find((r) => r.kind === 'add')!;
  assert.equal(del.text, 'b');
  assert.equal(del.oldNo, 2);
  assert.equal(add.text, 'B');
  assert.equal(add.newNo, 2);
  // surrounding context is kept (a, c, d all within 3 lines of the change)
  assert.ok(rows.some((r) => r.kind === 'ctx' && r.text === 'a'));
});

test('formatUnifiedDiff collapses far-apart unchanged regions into a gap', () => {
  const before = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n');
  const after = before.replace('line0', 'CHANGED0').replace('line39', 'CHANGED39');
  const { rows } = formatUnifiedDiff(before, after, 2);
  assert.ok(rows.some((r) => r.kind === 'gap'));
  // the big unchanged middle is not all rendered
  assert.ok(rows.filter((r) => r.kind === 'ctx').length < 38);
});

test('formatUnifiedDiff treats a brand-new file as all additions', () => {
  const { added, removed, rows } = formatUnifiedDiff('', 'x\ny\nz');
  assert.equal(removed, 0);
  assert.equal(added, 3);
  assert.equal(rows.filter((r) => r.kind === 'add').length, 3);
});
