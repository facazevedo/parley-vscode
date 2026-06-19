import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesPattern, parseIgnoreFile } from '../src/context/ignoreRules';

test('parseIgnoreFile removes comments, blanks, and negations', () => {
  assert.deepEqual(parseIgnoreFile('# comment\n\nnode_modules/\n!important.txt\n*.pem'), ['node_modules/', '*.pem']);
});

test('matchesPattern supports directory, literal, and glob patterns', () => {
  assert.equal(matchesPattern('node_modules/a/index.js', 'node_modules/'), true);
  assert.equal(matchesPattern('src/generated/client.ts', 'generated/'), true);
  assert.equal(matchesPattern('src/private.key', '*.key'), true);
  assert.equal(matchesPattern('src/index.ts', 'src/index.ts'), true);
  assert.equal(matchesPattern('src/index.ts', '*.key'), false);
});
