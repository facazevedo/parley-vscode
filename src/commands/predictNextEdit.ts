import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { reportProviderError } from './common';
import type { CheckpointStore } from '../diff/checkpoints';
import { reviewProposedEdit } from '../diff/reviewEdit';
import { showProposedDiff } from '../diff/showDiff';
import { recentEditsSummary } from '../completion/recentEdits';
import { parsePrediction } from './predictionParse';

const MAX_FILE_CHARS = 16000;

/**
 * `Parley: Predict Next Edit` (Ctrl+Alt+N) — from your recent edits + the current file,
 * predict the single most likely next change (a sibling case, a related call site, a type,
 * a matching test…) and offer it as a reviewable diff at that location. Reuses the same
 * diff-review + checkpoint flow as inline edit, so nothing is applied without your OK.
 */
export function registerPredictNextEditCommand(
  context: vscode.ExtensionContext,
  deps: CommandDependencies,
  checkpoints: CheckpointStore
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.predictNextEdit', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') {
        await vscode.window.showInformationMessage('Parley: open a file to predict the next edit.');
        return;
      }
      const doc = editor.document;
      const full = doc.getText();
      const recent = recentEditsSummary('') ?? '(no recent edits recorded yet)';
      const capped = full.length > MAX_FILE_CHARS ? `${full.slice(0, MAX_FILE_CHARS)}\n/* …truncated… */` : full;
      const prompt =
        "You predict a developer's NEXT edit. Given their recent edits and the current file, predict the single most " +
        'likely next change that continues the intent — e.g. update a sibling case/branch, a related call site, a type, ' +
        'an import, or a matching test.\n\n' +
        'Reply with EXACTLY one fenced ```json block and nothing else:\n' +
        '{"find":"<exact snippet copied verbatim from the current file — must occur exactly once>","replace":"<replacement text>","why":"<one short line>"}\n' +
        'or {"none":true} if there is no confident next edit.\n\n' +
        `Recent edits:\n${recent}\n\n` +
        `Current file — ${vscode.workspace.asRelativePath(doc.uri)} (${doc.languageId}):\n\`\`\`\n${capped}\n\`\`\``;

      let reply: string;
      try {
        reply = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Parley: predicting next edit…', cancellable: true },
          async (_p, token) => {
            const controller = new AbortController();
            token.onCancellationRequested(() => controller.abort());
            const response = await deps.getProvider().sendMessage(
              {
                prompt,
                messages: [{ role: 'user', content: prompt, createdAt: new Date().toISOString() }],
                context: [],
                agentId: deps.getSettings().defaultAgent
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

      const pred = parsePrediction(reply);
      if (!pred || pred.none || !pred.find || pred.replace === undefined) {
        await vscode.window.showInformationMessage('Parley: no confident next edit to suggest right now.');
        return;
      }
      const idx = full.indexOf(pred.find);
      if (idx === -1) {
        await vscode.window.showInformationMessage('Parley: the predicted edit no longer matches the file.');
        return;
      }
      if (full.indexOf(pred.find, idx + 1) !== -1) {
        await vscode.window.showInformationMessage('Parley: the predicted location was ambiguous — skipped.');
        return;
      }
      const proposedText = full.slice(0, idx) + pred.replace + full.slice(idx + pred.find.length);
      if (proposedText === full) {
        await vscode.window.showInformationMessage('Parley: the prediction was a no-op.');
        return;
      }
      // Reveal the predicted location so the review has context.
      const startPos = doc.positionAt(idx);
      editor.selection = new vscode.Selection(startPos, doc.positionAt(idx + pred.find.length));
      editor.revealRange(new vscode.Range(startPos, startPos), vscode.TextEditorRevealType.InCenter);

      const fileName = path.basename(doc.uri.fsPath);
      await showProposedDiff(
        {
          filePath: doc.uri.fsPath,
          originalText: full,
          proposedText,
          title: `Next edit: ${fileName}${pred.why ? ` — ${pred.why}` : ''}`
        },
        deps.diffProvider
      );
      const finalText = await reviewProposedEdit(fileName, full, proposedText);
      if (finalText !== undefined) {
        await checkpoints.applyWithCheckpoint(doc.uri, finalText, `next-edit ${fileName}`);
      }
    })
  );
}
