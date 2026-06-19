import assert from 'node:assert/strict';
import test from 'node:test';
import { applyFilePatch } from '../src/diff/applyFilePatch';

test('applyFilePatch applies matching context hunks', () => {
  const result = applyFilePatch('a\nb\nc\n', [
    [' a', '-b', '+B', ' c']
  ]);

  assert.equal(result, 'a\nB\nc\n');
});

test('applyFilePatch rejects hunks that do not match', () => {
  assert.throws(() => applyFilePatch('a\nb\nc\n', [[' x', '-b', '+B']]), /did not match/);
});
