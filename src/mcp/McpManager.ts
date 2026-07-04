import { spawn } from 'child_process';
import { spawnResolved } from '../util/childProcess';
import type { Logger } from '../logging/logger';
import type { ToolDefinition } from '../parley/types';
import { dbg } from '../debug/debug';
import { parseQualifiedName, providerSafeToolName, sanitizeServerName } from './naming';

/**
 * One entry of `parley.mcpServers`. Three transports:
 * - stdio (default when `command` is set): `{ command, args?, env? }`
 * - streamable HTTP (default when `url` is set): `{ url, headers? }`
 * - legacy SSE: `{ url, type: "sse", headers? }`
 * `type`/`transport` are interchangeable keys (Claude-Code-config compatible).
 */
export interface McpServerConfig {
  readonly command?: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
  readonly url?: string;
  readonly type?: 'stdio' | 'http' | 'sse';
  readonly transport?: 'stdio' | 'http' | 'sse';
  readonly headers?: Record<string, string>;
}

interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

/** A snapshot of one configured MCP server's connection outcome (for the status view). */
export interface McpServerStatus {
  readonly name: string;
  /** 'stdio' | 'http' | 'sse'. */
  readonly kind: string;
  /** The command (stdio) or URL (http/sse) it connects to. */
  readonly detail: string;
  readonly state: 'connected' | 'failed';
  readonly tools: { readonly name: string; readonly description?: string }[];
  readonly error?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type RpcMessage = { id?: number; result?: unknown; error?: { message?: string } };

/** A JSON-RPC pipe to one MCP server, independent of how the bytes travel. */
interface McpTransport {
  /** Establish the connection (spawn the process / open the SSE stream). */
  start(): Promise<void>;
  /** Send one JSON-RPC message. Rejects on transport failure so the caller can fail the pending call. */
  send(payload: Record<string, unknown>): Promise<void>;
  dispose(): void;
}

interface Server {
  transport: McpTransport;
  tools: McpTool[];
  pending: Map<number, Pending>;
  nextId: number;
}

const RPC_TIMEOUT_MS = 30000;
const SSE_ENDPOINT_TIMEOUT_MS = 10000;

/**
 * Model Context Protocol client. Supports stdio (newline-delimited JSON-RPC),
 * streamable HTTP (POST per message; JSON or SSE responses; `Mcp-Session-Id`),
 * and legacy HTTP+SSE servers. Runs the initialize handshake, lists tools, and
 * exposes them to the agent loop as `mcp__server__tool`. Fully defensive: a
 * server that fails to start/handshake is logged and skipped — chat keeps working.
 */
export class McpManager {
  private readonly servers = new Map<string, Server>();
  /** Provider-safe function name → the real `{ server, tool }` it routes to (rebuilt by `getTools`). */
  private readonly toolRoute = new Map<string, { server: string; tool: string }>();
  /** Last connection outcome per configured server — retained even after a failed
   *  server is dropped from `servers`, so the status view can show why it failed. */
  private readonly lastStatuses = new Map<string, McpServerStatus>();

  public constructor(private readonly logger: Logger) {}

