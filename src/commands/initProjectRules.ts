import * as vscode from 'vscode';

const TEMPLATE = `# Project rules for AI assistants

These instructions are sent to Parley with every request in this workspace
(Parley reads AGENTS.md, .parleyrules, .cursorrules, or CLAUDE.md).

## Project
- What this project is, the key directories, and how to build/run/test it.

## Conventions
- Code style, naming, and the libraries to prefer or avoid.

## Do / Don't
- Anything the assistant should always or never do.
`;

const CANDIDATES = ['AGENTS.md', '.parleyrules', '.cursorrules', 'CLAUDE.md'];

/** The workspace's existing rules file, if any (AGENTS.md / .parleyrules / .cursorrules / CLAUDE.md). */
export async function findExistingRulesFile(): Promise<vscode.Uri | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  for (const name of CANDIDATES) {
    const uri = vscode.Uri.joinPath(folder.uri, name);
    try {
      await vscode.workspace.fs.stat(uri);
      return uri;
    } catch {
      // Not present; keep looking.
    }
  }
  return undefined;
}

/** Write the static AGENTS.md template and open it (the non-agent fallback). */
export async function writeRulesTemplate(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return;
  }
  const target = vscode.Uri.joinPath(folder.uri, 'AGENTS.md');
  await vscode.workspace.fs.writeFile(target, Buffer.from(TEMPLATE, 'utf8'));
  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc);
  void vscode.window.showInformationMessage('Parley created AGENTS.md — it will be included in every request.');
}

/**
 * `Parley: Init Project Rules` — delegates to the chat panel's startInit(): in an
 * agent mode the agent ANALYZES the repository and writes a tailored AGENTS.md;
 * otherwise (or when a rules file already exists) it falls back to opening /
 * templating, preserving the old behavior.
 */
export function registerInitProjectRulesCommand(
  context: vscode.ExtensionContext,
  startInit: () => Promise<void>
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.initProjectRules', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        await vscode.window.showWarningMessage('Parley: open a folder first to create a project rules file.');
        return;
      }
      await startInit();
    })
  );
}
