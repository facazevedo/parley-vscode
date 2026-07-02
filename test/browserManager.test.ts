import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserError, clampText } from '../src/browser/browserText';

test('clampText collapses blank runs and truncates with a marker', () => {
  assert.equal(clampText('  hello \n\n\n world  '), 'hello \n\n world');
  const big = 'x'.repeat(20000);
  const out = clampText(big, 5000);
  assert.ok(out.length <= 5000 + 40);
  assert.match(out, /page text truncated/);
});

test('clampText leaves short text alone', () => {
  assert.equal(clampText('nav bar\ncontent'), 'nav bar\ncontent');
});

test('browserError maps launch failures to an actionable message', () => {
  const out = browserError(new Error("browserType.launch: Executable doesn't exist at /x/chromium"));
  assert.match(out, /could not launch/i);
  assert.match(out, /Close Browser/);
});

test('browserError maps navigation failures to a load hint', () => {
  assert.match(
    browserError(new Error('page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000')),
    /did not load/i
  );
  assert.match(browserError(new Error('Timeout 30000ms exceeded')), /did not load/i);
});

test('browserError falls back to a compact single-line message', () => {
  const out = browserError(new Error('something odd\nsecond line with detail'));
  assert.equal(out, 'Error: browser action failed — something odd');
  assert.equal(browserError('not an error object'), 'Error: browser action failed — unknown error');
});
