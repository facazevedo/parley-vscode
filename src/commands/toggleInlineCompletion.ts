import * as vscode from 'vscode';

export function registerToggleInlineCompletionCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.toggleInlineCompletion', async () => {
      const config = vscode.workspace.getConfiguration('parley.inlineCompletion');
      const enabled = config.get<boolean>('enabled', true);
      await config.update('enabled', !enabled, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(`Parley inline completion ${enabled ? 'disabled' : 'enabled'}.`);
    })
  );
}
