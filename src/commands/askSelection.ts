import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';

export function registerAskSelectionCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.askSelection', async () => {
      const prompt = await vscode.window.showInputBox({
        title: 'Ask Parley About Selection',
        prompt: 'What would you like to ask about the selected code?',
        ignoreFocusOut: true
      });

      if (!prompt) {
        return;
      }

      await runPromptCommand(deps, prompt, { includeSelection: true });
    })
  );
}
