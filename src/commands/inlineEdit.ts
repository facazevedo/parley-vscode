import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { reportProviderError } from './common';
import type { CheckpointStore } from '../diff/checkpoints';
import { showProposedDiff } from '../diff/showDiff';

/**
 * Cursor-style inline edit: select code, describe a change, review the diff, apply.
 * Bound to Ctrl+Alt+K (Cmd+Alt+K on macOS).
 */
export function registerInlineEditCommand(
  context: vscode.ExtensionContext,
  deps: CommandDependencies,
  checkpoints: CheckpointStore
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.inlineEdit', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        await vscode.window.showInformationMessage('Open a file and select code to use Parley inline edit.');
        return;
      }

      const selection = editor.selection;
      const range = selection.isEmpty ? editor.document.lineAt(selection.active.line).range : new vscode.Range(selection.start, selection.end);
      const selected = editor.document.getText(range);
      if (selected.trim().length === 0) {
        await vscode.window.showInformationMessage('Select some code first.');
        return;
      }

      const instruction = await vscode.window.showInputBox({
        title: 'Parley: Edit Selection',
        prompt: 'Describe the change to make to the selected code.',
        placeHolder: 'e.g. add error handling and JSDoc',
        ignoreFocusOut: true
      });
      if (!instruction) {
        return;
      }

      const settings = deps.getSettings();
      const prompt =
        `Rewrite the following ${editor.document.languageId} code according to the instruction. ` +
        'Output ONLY the replacement code — no Markdown fences, no commentary.\n\n' +
        `Instruction: ${instruction}\n\nCode:\n${selected}`;

      let reply: string;
      try {
        reply = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Parley editing…', cancellable: true },
          async (_progress, token) => {
            const controller = new AbortController();
            token.onCancellationRequested(() => controller.abort());
            const response = await deps.getProvider().sendMessage(
              {
                prompt,
                messages: [{ role: 'user', content: prompt, createdAt: new Date().toISOString() }],
                context: [],
                agentId: settings.defaultAgent,
                reasoningEffort: settings.reasoningEffort || undefined
              },
              { signal: controller.signal }
            );
            return response.message.content;
          }
        );
      } catch (error) {
        if ((error as { name?: string })?.name !== 'AbortError') {
          await reportProviderError(deps, error);
        }
        return;
      }

      const replacement = stripFences(reply);
      const original = editor.document.getText();
      const start = editor.document.offsetAt(range.start);
      const end = editor.document.offsetAt(range.end);
      const proposedText = original.slice(0, start) + replacement + original.slice(end);
      if (proposedText === original) {
        await vscode.window.showInformationMessage('Parley returned no change.');
        return;
      }

      const fileName = path.basename(editor.document.uri.fsPath);
      await showProposedDiff(
        { filePath: editor.document.uri.fsPath, originalText: original, proposedText, title: `Inline edit: ${fileName}` },
        deps.diffProvider
      );
      const answer = await vscode.window.showInformationMessage(`Apply Parley edit to ${fileName}?`, 'Apply', 'Reject');
      if (answer === 'Apply') {
        await checkpoints.applyWithCheckpoint(editor.document.uri, proposedText, `inline edit ${fileName}`);
      }
    })
  );
}

function stripFences(text: string): string {
  const match = text.match(/^```[\w.+-]*\n([\s\S]*?)```\s*$/);
  return (match ? match[1] : text).replace(/\s+$/, '');
}
