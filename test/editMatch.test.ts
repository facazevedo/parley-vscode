import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applySnippetEdit } from '../src/diff/editMatch';

const FILE = ['function add(a, b) {', '  return a + b;', '}', '', 'function sub(a, b) {', '  return a - b;', '}'].join(
  '\n'
);

test('tier 1: exact unique match replaces in place', () => {
  const r = applySnippetEdit(FILE, 'return a + b;', 'return a + b + 0;');
  assert.equal(r.kind, 'ok');
  assert.ok(r.kind === 'ok' && r.newText.includes('return a + b + 0;'));
  assert.ok(r.kind === 'ok' && r.newText.includes('return a - b;'), 'other function untouched');
});

test('tier 1: exact ambiguous match reports the line numbers', () => {
  const r = applySnippetEdit(FILE, 'function ', 'fn ');
  assert.equal(r.kind, 'ambiguous');
  assert.deepEqual(r.kind === 'ambiguous' && r.startLines, [1, 5]);
});

test('tier 2: indentation differences still match (trimmed lines)', () => {
  const r = applySnippetEdit(FILE, 'return a + b;\n}', 'return a + b; // sum\n}');
  assert.equal(r.kind, 'ok');
  assert.ok(r.kind === 'ok' && r.newText.includes('// sum'));
});

test('tier 3: collapsed internal whitespace still matches', () => {
  const r = applySnippetEdit(FILE, 'function  add(a,  b)  {', 'function add(a, b, c) {');
  assert.equal(r.kind, 'ok');
  assert.ok(r.kind === 'ok' && r.newText.startsWith('function add(a, b, c) {'));
});

test('CRLF files: line-tier replacement keeps CRLF endings', () => {
  const crlf = FILE.replace(/\n/g, '\r\n');
  // Force the line tier (indentation mismatch) so the file is reassembled.
  const r = applySnippetEdit(crlf, '  return a - b;\n  }', '  return b - a;\n}');
  assert.equal(r.kind, 'ok');
  assert.ok(r.kind === 'ok' && r.newText.includes('return b - a;'));
  assert.ok(r.kind === 'ok' && r.newText.includes('\r\n'), 'CRLF preserved');
  assert.ok(r.kind === 'ok' && !/[^\r]\n/.test(r.newText), 'no bare LFs introduced');
});

test('notfound: close-but-wrong snippet returns a repair hint with real content', () => {
  const r = applySnippetEdit(FILE, 'function sub(a, b) {\n  return a * b;\n}', 'x');
  assert.equal(r.kind, 'notfound');
  const hint = r.kind === 'notfound' ? r.hint : undefined;
  assert.ok(hint, 'expected a closest-match hint');
  assert.equal(hint!.startLine, 5);
  assert.equal(hint!.endLine, 7);
  assert.ok(hint!.similarity >= 0.6, `similarity ${hint!.similarity}`);
  assert.ok(hint!.excerpt.includes('return a - b;'), 'excerpt shows the actual file content');
  assert.ok(hint!.excerpt.includes('5 |'), 'excerpt is line-numbered');
});

test('notfound: nothing similar yields no hint', () => {
  const r = applySnippetEdit(FILE, 'class Zebra {\n  gallop();\n}', 'x');
  assert.equal(r.kind, 'notfound');
  assert.equal(r.kind === 'notfound' ? r.hint : 'set', undefined);
});

test('empty old_text is notfound, never a whole-file wipe', () => {
  const r = applySnippetEdit(FILE, '', 'boom');
  assert.equal(r.kind, 'notfound');
  const blank = applySnippetEdit(FILE, '\n  \n', 'boom');
  assert.equal(blank.kind, 'notfound');
});

test('multi-line replacement splices the window exactly once', () => {
  const r = applySnippetEdit(FILE, 'function sub(a, b) {\n    return a - b;\n  }', 'const sub = (a, b) => a - b;');
  assert.equal(r.kind, 'ok');
  const text = r.kind === 'ok' ? r.newText : '';
  assert.ok(text.includes('const sub = (a, b) => a - b;'));
  assert.ok(!text.includes('function sub'), 'old window fully removed');
  assert.ok(text.includes('function add(a, b) {'), 'preceding code intact');
});
