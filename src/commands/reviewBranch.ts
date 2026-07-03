import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';
import { getGitApi, resolveRepository } from './generateCommitMessage';
import { runShellCommand } from '../webview/toolExecutor';

const MAX_DIFF_CHARS = 30000;
const GIT_TIMEOUT_MS = 15000;
/** Base refs tried in order when finding what the branch forked from. */
const BASE_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master', 'origin/HEAD'];

function looksLikeSha(s: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(s.trim());
}

/**
 * `Parley: Review Current Branch` — diff the branch against its merge-base with
 * main/master, and stream a code review plus a PR title/description into the chat.
 * Complements the `@git` mention (uncommitted changes) with committed branch work.
 */
export function registerReviewBranchCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.reviewBranch', async () => {
      const api = await getGitApi();
      if (!api) {
        return;
      }
      if (api.repositories.length === 0) {
        await vscode.window.showWarningMessage('Parley: no Git repository found in this workspace.');
        return;
      }
      const repo = await resolveRepository(api.repositories, 'Select the repository whose branch to review');
      if (!repo) {
        return;
      }
      const root = repo.rootUri.fsPath;
      const git = (cmd: string): Promise<string> => runShellCommand(`git --no-pager ${cmd}`, root, GIT_TIMEOUT_MS);

      const branch = (await git('rev-parse --abbrev-ref HEAD')).trim();
      const head = (await git('rev-parse HEAD')).trim();
      if (!looksLikeSha(head)) {
        await vscode.window.showWarningMessage('Parley: could not resolve HEAD — is this a git repository?');
        return;
      }

      // Find the merge-base with the first base candidate that exists and is not
      // simply HEAD itself (i.e. the branch actually diverges from it).
      let base: string | undefined;
      let mergeBase: string | undefined;
      for (const candidate of BASE_CANDIDATES) {
        if (candidate === branch || candidate.endsWith(`/${branch}`)) {
          continue; // don't review a branch against itself
        }
        const mb = (await git(`merge-base HEAD "${candidate}"`)).trim();
        if (looksLikeSha(mb)) {
          base = candidate;
          mergeBase = mb;
          if (mb !== head) {
            break; // proper divergence found — take it
          }
        }
      }
      if (!base || !mergeBase) {
        await vscode.window.showWarningMessage(
          'Parley: could not find a base branch (tried origin/main, origin/master, main, master).'
        );
        return;
      }
      if (mergeBase === head) {
        await vscode.window.showInformationMessage(
          `Parley: "${branch}" has no commits beyond ${base} — nothing to review. (Uncommitted changes? Use the @git mention.)`
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
      const truncated = diff.length > MAX_DIFF_CHARS;
      const capped = truncated
        ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated — see the stat above for full scope]`
        : diff;

      const prompt =
        `Review the branch "${branch}" (vs its merge-base with ${base}).\n\n` +
        `First a CODE REVIEW: correctness bugs, risky edge cases, security issues, and worthwhile simplifications — grouped by severity, each with a \`file:line\` reference and a one-line why. Say clearly if the changes look good; do not invent nitpicks.\n\n` +
        `Then a PR DESCRIPTION: a "## PR" section with a concise title line and a markdown body (what & why, notable decisions, test notes) ready to paste into GitHub.\n\n` +
        `Commits:\n${log}\n\nChanged files:\n${stat}\n\nDiff:\n\`\`\`diff\n${capped}\n\`\`\``;

      await runPromptCommand(deps, prompt, {});
    })
  );

  // Review what's about to be committed — one click from the Source Control view.
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.reviewStagedChanges', async () => {
      const api = await getGitApi();
      if (!api) {
        return;
      }
      if (api.repositories.length === 0) {
        await vscode.window.showWarningMessage('Parley: no Git repository found in this workspace.');
        return;
      }
      const repo = await resolveRepository(api.repositories, 'Select the repository whose staged changes to review');
      if (!repo) {
        return;
      }
      let diff = '';
      let scope = 'staged';
      try {
        diff = await repo.diff(true);
        if (!diff.trim()) {
          diff = await repo.diff(false);
          scope = 'working-tree (nothing staged)';
        }
      } catch (error) {
        await vscode.window.showWarningMessage(
          `Parley: could not read the git diff (${error instanceof Error ? error.message : 'unknown'}).`
        );
        return;
      }
      if (!diff.trim()) {
        await vscode.window.showInformationMessage(
          'Parley: no changes to review — the working tree is clean. For committed branch work, use "Parley: Review Current Branch".'
        );
        return;
      }
      const truncated = diff.length > MAX_DIFF_CHARS;
      const capped = truncated ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]` : diff;
      const prompt =
        `Review these ${scope} changes BEFORE they are committed.\n\n` +
        `Report correctness bugs, risky edge cases, security issues, leftover debug code, and anything that would embarrass this commit — grouped by severity, each with a \`file:line\` reference and a one-line why. Say clearly if it looks good to commit; do not invent nitpicks.\n\n` +
        `Finish with a one-line Conventional Commits message suggestion for it.\n\n` +
        `Diff:\n\`\`\`diff\n${capped}\n\`\`\``;
      await runPromptCommand(deps, prompt, {});
    })
  );
}
