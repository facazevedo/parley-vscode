import * as vscode from 'vscode';
import { parseFrontmatter } from './outputStyles';

/** Same cap as output styles / project rules. */
const MAX_PROMPT_CHARS = 8000;

/**
 * Custom subagent types: a `name.md` under `.parley/agents/` defines an agent
 * the model can delegate investigations to via `run_subagent`'s optional
 * `agent` parameter. Frontmatter `description:` is what the model sees when
 * choosing; optional `model:` overrides the model the subagent runs on; the
 * body is appended to the invariant read-only subagent preamble (it can shape
 * focus and reporting style, but never grants write access).
 */

export interface SubagentType {
  /** Filename sans .md — the value the model passes as `agent`. */
  readonly id: string;
  readonly description: string;
  /** Extra system prompt appended to the built-in subagent preamble. */
  readonly prompt: string;
  /** Optional model (agent id) override for this subagent. */
  readonly model?: string;
}

/** Build a subagent type from a file's id + raw contents (pure). Undefined if the body is empty. */
export function subagentFromFile(id: string, raw: string): SubagentType | undefined {
  const { description, body, frontmatter } = parseFrontmatter(raw);
  const trimmed = body.trim();
  if (!trimmed) {
    return undefined;
  }
  const model = /(^|\n)model:\s*(.+)/i.exec(frontmatter);
  return {
    id,
    description: description || 'Custom subagent.',
    prompt: trimmed.slice(0, MAX_PROMPT_CHARS),
    model: model ? model[2].trim().replace(/^["']|["']$/g, '') : undefined
  };
}

/** All `.parley/agents/*.md` across workspace roots (later roots override by id). */
export async function loadSubagentTypes(): Promise<SubagentType[]> {
  const types: SubagentType[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const dir = vscode.Uri.joinPath(folder.uri, '.parley', 'agents');
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      continue; // no custom agents in this root
    }
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.toLowerCase().endsWith('.md')) {
        continue;
      }
      try {
        const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name))).toString('utf8');
        const agent = subagentFromFile(name.replace(/\.md$/i, ''), raw);
        if (!agent) {
          continue;
        }
        const existing = types.findIndex((t) => t.id === agent.id);
        if (existing >= 0) {
          types[existing] = agent;
        } else {
          types.push(agent);
        }
      } catch {
        // Skip unreadable file.
      }
    }
  }
  return types.sort((a, b) => a.id.localeCompare(b.id));
}
