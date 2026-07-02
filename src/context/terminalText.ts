/**
 * Pure helpers for the `@terminal` capture — ANSI stripping, the ring buffer, and
 * snapshot formatting — separated from the shell-integration event wiring so they
 * are unit-testable. `terminalLog.ts` delegates here.
 */

export interface TerminalEntry {
  readonly terminal: string;
  readonly command: string;
  readonly output: string;
  readonly at: string;
}

/** Remove ANSI CSI (`ESC [ … letter`) and OSC (`ESC ] … BEL`) escape sequences from captured output. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- ANSI escape sequences are control chars by definition
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/** Append an entry to the ring (mutates `entries`), capped at `max` most-recent. */
export function pushEntry(entries: TerminalEntry[], entry: TerminalEntry, max: number): void {
  entries.push(entry);
  if (entries.length > max) {
    entries.splice(0, entries.length - max);
  }
}

/** Format recent terminal activity (most recent last) for the `@terminal` mention. */
export function formatSnapshot(entries: readonly TerminalEntry[]): string {
  return entries.map((e) => `[${e.terminal}] $ ${e.command}\n${e.output.trim() || '(no output)'}`).join('\n\n---\n\n');
}
