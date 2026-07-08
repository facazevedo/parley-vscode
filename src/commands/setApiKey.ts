import * as vscode from 'vscode';
import type { CommandDependencies } from './common';

const VERIFY_API_KEY_TIMEOUT_MS = 15_000;

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
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Verifying Parley API key…' },
        async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), VERIFY_API_KEY_TIMEOUT_MS);
          try {
            const agents = await deps.getProvider().listAgents(controller.signal);
            return { ok: true as const, agents: agents.length };
          } catch (error) {
            const message = verificationErrorMessage(error);
            deps.logger.warn(message);
            return { ok: false as const, message };
          } finally {
            clearTimeout(timeout);
          }
        }
      );

      if (result.ok) {
        await vscode.window.showInformationMessage(
          `Parley API key saved and verified. ${result.agents} model(s) available.`
        );
      } else {
        await vscode.window.showWarningMessage(`Parley API key saved, but verification failed: ${result.message}`);
      }
    })
  );
}

function verificationErrorMessage(error: unknown): string {
  if ((error as { name?: string })?.name === 'AbortError') {
    return `verification timed out after ${VERIFY_API_KEY_TIMEOUT_MS / 1000}s. Check your network or VPN, then try the model picker or run "Parley: Set API Key" again.`;
  }
  return error instanceof Error ? error.message : 'unknown error';
}
