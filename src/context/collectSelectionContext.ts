import * as vscode from 'vscode';
import type { ContextAttachment } from '../parley/types';
import { createSelectionAttachment } from './selectionAttachment';

export function collectSelectionContext(editor: vscode.TextEditor, maxCharacters: number): ContextAttachment | undefined {
  const selection = editor.selection;
  if (selection.isEmpty) {
    return undefined;
  }

  const document = editor.document;
  const selectedText = document.getText(selection);
  const startLine = Math.max(0, selection.start.line - 8);
  const endLine = Math.min(document.lineCount - 1, selection.end.line + 8);
  const surroundingRange = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);

  return createSelectionAttachment({
    filePath: document.uri.fsPath,
    languageId: document.languageId,
    selectedText,
    surroundingText: document.getText(surroundingRange),
    maxCharacters
  });
}
