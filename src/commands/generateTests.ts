import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';

export function registerGenerateTestsCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.generateTests', async () => {
      await runPromptCommand(deps, 'Generate focused tests for the selected code or current file. Explain the test strategy before proposing edits.', {
        includeSelection: true,
        includeCurrentFile: true
      });
    })
  );
}
