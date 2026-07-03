/**
 * Computer-use action protocol (pure, unit-tested). The model returns ONE JSON
 * action per step; `parseAction` tolerantly extracts it (fenced or bare) and
 * validates it into a typed action, so the executor never acts on malformed or
 * partial output. Coordinates are in the SHOWN screenshot's pixel space; the
 * caller maps them back to real screen pixels.
 */

export type CuAction =
  | { type: 'click'; x: number; y: number; button: 'left' | 'right' | 'double' }
  | { type: 'move'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; keys: string }
  | { type: 'scroll'; x: number; y: number; amount: number }
  | { type: 'wait'; ms: number }
  | { type: 'done'; summary: string }
  | { type: 'abort'; reason: string };

export interface ParseError {
  readonly type: 'error';
  readonly message: string;
}

/** Extract the first balanced top-level `{…}` object from arbitrary model text. */
export function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) {
    return undefined;
  }
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Parse and validate one action from model output. Returns a ParseError on any problem. */
export function parseAction(text: string): CuAction | ParseError {
  const json = extractJsonObject(text);
  if (!json) {
    return { type: 'error', message: 'No JSON action object found in the reply.' };
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { type: 'error', message: 'The action was not valid JSON.' };
  }
  const action = String(obj.action ?? obj.type ?? '').toLowerCase();
  switch (action) {
    case 'click':
    case 'left_click':
    case 'right_click':
    case 'double_click': {
      const x = num(obj.x);
      const y = num(obj.y);
      if (x === undefined || y === undefined) {
        return { type: 'error', message: 'click requires numeric x and y.' };
      }
      const rawBtn = String(obj.button ?? '').toLowerCase();
      const button =
        action === 'right_click' || rawBtn === 'right'
          ? 'right'
          : action === 'double_click' || rawBtn === 'double'
            ? 'double'
            : 'left';
      return { type: 'click', x, y, button };
    }
    case 'move':
    case 'mouse_move': {
      const x = num(obj.x);
      const y = num(obj.y);
      if (x === undefined || y === undefined) {
        return { type: 'error', message: 'move requires numeric x and y.' };
      }
      return { type: 'move', x, y };
    }
    case 'type': {
      const text2 = obj.text;
      if (typeof text2 !== 'string' || text2.length === 0) {
        return { type: 'error', message: 'type requires non-empty text.' };
      }
      return { type: 'type', text: text2.slice(0, 2000) };
    }
    case 'key':
    case 'keypress': {
      const keys = String(obj.keys ?? obj.key ?? '').trim();
      if (!keys) {
        return { type: 'error', message: 'key requires a key or combo (e.g. "enter", "ctrl+s").' };
      }
      return { type: 'key', keys: keys.slice(0, 60) };
    }
    case 'scroll': {
      const x = num(obj.x) ?? 0;
      const y = num(obj.y) ?? 0;
      const amount = num(obj.amount) ?? num(obj.dy) ?? 0;
      if (amount === 0) {
        return { type: 'error', message: 'scroll requires a non-zero amount (+down / -up).' };
      }
      return { type: 'scroll', x, y, amount: Math.max(-10, Math.min(10, Math.round(amount))) };
    }
    case 'wait': {
      const ms = num(obj.ms) ?? 1000;
      return { type: 'wait', ms: Math.max(100, Math.min(5000, ms)) };
    }
    case 'done':
    case 'finish':
      return { type: 'done', summary: String(obj.summary ?? obj.text ?? 'Task complete.').slice(0, 500) };
    case 'abort':
    case 'stop':
    case 'fail':
      return { type: 'abort', reason: String(obj.reason ?? obj.summary ?? 'Aborted.').slice(0, 500) };
    default:
      return { type: 'error', message: `Unknown action "${action}".` };
  }
}

/** One-line human description of an action for the transcript. */
export function describeAction(a: CuAction): string {
  switch (a.type) {
    case 'click':
      return `${a.button === 'double' ? 'double-click' : a.button === 'right' ? 'right-click' : 'click'} (${a.x}, ${a.y})`;
    case 'move':
      return `move to (${a.x}, ${a.y})`;
    case 'type':
      return `type "${a.text.length > 40 ? a.text.slice(0, 40) + '…' : a.text}"`;
    case 'key':
      return `press ${a.keys}`;
    case 'scroll':
      return `scroll ${a.amount > 0 ? 'down' : 'up'} at (${a.x}, ${a.y})`;
    case 'wait':
      return `wait ${a.ms}ms`;
    case 'done':
      return `done — ${a.summary}`;
    case 'abort':
      return `abort — ${a.reason}`;
  }
}
