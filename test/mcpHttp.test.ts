import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import Module from 'node:module';
import { test } from 'node:test';

/**
 * Live test of the MCP streamable-HTTP transport against a real local server:
 * initialize (JSON response + Mcp-Session-Id), tools/list, and a tools/call whose
 * response arrives as an SSE stream — exercising both response modes on the wire.
 */

function makeVscodeStub(): unknown {
  const handler: ProxyHandler<() => unknown> = {
    get: (_target, prop) => (prop === Symbol.toPrimitive || prop === 'then' ? undefined : stub),
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
const { McpManager } = require('../src/mcp/McpManager') as typeof import('../src/mcp/McpManager');

const fakeLogger = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, dispose() {} } as never;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => resolve(body));
  });
}

test('streamable-HTTP MCP server: session handshake, tools/list, SSE tool response', async () => {
  const seenSessions: Array<string | undefined> = [];
  let sawAuthHeader = false;
  const server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const rpc = JSON.parse(body || '{}') as { id?: number; method?: string; params?: { name?: string } };
      seenSessions.push(req.headers['mcp-session-id'] as string | undefined);
      sawAuthHeader = sawAuthHeader || req.headers.authorization === 'Bearer test-token';

      if (rpc.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-42' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2024-11-05' } }));
        return;
      }
      if (rpc.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      if (rpc.method === 'tools/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: { tools: [{ name: 'echo', description: 'Echo back', inputSchema: { type: 'object' } }] }
          })
        );
        return;
      }
      if (rpc.method === 'tools/call') {
        // Respond over SSE to exercise the event-stream response path.
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: { content: [{ type: 'text', text: `echoed:${rpc.params?.name ?? ''}` }] }
          })}\n\n`
        );
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  );

  const mcp = new McpManager(fakeLogger);
  try {
    await mcp.start({
      remote: { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: 'Bearer test-token' } }
    });

    const tools = mcp.getTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].function.name, 'mcp__remote__echo');
    assert.deepEqual(mcp.status(), ['remote: 1 tool(s)']);

    const result = await mcp.callTool('mcp__remote__echo', '{"x":1}');
    assert.equal(result, 'echoed:echo');

    // The session id from initialize must be echoed on every later request.
    assert.equal(seenSessions[0], undefined, 'no session on initialize');
    assert.ok(
      seenSessions.slice(1).every((s) => s === 'sess-42'),
      `later requests carry the session: ${seenSessions}`
    );
    assert.ok(sawAuthHeader, 'custom Authorization header sent');
  } finally {
    mcp.dispose();
    server.close();
  }
});
