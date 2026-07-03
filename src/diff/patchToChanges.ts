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
    // Containment: a diff can name an absolute or `..` path; never propose a change
    // (or a deletion) outside the workspace, matching extractFileCodeBlockChanges.
    const rel = path.relative(workspaceFolder.uri.fsPath, filePath);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      continue;
    }
    const uri = vscode.Uri.file(filePath);
    const isNewFile = filePatch.oldPath === '/dev/null';

    try {
      // Creation diffs (`--- /dev/null`) target a file that does not exist yet, so
      // never ask VS Code to open it — the patch applies to an empty original.
      let originalText = '';
      if (!isNewFile) {
        const document = await vscode.workspace.openTextDocument(uri);
        originalText = document.getText();
      }

      if (filePatch.newPath === '/dev/null') {
        // Deletion diff: flag it for the apply side instead of proposing an
        // emptied-file rewrite (applying would otherwise leave a 0-byte file).
        changes.push({
          filePath,
          originalText,
          proposedText: '',
          deleteFile: true,
          title: `Delete file: ${patchPath}`
        });
        continue;
      }

      const proposedText = applyFilePatch(
        originalText,
        filePatch.hunks.map((hunk) => ({ lines: hunk.lines, oldStart: hunk.oldStart }))
      );
      changes.push({
        filePath,
        originalText,
        proposedText,
        title: isNewFile ? `New file: ${patchPath}` : `Imported patch: ${patchPath}`
      });
    } catch {
      continue;
    }
  }

  return changes;
}
