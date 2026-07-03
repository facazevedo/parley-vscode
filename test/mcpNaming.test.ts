import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isMcpTool,
  parseQualifiedName,
  providerSafeToolName,
  qualifyToolName,
  sanitizeServerName
} from '../src/mcp/naming';

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

test('providerSafeToolName keeps valid names verbatim and replaces invalid characters', () => {
  const taken = new Set<string>();
  assert.equal(providerSafeToolName('filesystem', 'read_file', taken), 'mcp__filesystem__read_file');
  assert.equal(providerSafeToolName('fs', 'list files', taken), 'mcp__fs__list-files');
  assert.equal(providerSafeToolName('fs', 'résumé.tool', taken), 'mcp__fs__r-sum--tool');
});

test('providerSafeToolName caps over-long names at 64 chars with a deterministic hash suffix', () => {
  const longName = 'very-long-tool-name-'.repeat(5); // 100 chars
  const first = providerSafeToolName('fs', longName, new Set());
  const second = providerSafeToolName('fs', longName, new Set());
  assert.equal(first, second, 'same input yields the same name');
  assert.equal(first.length, 64);
  assert.match(first, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.ok(first.startsWith('mcp__fs__very-long-tool-name-'), 'keeps a recognizable stem');
  assert.match(first, /-[0-9a-f]{6}$/, 'ends with the hash suffix');
});

test('providerSafeToolName keeps long names distinct after truncation', () => {
  const taken = new Set<string>();
  const first = providerSafeToolName('fs', `${'x'.repeat(80)}one`, taken);
  taken.add(first);
  const second = providerSafeToolName('fs', `${'x'.repeat(80)}two`, taken);
  assert.notEqual(second, first, 'tools that differ only past the truncation point stay distinct');
  assert.ok(second.length <= 64);
});

test('providerSafeToolName disambiguates collisions with a numeric suffix', () => {
  const taken = new Set<string>();
  const first = providerSafeToolName('fs', 'read file', taken);
  taken.add(first);
  const second = providerSafeToolName('fs', 'read.file', taken);
  taken.add(second);
  const third = providerSafeToolName('fs', 'read/file', taken);
  assert.equal(first, 'mcp__fs__read-file');
  assert.equal(second, 'mcp__fs__read-file-2');
  assert.equal(third, 'mcp__fs__read-file-3');
});

test('providerSafeToolName keeps numeric suffixes within the 64-char cap', () => {
  const longName = 'y'.repeat(100);
  const taken = new Set<string>();
  const first = providerSafeToolName('fs', longName, taken);
  taken.add(first);
  const second = providerSafeToolName('fs', longName, taken); // duplicate tool name from the same server
  assert.notEqual(second, first);
  assert.equal(second.length, 64);
  assert.match(second, /-2$/);
});
