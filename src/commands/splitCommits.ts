import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';
import { runShellCommand } from '../webview/toolExecutor';

const MAX_DIFF_CHARS = 28000;

/**
 * `Parley: Split Into Logical Commits` — analyze the uncommitted diff and propose grouping it
 * into several clean, self-contained commits (with messages). Advisory: it proposes the plan;
 * you do the staging.
 */
export function registerSplitCommitsCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.splitCommits', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        await vscode.window.showInformationMessage('Parley: open a git repository to plan commits.');
        return;
      }
      let diff = await runShellCommand('git --no-pager diff HEAD', root.fsPath, 15000);
      let scope = 'uncommitted';
      if (!diff.trim() || diff === '(no output)') {
        diff = await runShellCommand('git --no-pager diff --cached', root.fsPath, 15000);
        scope = 'staged';
      }
      if (!diff.trim() || diff === '(no output)' || /not a git repository/i.test(diff)) {
        await vscode.window.showInformationMessage('Parley: no uncommitted changes to split.');
        return;
      }
      const stat = (await runShellCommand('git --no-pager diff HEAD --stat', root.fsPath, 15000)).trim();
      const capped = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]` : diff;
      const prompt =
        `Propose how to split these ${scope} changes into several logical, self-contained commits. ` +
        'For each commit: a Conventional Commits message, the files (and which hunks, if a file is split across commits) ' +
        'it should include, and one line on why it stands alone. Order them so each commit builds on the previous. ' +
        'Do NOT run git or actually commit — just give me the plan I can follow (and the `git add` commands if helpful).\n\n' +
        `Changed files:\n${stat}\n\nDiff:\n\`\`\`diff\n${capped}\n\`\`\``;
      await runPromptCommand(deps, prompt, {});
    })
  );
}
