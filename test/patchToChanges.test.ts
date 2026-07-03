import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fakeVscode, setWorkspaceRoot } from './fakeVscode';
import { applyFilePatch } from '../src/diff/applyFilePatch';

type PatchToChangesModule = typeof import('../src/diff/patchToChanges');
// The vscode stub must be installed before requiring modules that import vscode.
// eslint-disable-next-line @typescript-eslint/no-var-requires -- loaded after the vscode stub is installed
const { parseUnifiedDiffToChanges } = require('../src/diff/patchToChanges') as PatchToChangesModule;

// The stock fake rejects openTextDocument (tool tests never want the language server);
// these tests need it to serve real file contents for existing files.
fakeVscode.workspace.openTextDocument = async (uri: { fsPath: string }) => ({
  getText: () => fs.readFileSync(uri.fsPath, 'utf8')
});

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parley-patch-'));
  setWorkspaceRoot(root);
  return root;
}

test('applyFilePatch applies matching context hunks', () => {
  const result = applyFilePatch('a\nb\nc\n', [{ lines: [' a', '-b', '+B', ' c'], oldStart: 1 }]);

  assert.equal(result, 'a\nB\nc\n');
});

test('applyFilePatch rejects hunks that do not match', () => {
  assert.throws(() => applyFilePatch('a\nb\nc\n', [{ lines: [' x', '-b', '+B'], oldStart: 1 }]), /did not match/);
});

test('applyFilePatch uses the @@ old-start line to pick between duplicate blocks', () => {
  const original = 'foo\nbar\nbaz\nfoo\nbar\nbaz\n';
  const lines = [' foo', '-bar', '+BAR', ' baz'];

  // The context matches both blocks; the header line number must disambiguate.
  assert.equal(applyFilePatch(original, [{ lines, oldStart: 4 }]), 'foo\nbar\nbaz\nfoo\nBAR\nbaz\n');
  assert.equal(applyFilePatch(original, [{ lines, oldStart: 1 }]), 'foo\nBAR\nbaz\nfoo\nbar\nbaz\n');
});

test('parseUnifiedDiffToChanges turns a --- /dev/null diff into a new-file change', async () => {
  const root = tmpRoot();
  const patch = [
    'diff --git a/notes.txt b/notes.txt',
    '--- /dev/null',
    '+++ b/notes.txt',
    '@@ -0,0 +1,2 @@',
    '+hello',
    '+world',
    ''
  ].join('\n');

  const changes = await parseUnifiedDiffToChanges(patch);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].filePath, path.join(root, 'notes.txt'));
  assert.equal(changes[0].originalText, '');
  assert.equal(changes[0].proposedText, 'hello\nworld\n');
  assert.equal(changes[0].title, 'New file: notes.txt');
  assert.notEqual(changes[0].deleteFile, true);
});

test('parseUnifiedDiffToChanges flags a +++ /dev/null diff as a deletion', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'old.txt'), 'gone\n');
  const patch = ['diff --git a/old.txt b/old.txt', '--- a/old.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone', ''].join(
    '\n'
  );

  const changes = await parseUnifiedDiffToChanges(patch);

  assert.equal(changes.length, 1);
  assert.equal(changes[0].filePath, path.join(root, 'old.txt'));
  assert.equal(changes[0].deleteFile, true);
  assert.equal(changes[0].originalText, 'gone\n');
  assert.equal(changes[0].proposedText, '');
});
