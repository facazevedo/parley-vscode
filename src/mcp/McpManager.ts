import { spawn, type ChildProcess } from 'child_process';
import type { Logger } from '../logging/logger';
import type { ToolDefinition } from '../parley/types';
import { dbg } from '../debug/debug';
import { parseQualifiedName, qualifyToolName, sanitizeServerName } from './naming';

export interface McpServerConfig {
  readonly command: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
}

interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Server {
  proc: ChildProcess;
  tools: McpTool[];
  pending: Map<number, Pending>;
  nextId: number;
  buffer: string;
}

const RPC_TIMEOUT_MS = 30000;

/**
 * Minimal Model Context Protocol client over stdio (newline-delimited JSON-RPC).
 * Spawns each configured server, runs the initialize handshake, lists its tools,
 * and exposes them to the agent loop as `mcp__server__tool`. Fully defensive: a
 * server that fails to start/handshake is logged and skipped — chat keeps working.
 */
export class McpManager {
  private readonly servers = new Map<string, Server>();

  public constructor(private readonly logger: Logger) {}

  /** (Re)start all configured servers. Existing ones are disposed first. */
  public async start(configs: Record<string, McpServerConfig> | undefined): Promise<void> {
    this.dispose();
    if (!configs) {
      return;
    }
    for (const [rawName, cfg] of Object.entries(configs)) {
      const name = sanitizeServerName(rawName);
      if (!cfg || typeof cfg.command !== 'string' || !cfg.command) {
        continue;
      }
      try {
        await this.launch(name, cfg);
      } catch (error) {
        this.logger.warn(`MCP server "${name}" failed to start: ${error instanceof Error ? error.message : 'error'}`);
        this.servers.delete(name);
      }
    }
  }

  private async launch(name: string, cfg: McpServerConfig): Promise<void> {
    dbg('mcp', `launch ${name}`, { command: cfg.command, args: cfg.args });
    const proc = spawn(cfg.command, cfg.args ?? [], {
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // so `npx`/`uvx` resolve on Windows
      windowsHide: true
    });
    const server: Server = { proc, tools: [], pending: new Map(), nextId: 1, buffer: '' };
    this.servers.set(name, server);

    proc.stdout?.on('data', (d: Buffer) => this.onData(name, d.toString()));
    proc.stderr?.on('data', (d: Buffer) => this.logger.debug(`[mcp:${name}] ${String(d).trim()}`));
    proc.on('error', (e) => this.logger.warn(`MCP "${name}" process error: ${e.message}`));
    proc.on('exit', (code) => {
      this.logger.warn(`MCP "${name}" exited (code ${code}).`);
      this.servers.delete(name);
    });

    await this.rpc(name, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'parley-vscode', version: '1.0' }
    });
    this.notify(name, 'notifications/initialized', {});
    const result = (await this.rpc(name, 'tools/list', {})) as { tools?: McpTool[] };
    server.tools = Array.isArray(result?.tools) ? result.tools : [];
    this.logger.info(`MCP "${name}" ready: ${server.tools.length} tool(s).`);
    dbg(
      'mcp',
      `ready ${name}`,
      server.tools.map((t) => t.name)
    );
  }

  private onData(name: string, chunk: string): void {
    const server = this.servers.get(name);
    if (!server) {
      return;
    }
    server.buffer += chunk;
    let nl: number;
    while ((nl = server.buffer.indexOf('\n')) !== -1) {
      const line = server.buffer.slice(0, nl).trim();
      server.buffer = server.buffer.slice(nl + 1);
      if (!line) {
        continue;
      }
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
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
  }

  private rpc(name: string, method: string, params: unknown): Promise<unknown> {
    const server = this.servers.get(name);
    if (!server || !server.proc.stdin) {
      return Promise.reject(new Error('MCP server is not running'));
    }
    const id = server.nextId;
    server.nextId += 1;
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        server.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, RPC_TIMEOUT_MS);
      server.pending.set(id, { resolve, reject, timer });
      server.proc.stdin!.write(payload);
    });
  }

  private notify(name: string, method: string, params: unknown): void {
    const server = this.servers.get(name);
    server?.proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /** MCP tools mapped to OpenAI function-tool definitions for the agent loop. */
  public getTools(): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const [name, server] of this.servers) {
      for (const tool of server.tools) {
        out.push({
          type: 'function',
          function: {
            name: qualifyToolName(name, tool.name),
            description: (tool.description ?? `MCP tool ${tool.name}`).slice(0, 1024),
            parameters: tool.inputSchema ?? { type: 'object', properties: {} }
          }
        });
      }
    }
    return out;
  }

  /** Execute an `mcp__server__tool` call and return its text content. */
  public async callTool(qualified: string, argsJson: string): Promise<string> {
    const parsed = parseQualifiedName(qualified);
    if (!parsed) {
      return `Error: "${qualified}" is not an MCP tool.`;
    }
    if (!this.servers.has(parsed.server)) {
      return `Error: MCP server "${parsed.server}" is not running.`;
    }
    let args: unknown = {};
    try {
      args = argsJson ? JSON.parse(argsJson) : {};
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    try {
      const result = (await this.rpc(parsed.server, 'tools/call', { name: parsed.tool, arguments: args })) as {
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

  public dispose(): void {
    for (const server of this.servers.values()) {
      for (const pending of server.pending.values()) {
        clearTimeout(pending.timer);
      }
      try {
        server.proc.kill();
      } catch {
        // Already gone.
      }
    }
    this.servers.clear();
  }
}
