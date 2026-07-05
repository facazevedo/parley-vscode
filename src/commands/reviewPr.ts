import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';
import { runShellCommand } from '../webview/toolExecutor';

const MAX_DIFF_CHARS = 30000;

/**
 * `Parley: Review a Pull Request` — fetch a GitHub PR's diff via `gh pr diff <n>` and run a
 * full code review on it. Complements `Review Current Branch` (which only reviews your own
 * local branch) by reviewing any PR by number.
 */
export function registerReviewPrCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.reviewPr', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        await vscode.window.showInformationMessage('Parley: open the repository to review a PR.');
        return;
      }
      const ghVersion = await runShellCommand('gh --version', root.fsPath, 10000);
      if (!/gh version/i.test(ghVersion)) {
        const action = await vscode.window.showWarningMessage(
          'Parley: GitHub CLI (gh) not found. Install it and run "gh auth login" to review PRs.',
          'Get gh'
        );
        if (action === 'Get gh') {
          void vscode.env.openExternal(vscode.Uri.parse('https://cli.github.com/'));
        }
        return;
      }
      const n = (
        await vscode.window.showInputBox({
          title: 'Parley: Review a Pull Request',
          prompt: 'PR number to review',
          placeHolder: 'e.g. 123',
          ignoreFocusOut: true
        })
      )?.trim();
      if (!n) {
        return;
      }
      if (!/^\d+$/.test(n)) {
        await vscode.window.showWarningMessage('Parley: enter a PR number (digits only).');
        return;
      }
      const { meta, diff } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Parley: fetching PR #${n}…` },
        async () => ({
          meta: (await runShellCommand(`gh pr view ${n}`, root.fsPath, 20000)).trim(),
          diff: (await runShellCommand(`gh pr diff ${n}`, root.fsPath, 30000)).trim()
        })
      );
      if (!diff || /no pull requests|not found|could not resolve|failed/i.test(meta)) {
        await vscode.window.showWarningMessage(
          `Parley: could not fetch PR #${n} (is the number right, and gh authed?).`
        );
        return;
      }
      const capped = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]` : diff;
      const prompt =
        `Review GitHub pull request #${n}. Report correctness bugs, risky edge cases, security issues, and worthwhile ` +
        'simplifications — grouped by severity, each with a `file:line` reference and a one-line why. Say clearly if it ' +
        'looks good; do not invent nitpicks. End with an overall recommendation (approve / request changes / comment).\n\n' +
        `PR:\n${meta}\n\nDiff:\n\`\`\`diff\n${capped}\n\`\`\``;
      await runPromptCommand(deps, prompt, {});
    })
  );
}
