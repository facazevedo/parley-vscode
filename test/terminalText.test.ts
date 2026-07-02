import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatSnapshot, pushEntry, stripAnsi, type TerminalEntry } from '../src/context/terminalText';

const ESC = String.fromCharCode(27); // \x1b
const BEL = String.fromCharCode(7); // \x07

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

test('formatSnapshot renders command + output blocks (most recent last), noting empty output', () => {
  const out = formatSnapshot([
    { terminal: 'bash', command: 'npm test', output: 'ok\n', at: '' },
    { terminal: 'bash', command: 'ls', output: '   ', at: '' }
  ]);
  assert.match(out, /\[bash\] \$ npm test\nok/);
  assert.match(out, /\[bash\] \$ ls\n\(no output\)/);
  assert.match(out, /\n\n---\n\n/, 'entries separated by a rule');
});
