import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import Module from 'node:module';
import { test } from 'node:test';
import { SUBAGENT_SYSTEM, describeSubagentStep, runSubagentTask } from '../src/agents/subagent';
import type { ChatResponse } from '../src/parley/types';

/**
 * Local subagents: pure orchestration tests against a fake provider, plus an
 * end-to-end nested loop against a REAL local HTTP gateway mock driving the
 * production ParleyClient (same harness as gatewayLoop.test.ts) — proving a
 * run_subagent call actually spins a fresh tool loop and returns only the report.
 */

// ---- vscode stub (needed only for the ParleyClient e2e below; subagent.ts itself is vscode-free) ----
function makeVscodeStub(): unknown {
  const handler: ProxyHandler<() => unknown> = {
    get: (_target, prop) => {
      if (prop === Symbol.toPrimitive || prop === 'then') {
        return undefined;
      }
      return stub;
    },
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

const fakeAuth = { getToken: async () => 'sk-parley-v1-test', clear: async () => {} } as never;
const fakeLogger = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, dispose() {} } as never;

function reply(content: string): ChatResponse {
  return { message: { role: 'assistant', content, createdAt: new Date().toISOString() } };
}

// ---------- pure orchestration (fake provider) ----------

test('subagent request has a fresh context: own system role, the task as the only message, bounded rounds', async () => {
  let captured: { req?: any; opts?: any } = {};
  const report = await runSubagentTask({
    task: '  map the retry pipeline  ',
    provider: {
      sendMessage: async (req, opts) => {
        captured = { req, opts };
        return reply('## Findings\nretry.ts:12 does backoff.');
      }
    },
    agentId: 'bedrock/claude-sonnet-4-6',
    speed: 'standard',
    tools: [],
    runTool: async () => 'unused'
  });
  assert.equal(report, '## Findings\nretry.ts:12 does backoff.');
  assert.equal(captured.req.systemExtra, SUBAGENT_SYSTEM);
  assert.equal(captured.req.messages.length, 1, 'parent history must NOT leak into the subagent');
  assert.equal(captured.req.messages[0].content, 'map the retry pipeline');
  assert.equal(captured.req.context.length, 0);
  assert.equal(captured.opts.maxToolRounds, 15);
  assert.equal(captured.opts.onToken, undefined, 'nothing streams into the parent bubble');
  assert.equal(captured.opts.getQueuedUserMessages, undefined, 'steering stays with the parent');
});

test('nested tool events surface as short progress steps', async () => {
  const steps: string[] = [];
  await runSubagentTask({
    task: 'investigate',
    provider: {
      sendMessage: async (_req, opts) => {
        opts?.onToolEvent?.({ name: 'read_file', args: '{"path":"src/a.ts"}' } as never);
        opts?.onToolEvent?.({ name: 'grep', args: '{"pattern":"retry"}' } as never);
        return reply('done');
      }
    },
    agentId: 'm',
    speed: 'standard',
    tools: [],
    runTool: async () => '',
    onStep: (s) => steps.push(s)
  });
  assert.deepEqual(steps, ['reading src/a.ts', 'searching retry']);
});

test('empty task, empty report, and provider failure all return actionable strings', async () => {
  const failing = {
    sendMessage: async (): Promise<ChatResponse> => {
      throw new Error('HTTP 500 from gateway\nlong stack');
    }
  };
  assert.match(
    await runSubagentTask({
      task: '   ',
      provider: failing,
      agentId: 'm',
      speed: 'standard',
      tools: [],
      runTool: async () => ''
    }),
    /task is required/
  );
  assert.match(
    await runSubagentTask({
      task: 'x',
      provider: { sendMessage: async () => reply('   ') },
      agentId: 'm',
      speed: 'standard',
      tools: [],
      runTool: async () => ''
    }),
    /returned no report/
  );
  const failed = await runSubagentTask({
    task: 'x',
    provider: failing,
    agentId: 'm',
    speed: 'standard',
    tools: [],
    runTool: async () => ''
  });
  assert.equal(failed, 'Error: subagent failed — HTTP 500 from gateway');
});

test('describeSubagentStep names the verb and target compactly', () => {
  assert.equal(describeSubagentStep('read_file', '{"path":"src/x.ts"}'), 'reading src/x.ts');
  assert.equal(describeSubagentStep('web_search', '{"query":"vscode api"}'), 'fetching vscode api');
  assert.equal(describeSubagentStep('find_references', '{"symbol":"Foo"}'), 'inspecting Foo');
  assert.equal(describeSubagentStep('list_directory', 'not json'), 'listing');
});

test('the subagent persona is explicit about read-only, fresh context, and a standalone report', () => {
  assert.match(SUBAGENT_SYSTEM, /READ-ONLY/);
  assert.match(SUBAGENT_SYSTEM, /cannot see the parent conversation/);
  assert.match(SUBAGENT_SYSTEM, /STAND ALONE/);
  assert.match(SUBAGENT_SYSTEM, /cannot edit files, run commands/);
});

// ---------- e2e: real ParleyClient loop against a local mock gateway ----------

function sse(res: ServerResponse, chunks: string[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const chunk of chunks) {
    res.write(`data: ${chunk}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => resolve(body));
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
}

test('e2e: a subagent runs a real nested tool loop and returns only its final report', async () => {
  let requests = 0;
  let secondBody = '';
  const server = createServer((req, res) => {
    void readBody(req).then((body) => {
      requests += 1;
      if (requests === 1) {
        sse(res, [
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 's1', function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }
                  ]
                }
              }
            ]
          })
        ]);
        return;
      }
      secondBody = body;
      sse(res, [JSON.stringify({ choices: [{ delta: { content: 'REPORT: answer at src/a.ts:10' } }] })]);
    });
  });
  const port = await listen(server);
  try {
    const client = new ParleyClient(`http://127.0.0.1:${port}`, fakeAuth, fakeLogger, 'test/model');
    const steps: string[] = [];
    const report = await runSubagentTask({
      task: 'Find where the answer is computed in src/a.ts and report the line.',
      provider: client,
      agentId: 'bedrock/claude-sonnet-4-6',
      speed: 'standard',
      tools: [
        {
          type: 'function',
          function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } }
        }
      ],
      runTool: async (call) => (call.name === 'read_file' ? 'const answer = 42; // line 10' : 'Error: unexpected'),
      onStep: (s) => steps.push(s)
    });
    assert.equal(report, 'REPORT: answer at src/a.ts:10');
    assert.equal(requests, 2, 'nested tool round + final report round');
    assert.deepEqual(steps, ['reading src/a.ts']);
    const sent = JSON.parse(secondBody) as { messages: Array<{ role: string; content: string }> };
    assert.match(sent.messages[0].content, /# Subagent role/, 'subagent persona reaches the wire as system text');
    const toolMsg = sent.messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg?.content, 'const answer = 42; // line 10', 'nested tool result fed back into the nested loop');
    assert.ok(
      sent.messages.every((m) => !/parent conversation history/.test(m.content ?? '')),
      'nothing but the task and nested activity is on the wire'
    );
  } finally {
    server.close();
  }
});
