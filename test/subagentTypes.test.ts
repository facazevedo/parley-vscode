import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';

// subagents.ts imports vscode (for its directory loader); stub it so the pure
// parts can be imported and tested (same trick as outputStyles.test.ts).
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
const subagents = require('../src/config/subagents') as typeof import('../src/config/subagents');
// eslint-disable-next-line @typescript-eslint/no-var-requires -- loaded after the vscode stub is installed
const tools = require('../src/parley/tools') as typeof import('../src/parley/tools');
const { subagentFromFile } = subagents;
const { withSubagentTypes, AGENT_TOOLS } = tools;

test('frontmatter description and model are parsed; body becomes the prompt', () => {
  const t = subagentFromFile(
    'security-reviewer',
    '---\ndescription: Audits code for vulns\nmodel: "openai/gpt-5-nano"\n---\nFocus on injection risks.'
  );
  assert.ok(t);
  assert.equal(t.id, 'security-reviewer');
  assert.equal(t.description, 'Audits code for vulns');
  assert.equal(t.model, 'openai/gpt-5-nano');
  assert.equal(t.prompt, 'Focus on injection risks.');
});

test('missing description falls back; missing model stays undefined', () => {
  const t = subagentFromFile('x', 'Just a prompt body.');
  assert.ok(t);
  assert.equal(t.description, 'Custom subagent.');
  assert.equal(t.model, undefined);
  assert.equal(t.prompt, 'Just a prompt body.');
});

test('empty body yields undefined (file skipped)', () => {
  assert.equal(subagentFromFile('x', '---\ndescription: no body\n---\n\n'), undefined);
});

test('prompt is capped at 8000 chars', () => {
  const t = subagentFromFile('x', 'A'.repeat(9000));
  assert.ok(t);
  assert.equal(t.prompt.length, 8000);
});

test('withSubagentTypes is a no-op for an empty roster', () => {
  assert.equal(withSubagentTypes(AGENT_TOOLS, []), AGENT_TOOLS);
});

test('withSubagentTypes adds the agent param and enumerates types on run_subagent only', () => {
  const types = [
    { id: 'security-reviewer', description: 'Audits code' },
    { id: 'perf-hunter', description: 'Finds hot paths' }
  ];
  const out = withSubagentTypes(AGENT_TOOLS, types);
  const sub = out.find((t) => t.function.name === 'run_subagent');
  assert.ok(sub);
  assert.match(sub.function.description, /"security-reviewer" — Audits code/);
  assert.match(sub.function.description, /"perf-hunter" — Finds hot paths/);
  const props = sub.function.parameters.properties as Record<string, unknown>;
  assert.ok(props.agent, 'agent parameter added');
  assert.ok(props.task, 'task parameter kept');
  assert.deepEqual((sub.function.parameters as { required?: string[] }).required, ['task']);
  // Other tools untouched (same references).
  for (const t of out) {
    if (t.function.name !== 'run_subagent') {
      assert.ok(AGENT_TOOLS.includes(t));
    }
  }
  // Source array not mutated.
  const orig = AGENT_TOOLS.find((t) => t.function.name === 'run_subagent');
  assert.ok(orig && !/security-reviewer/.test(orig.function.description));
});