  /** (Re)start all configured servers. Existing ones are disposed first. */
  public async start(configs: Record<string, McpServerConfig> | undefined): Promise<void> {
    this.dispose();
    this.lastStatuses.clear();
    if (!configs) {
      return;
    }
    for (const [rawName, cfg] of Object.entries(configs)) {
      const name = sanitizeServerName(rawName);
      if (!cfg || (typeof cfg.command !== 'string' && typeof cfg.url !== 'string')) {
        continue;
      }
      if (this.servers.has(name)) {
        // Two config keys that sanitize to the same name would silently orphan the
        // first subprocess and shadow it — keep the working server, skip the clash.
        this.logger.warn(
          `MCP: config key "${rawName}" sanitizes to "${name}", which collides with another server; skipping it.`
        );
        continue;
      }
      const kind = cfg.type ?? cfg.transport ?? (cfg.url ? 'http' : 'stdio');
      const detail = cfg.command ? [cfg.command, ...(cfg.args ?? [])].join(' ') : (cfg.url ?? '');
      try {
        await this.launch(name, cfg);
        this.lastStatuses.set(name, {
          name,
          kind,
          detail,
          state: 'connected',
          tools: (this.servers.get(name)?.tools ?? []).map((t) => ({ name: t.name, description: t.description }))
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'error';
        this.logger.warn(`MCP server "${name}" failed to start: ${message}`);
        this.servers.get(name)?.transport.dispose();
        this.servers.delete(name);
        this.lastStatuses.set(name, { name, kind, detail, state: 'failed', tools: [], error: message });
      }
    }
  }

  private async launch(name: string, cfg: McpServerConfig): Promise<void> {
    const kind = cfg.type ?? cfg.transport ?? (cfg.url ? 'http' : 'stdio');
    dbg('mcp', `launch ${name}`, { kind, command: cfg.command, url: cfg.url });

    const onMessage = (msg: RpcMessage): void => this.routeMessage(name, msg);
    let transport: McpTransport;
    if (kind === 'stdio') {
      if (!cfg.command) {
        throw new Error('stdio transport requires "command"');
      }
      transport = new StdioTransport(cfg, this.logger, name, onMessage, () => {
        this.logger.warn(`MCP "${name}" exited.`);
        // Fail in-flight calls immediately instead of stalling them into the 30s timeout.
        const server = this.servers.get(name);
        if (server) {
          for (const pending of server.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(`MCP server "${name}" exited`));
          }
          server.pending.clear();
        }
        this.servers.delete(name);
      });
    } else {
      if (!cfg.url) {
        throw new Error(`${kind} transport requires "url"`);
      }
      transport =
        kind === 'sse'
          ? new SseTransport(cfg.url, cfg.headers ?? {}, this.logger, name, onMessage)
          : new HttpTransport(cfg.url, cfg.headers ?? {}, this.logger, name, onMessage);
    }

    const server: Server = { transport, tools: [], pending: new Map(), nextId: 1 };
    this.servers.set(name, server);
    await transport.start();

    await this.rpc(name, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'parley-vscode', version: '1.0' }
    });
    this.notify(name, 'notifications/initialized', {});
    const result = (await this.rpc(name, 'tools/list', {})) as { tools?: McpTool[] };
    server.tools = Array.isArray(result?.tools) ? result.tools : [];
    this.logger.info(`MCP "${name}" (${kind}) ready: ${server.tools.length} tool(s).`);
    dbg(
      'mcp',
      `ready ${name}`,
      server.tools.map((t) => t.name)
    );
  }

