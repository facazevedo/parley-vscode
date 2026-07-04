import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';
import { detectTestCommand, runTestCommand } from '../testing/testRunner';

const MAX_COVERAGE_CHARS = 16000;

/** Best-effort coverage command: an explicit override wins, else derive from the detected
 *  test command (append the runner's coverage flag). Returns undefined if none detected. */
function coverageCommandFor(root: string, override: string): string | undefined {
  if (override.trim()) {
    return override.trim();
  }
  const base = detectTestCommand(root);
  if (!base) {
    return undefined;
  }
  if (base === 'npm test') {
    return 'npm test -- --coverage';
  }
  if (base.startsWith('pytest')) {
    return 'pytest --cov --cov-report=term-missing';
  }
  if (base.startsWith('go test')) {
    return 'go test -cover ./...';
  }
  return base; // best effort — may already include coverage, or the user can set parley.coverageCommand
}

/**
 * `Parley: Generate Tests for Uncovered Code` — run the test suite with coverage, then feed
 * the coverage report plus the current file to the agent so it writes tests aimed at the
 * lines/branches that aren't covered yet. Runs the project's test command, so it requires a
 * trusted workspace.
 */
export function registerCoverageTestsCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.coverageTests', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        await vscode.window.showInformationMessage('Parley: open a workspace folder to measure coverage.');
        return;
      }
      if (!vscode.workspace.isTrusted) {
        await vscode.window.showWarningMessage(
          'Parley: coverage runs the project test command (workspace-controlled) — trust this workspace first.'
        );
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') {
        await vscode.window.showInformationMessage('Parley: open the source file you want covered, then run this.');
        return;
      }
      const root = folder.uri.fsPath;
      const override = vscode.workspace.getConfiguration('parley').get<string>('coverageCommand', '') ?? '';
      let cmd = coverageCommandFor(root, override);
      if (!cmd) {
        const entered = await vscode.window.showInputBox({
          title: 'Parley: Generate Tests for Uncovered Code',
          prompt: 'No coverage command detected — enter one (or set parley.coverageCommand).',
          value: 'npm test -- --coverage',
          ignoreFocusOut: true
        });
        if (!entered?.trim()) {
          return;
        }
        cmd = entered.trim();
      }
      const run = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Parley: measuring coverage (${cmd})…`,
          cancellable: true
        },
        (_p, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          return runTestCommand(
            cmd as string,
            root,
            deps.getSettings().commandTimeoutSeconds * 1000,
            controller.signal
          );
        }
      );
      if (run.aborted) {
        return;
      }
      const report =
        run.output.length > MAX_COVERAGE_CHARS ? `…\n${run.output.slice(-MAX_COVERAGE_CHARS)}` : run.output;
      const rel = vscode.workspace.asRelativePath(editor.document.uri);
      const prompt =
        `Here is the project's test-coverage report (command: \`${cmd}\`):\n\n\`\`\`\n${report || '(no output)'}\n\`\`\`\n\n` +
        `Write focused tests for the currently-UNCOVERED lines and branches of \`${rel}\` (the current file). ` +
        'State which lines/paths each new test covers, put them in the appropriate test file (create a sibling test file if none exists), ' +
        'and return the changes as a reviewable edit. Do not restate already-covered code.';
      await runPromptCommand(deps, prompt, { includeCurrentFile: true });
    })
  );
}
