import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFileCodeBlocks } from '../src/diff/fileBlocks';

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
