import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';

// usageHistory.ts imports vscode; stub it so the pure aggregator can be imported.
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
const mod = require('../src/commands/usageHistory') as typeof import('../src/commands/usageHistory');
const { aggregateUsage } = mod;

const TODAY = '2026-07-03T12:00:00.000Z';

test('totals sum tokens and cost across entries', () => {
  const s = aggregateUsage(
    [
      { savedAt: '2026-07-03T09:00:00Z', model: 'openai/gpt-5', tokens: 1000, costUsd: 0.1 },
      { savedAt: '2026-07-02T09:00:00Z', model: 'bedrock/claude-opus', tokens: 2000, costUsd: 0.5 }
    ],
    TODAY
  );
  assert.equal(s.totalTokens, 3000);
  assert.ok(Math.abs(s.totalCost - 0.6) < 1e-9);
  assert.equal(s.totalConversations, 2);
});

test('byDay is a continuous 30-day window ending today, with matching days filled', () => {
  const s = aggregateUsage([{ savedAt: '2026-07-03T01:00:00Z', model: 'm', tokens: 5, costUsd: 0.05 }], TODAY);
  assert.equal(s.byDay.length, 30);
  assert.equal(s.byDay[29].date, '2026-07-03');
  assert.equal(s.byDay[0].date, '2026-06-04');
  assert.equal(s.byDay[29].cost, 0.05);
  assert.equal(s.byDay[28].cost, 0, 'a day with no conversations is zero, not missing');
});

test('byModel groups and sorts by cost desc', () => {
  const s = aggregateUsage(
    [
      { savedAt: TODAY, model: 'cheap', tokens: 100, costUsd: 0.01 },
      { savedAt: TODAY, model: 'pricey', tokens: 50, costUsd: 0.9 },
      { savedAt: TODAY, model: 'cheap', tokens: 100, costUsd: 0.01 }
    ],
    TODAY
  );
  assert.equal(s.byModel[0].model, 'pricey');
  assert.equal(s.byModel[1].model, 'cheap');
  assert.equal(s.byModel[1].count, 2);
  assert.ok(Math.abs(s.byModel[1].cost - 0.02) < 1e-9);
});

test('missing tokens/cost default to 0; missing model becomes "unknown"', () => {
  const s = aggregateUsage([{ savedAt: TODAY, model: '' }], TODAY);
  assert.equal(s.totalTokens, 0);
  assert.equal(s.totalCost, 0);
  assert.equal(s.byModel[0].model, 'unknown');
});
