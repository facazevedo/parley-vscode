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

/** Apply backspaces (`\b` erases the preceding char, not across a newline). Linear. */
function applyBackspaces(text: string): string {
  if (!text.includes('\b')) {
    return text;
  }
  const buf: string[] = [];
  for (const ch of text) {
    if (ch === '\b') {
      if (buf.length > 0 && buf[buf.length - 1] !== '\n') {
        buf.pop();
      }
    } else {
      buf.push(ch);
    }
  }
  return buf.join('');
}

/**
 * Clean captured shell output for display and model context: strip ANSI escapes
 * (incl. cursor moves like `ESC[A`), collapse carriage-return line rewrites
 * (progress bars) to their final frame, apply backspaces (spinners like `-\b\`),
 * then drop any remaining C0 control chars. Newlines and tabs are preserved. This
 * is what turns conda/apptainer spinner noise into readable log lines.
 */
export function sanitizeCommandOutput(text: string): string {
  if (!text) {
    return text;
  }
  let out = text.replace(/\r\n/g, '\n'); // CRLF -> LF before handling bare \r
  out = stripAnsi(out);
  // Each \r returns the cursor to column 0; a progress bar rewrites the whole line,
  // so keep only what follows the last \r on each physical line.
  out = out
    .split('\n')
    .map((line) => (line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line))
    .join('\n');
  out = applyBackspaces(out);
  // eslint-disable-next-line no-control-regex -- stripping leftover control chars is the point
  out = out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return out.replace(/\n{3,}/g, '\n\n'); // tidy: at most one blank line in a row
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
