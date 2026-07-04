/** Pure stack-trace frame extraction — no vscode, so it's unit-testable. */

export interface TraceFrame {
  readonly file: string;
  readonly line: number;
}

/** Extract (file, line) frames from common stack-trace formats (JS/TS, Python, generic). */
export function parseTraceFrames(trace: string): TraceFrame[] {
  const frames: TraceFrame[] = [];
  const seen = new Set<string>();
  const patterns = [
    /\(([^()\n]+?):(\d+):\d+\)/g, // JS/TS:  at fn (path:line:col)
    /\bat\s+([^\s()]+?):(\d+):\d+/g, // JS/TS:  at path:line:col
    /File "([^"\n]+)", line (\d+)/g, // Python
    /^\s*([^\s:][^:\n]*?):(\d+)(?::\d+)?/gm // generic  path:line[:col]
  ];
  for (const re of patterns) {
    for (const m of trace.matchAll(re)) {
      const file = m[1].trim();
      const line = Number(m[2]);
      const key = `${file}:${line}`;
      if (file && line > 0 && !seen.has(key)) {
        seen.add(key);
        frames.push({ file, line });
      }
    }
  }
  return frames;
}
