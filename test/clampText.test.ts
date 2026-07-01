import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampMiddle, clampToolResult } from '../src/parley/clampText';

test('clampMiddle leaves short text untouched', () => {
  assert.equal(clampMiddle('hello', 100), 'hello');
  const exact = 'x'.repeat(100);
  assert.equal(clampMiddle(exact, 100), exact);
});

test('clampMiddle keeps head and tail with an explicit omission marker', () => {
  const head = 'HEAD'.repeat(1000);
  const tail = 'TAIL'.repeat(1000);
  const text = head + 'MIDDLE'.repeat(5000) + tail;
  const clamped = clampMiddle(text, 8000);

  assert.ok(clamped.length <= 8000, `clamped length ${clamped.length} exceeds max`);
  assert.ok(clamped.startsWith('HEADHEAD'), 'head was not preserved');
  assert.ok(clamped.endsWith('TAILTAIL'), 'tail was not preserved');
  assert.match(clamped, /characters omitted from the middle/);
});

test('clampMiddle reports how much was omitted', () => {
  const text = 'a'.repeat(20000);
  const clamped = clampMiddle(text, 8000);
  const m = clamped.match(/([\d,]+) of ([\d,]+) characters omitted/);
  assert.ok(m, 'marker with counts expected');
  assert.equal(m![2], '20,000');
  const omitted = Number(m![1].replace(/,/g, ''));
  // omitted = total − kept; kept ≈ 8000 − marker
  assert.ok(omitted > 11000 && omitted < 13000, `unexpected omitted count ${omitted}`);
});

test('clampToolResult applies per-tool budgets', () => {
  const long = 'z'.repeat(30000);
  // run_command gets a bigger budget than the default…
  assert.ok(clampToolResult('run_command', long).length > clampToolResult('mcp__x__y', long).length);
  // …and read_file the biggest, so its own pagination footer survives.
  assert.ok(clampToolResult('read_file', long).length > clampToolResult('run_command', long).length);
  // Short results pass through for every tool.
  assert.equal(clampToolResult('run_command', 'ok'), 'ok');
});

test('clampMiddle keeps the tail even when the head share is large', () => {
  const text = `${'start '.repeat(2000)}ERROR: the real failure message`;
  const clamped = clampMiddle(text, 2000);
  assert.ok(clamped.endsWith('ERROR: the real failure message'), 'the tail (the error) must survive');
});
