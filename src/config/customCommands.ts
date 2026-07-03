import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseFrontmatter } from './outputStyles';

/**
 * User-defined slash commands: a `name.md` file becomes `/name` whose body is the
 * prompt. Optional `description:` frontmatter is shown in the composer's slash
 * menu. `$ARGS` expands to anything typed after the command; `$SELECTION` expands
 * to the active editor's selected text. Commands are discovered in the first
 * workspace root's `.parley/commands` and `.claude/commands`, then the global
 * `~/.parley/commands` and `~/.claude/commands` — first hit wins on a name
 * collision, so workspace commands shadow global ones.
 */

export interface CustomCommand {
  readonly name: string;
  /** From `description:` frontmatter; empty string when absent. */
  readonly description: string;
  /** The exact file this command was discovered in (re-read at run time). */
  readonly uri: vscode.Uri;
}

/** Expand a command body: `$SELECTION` first (so args containing the literal
 *  `$SELECTION` are not double-expanded), then the `$ARGS` convention. */
export function expandCommandBody(body: string, args: string, selection: string): string {
  const withSelection = body.replace(/\$SELECTION/g, selection);
  if (/\$ARGS/.test(withSelection)) {
    return withSelection.replace(/\$ARGS/g, args);
  }
  return args ? `${withSelection}\n\n${args}` : withSelection;
}

/** The directories scanned for `*.md` commands, in priority order (first wins). */
export function customCommandDirs(): vscode.Uri[] {
  const dirs: vscode.Uri[] = [];
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (root) {
    dirs.push(vscode.Uri.joinPath(root, '.parley', 'commands'), vscode.Uri.joinPath(root, '.claude', 'commands'));
  }
  const home = os.homedir();
  if (home) {
    dirs.push(
      vscode.Uri.file(path.join(home, '.parley', 'commands')),
      vscode.Uri.file(path.join(home, '.claude', 'commands'))
    );
  }
  return dirs;
}

/** Discover all custom commands (name, menu description, source file), sorted by name. */
export async function scanCustomCommands(): Promise<CustomCommand[]> {
  const byName = new Map<string, CustomCommand>();
  for (const dir of customCommandDirs()) {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      continue; // directory absent — fine
    }
    for (const [file, type] of entries) {
      if (type !== vscode.FileType.File || !file.toLowerCase().endsWith('.md')) {
        continue;
      }
      const name = file.slice(0, -3);
      if (byName.has(name)) {
        continue; // earlier (higher-priority) directory wins
      }
      const uri = vscode.Uri.joinPath(dir, file);
      let description = '';
      try {
        const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        description = parseFrontmatter(raw).description;
      } catch {
        continue; // unreadable file — skip
      }
      byName.set(name, { name, description, uri });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
