import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { reportProviderError } from './common';
import { runShellCommand } from '../webview/toolExecutor';

const MAX_LOG_CHARS = 20000;
const GIT_TIMEOUT_MS = 15000;

/**
 * `Parley: Generate Release Notes` — draft grouped release notes / CHANGELOG entries from the
 * commits since the last tag (or all commits if untagged), and open them in a markdown doc.
 */
export function registerReleaseNotesCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.releaseNotes', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        await vscode.window.showInformationMessage('Parley: open a git repository to generate release notes.');
        return;
      }
      const root = folder.uri.fsPath;
      const git = (cmd: string): Promise<string> => runShellCommand(`git --no-pager ${cmd}`, root, GIT_TIMEOUT_MS);

      let lastTag = (await git('describe --tags --abbrev=0')).trim();
      if (!/^[^\s]+$/.test(lastTag) || /fatal|error|no names|no tags/i.test(lastTag)) {
        lastTag = '';
      }
      const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
      const log = (await git(`log ${range} --no-merges --oneline`)).trim();
      if (!log || /fatal|not a git repository/i.test(log)) {
        await vscode.window.showInformationMessage(
          lastTag ? `Parley: no commits since ${lastTag}.` : 'Parley: no commits found (is this a git repository?).'
        );
        return;
      }
      const capped = log.length > MAX_LOG_CHARS ? `${log.slice(0, MAX_LOG_CHARS)}\n[truncated]` : log;
      const prompt =
        `Draft release notes from these git commit subjects${lastTag ? ` since \`${lastTag}\`` : ''}. ` +
        'Group them under `### Features`, `### Fixes`, `### Docs`, and `### Chore` (omit empty groups); each a concise, ' +
        'user-facing bullet — merge duplicates and drop noise (wip, formatting, merge commits). At the top, suggest the ' +
        'next semantic version bump (major/minor/patch) with a one-line rationale. Output GitHub-flavored markdown only, no preamble.\n\n' +
        `Commits:\n${capped}`;
      try {
        const text = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Parley: drafting release notes…',
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
          await vscode.window.showWarningMessage('Parley: the model returned empty release notes.');
          return;
        }
        await vscode.env.clipboard.writeText(text);
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: text });
        await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
        void vscode.window.showInformationMessage(
          `Parley drafted release notes${lastTag ? ` since ${lastTag}` : ''} — copied to the clipboard.`
        );
      } catch (error) {
        await reportProviderError(deps, error);
      }
    })
  );
}
