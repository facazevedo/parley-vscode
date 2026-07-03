import * as os from 'os';
import { redactSecrets } from '../context/secretScanner';

/**
 * A privacy-first, opt-in error channel. Extension errors are captured into a small
 * in-memory ring (bounded, sanitized) that NEVER leaves the machine on its own — the
 * user surfaces it explicitly via "Parley: Report an Issue", which prefills a GitHub
 * issue they review and submit themselves. Nothing is auto-sent; there is no network
 * call here. Before anything is stored, text is run through the secret scanner and the
 * user's home path is replaced with `~`, so a shared report can't leak keys or a
 * username. Pure (no vscode) so it is unit-testable.
 */

export interface CapturedError {
  readonly at: string;
  readonly message: string;
  /** Sanitized error name + message + stack, when an Error was attached. */
  readonly detail?: string;
}

const MAX_ERRORS = 50;
const ring: CapturedError[] = [];

function safeHomedir(): string {
  try {
    return os.homedir();
  } catch {
    return '';
  }
}

/**
 * Strip secrets and the user's home path from error text before it is stored or shown.
 * Pure: pass `homeDir` explicitly so it can be tested without touching the real OS.
 */
export function sanitizeErrorText(text: string, homeDir: string): string {
  let out = redactSecrets(text).text;
  if (homeDir) {
    // Replace both slash styles of the home dir so reports don't leak the username.
    for (const variant of [homeDir, homeDir.replace(/\\/g, '/')]) {
      if (variant) {
        out = out.split(variant).join('~');
      }
    }
  }
  return out;
}

/** Record an error into the in-memory ring (sanitized). Safe to call on every logger.error. */
export function recordError(message: string, error?: unknown, at: string = new Date().toISOString()): void {
  const home = safeHomedir();
  const detailParts: string[] = [];
  if (error instanceof Error) {
    detailParts.push(`${error.name}: ${error.message}`);
    if (error.stack) {
      detailParts.push(error.stack);
    }
  } else if (error !== undefined && error !== null) {
    detailParts.push(String(error));
  }
  ring.push({
    at,
    message: sanitizeErrorText(message, home),
    detail: detailParts.length ? sanitizeErrorText(detailParts.join('\n'), home) : undefined
  });
  while (ring.length > MAX_ERRORS) {
    ring.shift();
  }
}

/** The captured errors this session, oldest first (a defensive copy). */
export function recentErrors(): CapturedError[] {
  return [...ring];
}

/** Clear the ring (used by tests and after a report is filed). */
export function clearRecordedErrors(): void {
  ring.length = 0;
}
