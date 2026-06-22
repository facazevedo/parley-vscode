import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyHunks, computeHunks } from '../src/diff/lineDiff';

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
