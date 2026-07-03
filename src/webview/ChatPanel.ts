import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChatMode, ParleySettings } from '../config/settings';
import { loadOutputStyles, parseFrontmatter, resolveStylePrompt } from '../config/outputStyles';
import { CustomCommand, expandCommandBody, scanCustomCommands } from '../config/customCommands';
import { redactContextAttachments, summarizeFindings } from '../context/secretScanner';
import {
  collectCommandContext,
  previewAndConfirmContext,
  reportProviderError,
  type CommandDependencies,
  type ContextOptions
} from '../commands/common';
import { totalCharacters } from '../context/contextPreview';
import { parseRuleFile, ruleApplies } from '../context/rulesDir';
import { terminalSnapshot } from '../context/terminalLog';
import { isSensitiveFile } from '../context/sensitiveFileFilter';
import { loadIgnoreMatcher, type IgnoreMatcher } from '../context/ignoreRules';
import type { CheckpointStore } from '../diff/checkpoints';
import { formatUnifiedDiff } from '../diff/lineDiff';
import { decodeText } from '../diff/fileFormat';
import type { Logger } from '../logging/logger';
import { SYSTEM_PROMPT } from '../parley/ParleyClient';
import type { ParleyProvider } from '../parley/ParleyProvider';
import { extractMentionPaths, parseMentionRange } from '../parley/parsing';
import { rankMentionPaths } from '../context/fuzzyScore';
import {
  AGENT_TOOLS,
  READ_ONLY_TOOLS,
  resolveAcrossRoots,
  runAgentTool,
  toolRelPath,
  withSubagentTypes
} from '../parley/tools';
import { loadSubagentTypes, SubagentType } from '../config/subagents';
import { normalizeThinkingLevel, type ThinkingLevel } from '../parley/thinking';
import { buildChatHtml } from './webviewHtml';
import { TranscriptRecorder } from './transcriptRecorder';
import { AgentTurnRunner } from './agentTurnRunner';
import { ToolExecutor, runShellCommand } from './toolExecutor';
import { audioFormatFromExt, audioFormatFromMime, modelSupportsAudio } from '../parley/audio';
import { documentProviderFor } from '../parley/files';
import { contextWindowFor, modelSupportsThinking } from '../parley/models';
import { formatUsd } from '../parley/pricing';
import { armDebugFile } from '../debug/debug';
import { runHookEvent } from '../hooks/hooks';
import { getBrowserManager } from '../browser/browserManager';
import type { McpManager } from '../mcp/McpManager';
import { lexicalRank, type RankDoc } from '../codebase/lexicalSearch';
import { EmbeddingIndex } from '../codebase/embeddingIndex';
import {
  indexOfUserMessage,
  transcriptToMarkdown,
  transcriptToPlainText,
  type TranscriptEntry,
  type TranscriptMeta
} from '../transcript/transcript';
import * as transcriptStore from '../transcript/store';
import { extractAudioMp3, extractFrames, hasFfmpeg, resolveFfprobePath, type FfmpegBinaries } from '../video/ffmpeg';
import type {
  AgentInfo,
  AudioAttachment,
  ChatMessage,
  ContextAttachment,
  DocumentAttachment,
  ImageAttachment,
  ToolCall
} from '../parley/types';

const PROJECT_RULES_FILES = ['.parleyrules', 'AGENTS.md', '.cursorrules'];
// Directory rules (one file per rule, optional glob frontmatter — Cursor-compatible).
const RULES_DIRS = ['.parley/rules', '.cursor/rules'];
// Non-file mentions surfaced by the @ autocomplete so they are discoverable in the UI
// (they resolve in resolveMentions, not from the file list).
const SPECIAL_MENTIONS: ReadonlyArray<{ path: string; hint: string }> = [
  { path: 'codebase', hint: 'most relevant files for your question' },
  { path: 'git', hint: 'uncommitted diff vs HEAD' },
  { path: 'terminal', hint: 'recent terminal commands + output' },
  { path: 'browser', hint: 'open a URL and attach the rendered page (add the URL after)' }
];

interface ChatPanelMessage {
  readonly type:
    | 'send'
    | 'stop'
    | 'newChat'
    | 'refreshAgents'
    | 'contextOptionsChanged'
    | 'agentChanged'
    | 'modeChanged'
    | 'thinkingChanged'
    | 'speedChanged'
    | 'attachFiles'
    | 'pasteFile'
    | 'removeAttachment'
    | 'export'
    | 'compact'
    | 'openHistory'
    | 'historyList'
    | 'openConversation'
    | 'renameConversation'
    | 'archiveConversation'
    | 'deleteConversation'
    | 'reviewChanges'
    | 'copyText'
    | 'openLink'
    | 'mentionQuery'
    | 'applyChange'
    | 'applyCodeBlock'
    | 'dismissChange'
    | 'reviewChange'
    | 'unqueue'
    | 'rewind'
    | 'dropPaths'
    | 'dropText'
    | 'dropUnsupported'
    | 'webviewReady'
    | 'openUsage'
    | 'setUsageAccount'
    | 'setApiKey';
  readonly prompt?: string;
  readonly agentId?: string;
  readonly thinking?: string;
  readonly speed?: string;
  readonly mode?: string;
  readonly value?: boolean;
  readonly id?: string;
  readonly text?: string;
  readonly url?: string;
  readonly query?: string;
  readonly dataUri?: string;
  readonly name?: string;
  readonly contextOptions?: ContextOptions;
  /** For 'historyList': 'repo' (default) or 'all' — which conversations to list. */
  readonly scope?: string;
  /** For 'reviewChanges': workspace-relative paths to open as diffs. */
  readonly paths?: string[];
  /** For 'openConversation': the `.parley` base dir the conversation lives under. */
  readonly base?: string;
  /** For 'mentionQuery': echo token so the webview can drop stale results. */
  readonly seq?: number;
  /** For 'dropPaths': `text/uri-list` entries from a drag-and-drop. */
  readonly uris?: string[];
  /** For 'dropUnsupported': names of files that could not be attached. */
  readonly names?: string[];
  /** Steering-queue index for 'unqueue'. */
  readonly index?: number;
  /** For 'send': 0-based ordinal of the user message being edited & resent. */
  readonly editOrdinal?: number;
  /** For 'rewind': 0-based ordinal of the user message to rewind to. */
  readonly ordinal?: number;
  /** For 'rewind': transcript entry index to rewind to. */
  readonly tindex?: number;
  /** For 'compact': keep the last N messages verbatim (0 = summarize everything). Picked in the webview menu. */
  readonly keepRecent?: number;
  /** For 'export': format picked in the webview menu. */
  readonly fmt?: string;
  /** For 'rewind': which part to rewind, picked in the webview menu. */
  readonly what?: string;
  /** For 'renameConversation': new title entered inline in the webview. */
  readonly title?: string;
  /** For 'deleteConversation': the webview already showed an inline confirm. */
  readonly confirmed?: boolean;
  /** For 'setUsageAccount': the account id entered in the webview usage popover. */
  readonly accountId?: string;
  /** For 'applyCodeBlock': the fence language (informational). */
  readonly lang?: string;
}

type RewindChoice = 'convo' | 'files' | 'both';
type ExportFormat = 'md' | 'txt' | 'json';

function asRewindChoice(value: string | undefined): RewindChoice | undefined {
  return value === 'convo' || value === 'files' || value === 'both' ? value : undefined;
}

