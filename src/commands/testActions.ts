import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';

interface TestItemLike {
  readonly uri?: vscode.Uri;
  readonly label?: string;
  readonly range?: vscode.Range;
}

/**
 * `Parley: Fix / Explain Test` — added to the Test Explorer item context menu. Opens the test's
 * file and hands it to the agent to run, diagnose, and fix (or explain). Degrades to the active
 * editor when invoked without a test item.
 */
export function registerTestActionsCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.fixTestItem', async (item?: TestItemLike) => {
      if (item?.uri) {
        try {
          const doc = await vscode.workspace.openTextDocument(item.uri);
          const editor = await vscode.window.showTextDocument(doc);
          if (item.range) {
            editor.selection = new vscode.Selection(item.range.start, item.range.start);
            editor.revealRange(item.range, vscode.TextEditorRevealType.InCenter);
          }
        } catch {
          // fall back to the active editor
        }
      }
      if (!vscode.window.activeTextEditor) {
        await vscode.window.showInformationMessage('Parley: open the test file (or run this from the Test Explorer).');
        return;
      }
      const which = item?.label ? `the test "${item.label}"` : 'the test at the cursor';
      const prompt =
        `${which} needs attention. Run the suite with the run_tests tool, read the failure output for this test, ` +
        'and fix the root cause with the smallest safe change — fix the code under test; only change the test itself ' +
        'if it is genuinely wrong, and say so. Re-run until it passes. If it already passes, explain what it verifies.';
      await runPromptCommand(deps, prompt, { includeCurrentFile: true });
    })
  );
}
