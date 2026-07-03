import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';

// statusBar.ts imports vscode (StatusBarItem); stub it so the pure formatter can
// be imported and tested (same trick as outputStyles.test.ts).
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
const mod = require('../src/statusBar') as typeof import('../src/statusBar');
const { formatStatusText } = mod;

test('busy shows the spinner text regardless of counters', () => {
  assert.equal(
    formatStatusText({ sessionTokens: 12345, sessionCostUsd: 0.42, busy: true }),
    '$(loading~spin) Parley working…'
  );
});

test('tokens + cost: thousands abbreviated with one decimal under 10k', () => {
  assert.equal(
    formatStatusText({ sessionTokens: 12345, sessionCostUsd: 0.42, busy: false }),
    '$(sparkle) 12k · ~$0.42'
  );
  assert.equal(
    formatStatusText({ sessionTokens: 1234, sessionCostUsd: 0.42, busy: false }),
    '$(sparkle) 1.2k · ~$0.42'
  );
});

test('small counts shown verbatim; zero cost omitted', () => {
  assert.equal(formatStatusText({ sessionTokens: 987, sessionCostUsd: 0, busy: false }), '$(sparkle) 987');
  assert.equal(formatStatusText({ sessionTokens: 0, sessionCostUsd: 0, busy: false }), '$(sparkle) 0');
});

test('sub-cent cost renders the <$0.01 form', () => {
  assert.equal(
    formatStatusText({ sessionTokens: 100, sessionCostUsd: 0.004, busy: false }),
    '$(sparkle) 100 · ~<$0.01'
  );
});
