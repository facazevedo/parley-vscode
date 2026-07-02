/**
 * Pure text helpers for the browser tools — no `vscode`/Playwright imports, so they
 * are unit-testable in isolation from the on-demand runtime.
 */

const MAX_TEXT_CHARS = 12000;

/** Trim a page's text to a sane size with a marker. */
export function clampText(text: string, max = MAX_TEXT_CHARS): string {
  const collapsed = text.replace(/\n{3,}/g, '\n\n').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}\n[… page text truncated]` : collapsed;
}

/** Map a Playwright error to a compact, actionable tool result. */
export function browserError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  if (/Executable doesn't exist|Failed to launch|browserType\.launch/i.test(message)) {
    return 'Error: the local browser could not launch. Run "Parley: Close Browser" and retry, or reinstall the runtime (delete the extension\'s browser-runtime folder).';
  }
  if (/net::ERR|ECONNREFUSED|Timeout .*exceeded|timeout/i.test(message)) {
    return `Error: the page did not load (${message.split('\n')[0].slice(0, 160)}). Check the URL and that the server is running.`;
  }
  return `Error: browser action failed — ${message.split('\n')[0].slice(0, 200)}`;
}
