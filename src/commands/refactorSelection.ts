import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';

export function registerRefactorSelectionCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.refactorSelection', async () => {
      await runPromptCommand(deps, 'Refactor the selected code while preserving behavior. Return any proposed code changes as a reviewable patch.', {
        includeSelection: true
      });
    })
  );
}
