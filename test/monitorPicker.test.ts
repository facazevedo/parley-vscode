import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMonitors } from '../src/computer/winControl';

// parseMonitors is pure — it turns the enumerate script's JSON into Monitor[]. It never
// spawns PowerShell, so it's testable directly (winControl's other deps are `import type`).

test('parses a multi-monitor JSON array', () => {
  const json = JSON.stringify([
    { index: 0, x: 0, y: 0, w: 2560, h: 1440, primary: true },
    { index: 1, x: 2560, y: 0, w: 1920, h: 1080, primary: false }
  ]);
  const mons = parseMonitors(json);
  assert.equal(mons.length, 2);
  assert.deepEqual(mons[0], { index: 0, x: 0, y: 0, w: 2560, h: 1440, primary: true });
  assert.deepEqual(mons[1], { index: 1, x: 2560, y: 0, w: 1920, h: 1080, primary: false });
});

test('wraps a single bare object into a one-element array (ConvertTo-Json quirk)', () => {
  // PowerShell's ConvertTo-Json emits a bare object, not an array, for a single element.
  const json = JSON.stringify({ index: 0, x: 0, y: 0, w: 1920, h: 1080, primary: true });
  const mons = parseMonitors(json);
  assert.equal(mons.length, 1);
  assert.equal(mons[0].index, 0);
  assert.equal(mons[0].primary, true);
});

test('empty or whitespace stdout → []', () => {
  assert.deepEqual(parseMonitors(''), []);
  assert.deepEqual(parseMonitors('   \n  '), []);
});

test('malformed JSON → []', () => {
  assert.deepEqual(parseMonitors('not json'), []);
  assert.deepEqual(parseMonitors('{ index: 0 '), []);
});

test('drops rows with non-finite or non-positive dimensions', () => {
  const json = JSON.stringify([
    { index: 0, x: 0, y: 0, w: 1920, h: 1080, primary: true },
    { index: 1, x: 'oops', y: 0, w: 1920, h: 1080, primary: false }, // bad x
    { index: 2, x: 0, y: 0, w: 0, h: 1080, primary: false }, // zero width
    { index: 3, x: 0, y: 0, w: 800, h: 600, primary: false }
  ]);
  const mons = parseMonitors(json);
  assert.deepEqual(
    mons.map((m) => m.index),
    [0, 3]
  );
});

test('coerces numeric strings and defaults primary to false', () => {
  // ConvertTo-Json normally emits numbers, but be defensive about string-y values.
  const json = JSON.stringify([{ index: '1', x: '100', y: '0', w: '1280', h: '720' }]);
  const mons = parseMonitors(json);
  assert.equal(mons.length, 1);
  assert.deepEqual(mons[0], { index: 1, x: 100, y: 0, w: 1280, h: 720, primary: false });
});
