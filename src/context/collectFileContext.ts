import * as vscode from 'vscode';
import type { ContextAttachment } from '../parley/types';
import { trimToLimit } from './contextPreview';
import type { IgnoreMatcher } from './ignoreRules';
import { shouldSendFile } from './sensitiveFileFilter';

export async function collectFileContext(
  document: vscode.TextDocument,
  maxCharacters: number,
  ignoreMatcher?: IgnoreMatcher
): Promise<ContextAttachment | undefined> {
  if (document.uri.scheme !== 'file') {
    return undefined;
  }

  const filePath = document.uri.fsPath;
  if (!shouldSendFile(filePath) || ignoreMatcher?.ignores(filePath)) {
    return undefined;
  }

  const trimmed = trimToLimit(document.getText(), maxCharacters);
  return {
    id: `file:${filePath}`,
    kind: 'file',
    label: 'Current file',
    filePath,
    languageId: document.languageId,
    content: trimmed.content,
    characterCount: trimmed.content.length,
    truncated: trimmed.truncated
  };
}
