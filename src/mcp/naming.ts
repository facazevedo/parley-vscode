/**
 * Tool-name mapping for MCP. An MCP server's tools are exposed to the model as
 * `mcp__<server>__<tool>` so they don't collide with the built-in agent tools or
 * with each other. Pure + unit-tested.
 */
const PREFIX = 'mcp__';
const SEP = '__';

/** Sanitize a user-chosen server name so it can't break the `mcp__server__tool` scheme. */
export function sanitizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-]/g, '-');
}

export function qualifyToolName(server: string, tool: string): string {
  return `${PREFIX}${sanitizeServerName(server)}${SEP}${tool}`;
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
