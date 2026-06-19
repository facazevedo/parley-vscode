import * as vscode from 'vscode';
import type { ContextAttachment } from '../parley/types';
import { collectFileContext } from './collectFileContext';
import type { IgnoreMatcher } from './ignoreRules';

export async function collectOpenEditorsContext(maxCharacters: number, ignoreMatcher?: IgnoreMatcher): Promise<ContextAttachment[]> {
  const attachments: ContextAttachment[] = [];

  for (const document of vscode.workspace.textDocuments) {
    if (document.isUntitled || document.uri.scheme !== 'file') {
      continue;
    }

    const attachment = await collectFileContext(document, maxCharacters, ignoreMatcher);
    if (attachment) {
      attachments.push({
        ...attachment,
        id: `open-editor:${attachment.filePath ?? attachment.id}`,
        kind: 'open-editor',
        label: `Open editor: ${document.fileName}`
      });
    }
  }

  return attachments;
}
