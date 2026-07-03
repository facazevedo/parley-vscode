/**
 * Tool-name mapping for MCP. An MCP server's tools are exposed to the model as
 * `mcp__<server>__<tool>` so they don't collide with the built-in agent tools or
 * with each other. Pure + unit-tested.
 */
import { createHash } from 'crypto';

const PREFIX = 'mcp__';
const SEP = '__';
/** Providers require function names to match `^[a-zA-Z0-9_-]{1,64}$`. */
const MAX_NAME_LENGTH = 64;

/** Sanitize a user-chosen server name so it can't break the `mcp__server__tool` scheme. */
export function sanitizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-]/g, '-');
}

export function qualifyToolName(server: string, tool: string): string {
  return `${PREFIX}${sanitizeServerName(server)}${SEP}${tool}`;
}

/**
 * Build a provider-safe function name (`^[a-zA-Z0-9_-]{1,64}$`) for an MCP tool.
 * Servers may advertise names with spaces/dots or arbitrary length; forwarding those
 * verbatim makes the provider reject the whole request. Invalid characters become
 * `-`; over-long names are truncated with a deterministic 6-hex-char hash of the
 * original tool name so they stay unique; `taken` collisions get a numeric suffix.
 */
export function providerSafeToolName(server: string, tool: string, taken: { has(name: string): boolean }): string {
  const safeTool = tool.replace(/[^a-zA-Z0-9_-]/g, '-');
  let name = `${PREFIX}${sanitizeServerName(server)}${SEP}${safeTool}`;
  if (name.length > MAX_NAME_LENGTH) {
    const suffix = `-${createHash('sha1').update(tool).digest('hex').slice(0, 6)}`;
    name = name.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
  }
  let candidate = name;
  for (let n = 2; taken.has(candidate); n += 1) {
    const suffix = `-${n}`;
    candidate = name.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
  }
  return candidate;
}

export function isMcpTool(name: string): boolean {
  return name.startsWith(PREFIX);
}

/** Split a qualified name back into `{ server, tool }`, or `undefined` if it isn't an MCP tool. */
export function parseQualifiedName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith(PREFIX)) {
    return undefined;
  }
  const rest = name.slice(PREFIX.length);
  const idx = rest.indexOf(SEP);
  if (idx <= 0 || idx + SEP.length >= rest.length) {
    return undefined;
  }
  return { server: rest.slice(0, idx), tool: rest.slice(idx + SEP.length) };
}
