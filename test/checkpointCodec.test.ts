import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCheckpointLines, serializeCheckpoint, type CheckpointRecord } from '../src/diff/checkpointCodec';

const record: CheckpointRecord = {
  fsPath: 'D:\\proj\\src\\app.ts',
  previous: 'old content\nwith\nlines',
  label: 'edit src/app.ts',
  marker: 7,
  at: '2026-01-01T00:00:00.000Z'
};

test('serialize/parse round-trips a record', () => {
  const [parsed] = parseCheckpointLines(serializeCheckpoint(record));
  assert.deepEqual(parsed, record);
});

test('previous === undefined (new file) round-trips as null', () => {
  const created: CheckpointRecord = { ...record, previous: undefined };
  const line = serializeCheckpoint(created);
  assert.ok(line.includes('"v":null'));
  const [parsed] = parseCheckpointLines(line);
  assert.equal(parsed.previous, undefined);
});

test('empty previous (file existed but was empty) stays a string', () => {
  const empty: CheckpointRecord = { ...record, previous: '' };
  const [parsed] = parseCheckpointLines(serializeCheckpoint(empty));
  assert.equal(parsed.previous, '');
});

test('corrupt lines are skipped, valid ones survive', () => {
  const text = `${serializeCheckpoint(record)}\n{oops\n\n${serializeCheckpoint({ ...record, marker: 9 })}\n`;
  const parsed = parseCheckpointLines(text);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].marker, 7);
  assert.equal(parsed[1].marker, 9);
});

test('records missing a path are dropped', () => {
  assert.deepEqual(parseCheckpointLines('{"v":"x","l":"edit","m":1,"at":""}'), []);
});
