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

test('parses <function_call> and <tool_use> wrappers', () => {
  const a = parseTextToolCalls('<function_call>{"name": "read_file", "arguments": {"path": "a"}}</function_call>');
  assert.equal(a.calls[0].name, 'read_file');
  const b = parseTextToolCalls('<tool_use>{"name": "grep", "arguments": {"q": "x"}}</tool_use>');
  assert.equal(b.calls[0].name, 'grep');
});

test('parses <function=NAME>{args}</function> (Mistral/functionary style)', () => {
  const { calls } = parseTextToolCalls('<function=list_directory>{"path": "C:/x"}</function>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'list_directory');
  assert.deepEqual(JSON.parse(calls[0].argsJson), { path: 'C:/x' });
});

test('parses DeepSeek tool-call tokens', () => {
  const ds =
    'Let me check.<｜tool▁call▁begin｜>function<｜tool▁sep｜>list_directory\n' +
    '```json\n{"path": "C:/x"}\n```<｜tool▁call▁end｜>';
  const { calls } = parseTextToolCalls(ds);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'list_directory');
  assert.deepEqual(JSON.parse(calls[0].argsJson), { path: 'C:/x' });
});

test('fenced JSON is a tool call only when the name is a known tool', () => {
  const fenced = '```json\n{"name": "list_directory", "arguments": {"path": "."}}\n```';
  assert.equal(parseTextToolCalls(fenced).calls.length, 0, 'no knownTools → not treated as a call');
  const known = parseTextToolCalls(fenced, new Set(['list_directory']));
  assert.equal(known.calls.length, 1);
  assert.equal(known.calls[0].name, 'list_directory');
});

test('bare JSON object is a call only when gated by a known tool name', () => {
  const bare = '{"name": "read_file", "arguments": {"path": "a.ts"}}';
  assert.equal(parseTextToolCalls(bare).calls.length, 0);
  assert.equal(parseTextToolCalls(bare, new Set(['read_file'])).calls.length, 1);
});

test('ordinary JSON in an answer is not mistaken for a tool call', () => {
  const answer = 'Here is a config:\n```json\n{"port": 8080, "host": "localhost"}\n```';
  assert.equal(parseTextToolCalls(answer, new Set(['read_file', 'grep'])).calls.length, 0);
});
