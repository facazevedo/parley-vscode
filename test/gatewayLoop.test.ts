import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import Module from 'node:module';
import { test } from 'node:test';

/**
 * End-to-end loop tests against a REAL local HTTP gateway mock, exercising the
 * production ParleyClient code path: the plan's "live scenario" made executable —
 * a forced 429 must be retried transparently, and >8k tool output must reach the
 * next request clamped with an honest omission marker. (The actual MIT gateway
 * cannot be forced to 429 on demand, so this local server is the faithful stand-in.)
 */

// ---- vscode stub (same trick as bundle.test.ts): the module graph imports vscode. ----
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

const USER_MSG = [{ role: 'user' as const, content: 'hi', createdAt: new Date().toISOString() }];

test('a forced 429 mid-conversation is retried transparently and the turn completes', async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    void readBody(req).then(() => {
      requests += 1;
      if (requests <= 2) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        res.end(JSON.stringify({ error: { message: 'rate limited (forced by test)' } }));
        return;
      }
      sse(res, [
        JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
        JSON.stringify({
          choices: [{ delta: { content: ' world' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
        })
      ]);
    });
  });
  const port = await listen(server);
  try {
    const client = new ParleyClient(`http://127.0.0.1:${port}`, fakeAuth, fakeLogger, 'test/model');
    const tokens: string[] = [];
    const retries: string[] = [];
    const response = await client.sendMessage(
      { prompt: 'hi', messages: USER_MSG, context: [], agentId: 'bedrock/claude-sonnet-4-6' },
      { onToken: (d) => tokens.push(d), onRetry: (info) => retries.push(info.reason) }
    );
    assert.equal(response.message.content, 'Hello world');
    assert.equal(requests, 3, 'two 429s + one success');
    assert.equal(retries.length, 2, 'both 429s surfaced as retry notices');
    assert.ok(retries.every((r) => r === 'Rate-limited'));
    assert.deepEqual(tokens.join(''), 'Hello world');
  } finally {
    server.close();
  }
});

test('>8k tool output reaches the next request clamped with an honest omission marker', async () => {
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
                    { index: 0, id: 't1', function: { name: 'run_command', arguments: '{"command":"build"}' } }
                  ]
                }
              }
            ]
          })
        ]);
        return;
      }
      secondBody = body;
      sse(res, [JSON.stringify({ choices: [{ delta: { content: 'done' } }] })]);
    });
  });
  const port = await listen(server);
  try {
    const client = new ParleyClient(`http://127.0.0.1:${port}`, fakeAuth, fakeLogger, 'test/model');
    const bigOutput = `BUILD-HEAD ${'x'.repeat(30000)} FINAL-ERROR-AT-TAIL`;
    const response = await client.sendMessage(
      { prompt: 'run it', messages: USER_MSG, context: [], agentId: 'bedrock/claude-sonnet-4-6' },
      {
        onToken: () => {},
        tools: [
          {
            type: 'function',
            function: { name: 'run_command', description: 'run', parameters: { type: 'object', properties: {} } }
          }
        ],
        runTool: async () => bigOutput
      }
    );
    assert.equal(response.message.content, 'done');
    assert.equal(requests, 2, 'tool round + final round');
    const sent = JSON.parse(secondBody) as { messages: Array<{ role: string; content: string }> };
    const toolMsg = sent.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'tool result present in the follow-up request');
    assert.ok(toolMsg!.content.length <= 16100, `clamped to the run_command budget (got ${toolMsg!.content.length})`);
    assert.match(toolMsg!.content, /characters omitted from the middle/);
    assert.ok(toolMsg!.content.startsWith('BUILD-HEAD'), 'head preserved');
    assert.ok(toolMsg!.content.endsWith('FINAL-ERROR-AT-TAIL'), 'tail (the error) preserved');
  } finally {
    server.close();
  }
});
