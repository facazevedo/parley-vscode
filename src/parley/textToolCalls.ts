/**
 * Recover tool calls from models that emit them as TEXT rather than as native OpenAI
 * `tool_calls` (common for local/open models without native tool-calling). Handles the
 * common dialects — Hermes/Qwen `<tool_call>`, `<function_call>`/`<tool_use>`,
 * `<function=NAME>`, DeepSeek's special tokens, fenced JSON, and bare JSON — so ParleyClient
 * can turn a text-protocol model into a working agent. Pure and dependency-free; the
 * per-format behavior is unit-tested. See ParleyClient.runToolLoop for the loop.
 */

/** A tool call recovered from a model that emitted it as text rather than a native tool_call. */
export interface TextToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments, matching the shape native tool calls hand to runTool. */
  argsJson: string;
}

// DeepSeek's tool-call delimiters use fullwidth bar (U+FF5C) + lower-eighth-block (U+2581).
const DS_CALL_BEGIN = '<｜tool▁call▁begin｜>';
const DS_SEP = '<｜tool▁sep｜>';
const DS_CALL_END = '<｜tool▁call▁end｜>';

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

/** Coerce a parsed object into a {name, argsJson}, accepting the common key spellings. */
function asCall(obj: unknown): { name: string; argsJson: string } | null {
  if (!obj || typeof obj !== 'object') {
    return null;
  }
  const o = obj as Record<string, unknown>;
  const name = (o.name ?? o.tool ?? o.function ?? o.tool_name ?? o.recipient_name) as unknown;
  if (typeof name !== 'string' || !name) {
    return null;
  }
  const rawArgs = o.arguments ?? o.args ?? o.parameters ?? o.input ?? {};
  const argsJson = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
  return { name, argsJson };
}

interface Found {
  name: string;
  argsJson: string;
  end: number; // index in content just past this call (for truncating the assistant turn)
}

/** XML-ish wrappers: <tool_call>/<function_call>/<tool_use>/<tool> { json } [</tag>]. */
function scanTagged(content: string): Found[] {
  const out: Found[] = [];
  const re = /<(tool_call|function_call|tool_use|tool)(?:\s[^>]*)?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const parsed = extractBalancedJson(content, m.index + m[0].length);
    if (!parsed) {
      continue;
    }
    let call: { name: string; argsJson: string } | null = null;
    try {
      call = asCall(JSON.parse(parsed.json));
    } catch {
      call = null;
    }
    if (!call) {
      continue;
    }
    const closeTag = `</${m[1]}>`;
    const ci = content.indexOf(closeTag, parsed.end);
    out.push({ ...call, end: ci === -1 ? parsed.end : ci + closeTag.length });
  }
  return out;
}

/** Mistral/functionary style: <function=NAME>{args}</function>. */
function scanFunctionAttr(content: string): Found[] {
  const out: Found[] = [];
  const re = /<function=([^>\s]+)\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const parsed = extractBalancedJson(content, m.index + m[0].length);
    const argsJson = parsed ? parsed.json : '{}';
    const after = parsed ? parsed.end : m.index + m[0].length;
    const ci = content.indexOf('</function>', after);
    out.push({ name: m[1], argsJson, end: ci === -1 ? after : ci + '</function>'.length });
  }
  return out;
}

