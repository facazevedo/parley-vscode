import * as vscode from 'vscode';

const TEMPLATE = `# Project rules for AI assistants

These instructions are sent to Parley with every request in this workspace
(Parley reads AGENTS.md, .parleyrules, or .cursorrules).

## Project
- What this project is, the key directories, and how to build/run/test it.

## Conventions
- Code style, naming, and the libraries to prefer or avoid.

## Do / Don't
- Anything the assistant should always or never do.
`;

const CANDIDATES = ['AGENTS.md', '.parleyrules', '.cursorrules'];

/**
 * `Parley: Init Project Rules` — create an AGENTS.md template at the workspace
 * root (or open the existing rules file). Parley includes it in every request.
 */
export function registerInitProjectRulesCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.initProjectRules', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        await vscode.window.showWarningMessage('Parley: open a folder first to create a project rules file.');
        return;
      }

      for (const name of CANDIDATES) {
        const uri = vscode.Uri.joinPath(folder.uri, name);
        try {
          await vscode.workspace.fs.stat(uri);
          const existing = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(existing);
          void vscode.window.showInformationMessage(`Parley already uses ${name} for project rules.`);
          return;
        } catch {
          // Not present; keep looking.
        }
      }

      const target = vscode.Uri.joinPath(folder.uri, 'AGENTS.md');
      await vscode.workspace.fs.writeFile(target, Buffer.from(TEMPLATE, 'utf8'));
      const doc = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(doc);
      void vscode.window.showInformationMessage('Parley created AGENTS.md — it will be included in every request.');
    })
  );
}
