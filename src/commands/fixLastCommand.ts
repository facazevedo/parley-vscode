import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';
import { lastFailedCommand, onCommandFailed } from '../context/terminalLog';

const HINT_TIMEOUT_MS = 30000;

/**
 * `Parley: Fix Last Terminal Command` — send the most recent failed terminal
 * command (captured via shell integration) with its output into the chat for a
 * diagnosis/fix. When a command exits non-zero, a transient status-bar hint
 * appears for 30s as a one-click entry point (toggle: parley.terminalFixHint.enabled).
 * The terminal twin of the diagnostics lightbulb.
 */
export function registerFixLastCommandCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.fixLastCommand', async () => {
      const failure = lastFailedCommand();
      if (!failure) {
        await vscode.window.showInformationMessage(
          'Parley: no failed terminal command captured yet (requires shell integration).'
        );
        return;
      }
      const output = failure.output.trim() || '(no output captured)';
      const prompt =
        `A terminal command just failed — diagnose it and fix the underlying problem (edit files if the cause is in the code; suggest the corrected command if the command itself was wrong).\n\n` +
        `Command (terminal "${failure.terminal}", exit code ${failure.exitCode}):\n\`\`\`\n${failure.command}\n\`\`\`\n\n` +
        `Output:\n\`\`\`\n${output}\n\`\`\``;
      await runPromptCommand(deps, prompt, {});
    })
  );

  // Transient status-bar hint on failure.
  const hint = vscode.window.createStatusBarItem('parley.fixHint', vscode.StatusBarAlignment.Right, 99);
  hint.name = 'Parley fix hint';
  hint.text = '$(warning) Fix with Parley';
  hint.command = 'parley.fixLastCommand';
  hint.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  context.subscriptions.push(hint);
  let hideTimer: NodeJS.Timeout | undefined;
  onCommandFailed((failure) => {
    if (!deps.getSettings().terminalFixHintEnabled) {
      return;
    }
    hint.tooltip = `"${failure.command.slice(0, 80)}" exited with code ${failure.exitCode} — click to fix it with Parley.`;
    hint.show();
    if (hideTimer) {
      clearTimeout(hideTimer);
    }
    hideTimer = setTimeout(() => hint.hide(), HINT_TIMEOUT_MS);
  });
}
