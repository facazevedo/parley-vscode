import * as path from 'path';
import * as vscode from 'vscode';
import { parseUnifiedDiffToChanges } from './patchToChanges';
import { parseFileCodeBlocks } from './fileBlocks';
import type { ProposedFileChange } from '../parley/types';

/**
 * Extract reviewable file changes from a free-form model response.
 *
 * Two formats are recognized, in priority order:
 *   1. Unified diffs (```diff blocks or raw `--- a/… / +++ b/…` hunks).
 *   2. Whole-file rewrites introduced by a `File:`/`Path:` label followed by a
 *      fenced code block containing the complete updated file contents.
 *
 * Both the official API client and the manual website-import command share this
 * so model responses are reviewed identically regardless of transport.
 */
export async function extractProposedChanges(response: string): Promise<ProposedFileChange[]> {
  const diffChanges = await parseUnifiedDiffToChanges(response);
  const fileBlockChanges = await extractFileCodeBlockChanges(response);

  // De-duplicate by file path, preferring unified-diff results when both exist.
  const seen = new Set(diffChanges.map((change) => change.filePath));
  return [...diffChanges, ...fileBlockChanges.filter((change) => !seen.has(change.filePath))];
}

export async function extractFileCodeBlockChanges(response: string): Promise<ProposedFileChange[]> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return [];
  }

  const changes: ProposedFileChange[] = [];
  for (const { rawPath, code } of parseFileCodeBlocks(response)) {
    const filePath = path.isAbsolute(rawPath) ? rawPath : path.join(workspaceFolder.uri.fsPath, rawPath);
    const proposedText = code.endsWith('\n') ? code : `${code}\n`;

    let originalText = '';
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      originalText = document.getText();
    } catch {
      // File does not exist yet: treat as a new-file proposal (empty original).
      originalText = '';
    }

    changes.push({
      filePath,
      originalText,
      proposedText,
      title: originalText.length === 0 ? `New file: ${rawPath}` : `Proposed edit: ${rawPath}`
    });
  }

  return changes;
}
