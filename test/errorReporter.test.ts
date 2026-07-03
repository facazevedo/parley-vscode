import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearRecordedErrors, recentErrors, recordError, sanitizeErrorText } from '../src/logging/errorReporter';

const AWS = 'AKIA' + 'ABCDEFGHIJKLMNOP';

test('sanitizeErrorText strips secrets and the home path', () => {
  const home = '/home/alice';
  const text = `failed with key ${AWS} while reading ${home}/project/.env`;
  const out = sanitizeErrorText(text, home);
  assert.ok(!out.includes(AWS), 'secret is redacted');
  assert.ok(!out.includes('/home/alice'), 'home path is replaced');
  assert.ok(out.includes('~/project/.env'), 'home path becomes ~');
});

test('sanitizeErrorText handles Windows backslash home paths', () => {
  const home = 'C:\\Users\\bob';
  const out = sanitizeErrorText('read C:\\Users\\bob\\repo\\x.ts and C:/Users/bob/repo/y.ts', home);
  assert.ok(!out.includes('bob'), 'username stripped in both slash styles');
});

test('recordError captures a sanitized entry and keeps the message + detail', () => {
  clearRecordedErrors();
  const err = new Error(`boom with ${AWS}`);
  recordError('Parley request failed', err, '2026-07-02T00:00:00.000Z');
  const [e] = recentErrors();
  assert.equal(e.at, '2026-07-02T00:00:00.000Z');
  assert.equal(e.message, 'Parley request failed');
  assert.ok(e.detail && e.detail.startsWith('Error: boom with «redacted:'), 'detail is sanitized');
  assert.ok(!JSON.stringify(recentErrors()).includes(AWS), 'no secret survives anywhere in the ring');
  clearRecordedErrors();
});

test('the ring is bounded (oldest dropped past the cap)', () => {
  clearRecordedErrors();
  for (let i = 0; i < 60; i += 1) {
    recordError(`err ${i}`, undefined, `t${i}`);
  }
  const all = recentErrors();
  assert.ok(all.length <= 50, 'ring is capped at 50');
  assert.equal(all[all.length - 1].message, 'err 59', 'newest kept');
  assert.ok(!all.some((e) => e.message === 'err 0'), 'oldest dropped');
  clearRecordedErrors();
});

test('recentErrors returns a defensive copy', () => {
  clearRecordedErrors();
  recordError('one');
  const snapshot = recentErrors();
  snapshot.push({ at: 'x', message: 'injected' });
  assert.equal(recentErrors().length, 1, 'mutating the snapshot does not affect the ring');
  clearRecordedErrors();
});
