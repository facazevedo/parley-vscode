import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMcpTool, parseQualifiedName, qualifyToolName, sanitizeServerName } from '../src/mcp/naming';

test('qualifyToolName builds an mcp__server__tool name and sanitizes the server', () => {
  assert.equal(qualifyToolName('filesystem', 'read_file'), 'mcp__filesystem__read_file');
  assert.equal(qualifyToolName('my server', 'do'), 'mcp__my-server__do');
});

test('isMcpTool detects the prefix', () => {
  assert.equal(isMcpTool('mcp__fs__read'), true);
  assert.equal(isMcpTool('read_file'), false);
});

test('parseQualifiedName round-trips and tolerates __ inside the tool name', () => {
  assert.deepEqual(parseQualifiedName('mcp__filesystem__read_file'), { server: 'filesystem', tool: 'read_file' });
  // tool names may themselves contain '__' — only the first separator splits server/tool
  assert.deepEqual(parseQualifiedName('mcp__git__diff__staged'), { server: 'git', tool: 'diff__staged' });
  assert.equal(parseQualifiedName('read_file'), undefined);
  assert.equal(parseQualifiedName('mcp__onlyserver'), undefined);
});

test('sanitizeServerName keeps only safe characters', () => {
  assert.equal(sanitizeServerName('a.b/c d'), 'a-b-c-d');
});
