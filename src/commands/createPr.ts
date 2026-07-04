import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { reportProviderError } from './common';
import { getGitApi, resolveRepository, resolveBranchBase } from './generateCommitMessage';
import { runShellCommand } from '../webview/toolExecutor';

const MAX_DIFF_CHARS = 24000;
const GIT_TIMEOUT_MS = 15000;
const NET_TIMEOUT_MS = 60000;

/**
 * `Parley: Create Pull Request` — generate a PR description from the branch diff, confirm,
 * push the branch, and open the PR via the GitHub CLI (`gh`). Outward-facing, so it always
 * confirms before creating.
 */
export function registerCreatePrCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.createPr', async () => {
      const api = await getGitApi();
      if (!api) {
        return;
      }
      if (api.repositories.length === 0) {
        await vscode.window.showWarningMessage('Parley: no Git repository found in this workspace.');
        return;
      }
      const repo = await resolveRepository(api.repositories, 'Select the repository to open a PR for');
      if (!repo) {
        return;
      }
      const root = repo.rootUri.fsPath;
      const git = (cmd: string): Promise<string> => runShellCommand(`git --no-pager ${cmd}`, root, GIT_TIMEOUT_MS);

      const ghVersion = await runShellCommand('gh --version', root, 10000);
      if (!/gh version/i.test(ghVersion)) {
        const action = await vscode.window.showWarningMessage(
          'Parley: GitHub CLI (gh) not found. Install it and run "gh auth login" to create PRs.',
          'Get gh'
        );
        if (action === 'Get gh') {
          void vscode.env.openExternal(vscode.Uri.parse('https://cli.github.com/'));
        }
        return;
      }

      const info = await resolveBranchBase(git);
      if (!info) {
        return;
      }
      const { branch, head, base, mergeBase } = info;
      if (!/^[\w./-]+$/.test(branch)) {
        await vscode.window.showWarningMessage(`Parley: branch name "${branch}" has unsupported characters.`);
        return;
      }
      if (branch === 'main' || branch === 'master') {
        await vscode.window.showWarningMessage(
          'Parley: create a feature branch before opening a PR (you are on the base branch).'
        );
        return;
      }
      if (mergeBase === head) {
        await vscode.window.showInformationMessage(
          `Parley: "${branch}" has no commits beyond ${base} — nothing to open a PR for.`
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
      const capped = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]` : diff;
      const prompt =
        `Write a pull-request description for the branch "${branch}" (vs ${base}). ` +
        'Output GitHub-flavored markdown ONLY — first line "# <concise imperative title, ≤72 chars>", then "## Summary", ' +
        '"## Changes" (bullets), and "## Test plan" (`- [ ]` checklist). Base it on the real diff.\n\n' +
        `Commits:\n${log}\n\nChanged files:\n${stat}\n\nDiff:\n\`\`\`diff\n${capped}\n\`\`\``;

      let text: string;
      try {
        text = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Parley: writing PR description…' },
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
      } catch (error) {
        await reportProviderError(deps, error);
        return;
      }
      if (!text) {
        await vscode.window.showWarningMessage('Parley: the model returned an empty PR description.');
        return;
      }

      // Split the "# title" off the top; the rest is the body.
      const lines = text.split('\n');
      const h1 = lines.findIndex((l) => /^#\s+/.test(l));
      const rawTitle = h1 !== -1 ? lines[h1].replace(/^#\s+/, '') : branch;
      // Sanitize the title so it can't break shell quoting (it's passed on the command line).
      const title =
        rawTitle
          .replace(/["`$\\]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120) || branch;
      const body = (h1 !== -1 ? lines.slice(h1 + 1) : lines).join('\n').trim();
      const baseBranch = base.replace(/^origin\//, '');

      const answer = await vscode.window.showInformationMessage(
        `Create a GitHub PR from "${branch}" into "${baseBranch}"?\n\nTitle: ${title}`,
        { modal: true },
        'Create PR',
        'Cancel'
      );
      if (answer !== 'Create PR') {
        return;
      }

      const tmp = path.join(os.tmpdir(), `parley-pr-${process.pid}-${head.slice(0, 8)}.md`);
      try {
        fs.writeFileSync(tmp, body, 'utf8');
        const out = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Parley: pushing "${branch}" and opening the PR…` },
          async () => {
            await runShellCommand(`git push -u origin "${branch}"`, root, NET_TIMEOUT_MS);
            return runShellCommand(
              `gh pr create --base "${baseBranch}" --head "${branch}" --title "${title}" --body-file "${tmp}"`,
              root,
              NET_TIMEOUT_MS
            );
          }
        );
        const url = /https?:\/\/\S+/.exec(out)?.[0];
        if (url) {
          const act = await vscode.window.showInformationMessage(`Parley opened the PR: ${url}`, 'Open');
          if (act === 'Open') {
            void vscode.env.openExternal(vscode.Uri.parse(url));
          }
        } else {
          await vscode.window.showWarningMessage(`Parley: gh did not return a PR URL — ${out.slice(0, 300)}`);
        }
      } catch (error) {
        await vscode.window.showErrorMessage(
          `Parley: could not create the PR (${error instanceof Error ? error.message : 'unknown'}).`
        );
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
    })
  );
}
