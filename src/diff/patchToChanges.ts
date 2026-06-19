import * as path from 'path';
import * as vscode from 'vscode';
import { parsePatch } from './parsePatch';
import { applyFilePatch } from './applyFilePatch';
import type { ProposedFileChange } from '../parley/types';

export async function parseUnifiedDiffToChanges(patchText: string): Promise<ProposedFileChange[]> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return [];
  }

  const changes: ProposedFileChange[] = [];
  for (const filePatch of parsePatch(patchText)) {
    const patchPath = filePatch.newPath === '/dev/null' ? filePatch.oldPath : filePatch.newPath;
    if (!patchPath || patchPath === '/dev/null') {
      continue;
    }

    const filePath = path.isAbsolute(patchPath) ? patchPath : path.join(workspaceFolder.uri.fsPath, patchPath);
    const uri = vscode.Uri.file(filePath);

    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const originalText = document.getText();
      const proposedText = applyFilePatch(originalText, filePatch.hunks.map((hunk) => hunk.lines));
      changes.push({
        filePath,
        originalText,
        proposedText,
        title: `Imported patch: ${patchPath}`
      });
    } catch {
      continue;
    }
  }

  return changes;
}
