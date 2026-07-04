import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { reportProviderError } from './common';
import { getGitApi, resolveRepository, resolveBranchBase } from './generateCommitMessage';
import { runShellCommand } from '../webview/toolExecutor';

const MAX_DIFF_CHARS = 24000;
const GIT_TIMEOUT_MS = 15000;

/**
 * `Parley: Generate PR Description` — diff the branch against its merge-base with
 * main/master and write a clean, paste-ready GitHub PR description (title +
 * summary + changes + test plan). Unlike `Parley: Review Current Branch`, this
 * produces ONLY the description (no code review): it opens in an untitled markdown
 * doc and is copied to the clipboard.
 */
export function registerGeneratePrDescriptionCommand(
  context: vscode.ExtensionContext,
  deps: CommandDependencies
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.generatePrDescription', async () => {
      const api = await getGitApi();
      if (!api) {
        return;
      }
      if (api.repositories.length === 0) {
        await vscode.window.showWarningMessage('Parley: no Git repository found in this workspace.');
        return;
      }
      const repo = await resolveRepository(api.repositories, 'Select the repository to describe a PR for');
      if (!repo) {
        return;
      }
      const root = repo.rootUri.fsPath;
      const git = (cmd: string): Promise<string> => runShellCommand(`git --no-pager ${cmd}`, root, GIT_TIMEOUT_MS);

      const info = await resolveBranchBase(git);
      if (!info) {
        return;
      }
      const { branch, head, base, mergeBase } = info;
      if (mergeBase === head) {
        await vscode.window.showInformationMessage(
          `Parley: "${branch}" has no commits beyond ${base} — nothing to describe. (Uncommitted changes? Commit them first.)`
        );
        return;
      }

      const log = (await git(`log --oneline ${mergeBase}..HEAD`)).trim();
      const stat = (await git(`diff --stat ${mergeBase} HEAD`)).trim();
      const diff = (await git(`diff ${mergeBase} HEAD`)).trim();
      if (!diff) {
        await vscode.window.showInformationMessage(`Parley: no file changes between ${base} and "${branch}".`);
        return;
      }
      const capped =
        diff.length > MAX_DIFF_CHARS
          ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated — see the stat above for full scope]`
          : diff;

      const prompt =
        `Write a pull-request description for the branch "${branch}" (vs ${base}). ` +
        'Output GitHub-flavored markdown ONLY — no preamble and no surrounding code fence. Use exactly this structure:\n' +
        '- First line: "# <concise PR title>" in the imperative mood, ≤72 chars.\n' +
        '- "## Summary" — what changed and why, 2–5 sentences.\n' +
        '- "## Changes" — a bullet list of the notable changes.\n' +
        '- "## Test plan" — how to verify it, as a `- [ ]` checklist.\n' +
        'Base it on the real diff; do not invent changes that are not there.\n\n' +
        `Commits:\n${log}\n\nChanged files:\n${stat}\n\nDiff:\n\`\`\`diff\n${capped}\n\`\`\``;

      try {
        const text = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Parley: writing PR description…',
            cancellable: false
          },
          async () => {
            const resp = await deps.getProvider().sendMessage({
              prompt,
              messages: [{ role: 'user', content: prompt, createdAt: new Date().toISOString() }],
              context: [],
              agentId: deps.getSettings().defaultAgent
            });
            return resp.message.content
              .trim()
              .replace(/^```[a-z]*\n?|\n?```$/g, '')
              .trim();
          }
        );
        if (!text) {
          await vscode.window.showWarningMessage('Parley: the model returned an empty PR description.');
          return;
        }
        await vscode.env.clipboard.writeText(text);
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: text });
        await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
        void vscode.window.showInformationMessage(
          `Parley wrote a PR description for "${branch}" — copied to the clipboard, ready to paste into GitHub.`
        );
      } catch (error) {
        await reportProviderError(deps, error);
      }
    })
  );
}
