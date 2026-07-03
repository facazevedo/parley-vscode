import * as path from 'path';
import * as vscode from 'vscode';
import { isSensitiveFile } from '../context/sensitiveFileFilter';
import { formatRecentEdits, pushEdit, type RecentEdit } from './recentEditsCore';

/**
 * Ring buffer of the user's most recent edit locations, fed into the ghost-text
 * completion prompt (Cursor-Tab-style context: what you just changed elsewhere
 * is a strong hint for what you're typing now). Ring/formatting live in the pure
 * recentEditsCore; this file only wires the vscode events.
 */

const MAX_EDITS = 5;
// Only mirror documents up to this size — a full-text snapshot per keystroke would
// add latency on huge files; above it we still record edits, just without `before`.
const MAX_MIRROR_CHARS = 100_000;
const edits: RecentEdit[] = [];
// Per-document text as it was BEFORE the change currently being processed, so we can
// recover the pre-edit line (VS Code fires the change event AFTER applying it).
const mirror = new Map<string, string[]>();

export function activateRecentEdits(context: vscode.ExtensionContext): void {
  const drop = (uri: vscode.Uri): void => void mirror.delete(uri.toString());
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((d) => drop(d.uri)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const key = e.document.uri.toString();
      if (e.document.uri.scheme !== 'file' || e.contentChanges.length === 0 || isSensitiveFile(e.document.uri.fsPath)) {
        return;
      }
      const change = e.contentChanges[e.contentChanges.length - 1];
      const line = change.range.start.line;
      // Pre-edit line text from the mirror (captured before this event applied).
      const prevLines = mirror.get(key);
      const before = prevLines && line < prevLines.length ? prevLines[line].trim().slice(0, 160) : undefined;
      // Refresh the mirror to the post-edit state for the next change.
      if (e.document.getText().length <= MAX_MIRROR_CHARS) {
        mirror.set(key, sliceLines(e.document));
      } else {
        mirror.delete(key);
      }
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
      pushEdit(edits, { file, line, text: text.slice(0, 160), before }, MAX_EDITS);
    })
  );
}

/** Snapshot a document's lines (bounded) for the pre-edit mirror. */
function sliceLines(doc: vscode.TextDocument): string[] {
  const out: string[] = [];
  for (let i = 0; i < doc.lineCount; i += 1) {
    out.push(doc.lineAt(i).text);
  }
  return out;
}

/** Recent edit lines outside `excludeFsPath` (the file being completed), oldest first. */
export function recentEditsSummary(excludeFsPath: string): string | undefined {
  return formatRecentEdits(edits, path.basename(excludeFsPath));
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
