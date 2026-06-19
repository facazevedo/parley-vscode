import * as vscode from 'vscode';
import type { ProposedFileChange } from '../parley/types';

export async function applyProposedChange(change: ProposedFileChange): Promise<boolean> {
  const uri = vscode.Uri.file(change.filePath);
  const document = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  edit.replace(uri, fullRange, change.proposedText);
  return vscode.workspace.applyEdit(edit);
}

export async function confirmAndApplyChange(change: ProposedFileChange): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    `Apply Parley's proposed changes to ${change.filePath}?`,
    { modal: true },
    'Apply',
    'Cancel'
  );

  if (answer !== 'Apply') {
    return false;
  }

  return applyProposedChange(change);
}
