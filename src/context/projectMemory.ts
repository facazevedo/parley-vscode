import * as vscode from 'vscode';

/**
 * Agent-maintained project memory: durable, non-obvious facts the agent learns
 * while working ("tests need FOO=1", "deploys run from scripts/ship.ps1"),
 * appended via the `remember` tool to `.parley/memory.md` in the first workspace
 * root and injected into the system prompt each turn (like project rules). The
 * user reviews/prunes it with `Parley: Open Project Memory`.
 */

export const MEMORY_HEADER =
  '# Parley project memory\n\nFacts Parley has learned about this project (via the `remember` tool). Edit or delete lines freely — this file is yours.\n';
/** Injection cap, matching the per-source cap used for project rules. */
export const MAX_MEMORY_CHARS = 8000;
/** Hard cap on stored entries; oldest are dropped first. */
export const MAX_MEMORY_ENTRIES = 200;

/**
 * Append a fact to the memory file's content (pure). Returns the new content,
 * or undefined when there is nothing to add (blank fact or duplicate).
 */
export function appendFact(existing: string, fact: string): string | undefined {
  const cleaned = fact.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return undefined;
  }
  const body = existing.trim() ? existing : MEMORY_HEADER;
  const lines = body.split(/\r?\n/);
  const entry = `- ${cleaned}`;
  if (lines.some((l) => l.trim().toLowerCase() === entry.toLowerCase())) {
    return undefined; // exact duplicate
  }
  const header = lines.filter((l) => !l.startsWith('- '));
  const entries = lines.filter((l) => l.startsWith('- '));
  entries.push(entry);
  while (entries.length > MAX_MEMORY_ENTRIES) {
    entries.shift(); // oldest first out
  }
  return `${header.join('\n').trimEnd()}\n\n${entries.join('\n')}\n`;
}

export function memoryUri(): vscode.Uri | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  return root ? vscode.Uri.joinPath(root, '.parley', 'memory.md') : undefined;
}

/** The memory file's content for system-prompt injection ('' when absent), capped. */
export async function loadProjectMemory(): Promise<string> {
  const uri = memoryUri();
  if (!uri) {
    return '';
  }
  try {
    const raw = Buffer.from(await vscode.workspace.fs.readFile(uri))
      .toString('utf8')
      .trim();
    return raw.slice(0, MAX_MEMORY_CHARS);
  } catch {
    return '';
  }
}

/** Append a fact to the memory file on disk. */
export async function rememberFact(fact: string): Promise<'added' | 'duplicate' | 'no-workspace' | 'error'> {
  const uri = memoryUri();
  if (!uri) {
    return 'no-workspace';
  }
  let existing = '';
  try {
    existing = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    // First fact — file doesn't exist yet.
  }
  const updated = appendFact(existing, fact);
  if (updated === undefined) {
    return fact.trim() ? 'duplicate' : 'error';
  }
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
    return 'added';
  } catch {
    return 'error';
  }
}
