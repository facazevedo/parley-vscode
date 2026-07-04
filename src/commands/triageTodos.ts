import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';
import { runShellCommand } from '../webview/toolExecutor';

interface TodoItem extends vscode.QuickPickItem {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * `Parley: Triage TODOs` — scan the workspace for TODO/FIXME/HACK/XXX markers, list them
 * in a picker, and hand the chosen one to the agent to implement or justify.
 */
export function registerTriageTodosCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.triageTodos', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        await vscode.window.showInformationMessage('Parley: open a workspace folder to scan for TODOs.');
        return;
      }
      const root = folder.uri.fsPath;
      const raw = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Parley: scanning for TODO / FIXME…' },
        // git grep is fast and respects .gitignore; -I skips binaries, -n adds line numbers.
        () => runShellCommand('git --no-pager grep -nI -E "\\b(TODO|FIXME|HACK|XXX)\\b"', root, 20000)
      );
      const items: TodoItem[] = raw
        .split('\n')
        .map((l) => /^(.+?):(\d+):(.*)$/.exec(l.trim()))
        .filter((m): m is RegExpExecArray => !!m)
        .slice(0, 300)
        .map((m) => {
          const text = m[3].trim();
          return {
            label: text.slice(0, 90) || '(marker)',
            description: `${m[1]}:${m[2]}`,
            file: m[1],
            line: Number(m[2]),
            text
          };
        });
      if (items.length === 0) {
        await vscode.window.showInformationMessage('Parley: no TODO/FIXME/HACK/XXX markers found (git repo required).');
        return;
      }
      const pick = await vscode.window.showQuickPick(items, {
        title: `Parley: ${items.length} TODO/FIXME marker(s)`,
        placeHolder: 'Pick one to tackle',
        matchOnDescription: true
      });
      if (!pick) {
        return;
      }
      // Open the file at the marker so it (and the selected line) become the chat context.
      try {
        const uri = vscode.Uri.file(path.join(root, pick.file));
        const editor = await vscode.window.showTextDocument(uri);
        const pos = new vscode.Position(Math.max(0, pick.line - 1), 0);
        editor.selection = new vscode.Selection(pos, editor.document.lineAt(pos.line).range.end);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      } catch {
        // best-effort — still send the prompt below
      }
      const prompt =
        `Address this code marker at \`${pick.description}\`:\n\n> ${pick.text}\n\n` +
        'Investigate the surrounding code, then either implement what it asks (as a reviewable edit) or explain clearly why it should stay. ' +
        'Remove or update the marker comment if you resolve it.';
      await runPromptCommand(deps, prompt, { includeSelection: true, includeCurrentFile: true });
    })
  );
}
