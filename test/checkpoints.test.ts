import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fsp } from 'fs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setWorkspaceRoot } from './fakeVscode';

// The vscode stub (real-fs backed) must be installed before requiring the store.
// eslint-disable-next-line @typescript-eslint/no-var-requires -- loaded after the vscode stub is installed
const { CheckpointStore } = require('../src/diff/checkpoints') as typeof import('../src/diff/checkpoints');

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parley-cp-'));
  setWorkspaceRoot(root);
  return root;
}
const uri = (p: string): any => ({ fsPath: p });
const read = (p: string): Promise<string> => fsp.readFile(p, 'utf8');
async function bytes(p: string): Promise<Buffer> {
  return fsp.readFile(p);
}
async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function newStore(root: string, id = 'conv1'): Promise<InstanceType<typeof CheckpointStore>> {
  const store = new CheckpointStore();
  await store.bind(path.join(root, '.parley'), id);
  return store;
}

test('applyWithCheckpoint writes new content; revertLast restores the exact previous content', async () => {
  const root = tmpRoot();
  const file = path.join(root, 'a.txt');
  await fsp.writeFile(file, 'version one\n');
  const store = await newStore(root);

  await store.applyWithCheckpoint(uri(file), 'version two\n', 'edit a.txt');
  assert.equal(await read(file), 'version two\n');
  assert.equal(store.size, 1);

  const label = await store.revertLast();
  assert.equal(label, 'edit a.txt');
  assert.equal(await read(file), 'version one\n', 'reverted to the original bytes');
  assert.equal(store.size, 0);
});

test('a checkpointed NEW file is deleted on revert (previous === undefined)', async () => {
  const root = tmpRoot();
  const file = path.join(root, 'created.txt');
  const store = await newStore(root);

  await store.applyWithCheckpoint(uri(file), 'brand new\n', 'create created.txt');
  assert.equal(await exists(file), true);

  await store.revertLast();
  assert.equal(await exists(file), false, 'reverting a created file removes it');
});

test('revertAll unwinds every write (newest-first) across multiple files', async () => {
  const root = tmpRoot();
  const a = path.join(root, 'a.txt');
  const b = path.join(root, 'b.txt');
  await fsp.writeFile(a, 'a0\n');
  await fsp.writeFile(b, 'b0\n');
  const store = await newStore(root);

  await store.applyWithCheckpoint(uri(a), 'a1\n', 'edit a');
  await store.applyWithCheckpoint(uri(b), 'b1\n', 'edit b');
  await store.applyWithCheckpoint(uri(a), 'a2\n', 'edit a again');
  assert.equal(store.size, 3);

  const count = await store.revertAll();
  assert.equal(count, 3);
  assert.equal(await read(a), 'a0\n', 'a restored to its oldest previous');
  assert.equal(await read(b), 'b0\n');
  assert.equal(store.size, 0);
});

test('rewindTo(marker) restores files touched at/after the marker and keeps earlier ones', async () => {
  const root = tmpRoot();
  const a = path.join(root, 'a.txt');
  const b = path.join(root, 'b.txt');
  await fsp.writeFile(a, 'a-start\n');
  await fsp.writeFile(b, 'b-start\n');
  const store = await newStore(root);

  let marker = 0;
  store.setMarkerProvider(() => marker);

  marker = 1;
  await store.applyWithCheckpoint(uri(a), 'a-turn1\n', 'edit a');
  marker = 5;
  await store.applyWithCheckpoint(uri(b), 'b-turn5\n', 'edit b');
  await store.applyWithCheckpoint(uri(a), 'a-turn5\n', 'edit a again');

  const affected = await store.rewindTo(5);
  assert.deepEqual(affected.sort(), ['a.txt', 'b.txt']);
  // b returns to its pre-turn-5 state; a returns to its OLDEST previous captured at/after marker 5 (a-turn1).
  assert.equal(await read(b), 'b-start\n');
  assert.equal(await read(a), 'a-turn1\n', 'newest-first restore lands a at its state before turn 5');
  // The turn-1 checkpoint (marker < 5) survives.
  assert.equal(store.size, 1);
  await store.revertLast();
  assert.equal(await read(a), 'a-start\n');
});

test('format is preserved byte-faithfully through apply AND revert (CRLF file, LF edit)', async () => {
  const root = tmpRoot();
  const file = path.join(root, 'crlf.txt');
  await fsp.writeFile(file, Buffer.from('a\r\nb\r\n', 'utf8'));
  const store = await newStore(root);

  // The model emits LF; the store must re-encode to the file's CRLF on write…
  await store.applyWithCheckpoint(uri(file), 'a\nb\nc\n', 'edit crlf.txt');
  assert.equal((await bytes(file)).toString('utf8'), 'a\r\nb\r\nc\r\n', 'write keeps CRLF');

  // …and restore the original CRLF bytes exactly on revert.
  await store.revertLast();
  assert.deepEqual(await bytes(file), Buffer.from('a\r\nb\r\n', 'utf8'), 'revert is byte-faithful');
});

test('checkpoints persist to disk and a freshly-bound store can revert them (survives reload)', async () => {
  const root = tmpRoot();
  const file = path.join(root, 'p.txt');
  await fsp.writeFile(file, 'orig\n');

  const store1 = await newStore(root, 'sessionX');
  await store1.applyWithCheckpoint(uri(file), 'edited\n', 'edit p.txt');

  // Simulate a window reload: a brand-new store binds the same conversation log.
  const store2 = await newStore(root, 'sessionX');
  assert.equal(store2.size, 1, 'the persisted checkpoint was reloaded');
  await store2.revertLast();
  assert.equal(await read(file), 'orig\n', 'revert works after reload');
});

test('the on-disk log is removed once the stack is emptied', async () => {
  const root = tmpRoot();
  const file = path.join(root, 'q.txt');
  await fsp.writeFile(file, 'x\n');
  const logPath = path.join(root, '.parley', 'checkpoints', 'convLog.jsonl');

  const store = await newStore(root, 'convLog');
  await store.applyWithCheckpoint(uri(file), 'y\n', 'edit q.txt');
  assert.equal(await exists(logPath), true, 'log written while checkpoints exist');

  await store.revertAll();
  assert.equal(await exists(logPath), false, 'empty stack deletes the log');
});

test('changedSince reports unique basenames written at/after a stack position', async () => {
  const root = tmpRoot();
  const a = path.join(root, 'a.txt');
  const b = path.join(root, 'b.txt');
  await fsp.writeFile(a, '0');
  await fsp.writeFile(b, '0');
  const store = await newStore(root);

  await store.applyWithCheckpoint(uri(a), '1', 'edit a');
  const mark = store.size;
  await store.applyWithCheckpoint(uri(b), '1', 'edit b');
  await store.applyWithCheckpoint(uri(a), '2', 'edit a again');

  assert.deepEqual(store.changedSince(mark).sort(), ['a.txt', 'b.txt']);
});
