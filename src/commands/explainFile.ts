import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';

export function registerExplainFileCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.explainFile', async () => {
      // Explain the selection when there is one, otherwise the whole file.
      const editor = vscode.window.activeTextEditor;
      const hasSelection = !!editor && !editor.selection.isEmpty;
      if (hasSelection) {
        await runPromptCommand(
          deps,
          'Explain the selected code. Focus on intent, behavior, edge cases, and how it fits the surrounding file.',
          { includeSelection: true, includeCurrentFile: true }
        );
        return;
      }
      await runPromptCommand(deps, 'Explain the current file. Focus on intent, structure, risks, and important APIs.', {
        includeCurrentFile: true
      });
    })
  );
}
