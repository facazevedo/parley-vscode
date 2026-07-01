import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Ring buffer of the user's most recent edit locations, fed into the ghost-text
 * completion prompt (Cursor-Tab-style context: what you just changed elsewhere
 * is a strong hint for what you're typing now).
 */

interface RecentEdit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const MAX_EDITS = 5;
const edits: RecentEdit[] = [];

export function activateRecentEdits(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== 'file' || e.contentChanges.length === 0) {
        return;
      }
      const change = e.contentChanges[e.contentChanges.length - 1];
      const line = change.range.start.line;
      let text: string;
      try {
        text = e.document.lineAt(Math.min(line, e.document.lineCount - 1)).text.trim();
      } catch {
        return;
      }
      if (!text) {
        return;
      }
      const file = path.basename(e.document.uri.fsPath);
      // Coalesce consecutive edits on the same file+line (typing produces many events).
      const last = edits[edits.length - 1];
      if (last && last.file === file && last.line === line) {
        edits[edits.length - 1] = { file, line, text: text.slice(0, 160) };
        return;
      }
      edits.push({ file, line, text: text.slice(0, 160) });
      if (edits.length > MAX_EDITS) {
        edits.splice(0, edits.length - MAX_EDITS);
      }
    })
  );
}

/** Recent edit lines outside `excludeFsPath` (the file being completed), oldest first. */
export function recentEditsSummary(excludeFsPath: string): string | undefined {
  const exclude = path.basename(excludeFsPath);
  const rows = edits.filter((e) => e.file !== exclude).map((e) => `${e.file}:${e.line + 1}: ${e.text}`);
  return rows.length > 0 ? rows.join('\n') : undefined;
}

/** Basenames of files open in editor tabs (excluding the completed file), for cross-file hints. */
export function openTabsSummary(excludeFsPath: string): string | undefined {
  const exclude = path.basename(excludeFsPath);
  const names = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input as { uri?: vscode.Uri } | undefined;
      if (input?.uri?.scheme === 'file') {
        const name = path.basename(input.uri.fsPath);
        if (name !== exclude) {
          names.add(name);
        }
      }
    }
  }
  return names.size > 0 ? [...names].slice(0, 10).join(', ') : undefined;
}
