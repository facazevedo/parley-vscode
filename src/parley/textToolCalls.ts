/**
 * Recover tool calls from models that emit them as TEXT — `<tool_call>{…}</tool_call>` —
 * rather than as native OpenAI `tool_calls` (common for local/open models without native
 * tool-calling). Pure, dependency-free, and unit-tested so ParleyClient can turn a
 * text-protocol model into a working agent. See ParleyClient.runToolLoop for the loop.
 */

/** A tool call recovered from a model that emitted it as text rather than a native tool_call. */
export interface TextToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments, matching the shape native tool calls hand to runTool. */
  argsJson: string;
}

/** Extract the first brace-balanced JSON object at/after `from`. Tolerates truncation. */
function extractBalancedJson(s: string, from: number): { json: string; end: number } | null {
  const start = s.indexOf('{', from);
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === '\\') {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return { json: s.slice(start, i + 1), end: i + 1 };
      }
    }
  }
  return null;
}

/**
 * Recover text-format tool calls emitted inside `content` as
 * `<tool_call>{"name":…,"arguments":{…}}</tool_call>`. Returns the parsed calls plus
 * `assistantContent` — the model's turn truncated at the end of the last tool call, so any
 * fabricated `<tool_response>` it hallucinated afterward is dropped (we substitute the real
 * result). No calls → empty list and the content unchanged.
 */
export function parseTextToolCalls(content: string): { calls: TextToolCall[]; assistantContent: string } {
  const calls: TextToolCall[] = [];
  if (!content || content.indexOf('<tool_call>') === -1) {
    return { calls, assistantContent: content };
  }
  const open = /<tool_call>/g;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  let idx = 0;
  while ((m = open.exec(content)) !== null) {
    const parsed = extractBalancedJson(content, m.index + m[0].length);
    if (!parsed) {
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(parsed.json) as Record<string, unknown>;
    } catch {
      continue;
    }
    const name = (obj.name ?? obj.tool ?? obj.function) as string | undefined;
    if (!name || typeof name !== 'string') {
      continue;
    }
    const rawArgs = obj.arguments ?? obj.args ?? obj.parameters ?? {};
    const argsJson = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
    calls.push({ id: `txt_${idx}`, name, argsJson });
    idx += 1;
    const close = content.indexOf('</tool_call>', parsed.end);
    lastEnd = close === -1 ? parsed.end : close + '</tool_call>'.length;
  }
  if (calls.length === 0) {
    return { calls, assistantContent: content };
  }
  let assistantContent = content.slice(0, lastEnd).trimEnd();
  if (!assistantContent.endsWith('</tool_call>')) {
    assistantContent += '\n</tool_call>'; // close a tag the stop-sequence truncated
  }
  return { calls, assistantContent };
}
