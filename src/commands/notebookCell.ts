import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';

/**
 * `Parley: Ask About Notebook Cell` — explain (or act on) the selected Jupyter notebook
 * cell(s). Reads the cells' source directly, since a notebook cell isn't the "current file".
 */
export function registerNotebookCellCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.notebookCell', async () => {
      const nb = vscode.window.activeNotebookEditor;
      if (!nb) {
        await vscode.window.showInformationMessage('Parley: open a Jupyter notebook and select a cell.');
        return;
      }
      const cells = nb.notebook.getCells(nb.selection);
      const text = cells
        .map((c) => c.document.getText())
        .filter((t) => t.trim().length > 0)
        .join('\n\n# --- next cell ---\n\n');
      if (!text.trim()) {
        await vscode.window.showInformationMessage('Parley: the selected cell(s) are empty.');
        return;
      }
      const question = await vscode.window.showInputBox({
        title: 'Parley: Ask About Notebook Cell',
        prompt: 'What do you want to know or change? (leave blank to explain)',
        ignoreFocusOut: true
      });
      const ask = question?.trim() || 'Explain what this notebook cell does, step by step.';
      const lang = cells[0]?.document.languageId ?? 'python';
      const prompt = `${ask}\n\nNotebook cell(s) (${lang}):\n\`\`\`${lang}\n${text}\n\`\`\``;
      await runPromptCommand(deps, prompt, {});
    })
  );
}