  /** Match an incoming JSON-RPC message to its pending call (shared by all transports). */
  private routeMessage(name: string, msg: RpcMessage): void {
    const server = this.servers.get(name);
    if (!server) {
      return;
    }
    if (typeof msg.id === 'number' && server.pending.has(msg.id)) {
      const pending = server.pending.get(msg.id)!;
      server.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(msg.error.message ?? 'MCP error'));
      } else {
        pending.resolve(msg.result);
      }
    } else if (typeof msg.id === 'number') {
      // A response for a request we no longer track — typically one that already
      // timed out. Log it instead of dropping it silently (helps diagnose slow servers).
      this.logger.warn(
        `MCP ${name}: dropped a late/unmatched response (id ${msg.id}) — the call likely timed out earlier.`
      );
      dbg('mcp', 'late/unmatched response', { server: name, id: msg.id });
    }
  }

  private rpc(name: string, method: string, params: unknown): Promise<unknown> {
    const server = this.servers.get(name);
    if (!server) {
      return Promise.reject(new Error('MCP server is not running'));
    }
    const id = server.nextId;
    server.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        server.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, RPC_TIMEOUT_MS);
      server.pending.set(id, { resolve, reject, timer });
      server.transport.send({ jsonrpc: '2.0', id, method, params }).catch((error: unknown) => {
        if (server.pending.delete(id)) {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error('MCP transport error'));
        }
      });
    });
  }

  private notify(name: string, method: string, params: unknown): void {
    void this.servers
      .get(name)
      ?.transport.send({ jsonrpc: '2.0', method, params })
      .catch((error: unknown) =>
        this.logger.debug(`MCP ${name} notify failed: ${error instanceof Error ? error.message : 'error'}`)
      );
  }

  /**
   * MCP tools mapped to OpenAI function-tool definitions for the agent loop. All
   * tools ship to the provider in one array, so a single bad name or schema would
   * 400 the entire turn — names are sanitized to `^[a-zA-Z0-9_-]{1,64}$` (routed
   * back via `toolRoute`) and schemas are normalized to plain object schemas.
   */
  public getTools(): ToolDefinition[] {
    this.toolRoute.clear();
    const out: ToolDefinition[] = [];
    for (const [name, server] of this.servers) {
      for (const tool of server.tools) {
        if (typeof tool.name !== 'string' || tool.name.length === 0) {
          continue;
        }
        const safeName = providerSafeToolName(name, tool.name, this.toolRoute);
        this.toolRoute.set(safeName, { server: name, tool: tool.name });
        out.push({
          type: 'function',
          function: {
            name: safeName,
            description: (typeof tool.description === 'string' ? tool.description : `MCP tool ${tool.name}`).slice(
              0,
              1024
            ),
            parameters: normalizeToolParameters(tool.inputSchema)
          }
        });
      }
    }
    return out;
  }

  /** Execute an `mcp__server__tool` call and return its text content. */
  public async callTool(qualified: string, argsJson: string): Promise<string> {
    // Sanitized/truncated names aren't reversible by string-splitting, so prefer the
    // map built in getTools(). Fall back to parsing the qualified name so a validly
    // formed call to a running server still reaches it (the server rejects an unknown
    // tool) even if it wasn't in the last tools/list snapshot.
    const route = this.toolRoute.get(qualified) ?? parseQualifiedName(qualified);
    if (!route) {
      return `Error: "${qualified}" is not an MCP tool.`;
    }
    if (!this.servers.has(route.server)) {
      return `Error: MCP server "${route.server}" is not running.`;
    }
    let args: unknown = {};
    try {
      args = argsJson ? JSON.parse(argsJson) : {};
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    try {
      const result = (await this.rpc(route.server, 'tools/call', { name: route.tool, arguments: args })) as {
        content?: Array<{ type?: string; text?: string }>;
        isError?: boolean;
      };
      const content = Array.isArray(result?.content) ? result.content : [];
      const text = content
        .map((c) => (typeof c?.text === 'string' ? c.text : c?.type ? `[${c.type}]` : JSON.stringify(c)))
        .join('\n');
      return (result?.isError ? 'Error: ' : '') + (text || '(no content)');
    } catch (error) {
      return `Error: MCP call failed (${error instanceof Error ? error.message : 'unknown'}).`;
    }
  }

  /** Human-readable status, e.g. "filesystem: 6 tools". */
  public status(): string[] {
    return [...this.servers.entries()].map(([n, s]) => `${n}: ${s.tools.length} tool(s)`);
  }

  /** Per-server connection outcome from the last start() — connected servers with
   *  their tools, and failed servers with the error. Used by the MCP status view. */
  public serverStatuses(): McpServerStatus[] {
    return [...this.lastStatuses.values()];
  }

  public dispose(): void {
    for (const server of this.servers.values()) {
      for (const pending of server.pending.values()) {
        clearTimeout(pending.timer);
        // Reject (not just clear) so in-flight callTool awaiters resolve to an error
        // string instead of hanging forever across a restart/reconfigure.
        pending.reject(new Error('MCP server stopped'));
      }
      server.pending.clear();
      server.transport.dispose();
    }
    this.servers.clear();
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce a server-provided `inputSchema` into something the provider will accept:
 * non-objects (string/array/null/…) become an empty object schema, and `type` is
 * forced to `'object'` last so a bogus server value can't override it. Exported for tests.
 */
export function normalizeToolParameters(inputSchema: unknown): Record<string, unknown> {
  return isPlainObject(inputSchema) ? { ...inputSchema, type: 'object' } : { type: 'object', properties: {} };
}

// ---------- stdio transport (newline-delimited JSON-RPC over a child process) ----------

class StdioTransport implements McpTransport {
  private proc?: import('child_process').ChildProcess;
  private buffer = '';

  public constructor(
    private readonly cfg: McpServerConfig,
    private readonly logger: Logger,
    private readonly name: string,
    private readonly onMessage: (msg: RpcMessage) => void,
    private readonly onExit: () => void
  ) {}

  public start(): Promise<void> {
    // spawnResolved resolves `npx`/`uvx`/`.cmd` shims on Windows without the
    // `shell:true`+args form (DEP0190 + unescaped-arg concatenation); it quotes each
    // configured arg for the Windows command line and spawns directly on POSIX.
    const proc = spawnResolved(this.cfg.command!, this.cfg.args ?? [], {
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.proc = proc;
    proc.stdout?.on('data', (d: Buffer) => this.onData(d.toString()));
    proc.stderr?.on('data', (d: Buffer) => this.logger.debug(`[mcp:${this.name}] ${String(d).trim()}`));
    proc.on('error', (e) => this.logger.warn(`MCP "${this.name}" process error: ${e.message}`));
    proc.on('exit', () => this.onExit());
    return Promise.resolve();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) {
        continue;
      }
      try {
        this.onMessage(JSON.parse(line) as RpcMessage);
      } catch {
        // Skip unparseable lines.
      }
    }
  }

  public send(payload: Record<string, unknown>): Promise<void> {
    if (!this.proc?.stdin) {
      return Promise.reject(new Error('MCP server is not running'));
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    return Promise.resolve();
  }

  public dispose(): void {
    const proc = this.proc;
    if (!proc) {
      return;
    }
    try {
      if (process.platform === 'win32' && proc.pid) {
        // spawnResolved goes through the shell on Windows, so `proc` is the cmd.exe
        // wrapper — proc.kill() would orphan the real server. Kill the whole tree.
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
      } else {
        proc.kill();
      }
    } catch {
      // Already gone.
    }
  }
}

// ---------- streamable HTTP transport (POST per message; JSON or SSE responses) ----------

class HttpTransport implements McpTransport {
  private sessionId?: string;

  public constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly logger: Logger,
    private readonly name: string,
    private readonly onMessage: (msg: RpcMessage) => void
  ) {}

  public start(): Promise<void> {
    return Promise.resolve(); // connectionless — the first POST establishes the session
  }

  public async send(payload: Record<string, unknown>): Promise<void> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...this.headers,
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {})
      },
      body: JSON.stringify(payload)
    });
    const session = response.headers.get('mcp-session-id');
    if (session) {
      this.sessionId = session;
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(`MCP HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      await this.readSseBody(response);
      return;
    }
    if (contentType.includes('application/json')) {
      const body = (await response.json()) as RpcMessage | RpcMessage[];
      for (const msg of Array.isArray(body) ? body : [body]) {
        this.onMessage(msg);
      }
      return;
    }
    // 202 Accepted with no body (typical for notifications) — nothing to route.
  }

  private async readSseBody(response: Response): Promise<void> {
    if (!response.body) {
      return;
    }
    for await (const event of parseSseStream(response.body)) {
      try {
        this.onMessage(JSON.parse(event.data) as RpcMessage);
      } catch {
        this.logger.debug(`[mcp:${this.name}] skipped an unparseable SSE chunk`);
      }
    }
  }

  public dispose(): void {
    // Best-effort session teardown per the streamable-HTTP spec.
    if (this.sessionId) {
      void fetch(this.url, {
        method: 'DELETE',
        headers: { ...this.headers, 'Mcp-Session-Id': this.sessionId }
      }).catch(() => undefined);
    }
  }
}

// ---------- legacy HTTP+SSE transport (persistent GET stream + POST endpoint) ----------

class SseTransport implements McpTransport {
  private readonly controller = new AbortController();
  private postUrl?: string;

  public constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly logger: Logger,
    private readonly name: string,
    private readonly onMessage: (msg: RpcMessage) => void
  ) {}

  public async start(): Promise<void> {
    const response = await fetch(this.url, {
      headers: { Accept: 'text/event-stream', ...this.headers },
      signal: this.controller.signal
    });
    if (!response.ok || !response.body) {
      throw new Error(`MCP SSE connect failed (HTTP ${response.status})`);
    }
    let resolveEndpoint!: () => void;
    let rejectEndpoint!: (e: Error) => void;
    const endpointReady = new Promise<void>((resolve, reject) => {
      resolveEndpoint = resolve;
      rejectEndpoint = reject;
    });
    const timer = setTimeout(
      () => rejectEndpoint(new Error('MCP SSE server sent no endpoint event')),
      SSE_ENDPOINT_TIMEOUT_MS
    );

    // Read the stream for the lifetime of the connection (endpoint event, then responses).
    void (async () => {
      try {
        for await (const event of parseSseStream(response.body!)) {
          if (event.event === 'endpoint') {
            this.postUrl = new URL(event.data, this.url).toString();
            resolveEndpoint();
            continue;
          }
          try {
            this.onMessage(JSON.parse(event.data) as RpcMessage);
          } catch {
            this.logger.debug(`[mcp:${this.name}] skipped an unparseable SSE event`);
          }
        }
      } catch (error) {
        if (!this.controller.signal.aborted) {
          this.logger.warn(`MCP "${this.name}" SSE stream ended: ${error instanceof Error ? error.message : 'error'}`);
        }
      }
    })();

    await endpointReady.finally(() => clearTimeout(timer));
  }

  public async send(payload: Record<string, unknown>): Promise<void> {
    if (!this.postUrl) {
      throw new Error('MCP SSE endpoint not established');
    }
    const response = await fetch(this.postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw new Error(`MCP SSE POST failed (HTTP ${response.status})`);
    }
  }

  public dispose(): void {
    this.controller.abort();
  }
}

// ---------- shared SSE parsing ----------

interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/** Parse a web ReadableStream of SSE bytes into events (multi-line `data:` joined by \n). */
async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) {
            event = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            data.push(line.slice(5).trimStart());
          }
        }
        if (data.length > 0) {
          yield { event, data: data.join('\n') };
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released.
    }
  }
}
