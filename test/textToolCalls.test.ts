import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTextToolCalls } from '../src/parley/textToolCalls';

// parseTextToolCalls recovers <tool_call> tags that text-protocol models emit as content
// (instead of native tool_calls), so Parley can run them and feed real results back.

test('parses a single closed tool call', () => {
  const { calls, assistantContent } = parseTextToolCalls(
    'Let me look.\n<tool_call>{"name": "list_directory", "arguments": {"path": "C:\\\\x"}}</tool_call>'
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'list_directory');
  assert.deepEqual(JSON.parse(calls[0].argsJson), { path: 'C:\\x' });
  assert.ok(assistantContent.endsWith('</tool_call>'));
});

test('parses an unclosed tool call (stop-sequence truncated) and closes it', () => {
  const { calls, assistantContent } = parseTextToolCalls(
    '<tool_call>{"name": "read_file", "arguments": {"path": "a.ts"}}'
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
  assert.ok(assistantContent.endsWith('</tool_call>'), 'appends the missing closing tag');
});

test('drops a fabricated <tool_response> the model hallucinated after the call', () => {
  const { calls, assistantContent } = parseTextToolCalls(
    '<tool_call>{"name": "list_directory", "arguments": {}}</tool_call>\n' +
      '<tool_response>[{"fake": true}]</tool_response>\nHere is what I found...'
  );
  assert.equal(calls.length, 1);
  assert.ok(!assistantContent.includes('tool_response'), 'the fabricated response is stripped');
  assert.ok(!assistantContent.includes('Here is what I found'));
});

test('parses multiple tool calls', () => {
  const { calls } = parseTextToolCalls(
    '<tool_call>{"name": "a", "arguments": {"x": 1}}</tool_call>' +
      '<tool_call>{"name": "b", "arguments": {"y": 2}}</tool_call>'
  );
  assert.deepEqual(
    calls.map((c) => c.name),
    ['a', 'b']
  );
  assert.deepEqual(JSON.parse(calls[1].argsJson), { y: 2 });
});

test('handles arguments given as a JSON string', () => {
  const { calls } = parseTextToolCalls('<tool_call>{"name": "grep", "arguments": "{\\"q\\":\\"foo\\"}"}</tool_call>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].argsJson, '{"q":"foo"}');
});

test('no tool call → empty list, content unchanged', () => {
  const { calls, assistantContent } = parseTextToolCalls('Just a normal answer with no tools.');
  assert.equal(calls.length, 0);
  assert.equal(assistantContent, 'Just a normal answer with no tools.');
});

test('malformed JSON is skipped, not thrown', () => {
  const { calls } = parseTextToolCalls('<tool_call>{ not valid json </tool_call>');
  assert.equal(calls.length, 0);
});

test('nested braces in arguments parse correctly', () => {
  const { calls } = parseTextToolCalls(
    '<tool_call>{"name": "edit", "arguments": {"edits": [{"a": {"b": 1}}]}}</tool_call>'
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].argsJson), { edits: [{ a: { b: 1 } }] });
});
