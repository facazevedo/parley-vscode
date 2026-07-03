import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeAction, extractJsonObject, parseAction } from '../src/computer/actions';

test('extractJsonObject pulls a balanced object from surrounding prose/fences', () => {
  assert.equal(extractJsonObject('Sure: {"action":"done"} ok'), '{"action":"done"}');
  assert.equal(extractJsonObject('```json\n{"a":{"b":1}}\n```'), '{"a":{"b":1}}');
  assert.equal(extractJsonObject('a { with "brace } string" } end'), '{ with "brace } string" }');
  assert.equal(extractJsonObject('no object here'), undefined);
});

test('click parses coordinates and button variants', () => {
  assert.deepEqual(parseAction('{"action":"click","x":10,"y":20}'), { type: 'click', x: 10, y: 20, button: 'left' });
  assert.deepEqual(parseAction('{"action":"right_click","x":1,"y":2}'), { type: 'click', x: 1, y: 2, button: 'right' });
  assert.deepEqual(parseAction('{"action":"double_click","x":1,"y":2}'), {
    type: 'click',
    x: 1,
    y: 2,
    button: 'double'
  });
  assert.deepEqual(parseAction('{"action":"click","x":1,"y":2,"button":"double"}'), {
    type: 'click',
    x: 1,
    y: 2,
    button: 'double'
  });
});

test('click without coordinates is an error', () => {
  const r = parseAction('{"action":"click"}');
  assert.equal(r.type, 'error');
});

test('type / key / scroll parse and clamp', () => {
  assert.deepEqual(parseAction('{"action":"type","text":"hello"}'), { type: 'type', text: 'hello' });
  assert.deepEqual(parseAction('{"action":"key","keys":"ctrl+s"}'), { type: 'key', keys: 'ctrl+s' });
  assert.deepEqual(parseAction('{"action":"key","key":"enter"}'), { type: 'key', keys: 'enter' });
  assert.deepEqual(parseAction('{"action":"scroll","x":5,"y":6,"amount":50}'), {
    type: 'scroll',
    x: 5,
    y: 6,
    amount: 10 // clamped to ±10
  });
});

test('empty type text and zero scroll are errors', () => {
  assert.equal(parseAction('{"action":"type","text":""}').type, 'error');
  assert.equal(parseAction('{"action":"scroll","amount":0}').type, 'error');
});

test('done / abort / wait parse with defaults', () => {
  assert.deepEqual(parseAction('{"action":"done","summary":"all set"}'), { type: 'done', summary: 'all set' });
  assert.deepEqual(parseAction('{"action":"abort","reason":"blocked"}'), { type: 'abort', reason: 'blocked' });
  assert.deepEqual(parseAction('{"action":"wait"}'), { type: 'wait', ms: 1000 });
  assert.deepEqual(parseAction('{"action":"wait","ms":9999}'), { type: 'wait', ms: 5000 }); // clamped
});

test('unknown / non-JSON input is an error, never a throw', () => {
  assert.equal(parseAction('{"action":"frobnicate"}').type, 'error');
  assert.equal(parseAction('not json at all').type, 'error');
  assert.equal(parseAction('{bad json').type, 'error');
});

test('describeAction is human-readable', () => {
  assert.match(describeAction({ type: 'click', x: 4, y: 5, button: 'left' }), /click \(4, 5\)/);
  assert.match(describeAction({ type: 'type', text: 'x'.repeat(80) }), /type "x+…"/);
  assert.match(describeAction({ type: 'done', summary: 'ok' }), /done — ok/);
});
