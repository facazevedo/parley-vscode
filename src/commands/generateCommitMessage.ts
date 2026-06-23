import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { reportProviderError } from './common';

const MAX_DIFF_CHARS = 12000;

interface GitRepo {
  diff(cached?: boolean): Promise<string>;
  readonly inputBox: { value: string };
}
interface GitApi {
  readonly repositories: GitRepo[];
}

/**
 * `Parley: Generate Commit Message` — summarize the staged diff (or the working
 * tree if nothing is staged) into a Conventional Commits message and drop it into
 * the Source Control input box, like Cursor/Copilot.
 */
export function registerGenerateCommitMessageCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.generateCommitMessage', async () => {
      const gitExt = vscode.extensions.getExtension('vscode.git');
      if (!gitExt) {
        await vscode.window.showWarningMessage('Parley: the built-in Git extension is not available.');
        return;
      }
      const api: GitApi = (await gitExt.activate()).getAPI(1);
      const repo = api.repositories[0];
      if (!repo) {
        await vscode.window.showWarningMessage('Parley: no Git repository found in this workspace.');
        return;
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
        await vscode.window.showWarningMessage(`Parley: could not read the git diff (${error instanceof Error ? error.message : 'unknown'}).`);
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
            return resp.message.content.trim().replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
          }
        );
        if (!text) {
          await vscode.window.showWarningMessage('Parley: the model returned an empty commit message.');
          return;
        }
        repo.inputBox.value = text;
        await vscode.commands.executeCommand('workbench.view.scm');
        void vscode.window.showInformationMessage(`Parley wrote a commit message from your ${scope} changes — review it in Source Control.`);
      } catch (error) {
        await reportProviderError(deps, error);
      }
    })
  );
}
