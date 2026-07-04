import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fsp } from 'fs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fakeVscode, setWorkspaceRoot } from './fakeVscode';

// Install the real-fs vscode double before loading the tools (they import vscode).
// eslint-disable-next-line @typescript-eslint/no-var-requires -- loaded after the vscode stub is installed
const tools = require('../src/parley/tools') as typeof import('../src/parley/tools');
const { runAgentTool, isBlockedAddress, assertInsideWorkspace } = tools;

async function workspace(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parley-tools-'));
  setWorkspaceRoot(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content);
  }
  return root;
}
const run = (name: string, args: unknown): Promise<string> =>
  runAgentTool({ id: 't', name, arguments: JSON.stringify(args) });

test('read_file returns numbered lines with a header and total count', async () => {
  await workspace({ 'a.txt': 'one\ntwo\nthree\n' });
  const out = await run('read_file', { path: 'a.txt' });
  assert.match(out, /a\.txt \(lines 1-4 of 4\)/);
  assert.match(out, /1 \| one/);
  assert.match(out, /3 \| three/);
});

test('read_file honors start_line/end_line and shows a continuation footer', async () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
  await workspace({ 'big.txt': lines });
  const out = await run('read_file', { path: 'big.txt', start_line: 5, end_line: 7 });
  assert.match(out, /lines 5-7 of 20/);
  assert.match(out, /5 \| line 5/);
  assert.ok(!out.includes('line 8'), 'stops at end_line');
  assert.match(out, /more lines — call read_file with start_line=8/);
});

test('read_file guards: past-EOF, empty, sensitive, missing, and outside-workspace', async () => {
  await workspace({ 'a.txt': 'x\ny\n', 'empty.txt': '', '.env': 'SECRET=1' });
  assert.match(await run('read_file', { path: 'a.txt', start_line: 999 }), /past end of file/);
  assert.equal(await run('read_file', { path: 'empty.txt' }), '[file is empty]');
  assert.match(await run('read_file', { path: '.env' }), /refusing to read a sensitive file/);
  assert.match(await run('read_file', { path: 'nope.txt' }), /could not read/);
  assert.match(await run('read_file', { path: '../../etc/passwd' }), /outside the workspace/);
});

test('list_directory lists entries with a trailing slash for directories', async () => {
  await workspace({ 'src/app.ts': '1', 'README.md': '2' });
  const out = await run('list_directory', { path: '.' });
  assert.match(out, /(^|\n)src\/(\n|$)/, 'directory has a trailing slash');
  assert.match(out, /(^|\n)README\.md(\n|$)/);
  assert.match(await run('list_directory', { path: 'nope' }), /could not list/);
});

test('find_files matches a glob and skips node_modules', async () => {
  await workspace({
    'src/a.ts': '1',
    'src/deep/b.ts': '2',
    'src/c.js': '3',
    'node_modules/dep/index.ts': '4'
  });
  const out = await run('find_files', { glob: '**/*.ts' });
  assert.deepEqual(out.split('\n').sort(), ['src/a.ts', 'src/deep/b.ts']);
  assert.ok(!out.includes('node_modules'), 'node_modules excluded');
  assert.equal(await run('find_files', { glob: '**/*.py' }), '[no matches]');
});

test('search_text finds a substring with path:line, skips binary + sensitive files', async () => {
  const nul = String.fromCharCode(0); // a real NUL byte makes search_text treat the file as binary
  await workspace({
    'a.ts': 'const token = 1;\nconst other = 2;\n',
    'b.ts': 'no match here\n',
    'bin.dat': `token${nul}binary`, // embedded NUL → detected as binary and skipped
    '.env': 'token=secret'
  });
  const out = await run('search_text', { query: 'token' });
  assert.match(out, /a\.ts:1: const token = 1;/);
  assert.ok(!out.includes('bin.dat'), 'binary file skipped');
  assert.ok(!out.includes('.env'), 'sensitive file skipped');
  assert.equal(await run('search_text', { query: 'zzzznotfound' }), '[no matches]');
});

test('runAgentTool reports unknown tools and invalid JSON', async () => {
  await workspace({});
  assert.match(await run('nonsense', {}), /unknown tool/);
  assert.match(await runAgentTool({ id: 't', name: 'read_file', arguments: '{not json' }), /not valid JSON/);
});

test('fetch_url refuses non-https URLs without hitting the network', async () => {
  await workspace({});
  assert.match(await run('fetch_url', { url: 'http://insecure.example' }), /only https/i);
});

test('fetch_url refuses literal private/loopback destinations without hitting the network', async () => {
  await workspace({});
  const expected = /refusing to fetch a private, loopback, or link-local address/;
  assert.match(await run('fetch_url', { url: 'https://127.0.0.1/latest/meta-data' }), expected);
  assert.match(await run('fetch_url', { url: 'https://169.254.169.254/latest/meta-data' }), expected);
  assert.match(await run('fetch_url', { url: 'https://[::1]:8443/admin' }), expected);
});

test('isBlockedAddress blocks loopback, private, link-local, ULA, and unspecified addresses', () => {
  const blocked = [
    '127.0.0.1',
    '::1',
    '10.0.0.1',
    '172.16.5.5',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '::ffff:127.0.0.1',
    'fe80::1',
    'fc00::1'
  ];
  for (const ip of blocked) {
    assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
  }
});

test('isBlockedAddress allows public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) {
    assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
  }
});

test('assertInsideWorkspace: real paths under the root pass, paths outside fail, new files pass', async () => {
  const root = await workspace({ 'inside.txt': 'x' });
  const uri = (p: string) => fakeVscode.Uri.file(p);
  const rootUri = uri(root);
  assert.equal(await assertInsideWorkspace(uri(path.join(root, 'inside.txt')), rootUri), true);
  assert.equal(await assertInsideWorkspace(uri(path.join(root, 'new-dir', 'new.txt')), rootUri), true);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'parley-outside-'));
  assert.equal(await assertInsideWorkspace(uri(path.join(outside, 'f.txt')), rootUri), false);
  assert.equal(await assertInsideWorkspace({ scheme: 'untitled', fsPath: '/x' } as never, rootUri), true);
});

test('hostMatchesAllowlist: empty list allows any host', () => {
  assert.equal(tools.hostMatchesAllowlist('example.com', []), true);
  assert.equal(tools.hostMatchesAllowlist('evil.attacker.io', []), true);
});

test('hostMatchesAllowlist: exact and subdomain match, boundary-safe', () => {
  const allow = ['docs.python.org', 'github.com'];
  assert.equal(tools.hostMatchesAllowlist('github.com', allow), true, 'exact');
  assert.equal(tools.hostMatchesAllowlist('api.github.com', allow), true, 'subdomain');
  assert.equal(tools.hostMatchesAllowlist('GitHub.com', allow), true, 'case-insensitive');
  assert.equal(tools.hostMatchesAllowlist('notgithub.com', allow), false, 'not a subdomain boundary');
  assert.equal(tools.hostMatchesAllowlist('github.com.evil.io', allow), false, 'suffix trick blocked');
  assert.equal(tools.hostMatchesAllowlist('example.com', allow), false, 'unlisted host');
});

test('hostMatchesAllowlist: entries are trimmed and leading dots stripped', () => {
  assert.equal(tools.hostMatchesAllowlist('api.example.com', ['  .example.com  ']), true);
  assert.equal(tools.hostMatchesAllowlist('example.com', ['', '   ']), true, 'all-blank list = allow all');
});
