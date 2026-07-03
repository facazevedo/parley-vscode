import * as path from 'path';
import * as vscode from 'vscode';
import { parseCheckpointLines, serializeCheckpoint, type CheckpointRecord } from './checkpointCodec';
import { decodeText, encodeText, inferEol, type FileFormat } from './fileFormat';

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
  // All stack mutations run through this promise chain so a user-triggered revert
  // can't interleave its fs awaits with an agent's applyWithCheckpoint (which would
  // undo a just-applied edit or persist a torn stack). Serialized, FIFO.
  private tail: Promise<unknown> = Promise.resolve();

  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(op);
    this.tail = next.catch(() => undefined);
    return next;
  }

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

  public applyWithCheckpoint(uri: vscode.Uri, newText: string, label: string): Promise<void> {
    return this.run(() => this._applyWithCheckpoint(uri, newText, label));
  }

  private async _applyWithCheckpoint(uri: vscode.Uri, newText: string, label: string): Promise<void> {
    let previous: string | undefined;
    // New file → UTF-8, no BOM, EOL taken from the content itself. An existing
    // file keeps its own encoding/BOM/EOL so the write round-trips faithfully
    // (no CRLF→LF flip, no UTF-16→UTF-8 corruption).
    let format: FileFormat = { encoding: 'utf8', bom: false, eol: inferEol(newText) };
    try {
      const decoded = decodeText(await vscode.workspace.fs.readFile(uri));
      previous = decoded.text;
      format = decoded.format;
    } catch {
      previous = undefined;
    }
    await vscode.workspace.fs.writeFile(uri, encodeText(newText, format));
    this.stack.push({
      fsPath: uri.fsPath,
      previous,
      label,
      marker: this.markerProvider(),
      at: new Date().toISOString(),
      format
    });
    await this.flush();
  }

  /** Delete a file, checkpointing its prior contents so the deletion can be reverted. */
  public deleteWithCheckpoint(uri: vscode.Uri, label: string): Promise<void> {
    return this.run(() => this._deleteWithCheckpoint(uri, label));
  }

  private async _deleteWithCheckpoint(uri: vscode.Uri, label: string): Promise<void> {
    let previous: string | undefined;
    let format: FileFormat = { encoding: 'utf8', bom: false, eol: '\n' };
    try {
      const decoded = decodeText(await vscode.workspace.fs.readFile(uri));
      previous = decoded.text;
      format = decoded.format;
    } catch {
      return; // Nothing to delete.
    }
    await vscode.workspace.fs.delete(uri, { useTrash: false });
    this.stack.push({
      fsPath: uri.fsPath,
      previous, // non-undefined → revert re-creates the file with its original bytes
      label,
      marker: this.markerProvider(),
      at: new Date().toISOString(),
      format
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
  public revertAll(): Promise<number> {
    // One queued critical section for the whole drain, so a concurrent apply cannot
    // slip a fresh checkpoint into the stack mid-loop and get silently reverted.
    return this.run(async () => {
      let count = 0;
      while (this.stack.length > 0) {
        const cp = this.stack.pop();
        if (!cp) {
          break;
        }
        await this.restore(cp);
        count += 1;
      }
      await this.flush();
      return count;
    });
  }

  /** Revert the most recent checkpointed write. Returns its label, or undefined if none. */
  public revertLast(): Promise<string | undefined> {
    return this.run(async () => {
      const cp = this.stack.pop();
      if (!cp) {
        return undefined;
      }
      await this.restore(cp);
      await this.flush();
      return cp.label;
    });
  }

  /**
   * Restore every file touched at/after transcript position `marker` to its state
   * before that point, dropping those checkpoints. Newest-first restoration means
   * each file ends at its OLDEST `previous`. Returns the affected file basenames.
   */
  public rewindTo(marker: number): Promise<string[]> {
    return this.run(async () => {
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
    });
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
      // Re-encode in the file's original format; legacy records (no format) stay UTF-8.
      const bytes = cp.format ? encodeText(cp.previous, cp.format) : Buffer.from(cp.previous, 'utf8');
      await vscode.workspace.fs.writeFile(uri, bytes);
    }
  }
}
