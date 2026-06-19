import * as vscode from 'vscode';
import type { CommandDependencies } from './common';

export function registerSetApiKeyCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.setApiKey', async () => {
      const existing = await deps.auth.getToken();
      const key = await vscode.window.showInputBox({
        title: 'Parley: Set API Key',
        prompt: 'Paste your Parley API key (created at parley.mit.edu → Settings → API Keys).',
        placeHolder: 'sk-parley-v1-…',
        value: existing ?? '',
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => {
          const trimmed = value.trim();
          if (trimmed.length === 0) {
            return 'API key cannot be empty.';
          }
          if (!trimmed.startsWith('sk-')) {
            return 'Parley API keys start with "sk-". Double-check you copied the whole key.';
          }
          return undefined;
        }
      });

      if (key === undefined) {
        return;
      }

      await deps.auth.setToken(key.trim());
      deps.logger.info('Parley API key stored in SecretStorage.');

      // Verify the key against the live endpoint so the user gets immediate feedback.
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Verifying Parley API key…' },
        async () => {
          try {
            const agents = await deps.getProvider().listAgents();
            await vscode.window.showInformationMessage(
              `Parley API key saved and verified. ${agents.length} model(s) available.`
            );
          } catch (error) {
            deps.logger.warn(error instanceof Error ? error.message : 'Could not verify Parley API key.');
            await vscode.window.showWarningMessage(
              `Parley API key saved, but verification failed: ${
                error instanceof Error ? error.message : 'unknown error'
              }`
            );
          }
        }
      );
    })
  );
}
