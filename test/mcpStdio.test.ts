import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import * as fs from 'fs';
import Module from 'node:module';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { isMcpTool, parseQualifiedName, qualifyToolName, sanitizeServerName } from '../src/mcp/naming';

// McpManager pulls in debug.ts, which imports vscode — stub it (as mcpHttp.test.ts does).
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
const { McpManager } = require('../src/mcp/McpManager') as typeof import('../src/mcp/McpManager');

const fakeLogger = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, dispose() {} } as never;

// A minimal MCP server speaking newline-delimited JSON-RPC over stdio (plain CJS so `node` runs it directly).
const MOCK_SERVER = `
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue; // notification (e.g. notifications/initialized) — no reply
    let result, error;
    if (msg.method === 'initialize') {
      result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1' } };
    } else if (msg.method === 'tools/list') {
      result = { tools: [{ name: 'echo', description: 'echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] };
    } else if (msg.method === 'tools/call' && msg.params && msg.params.name === 'echo') {
      result = { content: [{ type: 'text', text: String((msg.params.arguments || {}).text || '') }] };
    } else {
      error = { message: 'unknown method or tool: ' + msg.method };
    }
    const resp = { jsonrpc: '2.0', id: msg.id };
    if (error) resp.error = error; else resp.result = result;
    process.stdout.write(JSON.stringify(resp) + '\\n');
  }
});
`;

test('MCP name mapping: qualify / parse / sanitize round-trip', () => {
  assert.equal(qualifyToolName('my server', 'do_it'), 'mcp__my-server__do_it');
  assert.equal(sanitizeServerName('a/b:c d'), 'a-b-c-d');
  assert.deepEqual(parseQualifiedName('mcp__my-server__do_it'), { server: 'my-server', tool: 'do_it' });
  assert.deepEqual(
    parseQualifiedName('mcp__srv__a__b'),
    { server: 'srv', tool: 'a__b' },
    'tool may contain the separator'
  );
  assert.equal(parseQualifiedName('read_file'), undefined);
  assert.equal(isMcpTool('mcp__x__y'), true);
  assert.equal(isMcpTool('read_file'), false);
});

test('stdio MCP server: handshake, tools/list, tools/call, and error path', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'parley-mcp-')), 'mock-mcp.cjs');
  await fsp.writeFile(file, MOCK_SERVER, 'utf8');
  const mgr = new McpManager(fakeLogger);
  try {
    // `node` (on PATH), not process.execPath — the transport uses shell:true on Windows,
    // where a full exe path with spaces (C:\Program Files\…) wouldn't resolve unquoted.
    await mgr.start({ echosrv: { command: 'node', args: [file] } });

    // Handshake succeeded → the tool is exposed as a qualified OpenAI function tool.
    const tools = mgr.getTools();
    assert.ok(
      tools.some((t) => t.function.name === 'mcp__echosrv__echo'),
      'echo tool listed after handshake'
    );
    assert.deepEqual(mgr.status(), ['echosrv: 1 tool(s)']);

    // tools/call round-trips content back.
    const out = await mgr.callTool('mcp__echosrv__echo', JSON.stringify({ text: 'hi there' }));
    assert.equal(out, 'hi there');

    // An unknown tool surfaces the server's error, not a crash.
    const bad = await mgr.callTool('mcp__echosrv__nope', '{}');
    assert.match(bad, /call failed|unknown/i);

    // A call to a server that isn't running is reported, not thrown.
    assert.match(await mgr.callTool('mcp__ghost__x', '{}'), /not running/i);
  } finally {
    mgr.dispose();
    await fsp.rm(path.dirname(file), { recursive: true, force: true });
  }
});
