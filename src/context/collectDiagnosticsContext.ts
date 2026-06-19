import * as vscode from 'vscode';
import type { ContextAttachment } from '../parley/types';
import { trimToLimit } from './contextPreview';
import type { IgnoreMatcher } from './ignoreRules';
import { shouldSendFile } from './sensitiveFileFilter';

export function collectDiagnosticsContext(
  maxCharacters: number,
  targetUri?: vscode.Uri,
  ignoreMatcher?: IgnoreMatcher
): ContextAttachment | undefined {
  const diagnostics = targetUri ? [[targetUri, vscode.languages.getDiagnostics(targetUri)] as const] : vscode.languages.getDiagnostics();
  const lines: string[] = [];

  for (const [uri, items] of diagnostics) {
    if (uri.scheme !== 'file' || items.length === 0 || !shouldSendFile(uri.fsPath) || ignoreMatcher?.ignores(uri.fsPath)) {
      continue;
    }

    lines.push(`File: ${uri.fsPath}`);
    for (const item of items) {
      const severity = vscode.DiagnosticSeverity[item.severity];
      lines.push(`- ${severity} L${item.range.start.line + 1}: ${item.message}`);
    }
  }

  if (lines.length === 0) {
    return undefined;
  }

  const trimmed = trimToLimit(lines.join('\n'), maxCharacters);
  return {
    id: 'diagnostics',
    kind: 'diagnostics',
    label: targetUri ? 'Current file diagnostics' : 'Workspace diagnostics',
    content: trimmed.content,
    characterCount: trimmed.content.length,
    truncated: trimmed.truncated
  };
}
