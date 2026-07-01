import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_ATTEMPTS,
  isRetryableError,
  isRetryableStatus,
  parseRetryAfter,
  retryDelayMs,
  retryReason,
  sleepWithAbort
} from '../src/parley/retry';
import { ParleyApiError } from '../src/parley/types';

test('isRetryableStatus covers transient statuses only', () => {
  for (const s of [408, 429, 500, 502, 503, 504, 529]) {
    assert.ok(isRetryableStatus(s), `${s} should be retryable`);
  }
  for (const s of [400, 401, 402, 403, 404, 413, 422]) {
    assert.ok(!isRetryableStatus(s), `${s} should NOT be retryable`);
  }
});

test('isRetryableError requires a ParleyApiError marked retryable', () => {
  assert.ok(isRetryableError(new ParleyApiError(429, 'rate limit', true)));
  assert.ok(!isRetryableError(new ParleyApiError(429, 'rate limit'))); // not marked
  assert.ok(!isRetryableError(new Error('plain')));
  assert.ok(!isRetryableError(undefined));
});

test('retryDelayMs backs off exponentially with jitter and caps', () => {
  const noJitter = () => 0;
  assert.equal(retryDelayMs(1, undefined, noJitter), 800);
  assert.equal(retryDelayMs(2, undefined, noJitter), 1600);
  assert.equal(retryDelayMs(3, undefined, noJitter), 3200);
  assert.equal(retryDelayMs(10, undefined, noJitter), 20000); // capped
  const jittered = retryDelayMs(1, undefined, () => 0.999);
  assert.ok(jittered > 800 && jittered <= 800 + 250);
});

test('retryDelayMs honors a longer Retry-After and caps it', () => {
  const noJitter = () => 0;
  assert.equal(retryDelayMs(1, 5, noJitter), 5000); // server wait wins
  assert.equal(retryDelayMs(3, 1, noJitter), 3200); // backoff wins when longer
  assert.equal(retryDelayMs(1, 120, noJitter), 20000); // capped
});

test('parseRetryAfter reads delta-seconds and HTTP-dates', () => {
  assert.equal(parseRetryAfter('7'), 7);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter('not-a-date'), undefined);
  const inFive = new Date(Date.now() + 5000).toUTCString();
  const parsed = parseRetryAfter(inFive);
  assert.ok(parsed !== undefined && parsed > 0 && parsed <= 6, `parsed ${parsed}`);
});

test('retryReason gives short human labels', () => {
  assert.equal(retryReason(new ParleyApiError(429, 'x', true)), 'Rate-limited');
  assert.equal(retryReason(new ParleyApiError(502, 'x', true)), 'Gateway error (HTTP 502)');
  assert.equal(retryReason(new ParleyApiError(0, 'Parley stream error: boom', true)), 'Stream error');
  assert.equal(retryReason(new ParleyApiError(0, 'Could not reach Parley', true)), 'Network error');
  assert.equal(retryReason(new Error('x')), 'Request failed');
});

test('MAX_ATTEMPTS is one initial try plus retries', () => {
  assert.ok(MAX_ATTEMPTS >= 2 && MAX_ATTEMPTS <= 6);
});

test('sleepWithAbort resolves after the delay', async () => {
  const start = Date.now();
  await sleepWithAbort(30);
  assert.ok(Date.now() - start >= 25);
});

test('sleepWithAbort rejects with AbortError when the signal fires', async () => {
  const controller = new AbortController();
  const sleep = sleepWithAbort(5000, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(sleep, (error: Error) => error.name === 'AbortError');
});

test('sleepWithAbort rejects immediately on an already-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sleepWithAbort(5000, controller.signal), (error: Error) => error.name === 'AbortError');
});
