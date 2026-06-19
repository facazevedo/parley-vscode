import * as vscode from 'vscode';
import type { ContextAttachment } from '../parley/types';
import { collectFileContext } from './collectFileContext';
import type { IgnoreMatcher } from './ignoreRules';

export async function collectUserSelectedFilesContext(
  maxCharacters: number,
  ignoreMatcher?: IgnoreMatcher
): Promise<ContextAttachment[]> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: true,
    openLabel: 'Attach to Parley'
  });

  if (!uris) {
    return [];
  }

  const attachments: ContextAttachment[] = [];
  for (const uri of uris) {
    if (uri.scheme !== 'file') {
      continue;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const attachment = await collectFileContext(document, maxCharacters, ignoreMatcher);
    if (attachment) {
      attachments.push({
        ...attachment,
        id: `user-file:${attachment.filePath ?? attachment.id}`,
        kind: 'user-file',
        label: `Selected file: ${document.fileName}`
      });
    }
  }

  return attachments;
}
