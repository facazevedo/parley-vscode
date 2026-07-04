import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTraceFrames } from '../src/commands/traceParse';

test('parseTraceFrames extracts JS/TS frames', () => {
  const trace = ['TypeError: x is not a function', '    at foo (src/app.ts:42:11)', '    at src/index.ts:7:3'].join(
    '\n'
  );
  const frames = parseTraceFrames(trace);
  assert.deepEqual(
    frames.filter((f) => f.file.startsWith('src/')),
    [
      { file: 'src/app.ts', line: 42 },
      { file: 'src/index.ts', line: 7 }
    ]
  );
});

test('parseTraceFrames extracts Python frames', () => {
  const trace = 'Traceback:\n  File "app/main.py", line 88, in handler\n    do()';
  const frames = parseTraceFrames(trace);
  assert.ok(frames.some((f) => f.file === 'app/main.py' && f.line === 88));
});

test('parseTraceFrames dedupes and ignores non-frames', () => {
  const trace = 'at a.ts:1:1\nat a.ts:1:1\njust prose with no frame';
  const frames = parseTraceFrames(trace);
  assert.equal(frames.filter((f) => f.file === 'a.ts' && f.line === 1).length, 1);
});
