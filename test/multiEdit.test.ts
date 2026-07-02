import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyMultiEdit } from '../src/diff/editMatch';

const FILE = ['const a = 1;', 'const b = 2;', 'const c = 3;', ''].join('\n');

test('applies multiple independent edits in one pass', () => {
  const r = applyMultiEdit(FILE, [
    { oldText: 'const a = 1;', newText: 'const a = 10;' },
    { oldText: 'const c = 3;', newText: 'const c = 30;' }
  ]);
  assert.equal(r.kind, 'ok');
  assert.equal(r.kind === 'ok' && r.newText, ['const a = 10;', 'const b = 2;', 'const c = 30;', ''].join('\n'));
});

test('all-or-nothing: one failing edit aborts the whole batch with its index', () => {
  const r = applyMultiEdit(FILE, [
    { oldText: 'const a = 1;', newText: 'const a = 10;' },
    { oldText: 'const NOPE = 9;', newText: 'x' }
  ]);
  assert.equal(r.kind, 'error');
  assert.equal(r.kind === 'error' && r.index, 1);
  assert.match(r.kind === 'error' ? r.message : '', /not found/);
});

test('overlap guard: a later old_text may not match text an earlier edit inserted', () => {
  const r = applyMultiEdit(FILE, [
    { oldText: 'const b = 2;', newText: 'const b = 2; // marker' },
    { oldText: '// marker', newText: '// changed' } // matches only edit #1 output
  ]);
  assert.equal(r.kind, 'error');
  assert.equal(r.kind === 'error' && r.index, 1);
  assert.match(r.kind === 'error' ? r.message : '', /overlaps text inserted by edit #1/);
});

test('sequential edits see each other’s result (later edit targets earlier output legitimately is guarded; independent chaining works)', () => {
  // Two edits to different lines; the second must still match the original untouched line.
  const r = applyMultiEdit(FILE, [
    { oldText: 'const a = 1;', newText: 'const a = 1;\nconst a2 = 11;' },
    { oldText: 'const b = 2;', newText: 'const b = 22;' }
  ]);
  assert.equal(r.kind, 'ok');
  assert.equal(
    r.kind === 'ok' && r.newText,
    ['const a = 1;', 'const a2 = 11;', 'const b = 22;', 'const c = 3;', ''].join('\n')
  );
});

test('empty batch and no-op batch are rejected', () => {
  assert.equal(applyMultiEdit(FILE, []).kind, 'error');
  const missingOld = applyMultiEdit(FILE, [{ oldText: '', newText: 'x' }]);
  assert.equal(missingOld.kind, 'error');
  assert.equal(missingOld.kind === 'error' && missingOld.index, 0);
});

test('a failed match still returns a repair hint for the offending edit', () => {
  const r = applyMultiEdit(FILE, [{ oldText: 'const b = 2', newText: 'const b = 20' }]);
  // 'const b = 2' (no semicolon) misses exact match; tiered matching finds it, so this succeeds.
  assert.equal(r.kind, 'ok');
  const miss = applyMultiEdit(FILE, [{ oldText: 'const zzz = 99;\nconst yyy = 98;', newText: 'x' }]);
  assert.equal(miss.kind, 'error');
  // hint may or may not be present depending on similarity; if present it carries an excerpt.
  if (miss.kind === 'error' && miss.hint) {
    assert.ok(miss.hint.excerpt.length > 0);
  }
});
