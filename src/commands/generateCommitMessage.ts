import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { reportProviderError } from './common';

const MAX_DIFF_CHARS = 12000;

export interface GitRepo {
  readonly rootUri: vscode.Uri;
  diff(cached?: boolean): Promise<string>;
  readonly inputBox: { value: string };
}
export interface GitApi {
  readonly repositories: GitRepo[];
}

/** The built-in Git extension's API, or undefined (with a warning shown) when unavailable. */
export async function getGitApi(): Promise<GitApi | undefined> {
  const gitExt = vscode.extensions.getExtension('vscode.git');
  if (!gitExt) {
    await vscode.window.showWarningMessage('Parley: the built-in Git extension is not available.');
    return undefined;
  }
  return (await gitExt.activate()).getAPI(1) as GitApi;
}

/** True when `uri` lives inside the repository's root folder (fsPath prefix compare). */
function repoContains(repo: GitRepo, uri: vscode.Uri): boolean {
  const root = repo.rootUri.fsPath.replace(/[\\/]+$/, '');
  const file = uri.fsPath;
  return file === root || file.startsWith(`${root}\\`) || file.startsWith(`${root}/`);
}

/**
 * Resolve which repository the command should act on. With several repos open,
 * prefer the one containing the active editor's file; otherwise (or when that is
 * ambiguous, e.g. nested repos) ask the user. Returns undefined when the user
 * dismisses the picker.
 */
export async function resolveRepository(
  repositories: readonly GitRepo[],
  placeHolder = 'Select the repository to generate a commit message for'
): Promise<GitRepo | undefined> {
  if (repositories.length === 1) {
    return repositories[0];
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const containing = repositories.filter((repo) => repoContains(repo, active));
    if (containing.length === 1) {
      return containing[0];
    }
  }
  const picked = await vscode.window.showQuickPick(
    repositories.map((repo) => ({
      label: path.basename(repo.rootUri.fsPath),
      description: repo.rootUri.fsPath,
      repo
    })),
    { placeHolder }
  );
  return picked?.repo;
}

/** Base refs tried in order when finding what the branch forked from. */
const BASE_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master', 'origin/HEAD'];

export function looksLikeSha(s: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(s.trim());
}

export interface BranchBase {
  readonly branch: string;
  readonly head: string;
  readonly base: string;
  readonly mergeBase: string;
}

/**
 * Resolve the current branch name, HEAD sha, and the merge-base with the first
 * base candidate (origin/main, main, …) it can find — preferring one the branch
 * actually diverges from. `mergeBase === head` means the branch has no commits
 * beyond its base (callers should handle that). Returns undefined (with a warning
 * shown) when HEAD or a base cannot be resolved. `git` runs `git --no-pager <cmd>`.
 */
export async function resolveBranchBase(git: (cmd: string) => Promise<string>): Promise<BranchBase | undefined> {
  const branch = (await git('rev-parse --abbrev-ref HEAD')).trim();
  const head = (await git('rev-parse HEAD')).trim();
  if (!looksLikeSha(head)) {
    await vscode.window.showWarningMessage('Parley: could not resolve HEAD — is this a git repository?');
    return undefined;
  }
  let base: string | undefined;
  let mergeBase: string | undefined;
  for (const candidate of BASE_CANDIDATES) {
    if (candidate === branch || candidate.endsWith(`/${branch}`)) {
      continue; // don't compare a branch against itself
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
    return undefined;
  }
  return { branch, head, base, mergeBase };
}

/**
 * `Parley: Generate Commit Message` — summarize the staged diff (or the working
 * tree if nothing is staged) into a Conventional Commits message and drop it into
 * the Source Control input box, like Cursor/Copilot.
 */
export function registerGenerateCommitMessageCommand(
  context: vscode.ExtensionContext,
  deps: CommandDependencies
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.generateCommitMessage', async () => {
      const api = await getGitApi();
      if (!api) {
        return;
      }
      if (api.repositories.length === 0) {
        await vscode.window.showWarningMessage('Parley: no Git repository found in this workspace.');
        return;
      }
      const repo = await resolveRepository(api.repositories);
      if (!repo) {
        return; // user dismissed the repository picker
      }

      let diff = '';
      let scope = 'staged';
      try {
        diff = await repo.diff(true);
        if (!diff.trim()) {
          diff = await repo.diff(false);
          scope = 'working-tree';
        }
      } catch (error) {
        await vscode.window.showWarningMessage(
          `Parley: could not read the git diff (${error instanceof Error ? error.message : 'unknown'}).`
        );
        return;
      }
      if (!diff.trim()) {
        await vscode.window.showInformationMessage('Parley: no changes to summarize (stage some changes first).');
        return;
      }

      const capped = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]` : diff;
      const prompt =
        'Write a commit message in the Conventional Commits style for the diff below. Output ONLY the message — a concise subject line (≤72 chars, e.g. "fix(api): handle null token"), then, if useful, a blank line and a few short body bullet points. No code fences, no preamble.\n\n' +
        capped;

      try {
        const text = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.SourceControl, title: 'Parley: generating commit message…' },
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
          await vscode.window.showWarningMessage('Parley: the model returned an empty commit message.');
          return;
        }
        repo.inputBox.value = text;
        await vscode.commands.executeCommand('workbench.view.scm');
        void vscode.window.showInformationMessage(
          `Parley wrote a commit message from your ${scope} changes — review it in Source Control.`
        );
      } catch (error) {
        await reportProviderError(deps, error);
      }
    })
  );
}
