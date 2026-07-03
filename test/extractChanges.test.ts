import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setWorkspaceRoot } from './fakeVscode';
import { parseFileCodeBlocks } from '../src/diff/fileBlocks';

// The vscode stub must be installed before requiring the extractor, which imports `vscode`.
type ExtractChangesModule = typeof import('../src/diff/extractChanges');
// eslint-disable-next-line @typescript-eslint/no-var-requires -- loaded after the vscode stub is installed
const { extractFileCodeBlockChanges } = require('../src/diff/extractChanges') as ExtractChangesModule;

function tmpWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parley-extract-'));
  setWorkspaceRoot(root);
  return root;
}

test('parses a single File: block with its complete contents', () => {
  const response = [
    'Here is the change:',
    '',
    'File: src/app.ts',
    '```ts',
    'export const x = 1;',
    'console.log(x);',
    '```',
    'Done.'
  ].join('\n');
  const blocks = parseFileCodeBlocks(response);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].rawPath, 'src/app.ts');
  assert.equal(blocks[0].code, 'export const x = 1;\nconsole.log(x);\n');
});

test('parses multiple blocks and both File: and Path: labels', () => {
  const response = [
    'File: a.txt',
    '```',
    'alpha',
    '```',
    '',
    'Path: nested/dir/b.js',
    '```js',
    'const b = 2;',
    '```'
  ].join('\n');
  const blocks = parseFileCodeBlocks(response);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].rawPath, 'a.txt');
  assert.equal(blocks[1].rawPath, 'nested/dir/b.js');
  assert.equal(blocks[1].code, 'const b = 2;\n');
});

test('handles a backtick-wrapped path and a markdown heading prefix', () => {
  const response = ['### File: `src/util.ts`', '```ts', 'export {};', '```'].join('\n');
  const blocks = parseFileCodeBlocks(response);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].rawPath, 'src/util.ts');
});

test('ignores a fenced code block that has no File:/Path: label', () => {
  const response = ['Just an example:', '```ts', 'const noop = 0;', '```'].join('\n');
  assert.equal(parseFileCodeBlocks(response).length, 0);
});

test('returns nothing for prose with no code blocks', () => {
  assert.deepEqual(parseFileCodeBlocks('No changes here, just an explanation.'), []);
});

test('extractFileCodeBlockChanges rejects an absolute File: target outside the workspace', async () => {
  const root = tmpWorkspace();
  const absoluteTarget = path.resolve(path.parse(root).root, 'evil', 'target.txt');
  assert.ok(path.isAbsolute(absoluteTarget), 'precondition: crafted target must be absolute');
  const response = [`File: ${absoluteTarget}`, '```', 'owned', '```'].join('\n');
  assert.deepEqual(await extractFileCodeBlockChanges(response), []);
});

test('extractFileCodeBlockChanges rejects parent-traversal File: targets', async () => {
  tmpWorkspace();
  const single = ['File: ../outside.txt', '```', 'escape', '```'].join('\n');
  const nested = ['File: ../../other/config', '```', 'escape', '```'].join('\n');
  assert.deepEqual(await extractFileCodeBlockChanges(single), []);
  assert.deepEqual(await extractFileCodeBlockChanges(nested), []);
});

test('extractFileCodeBlockChanges still proposes an in-workspace change', async () => {
  const root = tmpWorkspace();
  const response = ['File: src/app.ts', '```ts', 'export const x = 1;', '```'].join('\n');
  const changes = await extractFileCodeBlockChanges(response);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].filePath, path.join(root, 'src', 'app.ts'));
  assert.equal(changes[0].proposedText, 'export const x = 1;\n');
});
