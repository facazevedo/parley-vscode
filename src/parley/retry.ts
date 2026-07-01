import { ParleyApiError } from './types';

/**
 * Retry policy for chat requests. Transient gateway failures — rate limits,
 * upstream 5xx, network blips, mid-stream error events — are retried with
 * exponential backoff. Callers only retry while nothing has been streamed to
 * the UI yet, so a retry can never duplicate visible output.
 */

/** 1 initial attempt + 3 retries. */
export const MAX_ATTEMPTS = 4;

const BASE_DELAY_MS = 800;
const MAX_DELAY_MS = 20000;
const JITTER_MS = 250;

/** HTTP statuses worth retrying: timeout, rate limit, server/upstream errors, overloaded. */
export function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 529
  );
}

export function isRetryableError(error: unknown): boolean {
  return error instanceof ParleyApiError && error.retryable;
}

/**
 * Delay before the retry that follows `attempt` failed attempts (1-based):
 * 0.8s, 1.6s, 3.2s… plus jitter, capped. A server `Retry-After` wins when longer.
 */
export function retryDelayMs(attempt: number, retryAfterSeconds?: number, jitter: () => number = Math.random): number {
  const backoff =
    Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1)) + Math.floor(jitter() * JITTER_MS);
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    return Math.min(MAX_DELAY_MS, Math.max(backoff, Math.ceil(retryAfterSeconds * 1000)));
  }
  return Math.min(MAX_DELAY_MS, backoff);
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into seconds. */
export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.max(0, (date - Date.now()) / 1000);
  }
  return undefined;
}

/** Short human label for a retry notice ("Rate-limited", "Gateway error (HTTP 502)", …). */
export function retryReason(error: unknown): string {
  if (error instanceof ParleyApiError) {
    if (error.status === 429) {
      return 'Rate-limited';
    }
    if (error.status === 0) {
      return /stream error/i.test(error.message) ? 'Stream error' : 'Network error';
    }
    return `Gateway error (HTTP ${error.status})`;
  }
  return 'Request failed';
}

/** Abort-aware sleep. Rejects with an AbortError-named error if the signal fires. */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error('The request was aborted.');
  error.name = 'AbortError';
  return error;
}
