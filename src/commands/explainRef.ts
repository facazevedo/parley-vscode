import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';
import { runShellCommand } from '../webview/toolExecutor';

const MAX_DIFF_CHARS = 26000;
const GIT_TIMEOUT_MS = 15000;
// Typical git ref syntax only — blocks shell metacharacters since refs go into the command.
const REF_RE = /^[\w./~^@{}-]+$/;

/**
 * `Parley: Explain Commit / Compare Refs` — explain what a specific commit does, or summarize
 * the differences between two branches/refs.
 */
export function registerExplainRefCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.explainRef', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        await vscode.window.showInformationMessage('Parley: open a git repository first.');
        return;
      }
      const git = (cmd: string): Promise<string> =>
        runShellCommand(`git --no-pager ${cmd}`, root.fsPath, GIT_TIMEOUT_MS);

      const mode = await vscode.window.showQuickPick(
        [
          { label: 'Explain a commit', id: 'commit' as const, detail: 'What a commit changes and why' },
          {
            label: 'Compare two refs / branches',
            id: 'compare' as const,
            detail: 'Summarize the diff between two refs'
          }
        ],
        { title: 'Parley: Explain Commit / Compare Refs' }
      );
      if (!mode) {
        return;
      }

      const cap = (s: string): string =>
        s.length > MAX_DIFF_CHARS ? `${s.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]` : s;

      if (mode.id === 'commit') {
        const ref = (
          await vscode.window.showInputBox({
            title: 'Explain a commit',
            prompt: 'Commit hash or ref',
            value: 'HEAD',
            ignoreFocusOut: true
          })
        )?.trim();
        if (!ref) {
          return;
        }
        if (!REF_RE.test(ref)) {
          await vscode.window.showWarningMessage('Parley: that does not look like a valid git ref.');
          return;
        }
        const meta = (await git(`show -s --format=%H%n%an%n%ad%n%s%n%b ${ref}`)).trim();
        const stat = (await git(`show --stat --oneline ${ref}`)).trim();
        const diff = (await git(`show --format= ${ref}`)).trim();
        if (/fatal|unknown revision/i.test(meta)) {
          await vscode.window.showWarningMessage(`Parley: could not resolve "${ref}".`);
          return;
        }
        const prompt =
          `Explain this git commit: what it changes, why (intent), and any risk or follow-up worth noting.\n\n` +
          `Commit:\n${meta}\n\nStat:\n${stat}\n\nDiff:\n\`\`\`diff\n${cap(diff)}\n\`\`\``;
        await runPromptCommand(deps, prompt, {});
        return;
      }

      const base = (
        await vscode.window.showInputBox({ title: 'Compare — base ref', value: 'main', ignoreFocusOut: true })
      )?.trim();
      if (!base) {
        return;
      }
      const head = (
        await vscode.window.showInputBox({ title: 'Compare — head ref', value: 'HEAD', ignoreFocusOut: true })
      )?.trim();
      if (!head) {
        return;
      }
      if (!REF_RE.test(base) || !REF_RE.test(head)) {
        await vscode.window.showWarningMessage('Parley: one of those does not look like a valid git ref.');
        return;
      }
      const stat = (await git(`diff --stat ${base}..${head}`)).trim();
      const diff = (await git(`diff ${base}..${head}`)).trim();
      if (!diff || /fatal|unknown revision/i.test(stat)) {
        await vscode.window.showInformationMessage(`Parley: no differences (or bad refs) between ${base} and ${head}.`);
        return;
      }
      const prompt =
        `Summarize the differences between \`${base}\` and \`${head}\`: what changed, grouped by theme, and anything ` +
        `noteworthy or risky.\n\nStat:\n${stat}\n\nDiff:\n\`\`\`diff\n${cap(diff)}\n\`\`\``;
      await runPromptCommand(deps, prompt, {});
    })
  );
}
