import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fsp } from 'fs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IgnoreMatcher, loadIgnoreMatcher, matchesPattern, parseIgnoreFile } from '../src/context/ignoreRules';

async function buildMatcher(lines: string[]): Promise<{ root: string; matcher: IgnoreMatcher }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parley-ignore-'));
  await fsp.writeFile(path.join(root, '.parleyignore'), lines.join('\n'), 'utf8');
  const matcher = await loadIgnoreMatcher(root, false);
  return { root, matcher };
}

test('parseIgnoreFile removes comments and blanks but keeps negations', () => {
  assert.deepEqual(parseIgnoreFile('# comment\n\nnode_modules/\n!important.txt\n*.pem'), [
    'node_modules/',
    '!important.txt',
    '*.pem'
  ]);
});

test('matchesPattern supports directory, literal, and glob patterns', () => {
  assert.equal(matchesPattern('node_modules/a/index.js', 'node_modules/'), true);
  assert.equal(matchesPattern('src/generated/client.ts', 'generated/'), true);
  assert.equal(matchesPattern('src/private.key', '*.key'), true);
  assert.equal(matchesPattern('src/index.ts', 'src/index.ts'), true);
  assert.equal(matchesPattern('src/index.ts', '*.key'), false);
});

test('matchesPattern treats a bare directory name as the whole subtree', () => {
  assert.equal(matchesPattern('node_modules/react/index.js', 'node_modules'), true);
  assert.equal(matchesPattern('packages/app/node_modules/left-pad/index.js', 'node_modules'), true);
  assert.equal(matchesPattern('test/x.ts', 'test'), true);
  assert.equal(matchesPattern('test.js', 'test'), false);
});

test('ignore matcher honors negation with last-match-wins ordering', async () => {
  const { root, matcher } = await buildMatcher(['*', '!src/', '!package.json']);
  try {
    assert.equal(matcher.ignores(path.join(root, 'README.md')), true);
    assert.equal(matcher.ignores(path.join(root, 'src', 'index.ts')), false);
    assert.equal(matcher.ignores(path.join(root, 'package.json')), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('ignore matcher excludes contents of a bare directory pattern', async () => {
  const { root, matcher } = await buildMatcher(['node_modules']);
  try {
    assert.equal(matcher.ignores(path.join(root, 'node_modules', 'react', 'index.js')), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
