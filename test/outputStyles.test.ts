import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';

// outputStyles.ts imports vscode (for its directory loader); stub it so the pure
// resolver/built-ins can be imported and tested (same trick as gatewayLoop.test.ts).
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
const styles = require('../src/config/outputStyles') as typeof import('../src/config/outputStyles');
const { BUILT_IN_OUTPUT_STYLES, resolveStylePrompt } = styles;

test('default style contributes no extra instruction', () => {
  assert.equal(resolveStylePrompt(BUILT_IN_OUTPUT_STYLES, 'default'), '');
  assert.equal(resolveStylePrompt(BUILT_IN_OUTPUT_STYLES, undefined), '');
  assert.equal(resolveStylePrompt(BUILT_IN_OUTPUT_STYLES, ''), '');
});

test('named styles return their instruction', () => {
  assert.match(resolveStylePrompt(BUILT_IN_OUTPUT_STYLES, 'concise'), /Concise/);
  assert.match(resolveStylePrompt(BUILT_IN_OUTPUT_STYLES, 'explanatory'), /Explanatory/);
  assert.match(resolveStylePrompt(BUILT_IN_OUTPUT_STYLES, 'learning'), /Learning/);
});

test('an unknown style id falls back to default (no instruction)', () => {
  assert.equal(resolveStylePrompt(BUILT_IN_OUTPUT_STYLES, 'nope'), '');
});

test('every built-in has a unique id and a description; only default is empty-prompt', () => {
  const ids = BUILT_IN_OUTPUT_STYLES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of BUILT_IN_OUTPUT_STYLES) {
    assert.ok(s.description.length > 0, `${s.id} has a description`);
    if (s.id !== 'default') {
      assert.ok(s.prompt.length > 0, `${s.id} has a prompt`);
    }
  }
});
