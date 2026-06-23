import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendEvent,
  readEvents,
  upsertIndex,
  readIndex,
  ensureGitignore,
  jsonlPath
} from '../src/transcript/store';
import type { TranscriptEntry } from '../src/transcript/transcript';

async function tmpBase(name: string): Promise<string> {
  const dir = path.join(os.tmpdir(), 'parley-test-' + name);
  await fsp.rm(dir, { recursive: true, force: true });
  return dir;
}

test('append-then-read round-trips events in order (durable, no RAM dependency)', async () => {
  const base = await tmpBase('rt');
  const id = 'conv-1';
  const events: TranscriptEntry[] = [
    { kind: 'user', text: 'hello', at: '2026-06-23T00:00:00.000Z' },
    { kind: 'tool', action: 'Read a.ts', result: 'ok', at: '2026-06-23T00:00:01.000Z' },
    { kind: 'assistant', text: 'hi', model: 'm', at: '2026-06-23T00:00:02.000Z' }
  ];
  for (const e of events) {
    await appendEvent(base, id, e);
  }
  const read = await readEvents(base, id);
  assert.equal(read.length, 3);
  assert.deepEqual(read, events);
  await fsp.rm(base, { recursive: true, force: true });
});

test('readEvents skips a corrupt line rather than losing the whole log', async () => {
  const base = await tmpBase('corrupt');
  const id = 'conv-2';
  await appendEvent(base, id, { kind: 'user', text: 'a', at: '2026-06-23T00:00:00.000Z' });
  await fsp.appendFile(jsonlPath(base, id), 'this is not json\n', 'utf8');
  await appendEvent(base, id, { kind: 'user', text: 'b', at: '2026-06-23T00:00:01.000Z' });
  const read = await readEvents(base, id);
  assert.equal(read.length, 2);
  await fsp.rm(base, { recursive: true, force: true });
});

test('upsertIndex keeps newest first and de-duplicates by id', async () => {
  const base = await tmpBase('idx');
  await upsertIndex(base, { id: 'a', title: 'A', savedAt: '2026-06-23T00:00:00.000Z', model: 'm', events: 1 });
  await upsertIndex(base, { id: 'b', title: 'B', savedAt: '2026-06-23T00:00:01.000Z', model: 'm', events: 2 });
  await upsertIndex(base, { id: 'a', title: 'A2', savedAt: '2026-06-23T00:00:02.000Z', model: 'm', events: 3 });
  const idx = await readIndex(base);
  assert.equal(idx.length, 2);
  assert.equal(idx[0].id, 'a');
  assert.equal(idx[0].title, 'A2');
  await fsp.rm(base, { recursive: true, force: true });
});

test('ensureGitignore creates a wildcard ignore once and never overwrites', async () => {
  const base = await tmpBase('gi');
  await ensureGitignore(base);
  const first = await fsp.readFile(path.join(base, '.gitignore'), 'utf8');
  assert.match(first, /\*/);
  await fsp.writeFile(path.join(base, '.gitignore'), 'custom', 'utf8');
  await ensureGitignore(base);
  const second = await fsp.readFile(path.join(base, '.gitignore'), 'utf8');
  assert.equal(second, 'custom');
  await fsp.rm(base, { recursive: true, force: true });
});
