import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';

export function registerExplainFileCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.explainFile', async () => {
      await runPromptCommand(deps, 'Explain the current file. Focus on intent, structure, risks, and important APIs.', {
        includeCurrentFile: true
      });
    })
  );
}
