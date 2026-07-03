import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';

// fixDiagnostics.ts imports vscode (provider/command registration); stub it so the
// pure prompt builder can be imported and tested (same trick as outputStyles.test.ts).
function makeVscodeStub(): unknown {
  const handler: ProxyHandler<() => unknown> = {
    get: (_t, prop) => (prop === Symbol.toPrimitive || prop === 'then' ? undefined : stub),
    apply: () => stub,
    construct: () => ({})
  };
  const stub: unknown = new Proxy(function noop() {}, handler);
  return stub;
}
const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, ...rest: unknown[]): unknown {
  return request === 'vscode' ? makeVscodeStub() : originalLoad.apply(this, [request, ...rest] as never);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires -- loaded after the vscode stub is installed
const mod = require('../src/commands/fixDiagnostics') as typeof import('../src/commands/fixDiagnostics');
const { buildFixDiagnosticPrompt } = mod;

function diag(line: number, message: string, severity = 0, source?: string, code?: string | number) {
  return {
    message,
    severity,
    source,
    code,
    range: {
      start: { line, character: 0 },
      end: { line, character: 10 }
    }
  } as never;
}

const DOC = Array.from({ length: 30 }, (_, i) => `line ${i + 1};`).join('\n');

test('single diagnostic: quoted message, 1-based line, language fence, gutter', () => {
  const p = buildFixDiagnosticPrompt('src/a.ts', 'typescript', DOC, [
    diag(9, "Type 'number' is not assignable", 0, 'ts', 2322)
  ]);
  assert.match(p, /diagnostic in `src\/a\.ts`/);
  assert.match(p, /- Error L10: Type 'number' is not assignable \[ts 2322\]/);
  assert.match(p, /```typescript\n/);
  assert.match(p, /10 \| line 10;/);
  assert.match(p, / 7 \| line 7;/); // ±3 context
  assert.match(p, /13 \| line 13;/);
  assert.doesNotMatch(p, /14 \| /);
});

test('multiple diagnostics: plural header, non-adjacent ranges separated by ⋮', () => {
  const p = buildFixDiagnosticPrompt('a.py', 'python', DOC, [diag(2, 'first', 1), diag(24, 'second', 0)]);
  assert.match(p, /diagnostics in `a\.py`/);
  assert.match(p, /- Warning L3: first/);
  assert.match(p, /- Error L25: second/);
  assert.match(p, /⋮/);
});

test('overlapping ranges merge without duplicate lines', () => {
  const p = buildFixDiagnosticPrompt('a.ts', 'typescript', DOC, [diag(5, 'x'), diag(6, 'y')]);
  const count = (p.match(/^ ?6 \| line 6;/gm) || []).length;
  assert.equal(count, 1);
  assert.doesNotMatch(p, /⋮/); // contiguous run, no gap marker
});

test('long messages are truncated to their first line and capped', () => {
  const long = 'A'.repeat(400) + '\nsecond line detail';
  const p = buildFixDiagnosticPrompt('a.ts', 'typescript', DOC, [diag(0, long)]);
  assert.doesNotMatch(p, /second line detail/);
  assert.match(p, new RegExp(`- Error L1: A{300}[^A]`));
});

test('excerpt is capped at 60 lines for many spread diagnostics', () => {
  const bigDoc = Array.from({ length: 400 }, (_, i) => `l${i}`).join('\n');
  const diags = Array.from({ length: 5 }, (_, i) => diag(i * 80, `d${i}`));
  const p = buildFixDiagnosticPrompt('a.ts', 'typescript', bigDoc, diags);
  const fence = p.slice(p.indexOf('```typescript'));
  const codeLines = fence.split('\n').filter((l) => / \| /.test(l));
  assert.ok(codeLines.length <= 60, `got ${codeLines.length}`);
});