function asExportFormat(value: string | undefined): ExportFormat | undefined {
  return value === 'md' || value === 'txt' || value === 'json' ? value : undefined;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.mpeg', '.mpg', '.wmv']);
const DOCUMENT_MIME: Record<string, string> = { '.pdf': 'application/pdf' };
// Upload MIME types for text-family files (per Parley's /v1/files supported types).
const TEXT_UPLOAD_MIME: Record<string, string> = {
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.json': 'application/json',
  '.xml': 'application/xml'
};

const DEFAULT_CONTEXT_OPTIONS: Required<ContextOptions> = {
  includeSelection: true,
  includeCurrentFile: false,
  includeOpenEditors: false,
  includeDiagnostics: false,
  includeUserSelectedFiles: false
};

interface PendingAttachment {
  readonly id: string;
  readonly label: string;
  readonly kind: 'image' | 'text' | 'document' | 'audio';
  readonly image?: ImageAttachment;
  readonly text?: ContextAttachment;
  readonly document?: DocumentAttachment;
  readonly audio?: AudioAttachment;
  /** Full text of an attached text file (untruncated) — used to upload large files via /v1/files. */
  readonly rawText?: string;
  /** Upload MIME type for an attached text file (e.g. `application/json`). */
  readonly mimeType?: string;
}

interface SavedSession {
  readonly title: string;
  readonly savedAt: string;
  readonly history: ChatMessage[];
  readonly transcript?: TranscriptEntry[];
  readonly id?: string;
}

export class ChatPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'parley.chatView';

  // The hosting surface: the sidebar WebviewView, or an editor-tab WebviewPanel.
  private view?: { readonly webview: vscode.Webview };
  // Set only for tab-hosted chats — lets the AI-generated title rename the tab.
  private hostPanel?: vscode.WebviewPanel;
  private readonly history: ChatMessage[] = [];
  // Full ordered record of everything shown — owned by the TranscriptRecorder
  // (decomposition 2/4); these accessors keep the rest of the panel unchanged.
  private recorder!: TranscriptRecorder;
  private get transcript(): TranscriptEntry[] {
    return this.recorder.entries;
  }
  private set transcript(value: TranscriptEntry[]) {
    this.recorder.entries = value;
  }
  private get conversationStartedAt(): string {
    return this.recorder.startedAt;
  }
  private set conversationStartedAt(value: string) {
    this.recorder.startedAt = value;
  }
  private get conversationId(): string {
    return this.recorder.conversationId;
  }
  private set conversationId(value: string) {
    this.recorder.conversationId = value;
  }
  private agents: readonly AgentInfo[] = [];
  private selectedAgentId = '';
  private selectedThinking: ThinkingLevel = 'off';
  private selectedSpeed: 'standard' | 'fast' = 'standard';
  private contextOptions: Required<ContextOptions> = { ...DEFAULT_CONTEXT_OPTIONS };
  private mode: ChatMode = 'chat';
  private sessionTokens = 0;
  private sessionCost = 0;
  private highUsageWarned = false; // one-shot soft-budget notice per conversation (parley.usageWarnUsd)
  private jsonNext = false; // one-shot: request the next reply as a JSON object (/json)
  private customCommands: CustomCommand[] = []; // user-defined /commands (workspace + global dirs)
  // Last real editor, for actions invoked while the webview has focus (activeTextEditor
  // can be transiently undefined then).
  private lastActiveEditor?: vscode.TextEditor;
  // Previously sent prompts (newest last) for terminal-style ArrowUp recall in the composer.
  private promptHistory: string[] = [];
  // Per-turn snapshot of `.parley/agents` custom subagent types (loaded in runTurn).
  private subagentTypes: readonly SubagentType[] = [];
  // Assigned by extension.ts for the SIDEBAR panel only — drives the status-bar ticker.
  public statusSink?: (s: { sessionTokens: number; sessionCostUsd: number; busy: boolean }) => void;
  // The sidebar view (typed, unlike `view`) — for the unread-replies badge.
  private sidebarView?: vscode.WebviewView;
  private unreadTurns = 0;
  private embeddingIndex?: EmbeddingIndex; // lazy local semantic index for @codebase
  private attachments: PendingAttachment[] = [];
  // Workspace file/folder candidates for the @-mention autocomplete (short TTL so
  // per-keystroke queries don't re-walk the workspace).
  private mentionCache?: { at: number; files: string[]; dirs: string[] };
  // Window-global listeners registered by this panel — disposed with a tab chat so
  // closed tabs don't keep reacting to every selection change for the session.
  private readonly disposables: vscode.Disposable[] = [];
  private disposedFlag = false;
  // The chat the user interacted with last (sidebar or a tab) — palette commands target it.
  private static activeInstance?: ChatPanel;
  public static get current(): ChatPanel | undefined {
    return ChatPanel.activeInstance;
  }
  public get checkpointStore(): CheckpointStore {
    return this.checkpoints;
  }

  private turns!: AgentTurnRunner;
  private get busy(): boolean {
    // `starting` covers the pre-execute window (hooks, context, mentions) so a second
    // send during it is queued as steering instead of launching a concurrent turn.
    return this.turns.busy || this.turns.starting;
  }
  private set busy(value: boolean) {
    this.turns.busy = value;
  }
  private executor!: ToolExecutor;

  private resolveReady!: () => void;
  private readonly ready = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });
  // Resolved when the webview PAGE has loaded its script (`ready` only means the
  // webview was attached — messages posted before the page loads can be dropped).
  private resolvePageReady!: () => void;
  private readonly pageReady = new Promise<void>((resolve) => {
    this.resolvePageReady = resolve;
  });

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getProvider: () => ParleyProvider,
    private readonly getSettings: () => ParleySettings,
    private readonly logger: Logger,
    private readonly commandDeps: CommandDependencies,
    private readonly state: vscode.Memento,
    private readonly checkpoints: CheckpointStore,
    private readonly globalStorageUri: vscode.Uri,
    private readonly mcp: McpManager
  ) {
    this.recorder = new TranscriptRecorder(this.getSettings, this.logger, this.globalStorageUri, () => ({
      selectedAgentId: this.selectedAgentId,
      defaultAgent: this.getSettings().defaultAgent,
      mode: this.mode,
      thinking: this.selectedThinking,
      speed: this.selectedSpeed,
      sessionTokens: this.sessionTokens,
      sessionCost: this.sessionCost
    }));
    this.executor = new ToolExecutor({
      checkpoints: this.checkpoints,
      mcp: this.mcp,
      browser: getBrowserManager(this.globalStorageUri, this.logger),
      state: this.state,
      recorder: this.recorder,
      diffProvider: this.commandDeps.diffProvider,
      getSettings: this.getSettings,
      getMode: () => this.mode,
      getAbortSignal: () => this.turns.abortSignal,
      getSubagentParams: () => ({
        provider: this.getProvider(),
        agentId: this.selectedAgentId || this.getSettings().defaultAgent,
        thinking: this.selectedThinking,
        speed: this.selectedSpeed
      }),
      getSubagentTypes: () => this.subagentTypes,
      applyUsage: (tokens, cost) => this.accrueUsage(tokens, cost),
      post: (m) => this.post(m)
    });
    this.turns = new AgentTurnRunner({
      history: this.history,
      recorder: this.recorder,
      executor: this.executor,
      checkpoints: this.checkpoints,
      commandDeps: this.commandDeps,
      logger: this.logger,
      post: (m) => this.post(m),
      postState: () => this.postState(),
      applyUsage: (tokens, cost) => this.accrueUsage(tokens, cost),
      getSessionTokens: () => this.sessionTokens,
      runFollowUp: (prompt) => void this.runTurn(prompt, this.contextOptions),
      recordChangesSummary: (cpStart) => this.recordChangesSummary(cpStart)
    });
    const settings = this.getSettings();
    // Restore the previous session if present, else fall back to settings defaults.
    const savedHistory = this.state.get<ChatMessage[]>('parley.history');
    if (Array.isArray(savedHistory)) {
      this.history.push(...savedHistory);
    }
    const savedTranscript = this.state.get<TranscriptEntry[]>('parley.transcript');
    if (Array.isArray(savedTranscript)) {
      this.transcript = savedTranscript;
    } else if (Array.isArray(savedHistory)) {
      this.transcript = historyToTranscript(savedHistory); // migrate older sessions
    }
    this.conversationStartedAt = this.state.get<string>('parley.conversationStartedAt', this.conversationStartedAt);
    this.selectedAgentId = this.state.get<string>('parley.selectedAgentId', settings.defaultAgent);
    this.selectedThinking = normalizeThinkingLevel(
      this.state.get<string>('parley.selectedThinking', settings.thinking)
    );
    this.selectedSpeed = this.state.get<string>('parley.selectedSpeed', 'standard') === 'fast' ? 'fast' : 'standard';
    this.mode = normalizeMode(this.state.get<string>('parley.mode', settings.defaultMode));
    this.sessionTokens = this.state.get<number>('parley.sessionTokens', 0);
    this.sessionCost = this.state.get<number>('parley.sessionCost', 0);
    this.promptHistory = this.state.get<string[]>('parley.promptHistory', []);
    this.conversationId = this.state.get<string>('parley.conversationId', '') || this.newConversationId();
    this.contextOptions = {
      ...DEFAULT_CONTEXT_OPTIONS,
      ...this.state.get<ContextOptions>('parley.contextOptions', {})
    };
    this.recorder.customTitle = this.state.get<string>('parley.title') || undefined;
    // Checkpoints are stamped with the transcript position (for ⏪ rewind) and
    // persisted per conversation, so Revert works across window reloads.
    this.checkpoints.setMarkerProvider(() => this.transcript.length);
    void this.checkpoints.bind(this.parleyBase(), this.conversationId);
    // Incremental semantic index: re-embed a file on save, but only when the local
    // provider is selected AND the embedder is already loaded (never load it for a save).
    // Disposed with the panel (a tab chat) so closed chats don't keep re-embedding.
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!root || !this.embeddingIndex || this.getSettings().codebaseSearchProvider !== 'local') {
          return;
        }
        if (doc.uri.scheme !== 'file' || doc.getText().length > 200000) {
          return;
        }
        const rel = path.relative(root.fsPath, doc.uri.fsPath).replace(/\\/g, '/');
        if (rel.startsWith('..') || isSensitiveFile(rel)) {
          return;
        }
        void this.embeddingIndex.updateFile(root.fsPath, rel, doc.getText());
      })
    );
    // Selection pill: tell the webview what editor selection would ride along with
    // the next prompt (includeSelection is on by default and otherwise invisible).
    let selectionTimer: NodeJS.Timeout | undefined;
    const postSelection = (): void => this.post({ type: 'selectionInfo', info: this.currentSelectionInfo() });
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(() => {
        if (selectionTimer) {
          clearTimeout(selectionTimer);
        }
        selectionTimer = setTimeout(postSelection, 150);
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        // `undefined` also fires transiently when focus moves to a webview — keep the
        // last known selection then instead of flickering the pill away.
        if (editor) {
          this.lastActiveEditor = editor;
          postSelection();
        }
      }),
      // New/renamed/deleted files should show up in the @-mention dropdown right away.
      vscode.workspace.onDidCreateFiles(() => (this.mentionCache = undefined)),
      vscode.workspace.onDidRenameFiles(() => (this.mentionCache = undefined)),
      vscode.workspace.onDidDeleteFiles(() => (this.mentionCache = undefined))
    );
  }

  /**
   * The active editor selection shown in the composer's selection pill (`null` =
   * none). Any editor scheme counts — collectSelectionContext sends untitled and
   * virtual-document selections too, and the pill must not claim otherwise.
   */
  private currentSelectionInfo(): { file: string; startLine: number; endLine: number } | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      return null;
    }
    const sel = editor.selection;
    // A selection ending at column 0 doesn't visually include that line.
    const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
    return { file: path.basename(editor.document.fileName || 'selection'), startLine: sel.start.line + 1, endLine };
  }

  private save(): void {
    // Lightweight params — cheap, always written immediately.
    void this.state.update('parley.conversationStartedAt', this.conversationStartedAt);
    void this.state.update('parley.selectedAgentId', this.selectedAgentId);
    void this.state.update('parley.selectedThinking', this.selectedThinking);
    void this.state.update('parley.selectedSpeed', this.selectedSpeed);
    void this.state.update('parley.mode', this.mode);
    void this.state.update('parley.sessionTokens', this.sessionTokens);
    void this.state.update('parley.sessionCost', this.sessionCost);
    void this.state.update('parley.conversationId', this.conversationId);
    void this.state.update('parley.contextOptions', this.contextOptions);
    void this.state.update('parley.title', this.recorder.customTitle);
    // The history/transcript blobs (which embed base64 images and up-to-500-row diff
    // entries) get re-serialized on every postState — many times per streaming turn.
    // Coalesce them while busy; flush immediately when idle so turn-end/user-action
    // state stays durable. (The on-disk JSONL is the canonical record regardless.)
    if (this.busy) {
      this.scheduleHeavySave();
    } else {
      this.flushHeavySave();
    }
  }

  private saveTimer?: NodeJS.Timeout;

  private scheduleHeavySave(): void {
    if (this.saveTimer) {
      return;
    }
    this.saveTimer = setTimeout(() => this.flushHeavySave(), 800);
  }

  private flushHeavySave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    void this.state.update('parley.history', this.history);
    void this.state.update('parley.transcript', this.transcript);
  }

  // ---------- transcript delegation (owner: TranscriptRecorder, decomposition 2/4) ----------

  private newConversationId(): string {
    return TranscriptRecorder.newConversationId();
  }

  private parleyBase(): string {
    return this.recorder.base();
  }

  private conversationsDir(): vscode.Uri {
    return this.recorder.conversationsDir();
  }

  private currentTitle(): string {
    return this.recorder.currentTitle();
  }

  private transcriptMeta(): TranscriptMeta {
    return this.recorder.meta();
  }

  private appendTranscript(entry: TranscriptEntry): TranscriptEntry {
    return this.recorder.append(entry);
  }

  private syncTranscriptFile(): void {
    this.recorder.syncFile();
  }

  private autosaveConversation(): Promise<void> {
    return this.recorder.autosave();
  }

  /** Save & archive the current conversation, then reset to a fresh one. */
  private async startNewConversation(): Promise<void> {
    await this.autosaveConversation();
    this.archiveCurrent();
    this.history.length = 0;
    this.transcript = [];
    this.attachments = [];
    this.executor.resetConversationState();
    this.sessionTokens = 0;
    this.sessionCost = 0;
    this.highUsageWarned = false;
    this.conversationId = this.newConversationId();
    this.conversationStartedAt = new Date().toISOString();
    this.recorder.customTitle = undefined;
    await this.checkpoints.bind(this.parleyBase(), this.conversationId);
    await this.postState();
  }

  /** Public entry point for the "New Conversation" command. */
  public async newConversation(): Promise<void> {
    this.turns.abort();
    await this.startNewConversation();
    await vscode.commands.executeCommand('workbench.view.extension.parley');
    await vscode.commands.executeCommand('parley.chatView.focus');
  }

  /** Reveal the auto-save folder in the OS file manager. */
  public async openConversationsFolder(): Promise<void> {
    const dir = this.conversationsDir();
    try {
      await vscode.workspace.fs.createDirectory(dir);
    } catch {
      // Directory may already exist.
    }
    await vscode.commands.executeCommand('revealFileInOS', dir);
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    ChatPanel.activeInstance = this;
    this.view = webviewView;
    this.sidebarView = webviewView;
    this.disposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.unreadTurns = 0;
          webviewView.badge = undefined;
        }
      })
    );
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webview.html = buildChatHtml(webview, this.extensionUri);

    webview.onDidReceiveMessage((message: ChatPanelMessage) => {
      void this.handleMessage(message);
    });

    this.resolveReady();
    void this.refreshAgents();
    void this.refreshCustomCommands().then(() => this.postState());
    void this.postState();
  }

  /** Host this chat instance in an editor-tab WebviewPanel (multi-conversation tabs). */
  public attachPanel(panel: vscode.WebviewPanel): void {
    ChatPanel.activeInstance = this;
    this.hostPanel = panel;
    panel.onDidChangeViewState(() => {
      if (panel.active) {
        ChatPanel.activeInstance = this;
      }
    });
    this.view = panel;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    panel.webview.html = buildChatHtml(panel.webview, this.extensionUri);
    panel.webview.onDidReceiveMessage((message: ChatPanelMessage) => {
      void this.handleMessage(message);
    });
    panel.onDidDispose(() => {
      this.disposedFlag = true;
      this.turns.abort();
      this.flushHeavySave(); // don't lose a coalesced transcript tail on tab close
      void this.autosaveConversation();
      for (const d of this.disposables) {
        d.dispose();
      }
      if (ChatPanel.activeInstance === this) {
        ChatPanel.activeInstance = undefined; // palette commands fall back to the sidebar chat
      }
    });
    this.resolveReady();
    void this.refreshAgents();
    void this.refreshCustomCommands().then(() => this.postState());
    void this.postState();
  }

  /**
   * Entry point for prompt-style commands: focuses the chat view and streams the
   * turn into the conversation using the supplied context options.
   */
  public async submitExternalPrompt(prompt: string, options: ContextOptions): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.parley');
    await vscode.commands.executeCommand('parley.chatView.focus');
    await this.ready;
    await this.runTurn(prompt, { ...DEFAULT_CONTEXT_OPTIONS, ...options });
  }

  private async handleMessage(message: ChatPanelMessage): Promise<void> {
    ChatPanel.activeInstance = this; // any interaction makes this chat the command target
    switch (message.type) {
      case 'refreshAgents':
        await this.refreshAgents();
        return;
      case 'setApiKey':
        await vscode.commands.executeCommand('parley.setApiKey');
        await this.refreshAgents();
        return;
      case 'stop':
        this.turns.clearSteering();
        this.turns.abort();
        return;
      case 'newChat':
        this.turns.clearSteering();
        this.turns.abort();
        await this.startNewConversation();
        return;
      case 'unqueue':
        this.turns.removeQueued(message.index ?? -1);
        return;
      case 'rewind':
        await this.rewindAtIndex(message.tindex ?? -1, asRewindChoice(message.what));
        return;
      case 'openHistory':
        await this.openPastConversation();
        return;
      case 'historyList':
        await this.sendHistoryList(message.scope === 'all' ? 'all' : 'repo');
        return;
      case 'openConversation':
        await this.loadConversation(message.base ?? this.parleyBase(), message.id ?? '');
        return;
      case 'renameConversation':
        await this.renameConversationFlow(
          message.base ?? this.parleyBase(),
          message.id ?? '',
          message.scope === 'all' ? 'all' : 'repo',
          message.title
        );
        return;
      case 'archiveConversation':
        await this.archiveConversationFlow(
          message.base ?? this.parleyBase(),
          message.id ?? '',
          message.value !== false,
          message.scope === 'all' ? 'all' : 'repo'
        );
        return;
      case 'deleteConversation':
        await this.deleteConversationFlow(
          message.base ?? this.parleyBase(),
          message.id ?? '',
          message.scope === 'all' ? 'all' : 'repo',
          message.confirmed === true
        );
        return;
      case 'reviewChanges':
        await this.reviewChanges(message.paths ?? []);
        return;
      case 'agentChanged':
        this.selectedAgentId = message.agentId ?? this.selectedAgentId;
        this.save();
        if (this.maybeWarnOpenAiReasoning()) {
          await this.postState();
        }
        return;
      case 'modeChanged':
        this.mode = normalizeMode(message.mode);
        this.save();
        await this.postState();
        return;
      case 'thinkingChanged':
        this.selectedThinking = normalizeThinkingLevel(message.thinking);
        this.save();
        this.maybeWarnOpenAiReasoning();
        await this.postState();
        return;
      case 'speedChanged':
        this.selectedSpeed = message.speed === 'fast' ? 'fast' : 'standard';
        this.save();
        await this.postState();
        return;
      case 'attachFiles':
        await this.pickAttachments();
        return;
      case 'pasteFile':
        await this.addPastedFile(message.dataUri, message.name);
        return;
      case 'export':
        await this.exportConversation(asExportFormat(message.fmt));
        return;
      case 'openUsage':
        await this.sendUsageInfo();
        return;
      case 'setUsageAccount': {
        const accountId = (message.accountId ?? '').trim();
        if (accountId) {
          await vscode.workspace
            .getConfiguration('parley')
            .update('accountId', accountId, vscode.ConfigurationTarget.Global);
        }
        await this.sendUsageInfo();
        return;
      }
      case 'compact':
        if (typeof message.keepRecent === 'number') {
          await this.compactConversation(message.keepRecent);
        } else {
          await this.promptCompact();
        }
        return;
      case 'copyText':
        await vscode.env.clipboard.writeText(message.text ?? '');
        return;
      case 'openLink': {
        const url = message.url ?? '';
        if (/^https?:\/\//i.test(url)) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
        return;
      }
      case 'mentionQuery':
        await this.sendMentionResults(message.query ?? '', message.seq);
        return;
      case 'dropPaths':
        await this.handleDroppedPaths(message.uris ?? []);
        return;
      case 'dropText':
        await this.addDroppedText(message.name ?? '', message.text ?? '');
        return;
      case 'dropUnsupported':
        if ((message.names ?? []).length > 0) {
          void vscode.window.showWarningMessage(
            `Parley: could not attach ${(message.names ?? []).join(', ')} — too large to drop as text. Use the 📎 button instead.`
          );
        }
        return;
      case 'webviewReady':
        // The page (re)loaded its script; state posted before this can have been dropped.
        this.resolvePageReady();
        await this.postState();
        return;
      case 'applyChange': {
        if (this.executor.approveApproval(message.id ?? '')) {
          return;
        }
        await this.executor.applyPendingChange(message.id ?? '');
        return;
      }
      case 'applyCodeBlock':
        await this.applyCodeBlock(message.text ?? '');
        return;
      case 'dismissChange': {
        if (this.executor.rejectApproval(message.id ?? '')) {
          return;
        }
        this.executor.dismissPendingChange(message.id ?? '');
        return;
      }
      case 'reviewChange':
        // "Choose hunks…" on an approval card: fall back to the per-hunk review dialog.
        await this.executor.reviewApproval(message.id ?? '');
        return;
      case 'removeAttachment':
        this.attachments = this.attachments.filter((item) => item.id !== message.id);
        await this.postState();
        return;
      case 'contextOptionsChanged':
        if (message.contextOptions) {
          this.contextOptions = { ...DEFAULT_CONTEXT_OPTIONS, ...message.contextOptions };
          this.save();
        }
        return;
      case 'send':
        if (message.prompt?.trim()) {
          const text = message.prompt.trim();
          this.recordPromptHistory(text);
          if (this.busy) {
            // Steering: don't refuse — queue it for the next round boundary.
            this.turns.queueSteering(text);
            return;
          }
          if (message.editOrdinal !== undefined && message.editOrdinal >= 0) {
            // Edit & resend: fork the conversation just before that user message
            // (the original stays saved on disk in full).
            if (!(await this.forkAtUserMessage(message.editOrdinal))) {
              return;
            }
          }
          if (text.startsWith('/') && (await this.handleSlash(text))) {
            return;
          }
          await this.runTurn(text, this.contextOptions);
        }
        return;
      default:
        return;
    }
  }

  /** Rough token estimate of the current conversation (~4 chars/token). */
  private estimateHistoryTokens(): number {
    return Math.round(this.history.reduce((n, m) => n + (m.content?.length ?? 0), 0) / 4);
  }

  /**
   * Session token/cost sink shared by the turn runner and the tool executor (nested
   * subagent loops). Also fires the one-shot soft-budget notice once the estimated
   * spend crosses `parley.usageWarnUsd` (0 = off) so a runaway agent loop is visible.
   */
  private accrueUsage(tokens: number, cost: number): { sessionTokens: number; sessionCostUsd: number } {
    this.sessionTokens += tokens;
    if (cost) {
      this.sessionCost += cost;
    }
    const warnUsd = this.getSettings().usageWarnUsd;
    if (warnUsd > 0 && !this.highUsageWarned && this.sessionCost >= warnUsd) {
      this.highUsageWarned = true;
      const note =
        `💸 This conversation has used about **${formatUsd(this.sessionCost)}** (${this.sessionTokens.toLocaleString()} tokens), ` +
        `past your \`parley.usageWarnUsd\` warning threshold of ${formatUsd(warnUsd)}. ` +
        `Consider **/compact** to shrink context, or **＋** to start a fresh conversation. Run **Parley: Show Usage** for your real billed spend.`;
      this.history.push({ role: 'assistant', content: note, createdAt: new Date().toISOString() });
      this.appendTranscript({ kind: 'note', text: note, at: new Date().toISOString() });
      void vscode.window.showWarningMessage(
        `Parley: this conversation is at ~${formatUsd(this.sessionCost)} (threshold ${formatUsd(warnUsd)}).`
      );
    }
    this.notifyStatus();
    return { sessionTokens: this.sessionTokens, sessionCostUsd: this.sessionCost };
  }

  /** Push tokens/cost/busy to the status-bar ticker (sidebar instance only). */
  private notifyStatus(): void {
    this.statusSink?.({ sessionTokens: this.sessionTokens, sessionCostUsd: this.sessionCost, busy: this.busy });
  }

  /** Exact prompt-token count for the current history via the gateway, falling back to the heuristic. */
  private async countHistoryTokens(): Promise<number> {
    const model = this.selectedAgentId || this.getSettings().defaultAgent;
    try {
      const exact = await this.getProvider().countTokens(model, this.history);
      if (typeof exact === 'number') {
        return exact;
      }
    } catch {
      // Fall back to the heuristic below.
    }
    return this.estimateHistoryTokens();
  }

  /**
   * "Parley: Show Context Breakdown" (also `/context`) — a per-component estimate
   * of what is filling the model's context window right now: the system prompt,
   * the tool schemas sent every request, and the conversation messages. Opens as
   * a rendered Markdown preview beside the editor. Estimates use ~4 chars/token.
   */
  public async showContextBreakdown(): Promise<void> {
    const est = (s: string | undefined): number => Math.round((s?.length ?? 0) / 4);
    const model = this.selectedAgentId || this.getSettings().defaultAgent;
    const window = contextWindowFor(model);

    const baseTok = est(SYSTEM_PROMPT); // fixed identity/guidance prompt, prepended on every request
    const systemTok = est(await this.buildSystemExtra());
    const toolsEnabled = this.mode !== 'chat';
    const turnTools = toolsEnabled
      ? this.mode === 'plan'
        ? READ_ONLY_TOOLS
        : [...AGENT_TOOLS, ...this.mcp.getTools()]
      : [];
    const toolsTok = est(JSON.stringify(turnTools));

    let userTok = 0;
    let userN = 0;
    let asstTok = 0;
    let asstN = 0;
    let summaryTok = 0;
    for (const m of this.history) {
      const t = est(m.content);
      if (m.content?.startsWith('📦 **Compacted summary')) {
        summaryTok += t;
      } else if (m.role === 'user') {
        userTok += t;
        userN += 1;
      } else if (m.role === 'assistant') {
        asstTok += t;
        asstN += 1;
      }
    }
    const total = baseTok + systemTok + toolsTok + userTok + asstTok + summaryTok;
    const pct = window ? ` (${Math.round((total / window) * 100)}% of window)` : '';

    const rows: Array<[string, number, string]> = [
      ['Base system prompt', baseTok, 'fixed; sent every request'],
      ['System (env, output style, mode, project rules)', systemTok, 'dynamic; project rules can dominate'],
      [
        `Tool definitions (${turnTools.length})`,
        toolsTok,
        toolsEnabled ? 'sent every request in this mode' : 'none in Chat mode'
      ],
      [`Conversation — user (${userN})`, userTok, ''],
      [`Conversation — assistant (${asstN})`, asstTok, '']
    ];
    if (summaryTok > 0) {
      rows.push(['Compacted summary', summaryTok, 'older turns already condensed']);
    }

    const md = [
      '# Parley — context breakdown',
      '',
      `**Model:** \`${model}\`  `,
      window
        ? `**Context window:** ~${window.toLocaleString()} tokens  `
        : '**Context window:** unknown for this model  ',
      `**Estimated in use:** ~${total.toLocaleString()} tokens${pct}`,
      '',
      '| Component | Est. tokens | Notes |',
      '| --- | ---: | --- |',
      ...rows.map(([label, tok, note]) => `| ${label} | ~${tok.toLocaleString()} | ${note} |`),
      `| **Total** | **~${total.toLocaleString()}** | |`,
      '',
      '_Estimates use ~4 chars/token. Per-turn tool results (file reads, command output) are kept to the last few_',
      '_**inside** a turn and do not accumulate here — that is why the running window stays lean. If the total_',
      '_approaches the window, run **⊟ Parley: Compact Conversation** to replace older turns with a summary._'
    ].join('\n');

    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
    try {
      await vscode.commands.executeCommand('markdown.showPreviewToSide', doc.uri);
    } catch {
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    }
  }

  /** Handle composer slash commands. Returns true if the input was a known command. */
  private async handleSlash(input: string): Promise<boolean> {
    const cmd = input.slice(1).split(/\s+/)[0].toLowerCase();
    switch (cmd) {
      case 'clear':
      case 'new':
        await this.startNewConversation();
        return true;
      case 'compact':
        // Show the options in the webview's in-panel menu (concise, chat-anchored).
        this.post({ type: 'openCompactMenu' });
        return true;
      case 'context':
        await this.showContextBreakdown();
        return true;
      case 'cost': {
        const est = this.sessionCost > 0 ? ` (~${formatUsd(this.sessionCost)} estimated)` : '';
        this.history.push({
          role: 'assistant',
          content:
            `💰 This conversation has used **${this.sessionTokens.toLocaleString()} tokens**${est}.\n\n` +
            'For your real billed spend this month, run **`Parley: Show Usage`**.',
          createdAt: new Date().toISOString()
        });
        await this.postState();
        return true;
      }
      case 'model':
        await this.pickModel();
        return true;
      case 'init':
        await vscode.commands.executeCommand('parley.initProjectRules');
        return true;
      case 'json':
        this.jsonNext = true;
        this.history.push({
          role: 'assistant',
          content: '🧩 The next reply will be a JSON object (`response_format: json_object`). Ask your question now.',
          createdAt: new Date().toISOString()
        });
        await this.postState();
        return true;
      case 'help':
        this.history.push({
          role: 'assistant',
          content:
            '**Slash commands**\n- `/clear` (or `/new`) — start a new conversation\n- `/compact` — summarize to free up context (choose keep-recent or all)\n- `/context` — breakdown of what is filling the context window\n- `/cost` — show this conversation\'s token/cost usage\n- `/model` — switch the model\n- `/init` — create a project rules file (AGENTS.md)\n- `/json` — make the next reply a JSON object\n- `/help` — this list\n\n**Custom commands:** add a `name.md` file under `.parley/commands/` or `.claude/commands/` (workspace), or `~/.parley/commands/` / `~/.claude/commands/` (global — workspace wins on a name clash) and it becomes `/name` — its text is the prompt, with `$ARGS` replaced by anything typed after the command and `$SELECTION` by the active editor selection. Optional `description:` frontmatter shows in the slash menu.\n\n**Custom subagents:** add a `name.md` under `.parley/agents/` (frontmatter `description:` and optional `model:`; body = its extra system prompt) and the agent can delegate read-only investigations to it via run_subagent.\n\nMost actions also have commands in the Command Palette (search "Parley").',
          createdAt: new Date().toISOString()
        });
        await this.postState();
        return true;
      default:
        return this.runCustomCommand(cmd, input);
    }
  }

  /** Remember a sent prompt for ArrowUp recall (cap 50, consecutive dupes collapsed). */
  private recordPromptHistory(text: string): void {
    if (!text || this.promptHistory[this.promptHistory.length - 1] === text) {
      return;
    }
    this.promptHistory.push(text);
    if (this.promptHistory.length > 50) {
      this.promptHistory.splice(0, this.promptHistory.length - 50);
    }
    void this.state.update('parley.promptHistory', this.promptHistory);
  }

  /** Scan the workspace + global command dirs for user-defined `/command` markdown files (cached for the slash menu). */
  private async refreshCustomCommands(): Promise<void> {
    this.customCommands = await scanCustomCommands();
  }

  /** Run a user-defined `/command`: expand its file body (`$ARGS`, `$SELECTION`) and send it as a turn. */
  private async runCustomCommand(name: string, input: string): Promise<boolean> {
    const match = this.customCommands.find((c) => c.name.toLowerCase() === name);
    if (!match) {
      return false;
    }
    let body: string;
    try {
      // Re-read at run time so edits since the scan take effect; strip frontmatter.
      body = parseFrontmatter(Buffer.from(await vscode.workspace.fs.readFile(match.uri)).toString('utf8')).body;
    } catch {
      return false;
    }
    const args = input.replace(/^\/\S+\s*/, '').trim();
    const editor = vscode.window.activeTextEditor;
    const selection = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
    const expanded = expandCommandBody(body, args, selection);
    if (!expanded.trim()) {
      return true; // empty command body — nothing to send
    }
    await this.runTurn(expanded, this.contextOptions);
    return true;
  }

  /**
   * "Apply" on a chat code block: propose replacing the editor's selection (or
   * inserting at the cursor) with the block, via the existing proposed-change
   * card — previewed in-chat, applied through checkpoints (revertible).
   */
  private async applyCodeBlock(code: string): Promise<void> {
    if (!code) {
      return;
    }
    const editor = vscode.window.activeTextEditor ?? this.lastActiveEditor;
    if (!editor || editor.document.isClosed || editor.document.uri.scheme !== 'file') {
      void vscode.window.showWarningMessage('Parley: focus a file editor to apply a code block.');
      return;
    }
    if (!vscode.workspace.getWorkspaceFolder(editor.document.uri)) {
      void vscode.window.showWarningMessage('Parley: can only apply code blocks to files inside the workspace.');
      return;
    }
    // The apply pipeline reads/writes disk — sync the buffer first so the diff is truthful.
    if (editor.document.isDirty) {
      await editor.document.save();
    }
    const doc = editor.document;
    const original = doc.getText();
    const sel = editor.selection;
    const start = doc.offsetAt(sel.start);
    const end = doc.offsetAt(sel.end);
    // Replacing a selection: drop the block's trailing newline to avoid a spurious blank line.
    const snippet = sel.isEmpty ? code : code.replace(/\n$/, '');
    const proposed = original.slice(0, start) + snippet + original.slice(end);
    if (proposed === original) {
      return;
    }
    this.executor.postProposedChange({ filePath: doc.uri.fsPath, originalText: original, proposedText: proposed });
  }

  /**
   * Fork the conversation just before the nth user message: the ORIGINAL transcript
   * stays complete on disk (saved + archived), and a new conversation id continues
   * from the truncated copy. Files keep whatever changes were applied — use the ⏪
   * file-rewind for those. Returns false when the ordinal can't be resolved.
   */
  private async forkAtUserMessage(ordinal: number): Promise<boolean> {
    const idx = indexOfUserMessage(this.transcript, ordinal);
    return idx === undefined ? false : this.forkAtIndex(idx);
  }

  /** Fork the conversation just before transcript position `idx` (see forkAtUserMessage). */
  private async forkAtIndex(idx: number): Promise<boolean> {
    const truncated = this.transcript.slice(0, idx);
    await this.autosaveConversation();
    this.archiveCurrent();
    this.transcript = [...truncated];
    this.history.length = 0;
    this.history.push(...transcriptToHistory(truncated));
    this.executor.resetConversationState();
    this.conversationId = this.newConversationId();
    this.recorder.customTitle = undefined; // the fork names itself on its next exchange
    // The fork inherits the checkpoint stack (its files ARE this timeline's files).
    await this.checkpoints.rebind(this.parleyBase(), this.conversationId);
    this.syncTranscriptFile();
    await this.postState();
    return true;
  }

  /** ⏪ on any message: choose to fork the conversation, restore files, or both. */
  private async rewindAtIndex(idx: number, what?: RewindChoice): Promise<void> {
    if (this.busy) {
      await vscode.window.showInformationMessage('Parley is still responding — stop it before rewinding.');
      return;
    }
    if (idx < 0 || idx >= this.transcript.length) {
      return;
    }
    // The choice is normally made in the webview's in-panel menu; the QuickPick
    // below is only a fallback for messages that don't carry one.
    if (!what) {
      const CONVO = {
        label: '$(comment-discussion) Rewind conversation (fork)',
        detail: 'Continue from before this message — files keep their changes; the original conversation stays saved'
      };
      const FILES = {
        label: '$(files) Rewind files',
        detail: 'Restore files edited from this point on — the conversation itself is unchanged'
      };
      const BOTH = { label: '$(history) Rewind both', detail: 'Fork the conversation AND restore the files' };
      const pick = await vscode.window.showQuickPick([CONVO, FILES, BOTH], {
        title: 'Parley: rewind to this message',
        placeHolder: "Edits are restored from this conversation's checkpoints"
      });
      if (!pick) {
        return;
      }
      what = pick === CONVO ? 'convo' : pick === FILES ? 'files' : 'both';
    }
    if (what !== 'files') {
      await this.forkAtIndex(idx);
    }
    if (what !== 'convo') {
      const files = await this.checkpoints.rewindTo(idx);
      const note =
        files.length > 0
          ? `⏪ Restored ${files.length} file${files.length === 1 ? '' : 's'} to before that message: ${files.join(', ')}`
          : '⏪ No checkpointed file changes after that message — files were already in that state.';
      this.history.push({ role: 'assistant', content: note, createdAt: new Date().toISOString() });
      this.appendTranscript({ kind: 'note', text: note, at: new Date().toISOString() });
      await this.postState();
    }
  }

  /** Drop a generated image into the chat as an inline note (used by "Parley: Generate Image"). */
  public showGeneratedImage(dataUri: string, label: string): void {
    const note = `🎨 Generated image: ${label}`;
    this.history.push({ role: 'assistant', content: note, createdAt: new Date().toISOString() });
    this.appendTranscript({ kind: 'note', text: note, images: [dataUri], at: new Date().toISOString() });
    void this.postState();
  }

  /** Re-run the last user message (drop the responses after it). */
  public async regenerateLast(): Promise<void> {
    if (this.busy) {
      await vscode.window.showInformationMessage('Parley is still responding.');
      return;
    }
    let i = this.history.length - 1;
    while (i >= 0 && this.history[i].role !== 'user') {
      i -= 1;
    }
    if (i < 0) {
      await vscode.window.showInformationMessage('Parley: nothing to regenerate yet.');
      return;
    }
    const prompt = this.history[i].content;
    this.history.length = i; // runTurn re-adds the user message
    // Trim the transcript back to before its last user entry too (transcript indices
    // differ from the history index because tool/fileEdit/note entries don't map 1:1),
    // so the re-run yields [user, newAssistant] instead of duplicating the question
    // and stranding the stale answer in the saved transcript and on reload.
    let t = this.transcript.length - 1;
    while (t >= 0 && this.transcript[t].kind !== 'user') {
      t -= 1;
    }
    if (t >= 0) {
      this.transcript = this.transcript.slice(0, t);
      this.syncTranscriptFile();
    }
    await this.postState();
    await this.runTurn(prompt, this.contextOptions);
  }

  /** "Parley: Revert Last Edit" — guarded so it can't interleave with an in-flight agent turn. */
  public async revertLastEdit(): Promise<void> {
    if (this.busy) {
      await vscode.window.showInformationMessage('Parley is still responding — stop it before reverting.');
      return;
    }
    const label = await this.checkpoints.revertLast();
    await vscode.window.showInformationMessage(label ? `Parley reverted: ${label}.` : 'Parley: nothing to revert.');
  }

  /** "Parley: Revert All Edits" — guarded like revertLastEdit. */
  public async revertAllEdits(): Promise<void> {
    if (this.busy) {
      await vscode.window.showInformationMessage('Parley is still responding — stop it before reverting.');
      return;
    }
    const count = await this.checkpoints.revertAll();
    await vscode.window.showInformationMessage(
      count > 0 ? `Parley reverted ${count} edit${count === 1 ? '' : 's'}.` : 'Parley: nothing to revert.'
    );
  }

  /**
   * End-of-turn changed-files summary: for every file written since `cpStart`, diff
   * the oldest checkpointed original against the file's current bytes to get net
   * +/- counts, and record a `changes` transcript entry (the webview renders it as a
   * card with a Review button). Also pushes a concise history line so the model and
   * exports retain a mention. No-op when nothing changed.
   */
  public async recordChangesSummary(cpStart: number): Promise<void> {
    const changed = this.checkpoints.changedFilesSince(cpStart);
    if (changed.length === 0) {
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const files: Array<{ path: string; added: number; removed: number }> = [];
    let added = 0;
    let removed = 0;
    for (const cf of changed) {
      let current = '';
      try {
        current = decodeText(await vscode.workspace.fs.readFile(vscode.Uri.file(cf.fsPath))).text;
      } catch {
        current = ''; // file was deleted this turn → counts as all-removed
      }
      const d = formatUnifiedDiff(cf.previous ?? '', current);
      added += d.added;
      removed += d.removed;
      const rel = root ? path.relative(root.fsPath, cf.fsPath).replace(/\\/g, '/') : cf.fsPath;
      files.push({ path: rel && !rel.startsWith('..') ? rel : cf.fsPath, added: d.added, removed: d.removed });
    }
    this.appendTranscript({ kind: 'changes', files, added, removed, at: new Date().toISOString() });
    const note = `✏️ Changed ${files.length} file${files.length === 1 ? '' : 's'} (+${added} −${removed}). Run "Parley: Revert Last Edit" / "Revert All Edits" to undo.`;
    this.history.push({ role: 'assistant', content: note, createdAt: new Date().toISOString() });
  }

  /** "Review" on the changes summary: open each changed file as a before/after diff. */
  private async reviewChanges(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }
    for (const rel of paths.slice(0, 12)) {
      const uri = (await resolveAcrossRoots(rel)) ?? vscode.Uri.file(rel);
      const original = this.checkpoints.originalOf(uri.fsPath);
      try {
        if (original !== undefined) {
          // Left = checkpointed original, right = current file → a real before/after diff.
          const beforeUri = vscode.Uri.parse(`parley-diff:${encodeURIComponent(uri.fsPath)}?${Date.now()}`);
          this.commandDeps.diffProvider.set(beforeUri, original);
          await vscode.commands.executeCommand(
            'vscode.diff',
            beforeUri,
            uri,
            `Parley changes: ${path.basename(uri.fsPath)}`
          );
        } else {
          await vscode.commands.executeCommand('vscode.open', uri);
        }
      } catch {
        // Best-effort — a missing/renamed file just isn't opened.
      }
    }
  }

  private async runTurn(prompt: string, contextOptions: ContextOptions): Promise<void> {
    if (this.busy) {
      await vscode.window.showInformationMessage('Parley is still responding. Stop the current reply first.');
      return;
    }
    // The user is actively using Parley now — allow the debug log file to be created.
    armDebugFile();

    const settings = this.getSettings();
    const model = this.selectedAgentId || settings.defaultAgent;
    const window = contextWindowFor(model);
    const pctThreshold =
      settings.autoCompactPercent > 0 && window ? Math.floor((window * settings.autoCompactPercent) / 100) : 0;
    const thresholds = [settings.autoCompactTokens, pctThreshold].filter((t) => t > 0);
    if (this.history.length >= 4 && thresholds.length > 0) {
      const count = await this.countHistoryTokens();
      if (thresholds.some((t) => count > t)) {
        await this.compactConversation(4); // keep the most recent exchange verbatim
      }
    }
    // Claim the turn synchronously here (after the self-contained auto-compact, which
    // runs its own busy lifecycle) so a second send during the async pre-execute work
    // below — hooks, context collection, mention resolution — is queued as steering
    // rather than launching a concurrent turn. cancelStart() releases it on early exit.
    this.turns.begin();
    if (settings.tokenLimit > 0 && this.sessionTokens >= settings.tokenLimit) {
      this.turns.cancelStart();
      await vscode.window.showWarningMessage(
        `Parley token limit reached for this conversation (${this.sessionTokens.toLocaleString()} / ${settings.tokenLimit.toLocaleString()}). Start a new conversation or raise "parley.tokenLimit".`
      );
      await this.postToComposer({ type: 'restoreDraft', text: prompt });
      return;
    }
    // UserPromptSubmit hooks: exit 2 blocks the prompt; zero-exit stdout becomes extra context.
    const submitHook = await runHookEvent(
      settings.hooks,
      'UserPromptSubmit',
      { prompt },
      { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, log: (m) => this.logger.debug(`hooks: ${m}`) }
    );
    if (submitHook.blocked) {
      this.turns.cancelStart();
      const note = `🚫 Blocked by a UserPromptSubmit hook${submitHook.feedback ? `: ${submitHook.feedback}` : ''}.`;
      this.history.push({ role: 'assistant', content: note, createdAt: new Date().toISOString() });
      this.appendTranscript({ kind: 'note', text: note, at: new Date().toISOString() });
      await this.postState();
      await this.postToComposer({ type: 'restoreDraft', text: prompt });
      return;
    }

    const collected = await collectCommandContext(contextOptions, settings);
    const mentions = await this.resolveMentions(prompt, settings);
    if (submitHook.extraContext) {
      const content = submitHook.extraContext.slice(0, settings.contextMaxCharacters);
      mentions.push({
        id: 'hook-context',
        kind: 'user-file',
        label: 'UserPromptSubmit hook context',
        content,
        characterCount: content.length,
        truncated: submitHook.extraContext.length > content.length
      });
    }
    // Large attached text files are uploaded via /v1/files on OpenAI/Google (so they
    // aren't truncated); small files — and any file on Bedrock/Anthropic, which have no
    // upload endpoint — stay inline as (possibly truncated) prompt context.
    const targetModel = this.selectedAgentId || settings.defaultAgent;
    const uploadProvider = documentProviderFor(targetModel);
    const inlineText: ContextAttachment[] = [];
    const uploadedTextDocs: DocumentAttachment[] = [];
    for (const a of this.attachments) {
      if (a.kind !== 'text' || !a.text) {
        continue;
      }
      if (a.text.truncated && uploadProvider && a.rawText) {
        // The upload path must get the same secret redaction as inline context.
        const [redacted] = this.redactContextSecrets([
          { ...a.text, content: a.rawText, characterCount: a.rawText.length, truncated: false }
        ]);
        uploadedTextDocs.push({
          filename: a.label,
          mimeType: a.mimeType ?? 'text/plain',
          base64: Buffer.from(redacted.content, 'utf8').toString('base64')
        });
      } else {
        inlineText.push(a.text);
      }
    }
    const context = this.redactContextSecrets([...collected, ...inlineText, ...mentions]);
    const images = this.attachments.filter((a) => a.kind === 'image').map((a) => a.image!);
    const documents = [
      ...this.attachments.filter((a) => a.kind === 'document').map((a) => a.document!),
      ...uploadedTextDocs
    ];
    const audios = this.attachments.filter((a) => a.kind === 'audio').map((a) => a.audio!);
    const toolsEnabled = this.mode !== 'chat';
    const systemExtra = await this.buildSystemExtra();
    const responseFormat = this.jsonNext ? { type: 'json_object' } : undefined;
    this.jsonNext = false;

    // Per-message chat stays frictionless; only confirm when the attached context
    // is large. (The diff-review-before-apply step still gates any file changes.)
    if (totalCharacters(context) > settings.contextMaxCharacters / 2) {
      const confirmed = await previewAndConfirmContext(context, settings);
      if (!confirmed) {
        this.turns.cancelStart();
        await this.postToComposer({ type: 'restoreDraft', text: prompt });
        return;
      }
    }

    this.history.push({ role: 'user', content: prompt, createdAt: new Date().toISOString() });
    this.appendTranscript({
      kind: 'user',
      text: prompt,
      // Attached images render inline in the chat bubble (and persist in the transcript).
      ...(images.length > 0 ? { images: images.slice(0, 4).map((i) => i.dataUri) } : {}),
      at: new Date().toISOString()
    });
    // Surface the OpenAI-reasoning-no-op hint on the first send with that combo, even if the
    // level was carried over from a previous session (no change event would have fired).
    this.maybeWarnOpenAiReasoning();
    this.attachments = [];

    const useStream = settings.stream;
    const provider = this.getProvider();
    const agentId = this.selectedAgentId || settings.defaultAgent;
    const canAutoContinue = toolsEnabled && this.mode !== 'plan' && settings.autoContinue;

    if (images.length > 0 && !isLikelyVisionModel(agentId)) {
      void vscode.window.showWarningMessage(
        `${agentId} may not accept images. For image input, pick a Claude, Gemini, or GPT-5 model.`
      );
    }
    if (audios.length > 0 && !modelSupportsAudio(agentId)) {
      void vscode.window.showWarningMessage(
        `${agentId} does not accept audio. Audio input works only on OpenAI and Google models.`
      );
    }
    if (this.selectedThinking !== 'off' && !modelSupportsThinking(agentId)) {
      void vscode.window.showWarningMessage(
        `${agentId} does not support extended thinking. Reasoning works on Claude, Gemini, and GPT-5 models.`
      );
    }

    // Built-in tools for the mode + any configured MCP tools (MCP excluded from read-only Plan mode).
    // Custom subagent types are re-scanned each turn so the run_subagent schema stays current.
    this.subagentTypes = await loadSubagentTypes();
    const baseTools = withSubagentTypes(this.mode === 'plan' ? READ_ONLY_TOOLS : AGENT_TOOLS, this.subagentTypes);
    const turnTools = toolsEnabled
      ? this.mode === 'plan'
        ? baseTools
        : [...baseTools, ...this.mcp.getTools()]
      : undefined;

    await this.turns.execute({
      prompt,
      context,
      images,
      documents,
      audios,
      responseFormat,
      systemExtra,
      agentId,
      thinking: this.selectedThinking,
      speed: this.selectedSpeed,
      settings,
      provider,
      toolsEnabled,
      canAutoContinue,
      useStream,
      turnTools
    });

    // A reply finished while the sidebar is hidden → badge the activity-bar icon.
    if (this.sidebarView && !this.sidebarView.visible) {
      this.unreadTurns += 1;
      this.sidebarView.badge = {
        value: this.unreadTurns,
        tooltip: `${this.unreadTurns} Parley repl${this.unreadTurns === 1 ? 'y' : 'ies'} finished while the view was hidden`
      };
    }

    // Plan mode: open the plan as an editable document and offer to build it
    // (Claude-Code style — your edited version is what gets implemented).
    if (this.mode === 'plan') {
      void this.offerPlanReview();
    }
    // Name the conversation after its first exchange (cheap model, once, background).
    if (!this.recorder.customTitle) {
      void this.maybeGenerateTitle();
    }
  }

  /** AI-generate a short conversation title from the first exchange (best-effort, silent on failure). */
  private async maybeGenerateTitle(): Promise<void> {
    if (this.recorder.customTitle || this.turns.busy) {
      return;
    }
    const firstUser = this.transcript.find((e) => e.kind === 'user');
    const firstAssistant = this.transcript.find((e) => e.kind === 'assistant');
    if (firstUser?.kind !== 'user' || firstAssistant?.kind !== 'assistant') {
      return;
    }
    try {
      const prompt =
        'Write a short title (3-6 words, no quotes, no trailing punctuation) for a coding-assistant conversation that starts:\n' +
        `User: ${firstUser.text.slice(0, 300)}\n` +
        `Assistant: ${firstAssistant.text.slice(0, 300)}\n` +
        'Reply with ONLY the title.';
      const response = await this.getProvider().sendMessage({
        prompt,
        messages: [{ role: 'user', content: prompt, createdAt: new Date().toISOString() }],
        context: [],
        agentId: this.getSettings().inlineCompletionModel // fast + cheap
      });
      const title = response.message.content
        .trim()
        .split('\n')[0]
        .replace(/^["'#*\s]+|["'*.\s]+$/g, '')
        .slice(0, 60);
      if (title.length >= 3) {
        this.recorder.customTitle = title;
        this.save();
        if (this.hostPanel) {
          this.hostPanel.title = `Parley — ${title}`;
        }
        await this.autosaveConversation(); // the history picker shows the new title
      }
    } catch {
      // Title stays derived from the first message — never worth surfacing an error.
    }
  }

  /** After a plan-mode turn: show the plan as editable markdown beside the chat + Build buttons. */
  private async offerPlanReview(): Promise<void> {
    const lastPlan = [...this.transcript].reverse().find((e) => e.kind === 'assistant');
    if (!lastPlan || lastPlan.kind !== 'assistant' || lastPlan.text.trim().length < 40) {
      return;
    }
    const HEADER = '<!-- Parley plan — edit freely below; the EDITED text is what gets built. -->\n\n';
    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: HEADER + lastPlan.text.trim()
    });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });

    const ASK = 'Build (ask before edits)';
    const AUTO = 'Build (edit automatically)';
    const choice = await vscode.window.showInformationMessage(
      'Review the plan in the editor — edit it freely, then choose how to build it.',
      ASK,
      AUTO,
      'Stay in Plan'
    );
    if (choice !== ASK && choice !== AUTO) {
      return;
    }
    const planText = doc
      .getText()
      .replace(/^<!--[\s\S]*?-->\s*/, '')
      .trim();
    if (!planText) {
      return;
    }
    this.mode = choice === ASK ? 'ask' : 'edit';
    this.save();
    await this.postState();
    await this.runTurn(
      `Implement the following APPROVED plan, step by step. Any edits in it are intentional — follow this version exactly:\n\n${planText}`,
      this.contextOptions
    );
  }

  /** An `<env>` block telling the model its concrete environment (reduces platform/tool hallucination). */
  private async buildEnvBlock(): Promise<string> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const root = folders[0]?.uri;
    let isGit = false;
    if (root) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, '.git'));
        isGit = true;
      } catch {
        // Not a git repo.
      }
    }
    const model = this.selectedAgentId || this.getSettings().defaultAgent;
    return [
      '<env>',
      `Working directory: ${root?.fsPath ?? '(no folder open)'}`,
      `Is a git repo: ${isGit ? 'yes' : 'no'}`,
      `Platform: ${process.platform}`,
      `OS: ${os.type()} ${os.release()}`,
      `Default shell: ${vscode.env.shell || 'unknown'}`,
      `Model: ${model}`,
      `Today's date: ${new Date().toISOString().slice(0, 10)}`,
      '</env>'
    ].join('\n');
  }

  /** Redact (or warn about) secrets in attached context before it leaves the machine (parley.secretScanning). */
  private redactContextSecrets(context: ContextAttachment[]): ContextAttachment[] {
    const mode = this.getSettings().secretScanning;
    const { items, findings } = redactContextAttachments(context, mode);
    if (findings.length > 0) {
      const summary = summarizeFindings(findings);
      const note =
        mode === 'warn'
          ? `🔒 Detected ${summary} in the attached context (sent as-is; secretScanning=warn).`
          : `🔒 Redacted ${summary} from the attached context before sending.`;
      this.appendTranscript({ kind: 'note', text: note, at: new Date().toISOString() });
    }
    return items;
  }

  /** Compose the dynamic system prompt: env, output style, mode instruction, and project rules. */
  private async buildSystemExtra(): Promise<string | undefined> {
    const env = await this.buildEnvBlock();
    const stylePrompt = resolveStylePrompt(await loadOutputStyles(), this.getSettings().outputStyle);
    const rules = await this.readProjectRules();
    const rulesSection = rules ? `# Project rules (from the workspace)\n${rules}` : undefined;
    let modeNote: string | undefined;
    if (this.mode === 'plan') {
      modeNote =
        'You are in PLAN mode. Do NOT edit files or run commands. Use the read-only tools to explore the codebase, then present a concise, numbered plan of the changes you would make. For broad reconnaissance (mapping a subsystem, surveying many files), delegate to run_subagent with a self-contained brief — it investigates in a fresh context and returns only its report, keeping this conversation lean.';
    } else if (this.mode !== 'chat') {
      const fullAccess = this.mode === 'full';
      modeNote =
        "You are an autonomous coding agent in VS Code. Keep working — read files (use read_file start_line/end_line for large files), search (grep for regex/content, find_symbol/find_references for definitions and usages via the language server, find_files for names), edit (use edit_file for precise changes to existing files, write_file for new ones), and run commands — until the user's request is FULLY complete. Do not stop to ask whether to continue or wait for confirmation.\n\n" +
        'After an applied edit you may receive a "new problems" report from the editor\'s live diagnostics — fix those problems before moving on. If an edit_file match fails, the error often shows the closest real region of the file: copy old_text exactly from it instead of re-reading the whole file.\n\n' +
        'You are NOT limited to a single interaction or a fixed number of steps — you will be re-invoked automatically to continue, so never apologize about "running out of time", "this interaction/run", or "running out of steps"; just keep going. Your tools (read_file, edit_file, write_file, run_command, etc.) are ALWAYS available — NEVER claim that "the tool interface is unavailable", that tools "stopped responding", or that you "cannot continue in this run". If you want to act, simply call the tool. If earlier tool outputs in the conversation were trimmed to a short placeholder to save context, that is normal — just re-read the file or re-run the search; it does not mean anything is broken.\n\n' +
        'Use run_command to make the environment work for you. If a required dependency, package, or CLI tool is missing (e.g. pytest, numpy, a linter, a formatter, a build tool), INSTALL IT YOURSELF with the appropriate command (`pip install …`, `npm install …`, `npm i -D …`, etc.) and continue — never report a missing dependency as a blocker or ask the user to install it when you can install it yourself. When the user says "install those tools" or similar, they mean install the missing packages/CLIs via the shell — do it. ' +
        (fullAccess
          ? 'You are in FULL ACCESS mode: shell commands run WITHOUT asking, so install dependencies and run builds/tests freely.'
          : 'Shell commands ask for confirmation in this mode; still attempt installs/builds/tests and let the user approve them.') +
        '\n\n' +
        'If a command is terminated for exceeding its timeout, that is recoverable: re-run it, split it into smaller steps, or proceed — do not give up.\n\n' +
        'For any task with more than a couple of steps, call the `update_plan` tool first with the high-level steps, then update it (one step `in_progress` at a time, mark steps `done` as you finish) so the user can follow your progress.\n\n' +
        'When a task needs broad read-only reconnaissance first — mapping how a subsystem works, finding every usage of a pattern across many files, comparing several implementations — delegate that investigation to `run_subagent` with a SELF-CONTAINED brief (it cannot see this conversation) instead of flooding your own context with dozens of reads; then act on its report.\n\n' +
        'IMPORTANT — always communicate in plain text as you work: before each tool call, write a short sentence saying what you are about to do and why; after finishing a logical chunk, summarize what changed. This per-step narration is expected and helpful — the brevity guidance is about not padding the WHOLE response (restating the question, filler intros/outros), not about skipping these. Do NOT paste raw reasoning notes-to-self (fragments like "Need to…", "Use python? read __all__.") into your reply — write clear sentences for the user. NEVER reply with only tool calls and no text, and never return an empty message.\n\n' +
        'When the entire task is genuinely finished, your final message MUST end with a summary section formatted EXACTLY like this:\n' +
        '**SUMMARY**\n' +
        '- <what you did — one bullet per item>\n' +
        '- <files created/changed>\n' +
        '- <commands run and whether lint/tests/build passed>\n' +
        '- <any known limitations or follow-ups>\n' +
        'Use a bold **SUMMARY** heading on its own line, then concise Markdown bullet points (`- `). Put <DONE> on its own line AFTER the summary. Always include this SUMMARY section when finishing — even for small tasks.';
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    const multiRootNote =
      folders.length > 1
        ? `This is a MULTI-ROOT workspace (folders: ${folders.map((f) => f.name).join(', ')}). Tool paths may target any root — prefix with the folder name (e.g. "${folders[1].name}/src/…") when the first root isn't meant. run_command executes in the FIRST root (${folders[0].name}); use "cd <folder> && …" for the others.`
        : undefined;
    return (
      [env, stylePrompt || undefined, modeNote, multiRootNote, rulesSection].filter(Boolean).join('\n\n') || undefined
    );
  }

  /** "Parley: Select Output Style" — pick a communication style (built-in or custom) for the model. */
  public async selectOutputStyle(): Promise<void> {
    const styles = await loadOutputStyles();
    const current = this.getSettings().outputStyle;
    const pick = await vscode.window.showQuickPick(
      styles.map((s) => ({
        label: `${s.label}${s.id === current ? '  ✓' : ''}`,
        description: s.description,
        id: s.id
      })),
      { title: 'Parley: output style', placeHolder: 'How should Parley communicate? (applies to new messages)' }
    );
    if (!pick) {
      return;
    }
    await vscode.workspace.getConfiguration('parley').update('outputStyle', pick.id, vscode.ConfigurationTarget.Global);
    await vscode.window.showInformationMessage(`Parley output style: ${pick.label.replace(/\s*✓$/, '')}.`);
  }

  /**
   * One-time chat hint: extended thinking is a no-op on OpenAI models via Parley
   * (verified — the reasoning level is accepted but not applied), so nudge toward
   * Claude/Gemini. Returns true if the hint was added this call.
   */
  private maybeWarnOpenAiReasoning(): boolean {
    if (this.selectedThinking === 'off') {
      return false;
    }
    const model = this.selectedAgentId || this.getSettings().defaultAgent;
    if (!/^openai\//i.test(model)) {
      return false;
    }
    if (this.state.get<boolean>('parley.openaiReasoningHintShown', false)) {
      return false;
    }
    void this.state.update('parley.openaiReasoningHintShown', true);
    const hint =
      `ℹ️ Heads-up: on Parley the reasoning level isn't applied to **OpenAI / GPT-5** models — it's accepted but has no measurable effect (verified live). ` +
      `For deeper reasoning, switch to a **Claude** (Opus/Sonnet) or **Gemini** model, where extended thinking genuinely works.`;
    this.history.push({ role: 'assistant', content: hint, createdAt: new Date().toISOString() });
    this.appendTranscript({ kind: 'note', text: hint, at: new Date().toISOString() });
    return true;
  }

  private async pickAttachments(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach to Parley',
      title: 'Attach files to the Parley chat'
    });
    if (!uris || uris.length === 0) {
      return;
    }
    await this.attachUris(uris);
  }

  /**
   * Attach files to the pending-attachment chips (📎 picker, right-click "Add File
   * to Chat", drag-and-drop). Files that look like credentials are skipped — the
   * same guard mentions and the agent's read tool apply. Folders inside the
   * workspace become `@folder/` mentions instead.
   */
  public async attachUris(uris: readonly vscode.Uri[]): Promise<void> {
    await this.reveal();
    const skipped: string[] = [];
    const mentionInserts: string[] = [];
    for (const uri of uris) {
      if (isSensitiveFile(uri.fsPath)) {
        skipped.push(path.basename(uri.fsPath));
        continue;
      }
      let isDirectory = false;
      try {
        isDirectory = ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0;
      } catch {
        continue; // unreadable — skip silently, matching the old per-file behavior
      }
      if (isDirectory) {
        const rel = toolRelPath(uri).replace(/\/+$/, '');
        // A workspace ROOT folder yields its absolute path from asRelativePath — no
        // valid mention exists for it, so it lands in `skipped` with the others.
        if (vscode.workspace.getWorkspaceFolder(uri) && rel && !path.isAbsolute(rel) && !/\s/.test(rel)) {
          mentionInserts.push(`@${rel}/ `);
        } else {
          skipped.push(path.basename(uri.fsPath));
        }
        continue;
      }
      await this.attachUri(uri);
    }
    if (mentionInserts.length > 0) {
      await this.postToComposer({ type: 'insertText', text: mentionInserts.join('') });
    }
    if (skipped.length > 0) {
      void vscode.window.showWarningMessage(
        `Parley: skipped ${skipped.join(', ')} — looks like credentials/secrets or can't be attached.`
      );
    }
    await this.postState();
  }

  /** Attach one file as a pending attachment, classified by extension. */
  private async attachUri(uri: vscode.Uri): Promise<void> {
    const maxChars = this.getSettings().contextMaxCharacters;
    try {
      const label = path.basename(uri.fsPath);
      const ext = path.extname(uri.fsPath).toLowerCase();

      if (VIDEO_EXTENSIONS.has(ext)) {
        await this.attachVideo(uri, label);
        return;
      }

      const bytes = await vscode.workspace.fs.readFile(uri);
      const id = `att-${Date.now()}-${this.attachments.length}`;

      if (IMAGE_EXTENSIONS.has(ext)) {
        const mime = ext === '.jpg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
        const dataUri = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
        this.attachments.push({ id, label, kind: 'image', image: { label, dataUri } });
      } else if (DOCUMENT_MIME[ext]) {
        const base64 = Buffer.from(bytes).toString('base64');
        this.attachments.push({
          id,
          label,
          kind: 'document',
          document: { filename: label, mimeType: DOCUMENT_MIME[ext], base64 }
        });
      } else if (audioFormatFromExt(ext)) {
        const base64 = Buffer.from(bytes).toString('base64');
        this.attachments.push({
          id,
          label,
          kind: 'audio',
          audio: { label, format: audioFormatFromExt(ext)!, base64 }
        });
      } else {
        const raw = Buffer.from(bytes).toString('utf8');
        const content = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
        this.attachments.push({
          id,
          label,
          kind: 'text',
          rawText: raw,
          mimeType: TEXT_UPLOAD_MIME[ext] ?? 'text/plain',
          text: {
            id,
            kind: 'user-file',
            label,
            filePath: uri.fsPath,
            content,
            characterCount: content.length,
            truncated: raw.length > maxChars
          }
        });
      }
    } catch (error) {
      this.logger.warn(`Could not attach ${uri.fsPath}: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  /** Bring this chat's webview to front (sidebar view or editor tab) and wait for it. */
  private async reveal(): Promise<void> {
    if (this.hostPanel) {
      if (!this.disposedFlag) {
        this.hostPanel.reveal(undefined, false);
      }
    } else {
      await vscode.commands.executeCommand('workbench.view.extension.parley');
      await vscode.commands.executeCommand('parley.chatView.focus');
    }
    await this.ready;
  }

  /**
   * Post once the webview page has loaded its script — a message posted right
   * after a first-time reveal races the page load and can be dropped. The timeout
   * keeps us from hanging if the page never reports in.
   */
  private async postToComposer(message: Record<string, unknown>): Promise<void> {
    await Promise.race([this.pageReady, new Promise((resolve) => setTimeout(resolve, 1500))]);
    this.post(message);
  }

  /** Reveal this chat and insert text into the composer at the caret (e.g. an @-mention). */
  public async insertComposerText(text: string): Promise<void> {
    await this.reveal();
    await this.postToComposer({ type: 'insertText', text });
  }

  /**
   * Files dropped onto the composer as URIs (VS Code Explorer drags provide
   * `text/uri-list`): text workspace files become `@path` mentions in the input;
   * media and out-of-workspace files attach like the 📎 picker; dropped web links
   * become `@https://…` mentions.
   */
  private async handleDroppedPaths(uriStrings: readonly string[]): Promise<void> {
    const CAP = 20;
    const mentions: string[] = [];
    const attaches: vscode.Uri[] = [];
    const skipped: string[] = [];
    for (const raw of uriStrings.slice(0, CAP)) {
      let uri: vscode.Uri;
      try {
        uri = vscode.Uri.parse(raw, true);
      } catch {
        continue;
      }
      if (uri.scheme === 'http' || uri.scheme === 'https') {
        mentions.push(`@${raw.trim()} `); // a dropped link becomes a fetch-the-page mention
        continue;
      }
      if (uri.scheme !== 'file') {
        continue;
      }
      if (isSensitiveFile(uri.fsPath)) {
        skipped.push(path.basename(uri.fsPath));
        continue;
      }
      let isDirectory = false;
      try {
        isDirectory = ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0;
      } catch {
        continue;
      }
      // Mentions resolve by reading the file as UTF-8 — media must attach instead.
      const ext = path.extname(uri.fsPath).toLowerCase();
      const isMedia =
        IMAGE_EXTENSIONS.has(ext) || !!DOCUMENT_MIME[ext] || !!audioFormatFromExt(ext) || VIDEO_EXTENSIONS.has(ext);
      const rel = vscode.workspace.getWorkspaceFolder(uri) ? toolRelPath(uri) : '';
      if (rel && !path.isAbsolute(rel) && !/\s/.test(rel) && (isDirectory || !isMedia)) {
        mentions.push(isDirectory ? `@${rel.replace(/\/+$/, '')}/ ` : `@${rel} `);
      } else if (!isDirectory) {
        attaches.push(uri);
      } else {
        skipped.push(path.basename(uri.fsPath));
      }
    }
    if (mentions.length > 0) {
      await this.postToComposer({ type: 'insertText', text: mentions.join('') });
    }
    if (attaches.length > 0) {
      await this.attachUris(attaches);
    }
    if (skipped.length > 0) {
      void vscode.window.showWarningMessage(
        `Parley: skipped ${skipped.join(', ')} — looks like credentials/secrets or can't be attached.`
      );
    }
    if (uriStrings.length > CAP) {
      void vscode.window.showWarningMessage(`Parley: only the first ${CAP} dropped files were added.`);
    }
  }

  /** A code/text file dropped from the OS shell: attach its text like the 📎 text branch. */
  private async addDroppedText(name: string, text: string): Promise<void> {
    if (!text) {
      return;
    }
    const label = name && name.trim() ? name.trim() : `dropped-${this.attachments.length + 1}.txt`;
    if (isSensitiveFile(label)) {
      void vscode.window.showWarningMessage(`Parley: skipped ${label} — looks like credentials/secrets.`);
      return;
    }
    if (text.includes('\u0000')) {
      void vscode.window.showWarningMessage(
        `Parley: ${label} looks like a binary file — drop images/PDF/audio, or use the 📎 button.`
      );
      return;
    }
    const maxChars = this.getSettings().contextMaxCharacters;
    const id = `att-${Date.now()}-${this.attachments.length}`;
    const content = text.length > maxChars ? text.slice(0, maxChars) : text;
    const ext = path.extname(label).toLowerCase();
    this.attachments.push({
      id,
      label,
      kind: 'text',
      rawText: text,
      mimeType: TEXT_UPLOAD_MIME[ext] ?? 'text/plain',
      text: { id, kind: 'user-file', label, content, characterCount: content.length, truncated: text.length > maxChars }
    });
    await this.postState();
  }

  /** Resolve the ffmpeg/ffprobe binaries from settings (falling back to PATH lookups). */
  private ffmpegBins(): FfmpegBinaries {
    const ffmpeg = this.getSettings().videoFfmpegPath || 'ffmpeg';
    return { ffmpeg, ffprobe: resolveFfprobePath(ffmpeg) };
  }

  /**
   * Parley has no video content type. With ffmpeg available we approximate it:
   * sample frames (sent to a vision model as images) and/or extract the audio
   * track (sent as an `input_audio` clip). Without ffmpeg we explain how to add it.
   */
  private async attachVideo(uri: vscode.Uri, label: string): Promise<void> {
    const bins = this.ffmpegBins();
    if (!(await hasFfmpeg(bins))) {
      const choice = await vscode.window.showWarningMessage(
        `Attaching video needs ffmpeg, which wasn't found. Install it and add it to your PATH (or set "parley.video.ffmpegPath"), then try again.`,
        'Get ffmpeg'
      );
      if (choice === 'Get ffmpeg') {
        await vscode.env.openExternal(vscode.Uri.parse('https://ffmpeg.org/download.html'));
      }
      return;
    }

    const FRAMES = {
      label: 'Sample frames (visual)',
      detail: 'Extract frames and send them as images to a vision model'
    };
    const AUDIO = {
      label: 'Extract audio (spoken)',
      detail: 'Send the audio track for transcription/understanding (OpenAI/Google)'
    };
    const BOTH = { label: 'Both frames and audio', detail: 'Visual frames plus the audio track' };
    const pick = await vscode.window.showQuickPick([FRAMES, AUDIO, BOTH], {
      title: `Attach "${label}" as…`,
      placeHolder: 'Parley has no native video; choose how to convey it'
    });
    if (!pick) {
      return;
    }

    const settings = this.getSettings();
    const wantFrames = pick === FRAMES || pick === BOTH;
    const wantAudio = pick === AUDIO || pick === BOTH;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Processing ${label} with ffmpeg…` },
      async () => {
        try {
          if (wantFrames) {
            const frames = await extractFrames(bins, uri.fsPath, {
              maxFrames: settings.videoMaxFrames,
              width: settings.videoFrameWidth
            });
            frames.forEach((frame, i) => {
              const frameLabel = `${label} #${i + 1}`;
              this.attachments.push({
                id: `att-${Date.now()}-${this.attachments.length}`,
                label: frameLabel,
                kind: 'image',
                image: { label: frameLabel, dataUri: `data:${frame.mime};base64,${frame.base64}` }
              });
            });
            if (frames.length === 0) {
              void vscode.window.showWarningMessage(`Parley: no frames could be extracted from ${label}.`);
            }
          }
          if (wantAudio) {
            const base64 = await extractAudioMp3(bins, uri.fsPath, { maxSeconds: settings.videoMaxAudioSeconds });
            const audioLabel = `${label} (audio)`;
            this.attachments.push({
              id: `att-${Date.now()}-${this.attachments.length}`,
              label: audioLabel,
              kind: 'audio',
              audio: { label: audioLabel, format: 'mp3', base64 }
            });
          }
        } catch (error) {
          this.logger.warn(`ffmpeg failed for ${uri.fsPath}: ${error instanceof Error ? error.message : 'unknown'}`);
          void vscode.window.showErrorMessage(
            `Parley could not process ${label} with ffmpeg. See the Parley output log for details.`
          );
        }
      }
    );
  }

  /** Attach a file pasted (Ctrl+V) or dropped into the composer as a base64 data URI (image or PDF). */
  private async addPastedFile(dataUri?: string, name?: string): Promise<void> {
    if (!dataUri) {
      return;
    }
    // Guard against pathologically large pastes (data URIs are ~33% larger than the bytes).
    const MAX_BYTES = 12 * 1024 * 1024;
    if (dataUri.length > MAX_BYTES * 1.4) {
      void vscode.window.showWarningMessage('Parley: that file is too large to attach (max ~12 MB).');
      return;
    }
    const id = `att-${Date.now()}-${this.attachments.length}`;
    const mime = dataUri.slice(5, dataUri.indexOf(';') > 0 ? dataUri.indexOf(';') : 5).toLowerCase();
    const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
    const audioFormat = audioFormatFromMime(mime);
    if (/^image\//.test(mime)) {
      const label = name && name.trim() ? name.trim() : `pasted-image-${this.attachments.length + 1}.png`;
      this.attachments.push({ id, label, kind: 'image', image: { label, dataUri } });
    } else if (mime === 'application/pdf') {
      const label = name && name.trim() ? name.trim() : `pasted-${this.attachments.length + 1}.pdf`;
      this.attachments.push({
        id,
        label,
        kind: 'document',
        document: { filename: label, mimeType: 'application/pdf', base64 }
      });
    } else if (audioFormat) {
      const label = name && name.trim() ? name.trim() : `pasted-${this.attachments.length + 1}.${audioFormat}`;
      this.attachments.push({ id, label, kind: 'audio', audio: { label, format: audioFormat, base64 } });
    } else {
      return;
    }
    await this.postState();
  }

  /** Ask the model to switch (Claude-Code-style `/model`), via a QuickPick of available models. */
  private async pickModel(): Promise<void> {
    const items = this.agents.map((a) => ({ label: a.label, description: a.id, detail: a.description }));
    if (items.length === 0) {
      await vscode.window.showInformationMessage('Parley: no models loaded yet. Set your API key and refresh.');
      return;
    }
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Parley: switch model',
      placeHolder: this.selectedAgentId || 'Choose a model for this conversation'
    });
    if (!pick) {
      return;
    }
    this.selectedAgentId = pick.description;
    this.save();
    this.history.push({
      role: 'assistant',
      content: `🔀 Switched model to \`${pick.description}\`.`,
      createdAt: new Date().toISOString()
    });
    await this.postState();
  }

  /** Offer compaction options (Claude-Code-style): summarize everything, or keep the recent turns. */
  public async promptCompact(): Promise<void> {
    if (this.history.length < 2) {
      await vscode.window.showInformationMessage('Parley: not enough conversation to compact yet.');
      return;
    }
    const ALL = { label: 'Summarize everything', detail: 'Replace the whole conversation with one summary' };
    const KEEP = {
      label: 'Summarize older, keep recent',
      detail: 'Summarize all but the last few messages (kept verbatim)'
    };
    const pick = await vscode.window.showQuickPick([KEEP, ALL], {
      title: 'Parley: compact conversation',
      placeHolder: 'Compaction is lossy — it replaces history with a summary'
    });
    if (!pick) {
      return;
    }
    await this.compactConversation(pick === KEEP ? 4 : 0);
  }

  /**
   * Compact the conversation: ask the model to summarize it, then replace the
   * history with that summary so the chat can continue with far fewer tokens.
   * With `keepRecent > 0`, the most recent N messages are kept verbatim after the
   * summary. Client-side only — works with any model; Parley has no such endpoint.
   */
  public async compactConversation(keepRecent = 0): Promise<void> {
    if (this.busy) {
      await vscode.window.showInformationMessage('Parley is still responding. Stop the current reply first.');
      return;
    }
    if (this.history.length < 2) {
      await vscode.window.showInformationMessage('Parley: not enough conversation to compact yet.');
      return;
    }

    const settings = this.getSettings();
    const model = this.selectedAgentId || settings.defaultAgent;
    const splitAt = keepRecent > 0 ? Math.max(0, this.history.length - keepRecent) : this.history.length;
    const toSummarize = this.history.slice(0, splitAt);
    const toKeep = this.history.slice(splitAt);
    if (toSummarize.length < 2) {
      await vscode.window.showInformationMessage('Parley: not enough older conversation to compact.');
      return;
    }
    const transcript = toSummarize
      .map((m) => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role}: ${m.content}`)
      .join('\n\n');
    const prompt =
      'Summarize the conversation below so it can continue seamlessly with far fewer tokens. ' +
      'Preserve key decisions, proposed code and file paths, the current goal, and any unresolved tasks. ' +
      'Be concise but complete, and output only the summary.\n\n---\n' +
      transcript;

    try {
      // Run under the turn runner's busy/abort lifecycle so the Stop button (which
      // calls turns.abort()) can actually cancel compaction, including auto-compaction.
      const summary = await this.turns.runExternal(async (signal) =>
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Compacting conversation…' },
          async () => {
            const response = await this.getProvider().sendMessage(
              {
                prompt,
                messages: [{ role: 'user', content: prompt, createdAt: new Date().toISOString() }],
                context: [],
                agentId: model
              },
              { signal }
            );
            return response.message.content;
          }
        )
      );

      const summaryMsg: ChatMessage = {
        role: 'assistant',
        content: `📦 **Compacted summary of the conversation so far**\n\n${summary}`,
        createdAt: new Date().toISOString(),
        model
      };
      this.history.length = 0;
      this.history.push(summaryMsg, ...toKeep);
      await this.autosaveConversation();
    } catch (error) {
      // A user Stop during compaction aborts the request — leave history unchanged.
      if ((error as { name?: string })?.name !== 'AbortError') {
        await reportProviderError(this.commandDeps, error);
      }
    }
  }

  /** Archive the current conversation into the saved-sessions list (most recent first, capped). */
  private archiveCurrent(): void {
    if (this.transcript.length === 0) {
      return;
    }
    const sessions = this.state.get<SavedSession[]>('parley.sessions', []);
    sessions.unshift({
      title: this.currentTitle(),
      savedAt: new Date().toISOString(),
      history: [...this.history],
      transcript: [...this.transcript],
      id: this.conversationId
    });
    void this.state.update('parley.sessions', sessions.slice(0, 20));
  }

  /** Human label for the current workspace, shown as the "repo" of a conversation. */
  private currentRepoLabel(): string {
    return (
      vscode.workspace.workspaceFolders?.[0]?.name ?? (path.basename(path.dirname(this.parleyBase())) || 'workspace')
    );
  }

  /**
   * Build the in-panel history list for the given scope and post it to the webview.
   * `repo` lists this workspace's `.parley` only; `all` merges every base in the
   * global registry (Codex-style). The webview filters client-side as the user types.
   */
  private async sendHistoryList(scope: 'repo' | 'all'): Promise<void> {
    const currentBase = this.parleyBase();
    const bases: Array<{ base: string; repo: string }> = [{ base: currentBase, repo: this.currentRepoLabel() }];
    if (scope === 'all') {
      const seen = new Set<string>([path.resolve(currentBase)]);
      for (const b of await transcriptStore.readBases(this.globalStorageUri.fsPath)) {
        const key = path.resolve(b.base);
        if (!seen.has(key)) {
          seen.add(key);
          bases.push({ base: b.base, repo: b.label || path.basename(b.base) });
        }
      }
    }

    type HistoryItem = {
      id: string;
      base: string;
      title: string;
      savedAt: string;
      model: string;
      events: number;
      repo: string;
      archived: boolean;
    };
    const items: HistoryItem[] = [];
    for (const { base, repo } of bases) {
      let idx: transcriptStore.ConversationIndexEntry[];
      try {
        idx = await transcriptStore.readIndex(base);
      } catch {
        continue;
      }
      for (const e of idx) {
        if (base === currentBase && e.id === this.conversationId) {
          continue; // don't list the live conversation
        }
        items.push({
          id: e.id,
          base,
          title: e.title || 'Conversation',
          savedAt: e.savedAt,
          model: e.model,
          events: e.events,
          repo,
          archived: e.archived === true
        });
      }
    }
    items.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
    this.post({ type: 'historyResults', scope, items: items.slice(0, 200) });
  }

  /**
   * Fetch this month's billed usage and post it to the webview's in-panel usage
   * popover (`usageInfo`). If no account id is configured yet, the popover shows
   * an inline input instead ('setUsageAccount' saves it and re-fetches).
   */
  private async sendUsageInfo(): Promise<void> {
    const accountId = vscode.workspace.getConfiguration('parley').get<string>('accountId', '').trim();
    if (!accountId) {
      this.post({ type: 'usageInfo', needsAccount: true });
      return;
    }
    try {
      const usage = await this.getProvider().getUsage(accountId);
      const lines = [
        `Billed: ${formatUsd(usage.costUsd)}`,
        `Requests: ${usage.interactionsCount.toLocaleString()}`,
        `Tokens: ${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out`
      ];
      if (usage.periodStart && usage.periodEnd) {
        lines.push(`Period: ${usage.periodStart.slice(0, 10)} → ${usage.periodEnd.slice(0, 10)}`);
      }
      this.post({ type: 'usageInfo', lines, accountId });
    } catch (error) {
      this.post({
        type: 'usageInfo',
        error: error instanceof Error ? error.message : 'Could not fetch usage.',
        accountId
      });
    }
  }

  /** Rename a saved (or the live) conversation, then refresh the list. The new title
   *  normally comes from the webview's inline rename input; the input box is a fallback. */
  private async renameConversationFlow(
    base: string,
    id: string,
    scope: 'repo' | 'all',
    newTitle?: string
  ): Promise<void> {
    if (!id) {
      return;
    }
    let entered = newTitle;
    if (entered === undefined) {
      const idx = await transcriptStore.readIndex(base);
      const current = idx.find((e) => e.id === id);
      entered = await vscode.window.showInputBox({
        title: 'Parley: rename conversation',
        value: current?.title ?? '',
        prompt: 'New title for this conversation',
        validateInput: (v) => (v.trim().length === 0 ? 'Title cannot be empty.' : undefined)
      });
    }
    if (entered === undefined || entered.trim().length === 0) {
      return; // cancelled
    }
    const title = entered.trim().slice(0, 120);
    await transcriptStore.renameConversation(base, id, title);
    // If it's the live conversation in this workspace, keep the in-memory title in sync.
    if (base === this.parleyBase() && id === this.conversationId) {
      this.recorder.customTitle = title;
      this.save();
      if (this.hostPanel) {
        this.hostPanel.title = `Parley — ${title}`;
      }
    }
    await this.sendHistoryList(scope);
  }

  /** Archive/unarchive a saved conversation (hides it from the default list), then refresh. */
  private async archiveConversationFlow(
    base: string,
    id: string,
    archived: boolean,
    scope: 'repo' | 'all'
  ): Promise<void> {
    if (!id) {
      return;
    }
    await transcriptStore.setConversationArchived(base, id, archived);
    await this.sendHistoryList(scope);
  }

  /** Delete a conversation (transcript files + index entry) after a confirm, then refresh.
   *  `confirmed` means the webview already showed its inline "Delete?" confirm. */
  private async deleteConversationFlow(
    base: string,
    id: string,
    scope: 'repo' | 'all',
    confirmed = false
  ): Promise<void> {
    if (!id) {
      return;
    }
    if (!confirmed) {
      const idx = await transcriptStore.readIndex(base);
      const current = idx.find((e) => e.id === id);
      const choice = await vscode.window.showWarningMessage(
        `Delete "${current?.title ?? 'this conversation'}"? This permanently removes its transcript from disk and can't be undone.`,
        { modal: true },
        'Delete'
      );
      if (choice !== 'Delete') {
        return;
      }
    }
    await transcriptStore.deleteConversation(base, id);
    // Deleting the live conversation: reset to a fresh one so we're not editing a ghost.
    if (base === this.parleyBase() && id === this.conversationId) {
      await this.startNewConversation();
    }
    await this.sendHistoryList(scope);
  }

  /**
   * Load a saved conversation (by base + id) into the chat, archiving the current one
   * first. Works for both this-repo and cross-repo (All repos) entries; checkpoints
   * bind under the conversation's own base so its edit history travels with it.
   */
  private async loadConversation(base: string, id: string): Promise<void> {
    if (!id) {
      return;
    }
    const transcript = await transcriptStore.readEvents(base, id);
    if (transcript.length === 0) {
      await vscode.window.showInformationMessage(
        'Parley: that conversation could not be loaded (it may have been removed).'
      );
      return;
    }
    // Preserve any custom (renamed) title from the index so re-autosave doesn't revert it.
    const savedTitle = (await transcriptStore.readIndex(base)).find((e) => e.id === id)?.title;
    await this.autosaveConversation();
    this.archiveCurrent();
    this.transcript = transcript;
    this.history.length = 0;
    this.history.push(...transcriptToHistory(transcript));
    this.conversationId = id;
    this.recorder.customTitle = savedTitle && savedTitle !== 'Conversation' ? savedTitle : undefined;
    this.conversationStartedAt = transcript[0]?.at ?? new Date().toISOString();
    this.attachments = [];
    this.executor.resetConversationState();
    this.sessionTokens = 0;
    this.sessionCost = 0;
    this.highUsageWarned = false;
    await this.checkpoints.bind(base, id);
    await this.reveal();
    await this.postState();
  }

  /** Pick a previously saved conversation and load its FULL transcript back into the chat. */
  public async openPastConversation(): Promise<void> {
    const base = this.parleyBase();
    const diskIndex = await transcriptStore.readIndex(base);
    const sessions = this.state.get<SavedSession[]>('parley.sessions', []);

    type Item = vscode.QuickPickItem & { source: 'disk' | 'session'; id?: string; index?: number };
    const items: Item[] = [];
    for (const e of diskIndex) {
      if (e.id === this.conversationId) {
        continue;
      }
      items.push({
        label: e.title || 'Conversation',
        description: `${new Date(e.savedAt).toLocaleString()} · ${e.events} events`,
        detail: e.model,
        source: 'disk',
        id: e.id
      });
    }
    sessions.forEach((s, index) => {
      if (s.id && (s.id === this.conversationId || diskIndex.some((e) => e.id === s.id))) {
        return; // already represented on disk
      }
      items.push({
        label: s.title || 'Conversation',
        description: `${new Date(s.savedAt).toLocaleString()} · ${s.transcript?.length ?? s.history.length} events (memory)`,
        source: 'session',
        index
      });
    });

    if (items.length === 0) {
      await vscode.window.showInformationMessage('Parley: no saved conversations yet.');
      return;
    }
    const pick = await this.pickConversationWithSearch(items, base);
    if (!pick) {
      return;
    }

    // Save & archive the current one before switching.
    await this.autosaveConversation();
    this.archiveCurrent();

    let transcript: TranscriptEntry[] = [];
    let id = this.newConversationId();
    if (pick.source === 'disk' && pick.id) {
      transcript = await transcriptStore.readEvents(base, pick.id);
      id = pick.id; // continue appending to the same canonical file
    } else if (pick.source === 'session' && pick.index !== undefined) {
      const s = sessions[pick.index];
      transcript = s.transcript ?? historyToTranscript(s.history);
      id = s.id ?? this.newConversationId();
    }

    this.transcript = transcript;
    this.history.length = 0;
    this.history.push(...transcriptToHistory(transcript));
    this.conversationId = id;
    this.recorder.customTitle = pick.label && pick.label !== 'Conversation' ? pick.label : undefined;
    this.conversationStartedAt = transcript[0]?.at ?? new Date().toISOString();
    this.attachments = [];
    this.executor.resetConversationState();
    this.sessionTokens = 0;
    this.sessionCost = 0;
    this.highUsageWarned = false;
    await this.checkpoints.bind(this.parleyBase(), this.conversationId);
    await vscode.commands.executeCommand('workbench.view.extension.parley');
    await vscode.commands.executeCommand('parley.chatView.focus');
    await this.ready;
    await this.postState();
  }

  /**
   * Conversation picker with full-text search: typing 3+ characters also greps the
   * on-disk JSONL transcripts (debounced, cached) and shows a match snippet per hit.
   */
  private pickConversationWithSearch<T extends vscode.QuickPickItem & { id?: string }>(
    items: T[],
    base: string
  ): Promise<T | undefined> {
    const qp = vscode.window.createQuickPick<T>();
    qp.title = 'Open a past Parley conversation';
    qp.placeholder = 'Filter by title — or type 3+ characters to search the full transcript text';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.items = items;
    const dir = transcriptStore.conversationsDir(base);
    const cache = new Map<string, string>(); // id → lowercased transcript text
    let timer: NodeJS.Timeout | undefined;
    let generation = 0;

    const loadText = async (id: string): Promise<string> => {
      const hit = cache.get(id);
      if (hit !== undefined) {
        return hit;
      }
      let text = '';
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(dir, `${id}.jsonl`)));
        text = Buffer.from(bytes).toString('utf8').toLowerCase();
      } catch {
        text = '';
      }
      cache.set(id, text);
      return text;
    };

    qp.onDidChangeValue((value) => {
      if (timer) {
        clearTimeout(timer);
      }
      const query = value.trim().toLowerCase();
      if (query.length < 3) {
        qp.items = items;
        return;
      }
      const gen = ++generation;
      timer = setTimeout(() => {
        void (async () => {
          qp.busy = true;
          const matched: T[] = [];
          for (const item of items) {
            if (gen !== generation) {
              return; // superseded by newer input
            }
            const meta = `${item.label} ${item.description ?? ''} ${item.detail ?? ''}`.toLowerCase();
            if (meta.includes(query)) {
              matched.push(item);
              continue;
            }
            if (!item.id) {
              continue; // in-memory session without an on-disk transcript
            }
            const text = await loadText(item.id);
            const at = text.indexOf(query);
            if (at !== -1) {
              // Show the surrounding context so the hit is recognizable. The snippet
              // contains the query, which also satisfies the QuickPick's own filter.
              const snippet = text.slice(Math.max(0, at - 40), at + query.length + 40).replace(/\s+/g, ' ');
              matched.push({ ...item, detail: `…${snippet}…` });
            }
          }
          if (gen === generation) {
            qp.items = matched;
            qp.busy = false;
          }
        })();
      }, 250);
    });

    return new Promise((resolve) => {
      qp.onDidAccept(() => {
        resolve(qp.selectedItems[0]);
        qp.hide();
      });
      qp.onDidHide(() => {
        resolve(undefined);
        qp.dispose();
      });
      qp.show();
    });
  }

  /**
   * Export the conversation. The canonical transcript on disk is completed/flushed first,
   * then a copy is written in the chosen format to a location the user picks.
   */
  public async exportConversation(fmt?: ExportFormat): Promise<void> {
    if (this.transcript.length === 0) {
      await vscode.window.showInformationMessage('Parley: there is no conversation to export yet.');
      return;
    }

    // The format is normally picked in the webview's in-panel menu; the QuickPick
    // is a fallback for the command-palette entry.
    let choice = fmt ? { ext: fmt, fmt } : undefined;
    if (!choice) {
      choice = await vscode.window.showQuickPick(
        [
          { label: 'Markdown (.md)', ext: 'md' as const, fmt: 'md' as const },
          { label: 'Plain text (.txt)', ext: 'txt' as const, fmt: 'txt' as const },
          { label: 'JSON (.json)', ext: 'json' as const, fmt: 'json' as const }
        ],
        { title: 'Export Parley conversation', placeHolder: 'Choose a format' }
      );
    }
    if (!choice) {
      return;
    }

    // Complete & save the canonical copy (JSONL + Markdown + index) before exporting a copy elsewhere.
    this.syncTranscriptFile();
    await this.autosaveConversation();

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `parley-conversation-${stamp}.${choice.ext}`;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const filters: Record<string, string[]> =
      choice.fmt === 'json' ? { JSON: ['json'] } : choice.fmt === 'txt' ? { Text: ['txt'] } : { Markdown: ['md'] };
    const uri = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder, fileName) : undefined,
      saveLabel: 'Export',
      filters
    });
    if (!uri) {
      return;
    }

    const meta = this.transcriptMeta();
    const content =
      choice.fmt === 'json'
        ? JSON.stringify({ metadata: meta, transcript: this.transcript }, null, 2)
        : choice.fmt === 'txt'
          ? transcriptToPlainText(meta, this.transcript)
          : transcriptToMarkdown(meta, this.transcript);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    await vscode.commands.executeCommand('vscode.open', uri);
    void vscode.window.showInformationMessage(
      `Parley conversation exported to ${vscode.workspace.asRelativePath(uri)}.`
    );
  }

  // ---------- tool execution delegation (owner: ToolExecutor, decomposition 3/4) ----------

  private runTool(call: ToolCall): Promise<string> {
    return this.executor.run(call);
  }

  private postProposedChange(change: { filePath: string; originalText: string; proposedText: string }): void {
    this.executor.postProposedChange(change);
  }

  /** Review/remove the workspace's approved agent commands ("Parley: Manage Allowed Commands"). */
  public manageAllowedCommands(): Promise<void> {
    return this.executor.manageAllowedCommands();
  }

  /** Resolve `@path` mentions in the prompt into file context attachments. */
  private async resolveMentions(prompt: string, settings: ParleySettings): Promise<ContextAttachment[]> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      return [];
    }
    const out: ContextAttachment[] = [];
    const cap = settings.contextMaxCharacters;

    // @codebase — lexically retrieve the most relevant files for the question.
    if (/(?:^|\s)@codebase\b/i.test(prompt) && settings.codebaseSearchEnabled) {
      out.push(...(await this.codebaseContext(prompt, root, settings)));
    }

    // @git — include the uncommitted diff vs HEAD.
    if (/(?:^|\s)@git\b/i.test(prompt)) {
      const diff = await runShellCommand('git --no-pager diff HEAD', root.fsPath, 15000);
      const content = (diff && diff !== '(no output)' ? diff : 'No uncommitted changes.').slice(0, cap);
      out.push({
        id: 'mention-git',
        kind: 'user-file',
        label: '@git (uncommitted diff)',
        content,
        characterCount: content.length,
        truncated: diff.length > content.length
      });
    }

    // @browser <url> — open the URL in the local browser and attach rendered text + any console errors.
    const browserMatch = /(?:^|\s)@browser\s+(\S+)/i.exec(prompt);
    if (browserMatch) {
      const url = browserMatch[1].replace(/[)\].,;]+$/, '');
      const browser = getBrowserManager(this.globalStorageUri, this.logger);
      const rendered = await browser.navigate(url);
      const errors = rendered.startsWith('Error') ? '' : `\n\nConsole:\n${browser.consoleOutput(true)}`;
      const content = `${rendered}${errors}`.slice(0, cap);
      out.push({
        id: 'mention-browser',
        kind: 'user-file',
        label: `@browser ${url}`,
        content,
        characterCount: content.length,
        truncated: rendered.length + errors.length > content.length
      });
    }

    // @terminal — recent integrated-terminal commands and their output (shell integration).
    if (/(?:^|\s)@terminal\b/i.test(prompt)) {
      const snap = terminalSnapshot();
      const content = snap.slice(0, cap);
      out.push({
        id: 'mention-terminal',
        kind: 'user-file',
        label: '@terminal (recent output)',
        content,
        characterCount: content.length,
        truncated: snap.length > content.length
      });
    }

    // @<url> — fetch the page text.
    for (const m of prompt.matchAll(/(?:^|\s)@(https?:\/\/\S+)/gi)) {
      const url = m[1].replace(/[)\].,;]+$/, '');
      const text = await runAgentTool({ id: '', name: 'fetch_url', arguments: JSON.stringify({ url }) });
      const content = text.slice(0, cap);
      out.push({
        id: `mention-url-${url}`,
        kind: 'user-file',
        label: `@${url}`,
        content,
        characterCount: content.length,
        truncated: text.length > content.length
      });
    }

    // @path — a file's contents (optionally a #12-40 line range), or a folder's listing.
    for (const token of extractMentionPaths(prompt)) {
      if (
        token === 'git' ||
        token === 'codebase' ||
        token === 'terminal' ||
        token === 'browser' ||
        /^https?:/i.test(token)
      ) {
        continue;
      }
      const { path: rel, startLine, endLine } = parseMentionRange(token);
      if (isSensitiveFile(rel)) {
        continue;
      }
      try {
        // resolveAcrossRoots returns undefined for a path that escapes the workspace
        // (e.g. @../../../etc/passwd); skip it rather than reading outside the root.
        const uri = await resolveAcrossRoots(rel);
        if (!uri) {
          continue;
        }
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type === vscode.FileType.Directory) {
          // RelativePattern anchors the glob to the resolved folder, which also makes
          // folder-name-prefixed mentions work in multi-root workspaces.
          const files = await vscode.workspace.findFiles(
            new vscode.RelativePattern(uri, '**/*'),
            '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}',
            60
          );
          const listing =
            files
              .map((u) => toolRelPath(u))
              .filter((r) => !isSensitiveFile(r))
              .join('\n') || '(empty)';
          const content = listing.slice(0, cap);
          out.push({
            id: `mention-dir-${rel}`,
            kind: 'user-file',
            label: `@${rel}/ (folder)`,
            content,
            characterCount: content.length,
            truncated: listing.length > content.length
          });
          continue;
        }
        const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        let text = raw;
        let label = `@${rel}`;
        if (startLine !== undefined) {
          const lines = raw.split('\n');
          const from = Math.min(startLine, lines.length);
          const to = Math.min(endLine ?? startLine, lines.length);
          text = lines.slice(from - 1, to).join('\n');
          label = `@${rel} (lines ${from}-${to})`;
        }
        const content = text.length > cap ? text.slice(0, cap) : text;
        out.push({
          id: `mention-${token}`,
          kind: 'user-file',
          label,
          filePath: uri.fsPath,
          content,
          characterCount: content.length,
          truncated: text.length > content.length
        });
      } catch {
        // Not a readable file/dir (probably a normal "@mention" word) — ignore.
      }
    }
    return out;
  }

  /**
   * `@codebase` retrieval: rank workspace files lexically against the prompt and
   * include the most relevant ones as context. Keyless/private — no embeddings.
   */
  private async codebaseContext(
    prompt: string,
    root: vscode.Uri,
    settings: ParleySettings
  ): Promise<ContextAttachment[]> {
    const query = prompt.replace(/(?:^|\s)@\S+/g, ' ').trim() || prompt;
    const docs = await this.gatherCodebaseDocs(settings.respectGitignore);
    if (docs.length === 0) {
      return [];
    }
    const textById = new Map(docs.map((d) => [d.path, d.text]));

    // Prefer the opt-in local semantic index; fall back to lexical if it's not built or fails.
    let order: string[] | undefined;
    if (settings.codebaseSearchProvider === 'local') {
      this.embeddingIndex ??= new EmbeddingIndex(this.globalStorageUri, this.logger);
      order = await this.embeddingIndex.search(root.fsPath, query, settings.codebaseMaxFiles);
    }
    if (!order) {
      order = lexicalRank(query, docs)
        .slice(0, settings.codebaseMaxFiles)
        .map((r) => r.id);
    }

    const perFileCap = Math.max(2000, Math.floor(settings.contextMaxCharacters / Math.max(1, order.length)));
    return order
      .filter((id) => textById.has(id))
      .map((id) => {
        const raw = textById.get(id) ?? '';
        const content = raw.length > perFileCap ? raw.slice(0, perFileCap) : raw;
        return {
          id: `codebase-${id}`,
          kind: 'user-file' as const,
          label: `@codebase ${id}`,
          filePath: vscode.Uri.joinPath(root, id).fsPath,
          content,
          characterCount: content.length,
          truncated: raw.length > content.length
        };
      });
  }

  /** Read indexable workspace files (skip binaries, huge files, node_modules, sensitive, gitignored). */
  private async gatherCodebaseDocs(respectGitignore: boolean): Promise<RankDoc[]> {
    let files: vscode.Uri[];
    try {
      files = await vscode.workspace.findFiles(
        '**/*',
        '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/.vscode-test/**}',
        2000
      );
    } catch {
      return [];
    }
    // Honor .gitignore/.parleyignore per root — @codebase is the highest-volume upload
    // path, and a user who gitignores a file expects it excluded here too.
    const matchers = new Map<string, IgnoreMatcher>();
    for (const wf of vscode.workspace.workspaceFolders ?? []) {
      if (wf.uri.scheme === 'file') {
        matchers.set(wf.uri.fsPath, await loadIgnoreMatcher(wf.uri.fsPath, respectGitignore));
      }
    }
    const docs: RankDoc[] = [];
    for (const uri of files) {
      const rel = toolRelPath(uri); // folder-prefixed in multi-root workspaces
      if (isSensitiveFile(rel)) {
        continue;
      }
      const wf = vscode.workspace.getWorkspaceFolder(uri);
      const matcher = wf && matchers.get(wf.uri.fsPath);
      if (matcher?.ignores(uri.fsPath)) {
        continue;
      }
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.byteLength > 200000 || bytes.includes(0)) {
          continue; // skip very large or binary files
        }
        docs.push({ id: rel, path: rel, text: Buffer.from(bytes).toString('utf8') });
      } catch {
        // unreadable — skip
      }
    }
    return docs;
  }

  /** Build the local semantic index for `@codebase` (the `Parley: Rebuild Codebase Index` command). */
  public async rebuildCodebaseIndex(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      await vscode.window.showWarningMessage('Parley: open a folder to index.');
      return;
    }
    this.embeddingIndex ??= new EmbeddingIndex(this.globalStorageUri, this.logger);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Parley: building local codebase index…' },
        async () => {
          const docs = await this.gatherCodebaseDocs(this.getSettings().respectGitignore);
          const n = await this.embeddingIndex!.build(root.fsPath, docs);
          void vscode.window.showInformationMessage(`Parley indexed ${n} files for semantic @codebase search.`);
        }
      );
    } catch (error) {
      await vscode.window.showErrorMessage(
        `Parley: could not build the local index (${error instanceof Error ? error.message : 'unknown'}). @codebase will use lexical search. See the Parley output log.`
      );
    }
  }

  /**
   * Workspace files + folders offered by the @-mention autocomplete, cached for a
   * few seconds so per-keystroke queries don't re-walk the workspace.
   */
  private async mentionCandidates(): Promise<{ files: string[]; dirs: string[] }> {
    const TTL_MS = 15000;
    if (this.mentionCache && Date.now() - this.mentionCache.at < TTL_MS) {
      return this.mentionCache;
    }
    let files: string[] = [];
    try {
      const uris = await vscode.workspace.findFiles(
        '**/*',
        '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}',
        2000
      );
      files = uris
        .map((uri) => toolRelPath(uri)) // folder-prefixed in multi-root workspaces
        // Paths with spaces can't be @-mentioned (mentions are space-delimited),
        // so offering them would only produce dead mentions.
        .filter((rel) => !isSensitiveFile(rel) && !/\s/.test(rel));
    } catch {
      files = [];
    }
    // Folders derived from the file list, offered with a trailing '/'.
    const dirSet = new Set<string>();
    for (const rel of files) {
      let at = rel.indexOf('/');
      while (at > 0 && dirSet.size < 400) {
        dirSet.add(rel.slice(0, at + 1));
        at = rel.indexOf('/', at + 1);
      }
    }
    this.mentionCache = { at: Date.now(), files, dirs: [...dirSet] };
    return this.mentionCache;
  }

  /** Answer an @-mention autocomplete query with fuzzy-ranked workspace paths. */
  private async sendMentionResults(query: string, seq?: number): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.post({ type: 'mentionResults', items: [], seq });
      return;
    }
    // Match on the path part only — a typed '#12-40' range isn't part of the name.
    const cleaned = query
      .split('#')[0]
      .replace(/\\/g, '/')
      .replace(/[^\w ./-]/g, '');
    const q = cleaned.toLowerCase();
    const special = SPECIAL_MENTIONS.filter((s) => s.path.startsWith(q)).map((s) => ({ ...s }));
    const { files, dirs } = await this.mentionCandidates();
    // Files open in the editor rank above cold ones.
    const open = new Set(
      vscode.workspace.textDocuments.filter((d) => d.uri.scheme === 'file').map((d) => toolRelPath(d.uri))
    );
    let ranked = rankMentionPaths(cleaned, [...files, ...dirs], { limit: 8, boost: open });
    if (ranked.length === 0 && cleaned) {
      // Very large workspaces can exceed the cached candidate cap — fall back to a
      // directed substring glob so those files are still reachable.
      try {
        const extra = await vscode.workspace.findFiles(
          `**/*${cleaned}*`,
          '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}',
          30
        );
        ranked = rankMentionPaths(
          cleaned,
          extra.map((u) => toolRelPath(u)).filter((rel) => !isSensitiveFile(rel) && !/\s/.test(rel)),
          { limit: 8, boost: open }
        );
      } catch {
        // Keep the empty result.
      }
    }
    const items = [...special, ...ranked.map((p) => ({ path: p }))].slice(0, 8);
    this.post({ type: 'mentionResults', items, seq });
  }

  /**
   * Project rules for the system prompt, gathered from EVERY workspace root: the
   * first single-file rules file per root (.parleyrules / AGENTS.md / .cursorrules),
   * plus directory rules from `.parley/rules/` and `.cursor/rules/`. Glob-scoped
   * rules attach when the active editor file — or ANY file the agent has read or
   * edited this conversation — matches their frontmatter globs (Cursor-compatible).
   */
  private async readProjectRules(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      return undefined;
    }
    const parts: string[] = [];
    for (const folder of folders) {
      for (const name of PROJECT_RULES_FILES) {
        try {
          const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, name))).toString(
            'utf8'
          );
          if (raw.trim().length > 0) {
            parts.push(raw.slice(0, 8000));
            break; // one single-file rules file per root
          }
        } catch {
          // Not present; try the next.
        }
      }
    }

    const active = vscode.window.activeTextEditor?.document;
    const candidates: Array<string | undefined> = [
      active && active.uri.scheme === 'file'
        ? vscode.workspace.asRelativePath(active.uri, false).replace(/\\/g, '/')
        : undefined,
      // Files the agent has read/edited this conversation can activate glob rules too.
      ...this.executor
        .touchedFiles()
        .map((fsPath) => vscode.workspace.asRelativePath(vscode.Uri.file(fsPath), false).replace(/\\/g, '/'))
    ];
    for (const folder of folders) {
      for (const dir of RULES_DIRS) {
        let entries: Array<[string, vscode.FileType]>;
        try {
          entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(folder.uri, dir));
        } catch {
          continue; // Directory absent.
        }
        for (const [name, type] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
          if (type !== vscode.FileType.File || !/\.(md|mdc)$/i.test(name)) {
            continue;
          }
          try {
            const raw = Buffer.from(
              await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, dir, name))
            ).toString('utf8');
            const rule = parseRuleFile(raw);
            if (rule.body && ruleApplies(rule, candidates)) {
              parts.push(`## Rule: ${rule.description ?? name}\n${rule.body.slice(0, 4000)}`);
            }
          } catch {
            // Unreadable rule — skip.
          }
        }
      }
    }
    const combined = parts.join('\n\n').trim();
    return combined ? combined.slice(0, 12000) : undefined;
  }

  private async refreshAgents(): Promise<void> {
    try {
      this.agents = await this.getProvider().listAgents();
      const ids = new Set(this.agents.map((agent) => agent.id));
      if (!this.selectedAgentId || !ids.has(this.selectedAgentId)) {
        const preferred = this.getSettings().defaultAgent;
        this.selectedAgentId = ids.has(preferred) ? preferred : (this.agents[0]?.id ?? preferred);
      }
    } catch (error) {
      this.logger.warn(error instanceof Error ? error.message : 'Failed to list Parley agents.');
      this.agents = [{ id: this.getSettings().defaultAgent, label: this.getSettings().defaultAgent }];
    }
    await this.refreshCustomCommands();
    await this.postState();
  }

  private post(message: Record<string, unknown>): void {
    try {
      void this.view?.webview.postMessage(message);
    } catch {
      // The hosting webview was disposed (e.g. a closed tab) — nothing to update.
    }
  }

  private async postState(): Promise<void> {
    this.save();
    this.notifyStatus(); // busy flips and counter resets all funnel through here
    const hasKey = Boolean(await this.commandDeps.auth.getToken());
    const model = this.selectedAgentId || this.getSettings().defaultAgent;
    const window = contextWindowFor(model);
    const contextPct = window ? Math.min(100, Math.round((this.estimateHistoryTokens() / window) * 100)) : undefined;
    this.post({
      type: 'state',
      history: this.history,
      transcript: this.transcript,
      pendingChangeIds: this.executor.pendingIds(),
      agents: this.agents,
      hasKey,
      busy: this.busy,
      mode: this.mode,
      sessionTokens: this.sessionTokens,
      sessionCostUsd: this.sessionCost,
      contextPct,
      selectedAgentId: this.selectedAgentId,
      selectedThinking: this.selectedThinking,
      selectedSpeed: this.selectedSpeed,
      customCommands: this.customCommands.map((c) => ({ name: c.name, description: c.description })),
      promptHistory: this.promptHistory,
      contextOptions: this.contextOptions,
      selectionInfo: this.currentSelectionInfo(),
      attachments: this.attachments.map((a) => ({ id: a.id, label: a.label, kind: a.kind }))
    });
  }
}

