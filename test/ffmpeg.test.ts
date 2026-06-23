import assert from 'node:assert/strict';
import { test } from 'node:test';
import { framesFps, resolveFfprobePath } from '../src/video/ffmpeg';

test('framesFps spreads ~maxFrames across the clip duration', () => {
  // 12 frames over 120s = 0.1 fps
  assert.equal(framesFps(120, 12), '0.10000');
  // Short clip: more than 1 fps to still reach the cap
  assert.equal(framesFps(6, 12), '2.00000');
  // Unknown/zero duration falls back to 1 fps
  assert.equal(framesFps(undefined, 12), '1');
  assert.equal(framesFps(0, 12), '1');
});

test('resolveFfprobePath finds ffprobe beside ffmpeg', () => {
  assert.equal(resolveFfprobePath(''), 'ffprobe');
  assert.equal(resolveFfprobePath('ffmpeg'), 'ffprobe');
  // Directory is preserved (separator is platform-specific) and the binary is renamed.
  const resolved = resolveFfprobePath('/usr/local/bin/ffmpeg');
  assert.ok(resolved.endsWith('ffprobe'));
  assert.ok(resolved.includes('bin'));
  // Windows-style path with extension keeps the .exe suffix.
  assert.ok(resolveFfprobePath('C:\\tools\\ffmpeg.exe').endsWith('ffprobe.exe'));
});
