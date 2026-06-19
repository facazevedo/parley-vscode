import * as vscode from 'vscode';
import type { CommandDependencies } from './common';

export function registerSignOutCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.signOut', async () => {
      await deps.getProvider().signOut();
      await vscode.window.showInformationMessage('Parley authentication material cleared.');
    })
  );
}