/** Reconstruct the model-facing message history from a transcript (user/assistant text only). */
function transcriptToHistory(entries: readonly TranscriptEntry[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const e of entries) {
    if (e.kind === 'user') {
      out.push({ role: 'user', content: e.text, createdAt: e.at });
    } else if (e.kind === 'assistant') {
      out.push({ role: 'assistant', content: e.text, model: e.model, thinking: e.thinking, createdAt: e.at });
    }
  }
  return out;
}

/** Build a minimal transcript from a plain message history (for migrating older saved sessions). */
function historyToTranscript(history: readonly ChatMessage[]): TranscriptEntry[] {
  return history.map((m) => {
    const at = m.createdAt ?? new Date().toISOString();
    if (m.role === 'user') {
      return { kind: 'user', text: m.content, at };
    }
    if (m.role === 'assistant') {
      return { kind: 'assistant', text: m.content, model: m.model, thinking: m.thinking, at };
    }
    return { kind: 'note', text: m.content, at };
  });
}

function normalizeMode(value: string | undefined): ChatMode {
  return value === 'ask' || value === 'edit' || value === 'plan' || value === 'auto' || value === 'full'
    ? value
    : 'chat';
}

/** Heuristic: model families on Parley that accept image input. */
function isLikelyVisionModel(model: string): boolean {
  return /claude|gemini|gpt-5/i.test(model);
}
