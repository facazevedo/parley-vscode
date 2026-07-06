import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatSnapshot,
  pushEntry,
  sanitizeCommandOutput,
  stripAnsi,
  type TerminalEntry
} from '../src/context/terminalText';

const ESC = String.fromCharCode(27); // \x1b
const BEL = String.fromCharCode(7); // \x07
const BS = String.fromCharCode(8); // \b

test('stripAnsi removes CSI color codes and OSC title sequences, keeps plain text', () => {
  assert.equal(stripAnsi(`${ESC}[31mred${ESC}[0m text`), 'red text');
  assert.equal(stripAnsi(`${ESC}[2K${ESC}[1Gprompt$ `), 'prompt$ ');
  assert.equal(stripAnsi(`${ESC}]0;window title${BEL}output`), 'output');
  assert.equal(stripAnsi('no escapes here'), 'no escapes here');
});

test('pushEntry appends and caps the ring at max (most recent kept)', () => {
  const entries: TerminalEntry[] = [];
  for (let i = 1; i <= 12; i += 1) {
    pushEntry(entries, { terminal: 'zsh', command: `cmd ${i}`, output: `out ${i}`, at: '' }, 10);
  }
  assert.equal(entries.length, 10);
  assert.equal(entries[0].command, 'cmd 3', 'oldest two evicted');
  assert.equal(entries[9].command, 'cmd 12');
});

test('sanitizeCommandOutput applies backspaces (spinner frames collapse to the last)', () => {
  // conda-style spinner: "-", backspace, "\\" -> shows the final frame.
  assert.equal(sanitizeCommandOutput(`-${BS}\\`), '\\');
  // two-char frame erased by two backspaces, then rewritten.
  assert.equal(sanitizeCommandOutput(`- ${BS}${BS}ok`), 'ok');
});

test('sanitizeCommandOutput collapses carriage-return progress redraws to the final frame', () => {
  assert.equal(sanitizeCommandOutput('progress 10%\rprogress 55%\rprogress 100%'), 'progress 100%');
  // CRLF is a real newline, not a redraw.
  assert.equal(sanitizeCommandOutput('line1\r\nline2'), 'line1\nline2');
});

test('sanitizeCommandOutput strips ANSI cursor moves and leftover control chars', () => {
  assert.equal(sanitizeCommandOutput(`100%${ESC}[A${ESC}[A done`), '100% done');
  assert.equal(sanitizeCommandOutput(`a${ESC}b`), 'ab'); // stray ESC removed
});

test('sanitizeCommandOutput keeps newlines/tabs and does not erase across a newline', () => {
  assert.equal(sanitizeCommandOutput(`a\n${BS}b`), 'a\nb'); // backspace can't cross the newline
  assert.equal(sanitizeCommandOutput('col1\tcol2\nrow2'), 'col1\tcol2\nrow2');
  assert.equal(sanitizeCommandOutput('a\n\n\n\nb'), 'a\n\nb'); // blank-line run collapsed
});

test('formatSnapshot renders command + output blocks (most recent last), noting empty output', () => {
  const out = formatSnapshot([
    { terminal: 'bash', command: 'npm test', output: 'ok\n', at: '' },
    { terminal: 'bash', command: 'ls', output: '   ', at: '' }
  ]);
  assert.match(out, /\[bash\] \$ npm test\nok/);
  assert.match(out, /\[bash\] \$ ls\n\(no output\)/);
  assert.match(out, /\n\n---\n\n/, 'entries separated by a rule');
});
