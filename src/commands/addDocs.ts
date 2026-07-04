import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';

/**
 * `Parley: Add Docs` — add language-appropriate documentation comments (JSDoc /
 * docstrings / doc comments) to the selected code, or the whole file when there
 * is no selection. Behavior-preserving; returns a reviewable patch.
 */
export function registerAddDocsCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.addDocs', async () => {
      const editor = vscode.window.activeTextEditor;
      const hasSelection = !!editor && !editor.selection.isEmpty;
      const target = hasSelection ? 'the selected code' : 'the current file';
      await runPromptCommand(
        deps,
        `Add clear documentation comments to ${target} using this language's idiomatic style (JSDoc/TSDoc for JS/TS, docstrings for Python, doc comments elsewhere). ` +
          'Document public functions, classes, and non-obvious logic — describe intent, parameters, return values, and thrown errors. ' +
          'Do NOT change any behavior or rename anything; only add comments. Return the changes as a reviewable patch.',
        hasSelection ? { includeSelection: true, includeCurrentFile: true } : { includeCurrentFile: true }
      );
    })
  );
}
