import * as path from 'path';
import * as vscode from 'vscode';
import { parseCheckpointLines, serializeCheckpoint, type CheckpointRecord } from './checkpointCodec';

/**
 * Tracks file writes made by the agent or Ctrl+K inline edit so they can be
 * reverted (`Parley: Revert Last/All`) or rewound to a conversation position
 * (the ⏪ per-message rewind). The stack is persisted per conversation to
 * `<.parley>/checkpoints/<conversationId>.jsonl`, so reverting survives window
 * reloads and reopened conversations. A safety net on top of undo and git.
 */
export class CheckpointStore {
  private stack: CheckpointRecord[] = [];
  private fileUri?: vscode.Uri;
  private markerProvider: () => number = () => 0;

  /** Supplies the transcript position stamped onto each new checkpoint (set by the chat panel). */
  public setMarkerProvider(provider: () => number): void {
    this.markerProvider = provider;
  }

  /** Point at a conversation's checkpoint log and load whatever it already holds. */
  public async bind(baseDir: string, conversationId: string): Promise<void> {
    this.fileUri = vscode.Uri.file(path.join(baseDir, 'checkpoints', `${conversationId}.jsonl`));
    this.stack = [];
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri);
      this.stack = parseCheckpointLines(Buffer.from(bytes).toString('utf8'));
    } catch {
      // No log yet — empty stack.
    }
  }

  /** Carry the current stack into a fork's own log (the original conversation keeps its file). */
  public async rebind(baseDir: string, conversationId: string): Promise<void> {
    this.fileUri = vscode.Uri.file(path.join(baseDir, 'checkpoints', `${conversationId}.jsonl`));
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.fileUri) {
      return;
    }
    try {
      if (this.stack.length === 0) {
        try {
          await vscode.workspace.fs.delete(this.fileUri);
        } catch {
          // Nothing to delete.
        }
        return;
      }
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(this.fileUri.fsPath)));
      const text = this.stack.map(serializeCheckpoint).join('\n') + '\n';
      await vscode.workspace.fs.writeFile(this.fileUri, Buffer.from(text, 'utf8'));
    } catch {
      // Persistence is best-effort; in-memory revert keeps working.
    }
  }

  public async applyWithCheckpoint(uri: vscode.Uri, newText: string, label: string): Promise<void> {
    let previous: string | undefined;
    try {
      previous = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      previous = undefined;
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(newText, 'utf8'));
    this.stack.push({
      fsPath: uri.fsPath,
      previous,
      label,
      marker: this.markerProvider(),
      at: new Date().toISOString()
    });
    await this.flush();
  }

  public get size(): number {
    return this.stack.length;
  }

  /** Unique file basenames checkpointed at or after stack position `start` (for a "changed this turn" summary). */
  public changedSince(start: number): string[] {
    const names = this.stack.slice(start).map((c) => c.fsPath.replace(/\\/g, '/').split('/').pop() || c.label);
    return [...new Set(names)];
  }

  /** Revert every checkpointed write (most-recent first). Returns how many were reverted. */
  public async revertAll(): Promise<number> {
    let count = 0;
    while (this.stack.length > 0) {
      await this.revertLast();
      count += 1;
    }
    return count;
  }

  /** Revert the most recent checkpointed write. Returns its label, or undefined if none. */
  public async revertLast(): Promise<string | undefined> {
    const cp = this.stack.pop();
    if (!cp) {
      return undefined;
    }
    await this.restore(cp);
    await this.flush();
    return cp.label;
  }

  /**
   * Restore every file touched at/after transcript position `marker` to its state
   * before that point, dropping those checkpoints. Newest-first restoration means
   * each file ends at its OLDEST `previous`. Returns the affected file basenames.
   */
  public async rewindTo(marker: number): Promise<string[]> {
    const affected = new Set<string>();
    for (let i = this.stack.length - 1; i >= 0; i -= 1) {
      const cp = this.stack[i];
      if (cp.marker < marker) {
        continue;
      }
      await this.restore(cp);
      affected.add(cp.fsPath.replace(/\\/g, '/').split('/').pop() || cp.label);
      this.stack.splice(i, 1);
    }
    await this.flush();
    return [...affected];
  }

  private async restore(cp: CheckpointRecord): Promise<void> {
    const uri = vscode.Uri.file(cp.fsPath);
    if (cp.previous === undefined) {
      try {
        await vscode.workspace.fs.delete(uri);
      } catch {
        // File may already be gone.
      }
    } else {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(cp.previous, 'utf8'));
    }
  }
}
