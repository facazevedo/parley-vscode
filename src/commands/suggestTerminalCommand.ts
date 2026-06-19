import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { handleResponse, sendPrompt } from './common';

export function registerSuggestTerminalCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.suggestTerminalCommand', async () => {
      const prompt = await vscode.window.showInputBox({
        title: 'Parley: Suggest Terminal Command',
        prompt: 'Describe the task. Parley may suggest a command, but it will not be executed automatically.',
        ignoreFocusOut: true
      });

      if (!prompt) {
        return;
      }

      const response = await sendPrompt(deps, `Suggest terminal command only after explaining risk: ${prompt}`, []);
      if (response) {
        await handleResponse(deps, response);
      }
    })
  );
}
