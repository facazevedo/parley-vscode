/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fsp } from 'fs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeMemento, makeRecorder, setWorkspaceRoot } from './fakeVscode';

// Install the real-fs vscode stub before loading the executor + checkpoint store.
// eslint-disable-next-line @typescript-eslint/no-var-requires -- loaded after the vscode stub is installed
const { ToolExecutor } = require('../src/webview/toolExecutor') as typeof import('../src/webview/toolExecutor');
// eslint-disable-next-line @typescript-eslint/no-var-requires -- loaded after the vscode stub is installed
const { CheckpointStore } = require('../src/diff/checkpoints') as typeof import('../src/diff/checkpoints');

async function waitFor<T>(fn: () => T | undefined, tries = 200): Promise<T> {
  for (let i = 0; i < tries; i += 1) {
    const v = fn();
    if (v !== undefined) {
      return v;
    }
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('waitFor: condition not met in time');
}

async function setup(mode = 'edit') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parley-exec-'));
  setWorkspaceRoot(root);
  const store = new CheckpointStore();
  await store.bind(path.join(root, '.parley'), 'conv');
  const posts: any[] = [];
  const recorder = makeRecorder();
  let curMode = mode;
  let secretScanning = 'redact';
  let abort: AbortSignal | undefined;
  const host: any = {
    checkpoints: store,
    mcp: { getTools: () => [], callTool: async () => '' },
    browser: {},
    state: makeMemento(),
    recorder,
    diffProvider: { set: () => {} },
    getSettings: () => ({ hooks: {}, secretScanning }),
    getMode: () => curMode,
    getAbortSignal: () => abort,
    getSubagentParams: () => ({}),
    applyUsage: () => ({ sessionTokens: 0, sessionCostUsd: 0 }),
    post: (m: any) => posts.push(m)
  };
  const exec = new ToolExecutor(host);
  return {
    root,
    exec,
    store,
    posts,
    recorder,
    setMode: (m: string) => {
      curMode = m;
    },
    setSecretScanning: (m: string) => {
      secretScanning = m;
    },
    setAbort: (s?: AbortSignal) => {
      abort = s;
    }
  };
}

const call = (name: string, args: unknown) => ({ id: 't1', name, arguments: JSON.stringify(args) });
const read = (p: string): Promise<string> => fsp.readFile(p, 'utf8');

test('edit_file in Edit mode applies to disk and checkpoints it', async () => {
  const { root, exec, store, posts } = await setup('edit');
  const file = path.join(root, 'a.txt');
  await fsp.writeFile(file, 'hello world\n');

  const result = await exec.run(call('edit_file', { path: 'a.txt', old_text: 'world', new_text: 'there' }));
  assert.match(result, /Applied edit to a\.txt/);
  assert.equal(await read(file), 'hello there\n');
  assert.equal(store.size, 1, 'the edit is checkpointed (revertible)');
  assert.ok(
    posts.some((m) => m.type === 'fileEdit' && m.path === 'a.txt'),
    'a diff card was posted'
  );

  // And it is genuinely revertible.
  await store.revertLast();
  assert.equal(await read(file), 'hello world\n');
});

test('Ask mode: the edit awaits approval; Apply writes it, and the id then goes stale', async () => {
  const { root, exec, store, posts } = await setup('ask');
  const file = path.join(root, 'b.txt');
  await fsp.writeFile(file, 'one two\n');

  const pending = exec.run(call('edit_file', { path: 'b.txt', old_text: 'two', new_text: 'three' }));
  const id = await waitFor(() => posts.find((m) => m.type === 'proposedChange' && m.approval)?.id);
  assert.equal(await read(file), 'one two\n', 'nothing written while awaiting approval');

  assert.equal(exec.approveApproval(id), true);
  const result = await pending;
  assert.match(result, /Applied edit to b\.txt/);
  assert.equal(await read(file), 'one three\n');
  assert.equal(store.size, 1);
  // The approval id is consumed: a second approve (or reject) is a no-op.
  assert.equal(exec.approveApproval(id), false);
  assert.equal(exec.rejectApproval(id), false);
});

test('Ask mode: Reject leaves the file untouched and uncheckpointed', async () => {
  const { root, exec, store, posts } = await setup('ask');
  const file = path.join(root, 'c.txt');
  await fsp.writeFile(file, 'keep me\n');

  const pending = exec.run(call('edit_file', { path: 'c.txt', old_text: 'keep me', new_text: 'nope' }));
  const id = await waitFor(() => posts.find((m) => m.type === 'proposedChange')?.id);
  assert.equal(exec.rejectApproval(id), true);

  const result = await pending;
  assert.match(result, /rejected/i);
  assert.equal(await read(file), 'keep me\n', 'rejected edit is not written');
  assert.equal(store.size, 0);
  assert.ok(posts.some((m) => m.type === 'changeResolved' && m.status === 'dismissed'));
});

test('Ask mode: aborting the turn dismisses the pending approval', async () => {
  const { root, exec, posts, setAbort } = await setup('ask');
  const controller = new AbortController();
  setAbort(controller.signal);
  const file = path.join(root, 'd.txt');
  await fsp.writeFile(file, 'x\n');

  const pending = exec.run(call('edit_file', { path: 'd.txt', old_text: 'x', new_text: 'y' }));
  await waitFor(() => posts.find((m) => m.type === 'proposedChange')?.id);
  controller.abort();

  const result = await pending;
  assert.match(result, /rejected/i);
  assert.equal(await read(file), 'x\n');
});

test('write_file refuses to clobber an unseen existing file, then succeeds on re-issue', async () => {
  const { root, exec } = await setup('edit');
  const file = path.join(root, 's.txt');
  await fsp.writeFile(file, 'original\n');

  // First attempt: never read this conversation → guard fires, nothing written.
  const first = await exec.run(call('write_file', { path: 's.txt', content: 'replacement' }));
  assert.match(first, /have not read it|CHANGED/);
  assert.equal(await read(file), 'original\n', 'the unseen file is not clobbered');

  // The guard recorded the current content, so an identical re-issue now applies.
  const second = await exec.run(call('write_file', { path: 's.txt', content: 'replacement' }));
  assert.match(second, /Applied edit to s\.txt/);
  assert.equal(await read(file), 'replacement\n');
});

test('tool results are scanned: a secret in a read file is redacted before returning', async () => {
  const { root, exec, setSecretScanning } = await setup('edit');
  const file = path.join(root, 'conf.txt');
  const secret = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  await fsp.writeFile(file, `aws_key = ${secret}\n`);

  const redacted = await exec.run(call('read_file', { path: 'conf.txt' }));
  assert.ok(!redacted.includes(secret), 'the secret does not survive in the tool result');
  assert.match(redacted, /redacted .*AWS access key/i);

  // With scanning off, the raw value flows through.
  setSecretScanning('off');
  const raw = await exec.run(call('read_file', { path: 'conf.txt' }));
  assert.ok(raw.includes(secret), 'secretScanning=off leaves the value intact');
});

test('read_file records the file as touched; resetConversationState clears state', async () => {
  const { root, exec } = await setup('edit');
  const file = path.join(root, 'r.txt');
  await fsp.writeFile(file, 'line 1\nline 2\n');

  await exec.run(call('read_file', { path: 'r.txt' }));
  assert.ok(
    exec.touchedFiles().some((p) => p.replace(/\\/g, '/').endsWith('/r.txt')),
    'the read file is tracked (for glob-scoped rules + staleness)'
  );

  exec.resetConversationState();
  assert.deepEqual(exec.touchedFiles(), []);
  assert.deepEqual(exec.pendingIds(), []);
});
