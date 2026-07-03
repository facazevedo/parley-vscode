import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserError, clampText } from '../src/browser/browserText';
import './fakeVscode';

// eslint-disable-next-line @typescript-eslint/no-var-requires -- loaded after the vscode stub is installed
const { isMetadataHost } = require('../src/browser/browserManager') as typeof import('../src/browser/browserManager');

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

test('isMetadataHost blocks cloud metadata endpoints', () => {
  assert.equal(isMetadataHost('169.254.169.254'), true);
  assert.equal(isMetadataHost('169.254.0.99'), true); // anywhere in 169.254.0.0/16
  assert.equal(isMetadataHost('metadata.google.internal'), true);
  assert.equal(isMetadataHost('metadata.google.internal.'), true); // trailing dot is the same host
  assert.equal(isMetadataHost('[::ffff:a9fe:a9fe]'), true); // IPv6-mapped 169.254.169.254
  assert.equal(isMetadataHost('::ffff:169.254.169.254'), true);
  assert.equal(isMetadataHost('fd00:ec2::254'), true); // AWS IMDS IPv6
});

test('isMetadataHost keeps localhost and private ranges reachable', () => {
  assert.equal(isMetadataHost('localhost'), false);
  assert.equal(isMetadataHost('127.0.0.1'), false);
  assert.equal(isMetadataHost('example.com'), false);
  assert.equal(isMetadataHost('10.0.0.5'), false);
  assert.equal(isMetadataHost('169.254.example.com'), false); // a hostname, not an IP literal
});
