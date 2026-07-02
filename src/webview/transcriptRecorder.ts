import * as path from 'path';
import * as vscode from 'vscode';
import type { ParleySettings } from '../config/settings';
import type { Logger } from '../logging/logger';
import * as transcriptStore from '../transcript/store';
import { transcriptToMarkdown, type TranscriptEntry, type TranscriptMeta } from '../transcript/transcript';

/** Live conversation parameters the recorder stamps into metadata (owned by the panel). */
export interface ConversationSnapshot {
  readonly selectedAgentId: string;
  readonly defaultAgent: string;
  readonly mode: string;
  readonly thinking: string;
  readonly speed: string;
  readonly sessionTokens: number;
  readonly sessionCost: number;
}

/**
 * Owns the conversation transcript — the ordered record of everything shown —
 * and its persistence to the `.parley` store (append-as-it-happens JSONL, the
 * human-readable .md mirror, index and state files). Extracted from ChatPanel
 * as part of the 4-way decomposition; the panel delegates via thin accessors.
 */
export class TranscriptRecorder {
  public entries: TranscriptEntry[] = [];
  public conversationId: string;
  public startedAt = new Date().toISOString();
  /** AI-generated conversation title; falls back to the first user message. */
  public customTitle?: string;

  public constructor(
    private readonly getSettings: () => ParleySettings,
    private readonly logger: Logger,
    private readonly globalStorageUri: vscode.Uri,
    private readonly snapshot: () => ConversationSnapshot
  ) {
    this.conversationId = TranscriptRecorder.newConversationId();
  }

  public static newConversationId(): string {
    return 'parley-' + new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  }

  /**
   * Base `.parley` folder: `parley.conversationsDir` if set, else `<workspace>/.parley`,
   * else the extension's global storage. Holds `conversations/`, `index.json`, `state.json`.
   */
  public base(): string {
    const custom = this.getSettings().conversationsDir;
    if (custom) {
      return custom;
    }
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
    return ws ? path.join(ws.fsPath, '.parley') : path.join(this.globalStorageUri.fsPath, 'parley');
  }

  /** Reveal folder for the auto-save location. */
  public conversationsDir(): vscode.Uri {
    return vscode.Uri.file(transcriptStore.conversationsDir(this.base()));
  }

  public currentTitle(): string {
    if (this.customTitle) {
      return this.customTitle;
    }
    const firstUser = this.entries.find((e) => e.kind === 'user') as { text?: string } | undefined;
    return (firstUser?.text ?? 'Conversation').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Conversation';
  }

  public meta(): TranscriptMeta {
    const snap = this.snapshot();
    const models = [...new Set(this.entries.flatMap((e) => (e.kind === 'assistant' && e.model ? [e.model] : [])))];
    return {
      id: this.conversationId,
      title: this.currentTitle(),
      createdAt: this.startedAt,
      exportedAt: new Date().toISOString(),
      models: models.length > 0 ? models : [snap.selectedAgentId || snap.defaultAgent],
      mode: snap.mode,
      thinking: snap.thinking,
      speed: snap.speed,
      messages: this.entries.filter((e) => e.kind === 'user' || e.kind === 'assistant').length,
      sessionTokens: snap.sessionTokens,
      estimatedCostUsd: snap.sessionCost
    };
  }

  /** Append one transcript event in memory and (best-effort) to its on-disk JSONL log. */
  public append(entry: TranscriptEntry): TranscriptEntry {
    this.entries.push(entry);
    if (this.getSettings().autoSaveConversations) {
      void transcriptStore
        .appendEvent(this.base(), this.conversationId, entry)
        .catch((error) =>
          this.logger.debug(`transcript append failed: ${error instanceof Error ? error.message : 'error'}`)
        );
    }
    return entry;
  }

  /** Rewrite the canonical JSONL (used after an in-place status change, e.g. Apply/Dismiss). */
  public syncFile(): void {
    if (!this.getSettings().autoSaveConversations) {
      return;
    }
    void transcriptStore
      .writeEvents(this.base(), this.conversationId, this.entries)
      .catch((error) =>
        this.logger.debug(`transcript sync failed: ${error instanceof Error ? error.message : 'error'}`)
      );
  }

  /** Write the human-readable .md, update the index, and persist Parley params. Best-effort. */
  public async autosave(): Promise<void> {
    if (!this.getSettings().autoSaveConversations || this.entries.length === 0) {
      return;
    }
    const base = this.base();
    const meta = this.meta();
    const snap = this.snapshot();
    try {
      await transcriptStore.ensureGitignore(base);
      await transcriptStore.writeMarkdown(base, this.conversationId, transcriptToMarkdown(meta, this.entries));
      await transcriptStore.upsertIndex(base, {
        id: this.conversationId,
        title: meta.title,
        savedAt: meta.exportedAt ?? meta.createdAt,
        model: meta.models[0] ?? '',
        events: this.entries.length
      });
      await transcriptStore.writeState(base, {
        lastConversationId: this.conversationId,
        selectedAgentId: snap.selectedAgentId,
        mode: snap.mode,
        thinking: snap.thinking,
        speed: snap.speed,
        updatedAt: meta.exportedAt
      });
    } catch (error) {
      this.logger.warn(`Could not auto-save conversation: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
}
