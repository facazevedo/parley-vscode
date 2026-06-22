import * as vscode from 'vscode';

interface Checkpoint {
  readonly uri: vscode.Uri;
  /** Previous file contents, or undefined if the file did not exist before. */
  readonly previous: string | undefined;
  readonly label: string;
}

/**
 * Tracks file writes made by the agent or Ctrl+K inline edit so the most recent
 * one can be reverted (`Parley: Revert Last Edit`). A lightweight safety net on
 * top of VS Code's own undo and git.
 */
export class CheckpointStore {
  private readonly stack: Checkpoint[] = [];

  public async applyWithCheckpoint(uri: vscode.Uri, newText: string, label: string): Promise<void> {
    let previous: string | undefined;
    try {
      previous = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      previous = undefined;
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(newText, 'utf8'));
    this.stack.push({ uri, previous, label });
  }

  public get size(): number {
    return this.stack.length;
  }

  /** Unique file basenames checkpointed at or after `start` (for a "changed this turn" summary). */
  public changedSince(start: number): string[] {
    const names = this.stack.slice(start).map((c) => c.uri.fsPath.replace(/\\/g, '/').split('/').pop() || c.label);
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
    if (cp.previous === undefined) {
      try {
        await vscode.workspace.fs.delete(cp.uri);
      } catch {
        // File may already be gone.
      }
    } else {
      await vscode.workspace.fs.writeFile(cp.uri, Buffer.from(cp.previous, 'utf8'));
    }
    return cp.label;
  }
}
