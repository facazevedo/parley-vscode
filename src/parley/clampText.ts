/**
 * Honest truncation for tool results and command output.
 *
 * Long text is clamped by keeping the head and the tail around an explicit
 * omission marker, instead of silently cutting the end. The tail matters most
 * for command output (the error usually prints last); the head carries the
 * tool's own framing (e.g. read_file's numbering and pagination footer). The
 * marker tells the model exactly how much was dropped so it can narrow the
 * request instead of reasoning over an amputated result as if it were complete.
 */

/** Per-tool result budgets (chars). Tools that self-cap get headroom so their own hints survive intact. */
const TOOL_RESULT_BUDGETS: Record<string, number> = {
  read_file: 24000, // self-caps at 20k chars / 500 lines with a pagination footer
  run_command: 16000, // build/test output — the failure is usually at the tail
  fetch_url: 13000, // self-caps at 12k
  search_text: 12000,
  grep: 12000
};

const DEFAULT_TOOL_RESULT_BUDGET = 8000;

/** Fraction of the budget spent on the head; the rest keeps the tail. */
const HEAD_SHARE = 0.4;

/** Clamp text to at most `maxChars`, keeping head + tail around an explicit omission marker. */
export function clampMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const marker = (omitted: number): string =>
    `\n[… ${omitted.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters omitted from the middle — narrow the request (smaller line range, more specific command or query) if you need the rest …]\n`;
  // Reserve space for the marker using its largest possible rendering.
  const budget = Math.max(200, maxChars - marker(text.length).length);
  const headLen = Math.floor(budget * HEAD_SHARE);
  const tailLen = budget - headLen;
  return text.slice(0, headLen) + marker(text.length - headLen - tailLen) + text.slice(text.length - tailLen);
}

/** Clamp a tool result to its per-tool budget before it joins the conversation. */
export function clampToolResult(toolName: string, result: string): string {
  return clampMiddle(result, TOOL_RESULT_BUDGETS[toolName] ?? DEFAULT_TOOL_RESULT_BUDGET);
}
