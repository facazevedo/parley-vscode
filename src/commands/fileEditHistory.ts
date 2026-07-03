import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { parseCheckpointLines, type CheckpointRecord } from '../diff/checkpointCodec';
import * as transcriptStore from '../transcript/store';

/**
 * `Parley: File Edit History` — every checkpointed Parley edit to the current
 * file, across all conversations, as a QuickPick; picking one opens a
 * before ⇄ after diff. This is the "what did the agent do to this file"
 * answer outside the chat. (VS Code's Timeline provider API is still proposed,
 * so this ships as a command instead of a Timeline lane.)
 */

interface HistoryHit {
  readonly record: CheckpointRecord;
  readonly conversationId: string;
}

function checkpointsBase(settings: { conversationsDir: string }): string | undefined {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const base = settings.conversationsDir || (ws ? path.join(ws, '.parley') : undefined);
  return base ? path.join(base, 'checkpoints') : undefined;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

export function registerFileEditHistoryCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.fileEditHistory', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') {
        await vscode.window.showInformationMessage('Parley: open a file to see its Parley edit history.');
        return;
      }
      const filePath = editor.document.uri.fsPath;
      const dir = checkpointsBase(deps.getSettings());
      if (!dir) {
        await vscode.window.showInformationMessage('Parley: no workspace open — no checkpoint history to show.');
        return;
      }

      // Collect this file's checkpoints from every conversation's log.
      const hits: HistoryHit[] = [];
      let entries: [string, vscode.FileType][] = [];
      try {
        entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
      } catch {
        // No checkpoints dir yet.
      }
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.toLowerCase().endsWith('.jsonl')) {
          continue;
        }
        try {
          const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(dir, name)))).toString(
            'utf8'
          );
          for (const record of parseCheckpointLines(raw)) {
            if (samePath(record.fsPath, filePath)) {
              hits.push({ record, conversationId: name.replace(/\.jsonl$/i, '') });
            }
          }
        } catch {
          // Unreadable log — skip.
        }
      }
      if (hits.length === 0) {
        await vscode.window.showInformationMessage(
          `Parley has no checkpointed edits for ${path.basename(filePath)} (checkpoints are kept until reverted/rewound).`
        );
        return;
      }

      // Conversation titles for context in the picker.
      const titles = new Map<string, string>();
      try {
        const base = path.dirname(dir);
        for (const e of await transcriptStore.readIndex(base)) {
          titles.set(e.id, e.title || 'Conversation');
        }
      } catch {
        // Titles are optional.
      }

      hits.sort((x, y) => (x.record.at < y.record.at ? 1 : x.record.at > y.record.at ? -1 : 0)); // newest first
      const rel = vscode.workspace.asRelativePath(filePath);
      const picked = await vscode.window.showQuickPick(
        hits.map((h, i) => ({
          label: `$(pencil) ${h.record.label || 'edit'}`,
          description: new Date(h.record.at).toLocaleString(),
          detail: titles.get(h.conversationId) ?? h.conversationId,
          index: i
        })),
        {
          title: `Parley edits to ${rel} (${hits.length})`,
          placeHolder: 'Pick an edit to see its before ⇄ after diff (newest first)'
        }
      );
      if (!picked) {
        return;
      }

      // Before = the checkpoint's captured pre-edit content. After = the next-newer
      // checkpoint's "before", or the file's current content for the newest edit.
      const hit = hits[picked.index];
      const before = hit.record.previous ?? '';
      let after: string;
      if (picked.index === 0) {
        after = editor.document.getText();
      } else {
        after = hits[picked.index - 1].record.previous ?? '';
      }
      const stamp = Date.now();
      const beforeUri = vscode.Uri.parse(`parley-diff:${encodeURIComponent(filePath)}?before-${stamp}`);
      const afterUri = vscode.Uri.parse(`parley-diff:${encodeURIComponent(filePath)}?after-${stamp}`);
      deps.diffProvider.set(beforeUri, before);
      deps.diffProvider.set(afterUri, after);
      const when = new Date(hit.record.at).toLocaleString();
      await vscode.commands.executeCommand(
        'vscode.diff',
        beforeUri,
        afterUri,
        `Parley: ${path.basename(filePath)} — ${hit.record.label || 'edit'} (${when})`
      );
    })
  );
}
