import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';
import { runShellCommand } from '../webview/toolExecutor';

const MAX_AUDIT_CHARS = 24000;

/**
 * `Parley: Audit Dependencies` — run the package manager's audit (npm / pnpm / yarn,
 * auto-detected from the lockfile) and stream a plain-English explanation with a
 * remediation plan into the chat. `npm audit` reads the lockfile and queries the
 * registry; it does not execute the project's own scripts.
 */
export function registerAuditDependenciesCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.auditDependencies', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        await vscode.window.showInformationMessage('Parley: open a workspace folder to audit dependencies.');
        return;
      }
      const root = folder.uri.fsPath;
      const has = (f: string): boolean => {
        try {
          return fs.existsSync(path.join(root, f));
        } catch {
          return false;
        }
      };
      if (!has('package.json')) {
        await vscode.window.showInformationMessage('Parley: no package.json here (npm/pnpm/yarn audit only).');
        return;
      }
      const cmd = has('pnpm-lock.yaml')
        ? 'pnpm audit --json'
        : has('yarn.lock')
          ? 'yarn npm audit --json'
          : 'npm audit --json';

      const raw = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Parley: running ${cmd}…`, cancellable: true },
        (_p, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          return runShellCommand(cmd, root, 90000, controller.signal);
        }
      );
      const capped = raw.length > MAX_AUDIT_CHARS ? `${raw.slice(0, MAX_AUDIT_CHARS)}\n[truncated]` : raw;
      const prompt =
        `Explain this dependency audit in plain English. Group findings by severity (critical → low); for each, say ` +
        `which package and version is affected, why it matters in practice, and the recommended fix. Call out any ` +
        `fix that is a breaking major bump. End with the exact command(s) to remediate.\n\n` +
        `Audit output (${cmd}):\n\`\`\`json\n${capped}\n\`\`\``;
      await runPromptCommand(deps, prompt, {});
    })
  );
}
