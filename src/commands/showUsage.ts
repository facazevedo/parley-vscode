import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { reportProviderError } from './common';
import { formatUsd } from '../parley/pricing';

/**
 * `Parley: Show Usage` — fetch the account's real billed usage for the current
 * month from `GET /v1/accounts/{accountId}/usage`. The account id isn't derivable
 * from the API key, so it's read from `parley.accountId` (prompted and saved on
 * first use). This is the authoritative spend, complementing the in-chat estimate.
 */
export function registerShowUsageCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.showUsage', async () => {
      const config = vscode.workspace.getConfiguration('parley');
      let accountId = config.get<string>('accountId', '').trim();

      if (!accountId) {
        const entered = await vscode.window.showInputBox({
          title: 'Parley: Show Usage',
          prompt: 'Enter your Parley account id (find it in the Parley Admin Portal under "My Account").',
          placeHolder: 'acc_…',
          ignoreFocusOut: true
        });
        accountId = entered?.trim() ?? '';
        if (!accountId) {
          return;
        }
        await config.update('accountId', accountId, vscode.ConfigurationTarget.Global);
      }

      try {
        const usage = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Fetching Parley usage…' },
          () => deps.getProvider().getUsage(accountId)
        );

        const period =
          usage.periodStart && usage.periodEnd
            ? ` (${usage.periodStart.slice(0, 10)} → ${usage.periodEnd.slice(0, 10)})`
            : '';
        const summary =
          `Parley usage${period}: ${formatUsd(usage.costUsd)} · ` +
          `${usage.interactionsCount.toLocaleString()} requests · ` +
          `${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out tokens`;

        const choice = await vscode.window.showInformationMessage(summary, 'Change account id');
        if (choice === 'Change account id') {
          await config.update('accountId', '', vscode.ConfigurationTarget.Global);
          await vscode.commands.executeCommand('parley.showUsage');
        }
      } catch (error) {
        await reportProviderError(deps, error);
      }
    })
  );
}
