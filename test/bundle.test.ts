import assert from 'node:assert/strict';
import { test } from 'node:test';
import Module from 'node:module';
import * as path from 'node:path';

/**
 * Guards the esbuild bundling step: the shipped `dist/extension.js` must load as a
 * CommonJS module and export `activate`/`deactivate`. The bundle `require('vscode')`,
 * which only exists inside the VS Code host, so we stub it with a forgiving proxy.
 */
function makeVscodeStub(): unknown {
  const handler: ProxyHandler<() => unknown> = {
    get: (_target, prop) => {
      if (prop === 'EventEmitter') {
        return class {
          public event = (): void => {};
          public fire(): void {}
          public dispose(): void {}
        };
      }
      if (prop === Symbol.toPrimitive || prop === 'then') {
        return undefined; // don't masquerade as a thenable
      }
      return stub;
    },
    apply: () => stub,
    construct: () => ({})
  };
  const stub: unknown = new Proxy(function noop() {}, handler);
  return stub;
}

test('bundled dist/extension.js loads and exports activate/deactivate', () => {
  const stub = makeVscodeStub();
  const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
  const original = loader._load;
  loader._load = function (request: string, ...rest: unknown[]): unknown {
    return request === 'vscode' ? stub : original.apply(this, [request, ...rest] as never);
  };
  try {
    const bundlePath = path.resolve(__dirname, '../../dist/extension.js');
    delete require.cache[bundlePath];
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- intentionally loading the built bundle at runtime
    const ext = require(bundlePath) as { activate?: unknown; deactivate?: unknown };
    assert.equal(typeof ext.activate, 'function', 'bundle should export activate()');
    assert.equal(typeof ext.deactivate, 'function', 'bundle should export deactivate()');
  } finally {
    loader._load = original;
  }
});
