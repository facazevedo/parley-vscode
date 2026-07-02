import * as vscode from 'vscode';

/**
 * Output styles: a user-selectable communication style prepended to the system
 * prompt (Claude-Code-style). Built-ins ship in code; custom styles are read from
 * `.parley/output-styles/*.md` in each workspace root (filename = id, optional
 * `description:` frontmatter, body = the style instruction). The pure parts
 * (built-ins + resolver) are unit-tested; the directory loader needs vscode.
 */

export interface OutputStyle {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Instruction prepended to the system prompt; empty string for the default (no override). */
  readonly prompt: string;
}

export const BUILT_IN_OUTPUT_STYLES: readonly OutputStyle[] = [
  {
    id: 'default',
    label: 'Default',
    description: "Parley's standard voice — concise and technical, no imposed persona.",
    prompt: ''
  },
  {
    id: 'concise',
    label: 'Concise',
    description: 'Minimal prose; lead with the answer or the code.',
    prompt:
      'Output style — Concise: answer in the fewest words that stay clear. Lead with the result or the code; skip preamble, restatement, and closing summaries unless asked. Prefer short sentences and tight bullets over paragraphs.'
  },
  {
    id: 'explanatory',
    label: 'Explanatory',
    description: 'Explain the reasoning and trade-offs behind the work.',
    prompt:
      'Output style — Explanatory: briefly explain the WHY behind non-obvious choices — the trade-offs weighed, why this approach over alternatives, and any gotchas worth knowing. Keep it proportional; do not pad simple answers.'
  },
  {
    id: 'learning',
    label: 'Learning',
    description: 'Teach as you go; invite the user to try small pieces.',
    prompt:
      'Output style — Learning: treat the user as a capable engineer learning this codebase. Explain concepts as they arise and point out patterns worth knowing. Where a small piece is a good exercise, mark it clearly (e.g. "you try: …") rather than doing everything silently — but still deliver a working result.'
  }
];

/** The style instruction for the selected id (empty string if unknown or default). */
export function resolveStylePrompt(styles: readonly OutputStyle[], id: string | undefined): string {
  return styles.find((s) => s.id === (id && id.trim() ? id : 'default'))?.prompt ?? '';
}

/** Extract an optional `description:` and the body from simple `---` frontmatter. */
function parseStyleFile(raw: string): { description: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) {
    return { description: '', body: raw };
  }
  const desc = /(^|\n)description:\s*(.+)/i.exec(match[1]);
  return { description: desc ? desc[2].trim().replace(/^["']|["']$/g, '') : '', body: raw.slice(match[0].length) };
}

/** Built-in styles plus any `.parley/output-styles/*.md` in the workspace (custom overrides built-in by id). */
export async function loadOutputStyles(): Promise<OutputStyle[]> {
  const styles: OutputStyle[] = [...BUILT_IN_OUTPUT_STYLES];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const dir = vscode.Uri.joinPath(folder.uri, '.parley', 'output-styles');
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      continue; // no custom styles in this root
    }
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.toLowerCase().endsWith('.md')) {
        continue;
      }
      try {
        const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name))).toString('utf8');
        const { description, body } = parseStyleFile(raw);
        if (!body.trim()) {
          continue;
        }
        const id = name.replace(/\.md$/i, '');
        const style: OutputStyle = {
          id,
          label: id,
          description: description || 'Custom output style.',
          prompt: body.trim()
        };
        const existing = styles.findIndex((s) => s.id === id);
        if (existing >= 0) {
          styles[existing] = style;
        } else {
          styles.push(style);
        }
      } catch {
        // Skip unreadable file.
      }
    }
  }
  return styles;
}
