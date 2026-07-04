import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';
import { detectTestCommand, runTestCommand } from '../testing/testRunner';

/**
 * `Parley: Fix Failing Tests` — run the project's test command once; if it fails,
 * hand the failure output to the agent with instructions to fix the root cause and
 * re-run via the run_tests tool until green. In an agentic mode (Agent/Full) this
 * becomes a closed run → fix → re-run loop.
 */
export function registerFixFailingTestsCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.fixFailingTests', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        await vscode.window.showInformationMessage('Parley: open a workspace folder to run tests.');
        return;
      }
      const root = folder.uri.fsPath;
      const settings = deps.getSettings();
      let command = detectTestCommand(root, settings.testCommand || settings.verifyCommand);
      if (!command) {
        const entered = await vscode.window.showInputBox({
          title: 'Parley: Fix Failing Tests',
          prompt: 'No test command detected — enter the command to run.',
          value: 'npm test',
          ignoreFocusOut: true
        });
        if (!entered?.trim()) {
          return;
        }
        command = entered.trim();
      }
      const cmd = command;

      const run = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Parley: running ${cmd}…`, cancellable: true },
        async (_progress, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          return runTestCommand(cmd, root, deps.getSettings().commandTimeoutSeconds * 1000, controller.signal);
        }
      );

      if (run.aborted) {
        return;
      }
      if (run.exitCode === 0 && !run.timedOut) {
        void vscode.window.showInformationMessage(`Parley: "${cmd}" already passes — nothing to fix. ✅`);
        return;
      }

      const tail = run.output.length > 12000 ? `…(truncated)…\n${run.output.slice(-12000)}` : run.output;
      const status = run.timedOut ? 'timed out' : `failing (exit ${run.exitCode})`;
      const prompt =
        `The test command \`${cmd}\` is ${status}. Diagnose and fix the underlying issue with the smallest safe change, ` +
        'then re-run the tests with the run_tests tool and keep iterating until they pass. If a test itself is wrong, ' +
        'fix the test and say so explicitly — do not weaken or delete tests just to make them green.\n\n' +
        `Test output:\n\`\`\`\n${tail || '(no output)'}\n\`\`\``;
      await runPromptCommand(deps, prompt, {});
    })
  );
}