/** DeepSeek: …<｜tool▁call▁begin｜>function<｜tool▁sep｜>NAME```json {args}```<｜tool▁call▁end｜>… */
function scanDeepSeek(content: string): Found[] {
  const out: Found[] = [];
  let from = 0;
  for (;;) {
    const begin = content.indexOf(DS_CALL_BEGIN, from);
    if (begin === -1) {
      break;
    }
    const sep = content.indexOf(DS_SEP, begin);
    if (sep === -1) {
      break;
    }
    const nameStart = sep + DS_SEP.length;
    // Name runs until a newline or the start of the JSON fence.
    const nl = content.indexOf('\n', nameStart);
    const brace = content.indexOf('{', nameStart);
    const nameEnd = nl === -1 ? (brace === -1 ? content.length : brace) : nl;
    const name = content
      .slice(nameStart, nameEnd)
      .replace(/```(?:json)?/g, '')
      .trim();
    const parsed = extractBalancedJson(content, nameStart);
    const argsJson = parsed ? parsed.json : '{}';
    const endTok = content.indexOf(DS_CALL_END, parsed ? parsed.end : nameStart);
    const end = endTok === -1 ? (parsed ? parsed.end : nameEnd) : endTok + DS_CALL_END.length;
    if (name) {
      out.push({ name, argsJson, end });
    }
    from = end;
  }
  return out;
}

/** Fenced blocks: ```json / ```tool_call / ```tool_code / ``` … whose JSON is a {name,arguments}. */
function scanFenced(content: string): Found[] {
  const out: Found[] = [];
  const re = /```(?:json|tool_call|tool_code|tool)?\s*\r?\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    let call: { name: string; argsJson: string } | null = null;
    try {
      call = asCall(JSON.parse(m[1].trim()));
    } catch {
      call = null;
    }
    if (call) {
      out.push({ ...call, end: m.index + m[0].length });
    }
  }
  return out;
}

/**
 * Recover text-format tool calls from `content`. Returns the parsed calls plus
 * `assistantContent` — the model's turn truncated at the end of the last tool call, so any
 * fabricated result it hallucinated afterward is dropped (the real result is substituted).
 * `knownTools`, when given, gates the *ambiguous* formats (fenced/bare JSON) to real tool
 * names so ordinary JSON in an answer isn't mistaken for a tool call. No calls → empty list.
 */
export function parseTextToolCalls(
  content: string,
  knownTools?: ReadonlySet<string>
): { calls: TextToolCall[]; assistantContent: string } {
  const empty = { calls: [] as TextToolCall[], assistantContent: content };
  if (!content) {
    return empty;
  }
  const hasKnown = !!knownTools && knownTools.size > 0;
  // Ambiguous formats (fenced/bare JSON) are only trusted when they name a real tool —
  // otherwise ordinary JSON in an answer would be mistaken for a call. With no allowlist,
  // reject them entirely.
  const gateAmbiguous = (found: Found[]): Found[] => (hasKnown ? found.filter((f) => knownTools!.has(f.name)) : []);

  // Priority: pick the first dialect present so patterns can't double-count one call.
  let found: Found[] = [];
  if (/<(?:tool_call|function_call|tool_use)\b/i.test(content)) {
    found = scanTagged(content);
  } else if (content.includes(DS_CALL_BEGIN)) {
    found = scanDeepSeek(content);
  } else if (/<function=/i.test(content)) {
    found = scanFunctionAttr(content);
  } else {
    const fenced = gateAmbiguous(scanFenced(content));
    if (fenced.length > 0) {
      found = fenced;
    } else {
      const t = content.trim();
      if (t.startsWith('{') && t.endsWith('}')) {
        try {
          const call = asCall(JSON.parse(t));
          if (call) {
            found = gateAmbiguous([{ ...call, end: content.length }]);
          }
        } catch {
          /* not JSON */
        }
      }
    }
  }

  if (found.length === 0) {
    return empty;
  }
  const calls: TextToolCall[] = found.map((f, i) => ({ id: `txt_${i}`, name: f.name, argsJson: f.argsJson }));
  const lastEnd = found.reduce((mx, f) => Math.max(mx, f.end), 0);
  let assistantContent = content.slice(0, lastEnd).trimEnd();
  if (assistantContent.includes('<tool_call>') && !assistantContent.endsWith('</tool_call>')) {
    assistantContent += '\n</tool_call>'; // close a tag the stop-sequence truncated
  }
  return { calls, assistantContent };
}
