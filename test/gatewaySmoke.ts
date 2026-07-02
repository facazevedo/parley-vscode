import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';

/**
 * Live smoke test against the REAL Parley gateway — a single minimal chat
 * round-trip. Deliberately NOT named `*.test.ts`, so the default offline suite
 * (`out/test/*.test.js`) never runs it; it runs only via `npm run test:smoke`,
 * which CI invokes only when the `PARLEY_SMOKE_KEY` secret is configured.
 * Without the key it skips, so it is safe to run anywhere.
 */

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
const { ParleyClient } = require('../src/parley/ParleyClient') as typeof import('../src/parley/ParleyClient');

const fakeLogger = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, dispose() {} } as never;

const key = process.env.PARLEY_SMOKE_KEY;
const endpoint = process.env.PARLEY_SMOKE_ENDPOINT || 'https://parley.api.mit.edu/v1';
const model = process.env.PARLEY_SMOKE_MODEL || 'bedrock/claude-sonnet-4-6';

test(
  'live gateway smoke: a minimal chat round-trip returns a non-empty reply',
  { skip: key ? false : 'set PARLEY_SMOKE_KEY (and optionally PARLEY_SMOKE_ENDPOINT / PARLEY_SMOKE_MODEL) to run' },
  async () => {
    const auth = { getToken: async () => key, clear: async () => {} } as never;
    const client = new ParleyClient(endpoint, auth, fakeLogger, model);
    const prompt = 'Reply with exactly: OK';
    const res = await client.sendMessage(
      {
        prompt,
        messages: [{ role: 'user', content: prompt, createdAt: new Date().toISOString() }],
        context: [],
        agentId: model
      },
      {}
    );
    assert.ok(res.message.content.trim().length > 0, 'the gateway returned a non-empty reply');
  }
);
