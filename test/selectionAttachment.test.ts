import assert from 'node:assert/strict';
import test from 'node:test';
import { createSelectionAttachment } from '../src/context/selectionAttachment';

test('createSelectionAttachment includes selected and surrounding context', () => {
  const attachment = createSelectionAttachment({
    filePath: '/workspace/src/app.ts',
    languageId: 'typescript',
    selectedText: 'const value = 1;',
    surroundingText: 'function main() {\n  const value = 1;\n}',
    maxCharacters: 200
  });

  assert.equal(attachment.kind, 'selection');
  assert.equal(attachment.filePath, '/workspace/src/app.ts');
  assert.match(attachment.content, /Selected text/);
  assert.match(attachment.content, /Surrounding context/);
});

test('createSelectionAttachment trims oversized content', () => {
  const attachment = createSelectionAttachment({
    filePath: '/workspace/src/app.ts',
    languageId: 'typescript',
    selectedText: 'x'.repeat(500),
    maxCharacters: 120
  });

  assert.equal(attachment.truncated, true);
  assert.ok(attachment.characterCount <= 120);
});
