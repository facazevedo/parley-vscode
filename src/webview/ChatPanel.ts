import * as path from 'path';
import * as vscode from 'vscode';
import type { ChatMode, ParleySettings } from '../config/settings';
import {
  collectCommandContext,
  handleResponse,
  previewAndConfirmContext,
  reportProviderError,
  type CommandDependencies,
  type ContextOptions
} from '../commands/common';
import { exec } from 'child_process';
import { createHash } from 'crypto';
import { totalCharacters } from '../context/contextPreview';
import { isSensitiveFile } from '../context/sensitiveFileFilter';
import type { CheckpointStore } from '../diff/checkpoints';
import { applySnippetEdit } from '../diff/editMatch';
import { reviewProposedEdit } from '../diff/reviewEdit';
import { formatUnifiedDiff } from '../diff/lineDiff';
import { showProposedDiff } from '../diff/showDiff';
import type { Logger } from '../logging/logger';
import type { ParleyProvider } from '../parley/ParleyProvider';
import { extractMentionPaths } from '../parley/parsing';
import { AGENT_TOOLS, READ_ONLY_TOOLS, runAgentTool } from '../parley/tools';
import { normalizeThinkingLevel, resolveThinking, type ThinkingLevel } from '../parley/thinking';
import { audioFormatFromExt, audioFormatFromMime, modelSupportsAudio } from '../parley/audio';
import { clampMiddle } from '../parley/clampText';
import { documentProviderFor } from '../parley/files';
import { contextWindowFor, modelSupportsThinking } from '../parley/models';
import { estimateCostUsd, formatUsd } from '../parley/pricing';
import { armDebugFile, dbg } from '../debug/debug';
import type { McpManager } from '../mcp/McpManager';
import { isMcpTool } from '../mcp/naming';
import { webSearch } from '../web/webSearch';
import { lexicalRank, type RankDoc } from '../codebase/lexicalSearch';
import { EmbeddingIndex } from '../codebase/embeddingIndex';
import {
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
// User-defined slash commands: a `name.md` here becomes `/name` whose body is the prompt
// (with `$ARGS` replaced by anything typed after the command).
const CUSTOM_COMMAND_DIRS = ['.parley/commands', '.claude/commands'];

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
    | 'copyText'
    | 'openLink'
    | 'mentionQuery'
    | 'applyChange'
    | 'dismissChange'
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

  private view?: vscode.WebviewView;
  private readonly history: ChatMessage[] = [];
  // Full ordered record of everything shown (messages, tool activity, diffs, plans, notes).
  // The canonical copy is the per-conversation .jsonl on disk; this mirrors it for rendering.
  private transcript: TranscriptEntry[] = [];
  private conversationStartedAt = new Date().toISOString();
  private lastToolAction = ''; // pairs a tool's ⏺ action with its ⎿ result for the transcript
  private agents: readonly AgentInfo[] = [];
  private selectedAgentId = '';
  private selectedThinking: ThinkingLevel = 'off';
  private selectedSpeed: 'standard' | 'fast' = 'standard';
  private contextOptions: Required<ContextOptions> = { ...DEFAULT_CONTEXT_OPTIONS };
  private mode: ChatMode = 'chat';
  private sessionTokens = 0;
  private sessionCost = 0;
  private jsonNext = false; // one-shot: request the next reply as a JSON object (/json)
  private conversationId = ''; // stable id → filename for the auto-saved transcript
  private customCommandNames: string[] = []; // user-defined /commands from .parley|.claude/commands
  private commandChannel?: vscode.OutputChannel; // visible mirror of agent shell commands
  private embeddingIndex?: EmbeddingIndex; // lazy local semantic index for @codebase
  // Proposed file changes from a chat-mode reply, awaiting an inline Apply click.
  private readonly pendingChanges = new Map<
    string,
    { uri: vscode.Uri; rel: string; original: string; proposedText: string }
  >();
  private changeSeq = 0;
  private attachments: PendingAttachment[] = [];
  private busy = false;
  private abortController?: AbortController;
  // Content hashes of files the agent has read this conversation — staleness detection
  // for write_file (don't clobber unseen changes) and better edit_file errors.
  private readonly fileReadHashes = new Map<string, string>();

  private resolveReady!: () => void;
  private readonly ready = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
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
    this.conversationId = this.state.get<string>('parley.conversationId', '') || this.newConversationId();
  }

  private save(): void {
    void this.state.update('parley.history', this.history);
    void this.state.update('parley.transcript', this.transcript);
    void this.state.update('parley.conversationStartedAt', this.conversationStartedAt);
    void this.state.update('parley.selectedAgentId', this.selectedAgentId);
    void this.state.update('parley.selectedThinking', this.selectedThinking);
    void this.state.update('parley.selectedSpeed', this.selectedSpeed);
    void this.state.update('parley.mode', this.mode);
    void this.state.update('parley.sessionTokens', this.sessionTokens);
    void this.state.update('parley.sessionCost', this.sessionCost);
    void this.state.update('parley.conversationId', this.conversationId);
  }

  private newConversationId(): string {
    return 'parley-' + new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  }

  /**
   * Base `.parley` folder: `parley.conversationsDir` if set, else `<workspace>/.parley`,
   * else the extension's global storage. Holds `conversations/`, `index.json`, `state.json`.
   */
  private parleyBase(): string {
    const custom = this.getSettings().conversationsDir;
    if (custom) {
      return custom;
    }
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
    return ws ? path.join(ws.fsPath, '.parley') : path.join(this.globalStorageUri.fsPath, 'parley');
  }

  /** Reveal folder for the auto-save location (compat with the old name). */
  private conversationsDir(): vscode.Uri {
    return vscode.Uri.file(transcriptStore.conversationsDir(this.parleyBase()));
  }

  private currentTitle(): string {
    const firstUser = this.transcript.find((e) => e.kind === 'user') as { text?: string } | undefined;
    return (firstUser?.text ?? 'Conversation').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Conversation';
  }

  private transcriptMeta(): TranscriptMeta {
    const models = [...new Set(this.transcript.flatMap((e) => (e.kind === 'assistant' && e.model ? [e.model] : [])))];
    return {
      id: this.conversationId,
      title: this.currentTitle(),
      createdAt: this.conversationStartedAt,
      exportedAt: new Date().toISOString(),
      models: models.length > 0 ? models : [this.selectedAgentId || this.getSettings().defaultAgent],
      mode: this.mode,
      thinking: this.selectedThinking,
      speed: this.selectedSpeed,
      messages: this.transcript.filter((e) => e.kind === 'user' || e.kind === 'assistant').length,
      sessionTokens: this.sessionTokens,
      estimatedCostUsd: this.sessionCost
    };
  }

  /** Append one transcript event in memory and (best-effort) to its on-disk JSONL log. */
  private appendTranscript(entry: TranscriptEntry): TranscriptEntry {
    this.transcript.push(entry);
    if (this.getSettings().autoSaveConversations) {
      void transcriptStore
        .appendEvent(this.parleyBase(), this.conversationId, entry)
        .catch((error) =>
          this.logger.debug(`transcript append failed: ${error instanceof Error ? error.message : 'error'}`)
        );
    }
    return entry;
  }

  /** Rewrite the canonical JSONL (used after an in-place status change, e.g. Apply/Dismiss). */
  private syncTranscriptFile(): void {
    if (!this.getSettings().autoSaveConversations) {
      return;
    }
    void transcriptStore
      .writeEvents(this.parleyBase(), this.conversationId, this.transcript)
      .catch((error) =>
        this.logger.debug(`transcript sync failed: ${error instanceof Error ? error.message : 'error'}`)
      );
  }

  /** Write the human-readable .md, update the index, and persist Parley params. Best-effort. */
  private async autosaveConversation(): Promise<void> {
    if (!this.getSettings().autoSaveConversations || this.transcript.length === 0) {
      return;
    }
    const base = this.parleyBase();
    const meta = this.transcriptMeta();
    try {
      await transcriptStore.ensureGitignore(base);
      await transcriptStore.writeMarkdown(base, this.conversationId, transcriptToMarkdown(meta, this.transcript));
      await transcriptStore.upsertIndex(base, {
        id: this.conversationId,
        title: meta.title,
        savedAt: meta.exportedAt ?? meta.createdAt,
        model: meta.models[0] ?? '',
        events: this.transcript.length
      });
      await transcriptStore.writeState(base, {
        lastConversationId: this.conversationId,
        selectedAgentId: this.selectedAgentId,
        mode: this.mode,
        thinking: this.selectedThinking,
        speed: this.selectedSpeed,
        updatedAt: meta.exportedAt
      });
    } catch (error) {
      this.logger.warn(`Could not auto-save conversation: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  /** Save & archive the current conversation, then reset to a fresh one. */
  private async startNewConversation(): Promise<void> {
    await this.autosaveConversation();
    this.archiveCurrent();
    this.history.length = 0;
    this.transcript = [];
    this.attachments = [];
    this.fileReadHashes.clear();
    this.sessionTokens = 0;
    this.sessionCost = 0;
    this.conversationId = this.newConversationId();
    this.conversationStartedAt = new Date().toISOString();
    await this.postState();
  }

  /** Public entry point for the "New Conversation" command. */
  public async newConversation(): Promise<void> {
    this.abortController?.abort();
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
    this.view = webviewView;
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webview.html = this.getHtml(webview);

    webview.onDidReceiveMessage((message: ChatPanelMessage) => {
      void this.handleMessage(message);
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
    switch (message.type) {
      case 'refreshAgents':
        await this.refreshAgents();
        return;
      case 'setApiKey':
        await vscode.commands.executeCommand('parley.setApiKey');
        await this.refreshAgents();
        return;
      case 'stop':
        this.abortController?.abort();
        return;
      case 'newChat':
        this.abortController?.abort();
        await this.startNewConversation();
        return;
      case 'openHistory':
        await this.openPastConversation();
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
        await this.exportConversation();
        return;
      case 'compact':
        await this.promptCompact();
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
        await this.sendMentionResults(message.query ?? '');
        return;
      case 'applyChange':
        await this.applyPendingChange(message.id ?? '');
        return;
      case 'dismissChange':
        this.pendingChanges.delete(message.id ?? '');
        this.post({ type: 'changeResolved', id: message.id ?? '', status: 'dismissed' });
        this.resolveTranscriptChange(message.id ?? '', 'dismissed');
        return;
      case 'removeAttachment':
        this.attachments = this.attachments.filter((item) => item.id !== message.id);
        await this.postState();
        return;
      case 'contextOptionsChanged':
        if (message.contextOptions) {
          this.contextOptions = { ...DEFAULT_CONTEXT_OPTIONS, ...message.contextOptions };
        }
        return;
      case 'send':
        if (message.prompt?.trim()) {
          const text = message.prompt.trim();
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

  /** Handle composer slash commands. Returns true if the input was a known command. */
  private async handleSlash(input: string): Promise<boolean> {
    const cmd = input.slice(1).split(/\s+/)[0].toLowerCase();
    switch (cmd) {
      case 'clear':
      case 'new':
        await this.startNewConversation();
        return true;
      case 'compact':
        await this.promptCompact();
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
            '**Slash commands**\n- `/clear` (or `/new`) — start a new conversation\n- `/compact` — summarize to free up context (choose keep-recent or all)\n- `/cost` — show this conversation\'s token/cost usage\n- `/model` — switch the model\n- `/init` — create a project rules file (AGENTS.md)\n- `/json` — make the next reply a JSON object\n- `/help` — this list\n\n**Custom commands:** add a `name.md` file under `.parley/commands/` (or `.claude/commands/`) and it becomes `/name` — its text is used as the prompt, with `$ARGS` replaced by anything you type after the command.\n\nMost actions also have commands in the Command Palette (search "Parley").',
          createdAt: new Date().toISOString()
        });
        await this.postState();
        return true;
      default:
        return this.runCustomCommand(cmd, input);
    }
  }

  /** Scan the workspace for user-defined `/command` markdown files (cached for the slash menu). */
  private async refreshCustomCommands(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      this.customCommandNames = [];
      return;
    }
    const names = new Set<string>();
    for (const dir of CUSTOM_COMMAND_DIRS) {
      try {
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, dir));
        for (const [name, type] of entries) {
          if (type === vscode.FileType.File && name.toLowerCase().endsWith('.md')) {
            names.add(name.slice(0, -3));
          }
        }
      } catch {
        // Directory absent — fine.
      }
    }
    this.customCommandNames = [...names].sort((a, b) => a.localeCompare(b));
  }

  /** Run a user-defined `/command`: expand its file body (with `$ARGS`) and send it as a turn. */
  private async runCustomCommand(name: string, input: string): Promise<boolean> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      return false;
    }
    const match = this.customCommandNames.find((n) => n.toLowerCase() === name);
    if (!match) {
      return false;
    }
    for (const dir of CUSTOM_COMMAND_DIRS) {
      try {
        const body = Buffer.from(
          await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, dir, `${match}.md`))
        ).toString('utf8');
        const args = input.replace(/^\/\S+\s*/, '').trim();
        const expanded = /\$ARGS/.test(body) ? body.replace(/\$ARGS/g, args) : args ? `${body}\n\n${args}` : body;
        await this.runTurn(expanded, this.contextOptions);
        return true;
      } catch {
        // Try the next directory.
      }
    }
    return false;
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
    await this.postState();
    await this.runTurn(prompt, this.contextOptions);
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
    if (settings.tokenLimit > 0 && this.sessionTokens >= settings.tokenLimit) {
      await vscode.window.showWarningMessage(
        `Parley token limit reached for this conversation (${this.sessionTokens.toLocaleString()} / ${settings.tokenLimit.toLocaleString()}). Start a new conversation or raise "parley.tokenLimit".`
      );
      return;
    }
    const collected = await collectCommandContext(contextOptions, settings);
    const mentions = await this.resolveMentions(prompt, settings);
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
        uploadedTextDocs.push({
          filename: a.label,
          mimeType: a.mimeType ?? 'text/plain',
          base64: Buffer.from(a.rawText, 'utf8').toString('base64')
        });
      } else {
        inlineText.push(a.text);
      }
    }
    const context = [...collected, ...inlineText, ...mentions];
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
        return;
      }
    }

    this.history.push({ role: 'user', content: prompt, createdAt: new Date().toISOString() });
    this.appendTranscript({ kind: 'user', text: prompt, at: new Date().toISOString() });
    // Surface the OpenAI-reasoning-no-op hint on the first send with that combo, even if the
    // level was carried over from a previous session (no change event would have fired).
    this.maybeWarnOpenAiReasoning();
    this.attachments = [];
    this.busy = true;
    this.abortController = new AbortController();
    await this.postState();

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
    const baseTools = this.mode === 'plan' ? READ_ONLY_TOOLS : AGENT_TOOLS;
    const turnTools = toolsEnabled
      ? this.mode === 'plan'
        ? baseTools
        : [...baseTools, ...this.mcp.getTools()]
      : undefined;

    let turnTokens = 0;
    const cpStart = this.checkpoints.size;
    this.post({ type: 'tokens', total: 0 });
    dbg('turn', 'start', {
      agentId,
      mode: this.mode,
      toolsEnabled,
      canAutoContinue,
      stream: useStream,
      thinking: this.selectedThinking,
      speed: this.selectedSpeed,
      mcpTools: this.mcp.getTools().length
    });

    try {
      let auto = 0;
      let nudged = false; // one free "your reply was empty" retry before declaring a stall
      let continuation: string | null = null; // null = first send (real prompt + context)
      for (;;) {
        const stepActions: string[] = []; // tool activity for this step (persisted if the model doesn't narrate)
        if (useStream) {
          this.post({ type: 'streamStart' });
        }
        const isCont = continuation !== null;
        const contText = continuation ?? '';
        const messages = isCont
          ? [...this.history, { role: 'user' as const, content: contText, createdAt: new Date().toISOString() }]
          : this.history;

        const response = await provider.sendMessage(
          {
            prompt: isCont ? contText : prompt,
            messages,
            context: isCont ? [] : context,
            agentId,
            images: isCont || images.length === 0 ? undefined : images,
            documents: isCont || documents.length === 0 ? undefined : documents,
            audios: isCont || audios.length === 0 ? undefined : audios,
            thinking: resolveThinking(this.selectedThinking),
            speed: this.selectedSpeed,
            responseFormat,
            systemExtra
          },
          {
            signal: this.abortController.signal,
            onToken: useStream ? (delta) => this.post({ type: 'streamDelta', delta }) : undefined,
            onThinking: useStream ? (delta) => this.post({ type: 'thinkingDelta', delta }) : undefined,
            tools: turnTools,
            runTool: toolsEnabled ? (call) => this.runTool(call) : undefined,
            onToolEvent: toolsEnabled
              ? (event) => {
                  const action = this.describeToolEvent(event.name, event.args);
                  stepActions.push(action);
                  this.lastToolAction = action;
                  this.post({ type: 'toolEvent', name: event.name, args: event.args });
                }
              : undefined,
            onToolResult: toolsEnabled
              ? (name, result) => {
                  // write/edit show a diff card already; others get a Claude-style ⎿ result line.
                  if (name !== 'write_file' && name !== 'edit_file') {
                    const text = summarizeToolResult(name, result);
                    this.post({ type: 'toolResult', text });
                    // Record the ⏺ action + ⎿ result together in the persisted transcript.
                    this.appendTranscript({
                      kind: 'tool',
                      action: this.lastToolAction || name,
                      result: text,
                      at: new Date().toISOString()
                    });
                  }
                }
              : undefined,
            onRetry: (info) => {
              // Transient failure being retried — show it on the status line instead of dying.
              this.post({
                type: 'retry',
                text: `${info.reason} — retrying in ${Math.ceil(info.delayMs / 1000)}s (attempt ${info.attempt}/${info.maxAttempts})…`
              });
            },
            onUsage: (usage) => {
              turnTokens += usage.total;
              this.sessionTokens += usage.total;
              const cost = estimateCostUsd(agentId, usage);
              if (cost) {
                this.sessionCost += cost;
              }
              this.post({
                type: 'tokens',
                total: turnTokens,
                session: this.sessionTokens,
                sessionCostUsd: this.sessionCost
              });
            },
            maxToolRounds: settings.maxToolRounds
          }
        );

        const rawContent = response.message.content;
        const done = /<DONE>/i.test(rawContent);
        let cleaned = rawContent.replace(/<DONE>/gi, '').trimEnd();
        // Reasoning counts as progress: with extended thinking on, a step can be
        // thinking-only — that is the model working, not a stall.
        const thinkingLen = response.message.thinking?.trim().length ?? 0;
        const madeProgress = cleaned.trim().length > 0 || stepActions.length > 0 || thinkingLen > 0;
        dbg('turn', 'send complete', {
          auto,
          contentChars: cleaned.length,
          thinkingChars: thinkingLen,
          toolActions: stepActions.length,
          madeProgress,
          done,
          aborted: this.abortController.signal.aborted
        });

        if (!madeProgress) {
          // A truly empty step is often a transient hiccup, not completion — nudge once
          // before giving up (the model keeps its tools; see the agent system prompt).
          if (canAutoContinue && !nudged && !this.abortController.signal.aborted) {
            nudged = true;
            auto += 1;
            continuation =
              'Your previous reply was empty. Continue with the task — call a tool or reply with text. If it is already fully complete, reply with <DONE>.';
            continue;
          }
          // Empty response with no tool actions: don't render a blank bubble or keep looping.
          const note = canAutoContinue
            ? '⏸ Stopped: the model returned an empty response and took no actions. Try rephrasing, switching models, or another mode.'
            : '_(The model returned an empty response.)_';
          this.history.push({ role: 'assistant', content: note, createdAt: new Date().toISOString(), model: agentId });
          this.appendTranscript({ kind: 'note', text: note, at: new Date().toISOString() });
          this.post({ type: 'streamEnd' });
          await this.postState();
          break;
        }

        // If the model worked through tools but didn't narrate, persist a summary of what it did
        // so the conversation and exports aren't blank (Claude-Code-style activity log).
        const hadNarration = cleaned.trim().length > 0;
        const thinkingOnly = !hadNarration && stepActions.length === 0 && thinkingLen > 0;
        if (!cleaned.trim()) {
          cleaned = stepActions.map((a) => `⏺ ${a}`).join('\n');
        }
        this.history.push({ ...response.message, content: cleaned, model: agentId });
        // Record an assistant entry when there was real prose — or when the step was
        // thinking-only, so the streamed 💭 panel survives the post-turn re-render.
        // With tool actions and no narration, the tool/fileEdit entries already
        // represent this step in the transcript (no duplication).
        if (hadNarration || thinkingOnly) {
          this.appendTranscript({
            kind: 'assistant',
            text: cleaned,
            model: agentId,
            thinking: response.message.thinking,
            tokens: response.usage?.total,
            at: new Date().toISOString()
          });
        }
        this.post({ type: 'streamEnd' });
        await this.postState();
        // Chat mode (no file tools): surface any "File:" blocks as inline Apply cards
        // instead of modal popups. Agent modes apply edits through tools, so skip there.
        await handleResponse(this.commandDeps, response, { skipMessageDisplay: true, skipProposedChanges: true });
        if (!toolsEnabled) {
          for (const change of response.proposedChanges ?? []) {
            this.postProposedChange(change);
          }
        }

        if (!canAutoContinue || done || this.abortController.signal.aborted) {
          break;
        }
        if (settings.tokenLimit > 0 && this.sessionTokens >= settings.tokenLimit) {
          const note = `⏸ Stopped — token limit reached (${this.sessionTokens.toLocaleString()} / ${settings.tokenLimit.toLocaleString()}). Raise "parley.tokenLimit" or start a new conversation.`;
          this.history.push({ role: 'assistant', content: note, createdAt: new Date().toISOString() });
          this.appendTranscript({ kind: 'note', text: note, at: new Date().toISOString() });
          await this.postState();
          break;
        }
        if (auto >= settings.maxAutoContinue) {
          // Don't stop silently — tell the user why and how to resume.
          const note = `⏸ Paused after ${settings.maxAutoContinue} automatic steps to avoid runaway usage. Type "continue" to keep going.`;
          this.history.push({ role: 'assistant', content: note, createdAt: new Date().toISOString() });
          this.appendTranscript({ kind: 'note', text: note, at: new Date().toISOString() });
          await this.postState();
          break;
        }
        auto += 1;
        continuation = 'Continue. If the task is already fully complete, reply with <DONE>.';
      }

      const changed = this.checkpoints.changedSince(cpStart);
      if (changed.length > 0) {
        const note = `✏️ Changed ${changed.length} file${changed.length === 1 ? '' : 's'}: ${changed.join(', ')}\n_Run "Parley: Revert Last Edit" or "Parley: Revert All Edits" to undo._`;
        this.history.push({ role: 'assistant', content: note, createdAt: new Date().toISOString() });
        this.appendTranscript({ kind: 'note', text: note, at: new Date().toISOString() });
      }
      this.busy = false;
      this.abortController = undefined;
      await this.postState();
      await this.autosaveConversation();
    } catch (error) {
      this.busy = false;
      this.abortController = undefined;
      this.post({ type: 'streamEnd' });
      await this.postState();
      if ((error as { name?: string })?.name === 'AbortError') {
        this.logger.info('Parley reply was stopped by the user.');
        return;
      }
      await reportProviderError(this.commandDeps, error);
    }
  }

  /** Compose project rules + the mode-specific system instruction (plan / autonomous agent). */
  private async buildSystemExtra(): Promise<string | undefined> {
    const rules = await this.readProjectRules();
    let modeNote: string | undefined;
    if (this.mode === 'plan') {
      modeNote =
        'You are in PLAN mode. Do NOT edit files or run commands. Use the read-only tools to explore the codebase, then present a concise, numbered plan of the changes you would make.';
    } else if (this.mode !== 'chat') {
      const fullAccess = this.mode === 'full';
      modeNote =
        "You are an autonomous coding agent in VS Code. Keep working — read files (use read_file start_line/end_line for large files), search (grep for regex/content searches, find_files for names), edit (use edit_file for precise changes to existing files, write_file for new ones), and run commands — until the user's request is FULLY complete. Do not stop to ask whether to continue or wait for confirmation.\n\n" +
        'After an applied edit you may receive a "new problems" report from the editor\'s live diagnostics — fix those problems before moving on. If an edit_file match fails, the error often shows the closest real region of the file: copy old_text exactly from it instead of re-reading the whole file.\n\n' +
        'You are NOT limited to a single interaction or a fixed number of steps — you will be re-invoked automatically to continue, so never apologize about "running out of time", "this interaction/run", or "running out of steps"; just keep going. Your tools (read_file, edit_file, write_file, run_command, etc.) are ALWAYS available — NEVER claim that "the tool interface is unavailable", that tools "stopped responding", or that you "cannot continue in this run". If you want to act, simply call the tool. If earlier tool outputs in the conversation were trimmed to a short placeholder to save context, that is normal — just re-read the file or re-run the search; it does not mean anything is broken.\n\n' +
        'Use run_command to make the environment work for you. If a required dependency, package, or CLI tool is missing (e.g. pytest, numpy, a linter, a formatter, a build tool), INSTALL IT YOURSELF with the appropriate command (`pip install …`, `npm install …`, `npm i -D …`, etc.) and continue — never report a missing dependency as a blocker or ask the user to install it when you can install it yourself. When the user says "install those tools" or similar, they mean install the missing packages/CLIs via the shell — do it. ' +
        (fullAccess
          ? 'You are in FULL ACCESS mode: shell commands run WITHOUT asking, so install dependencies and run builds/tests freely.'
          : 'Shell commands ask for confirmation in this mode; still attempt installs/builds/tests and let the user approve them.') +
        '\n\n' +
        'If a command is terminated for exceeding its timeout, that is recoverable: re-run it, split it into smaller steps, or proceed — do not give up.\n\n' +
        'For any task with more than a couple of steps, call the `update_plan` tool first with the high-level steps, then update it (one step `in_progress` at a time, mark steps `done` as you finish) so the user can follow your progress.\n\n' +
        'IMPORTANT — always communicate in plain text as you work: before each tool call, write a short sentence saying what you are about to do and why; after finishing a logical chunk, summarize what changed. Do NOT paste raw reasoning notes-to-self (fragments like "Need to…", "Use python? read __all__.") into your reply — write clear sentences for the user. NEVER reply with only tool calls and no text, and never return an empty message.\n\n' +
        'When the entire task is genuinely finished, your final message MUST end with a summary section formatted EXACTLY like this:\n' +
        '**SUMMARY**\n' +
        '- <what you did — one bullet per item>\n' +
        '- <files created/changed>\n' +
        '- <commands run and whether lint/tests/build passed>\n' +
        '- <any known limitations or follow-ups>\n' +
        'Use a bold **SUMMARY** heading on its own line, then concise Markdown bullet points (`- `). Put <DONE> on its own line AFTER the summary. Always include this SUMMARY section when finishing — even for small tasks.';
    }
    return [rules, modeNote].filter(Boolean).join('\n\n') || undefined;
  }

  /** Short human label for a tool call, used to persist an activity log when the model doesn't narrate. */
  private describeToolEvent(name: string, argsJson: string): string {
    let a: { path?: string; glob?: string; query?: string; pattern?: string; command?: string; url?: string } = {};
    try {
      a = JSON.parse(argsJson || '{}');
    } catch {
      a = {};
    }
    switch (name) {
      case 'read_file':
        return `Read ${a.path ?? ''}`.trim();
      case 'list_directory':
        return `List ${a.path ?? '.'}`;
      case 'find_files':
        return `Find ${a.glob ?? ''}`.trim();
      case 'search_text':
        return `Search "${a.query ?? ''}"`;
      case 'grep':
        return `Grep /${a.pattern ?? ''}/`;
      case 'write_file':
        return `Write ${a.path ?? ''}`.trim();
      case 'edit_file':
        return `Edit ${a.path ?? ''}`.trim();
      case 'run_command':
        return `Run: ${a.command ?? ''}`.trim();
      case 'fetch_url':
        return `Fetch ${a.url ?? ''}`.trim();
      default:
        return name;
    }
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

    const maxChars = this.getSettings().contextMaxCharacters;
    for (const uri of uris) {
      try {
        const label = path.basename(uri.fsPath);
        const ext = path.extname(uri.fsPath).toLowerCase();

        if (VIDEO_EXTENSIONS.has(ext)) {
          await this.attachVideo(uri, label);
          continue;
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

    this.busy = true;
    await this.postState();
    try {
      const summary = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Compacting conversation…' },
        async () => {
          const response = await this.getProvider().sendMessage({
            prompt,
            messages: [{ role: 'user', content: prompt, createdAt: new Date().toISOString() }],
            context: [],
            agentId: model
          });
          return response.message.content;
        }
      );

      const summaryMsg: ChatMessage = {
        role: 'assistant',
        content: `📦 **Compacted summary of the conversation so far**\n\n${summary}`,
        createdAt: new Date().toISOString(),
        model
      };
      this.history.length = 0;
      this.history.push(summaryMsg, ...toKeep);
    } catch (error) {
      await reportProviderError(this.commandDeps, error);
    } finally {
      this.busy = false;
      await this.postState();
      await this.autosaveConversation();
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
    const pick = await vscode.window.showQuickPick(items, { title: 'Open a past Parley conversation' });
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
    this.conversationStartedAt = transcript[0]?.at ?? new Date().toISOString();
    this.attachments = [];
    this.pendingChanges.clear();
    this.fileReadHashes.clear();
    this.sessionTokens = 0;
    this.sessionCost = 0;
    await vscode.commands.executeCommand('workbench.view.extension.parley');
    await vscode.commands.executeCommand('parley.chatView.focus');
    await this.ready;
    await this.postState();
  }

  /**
   * Export the conversation. The canonical transcript on disk is completed/flushed first,
   * then a copy is written in the chosen format to a location the user picks.
   */
  public async exportConversation(): Promise<void> {
    if (this.transcript.length === 0) {
      await vscode.window.showInformationMessage('Parley: there is no conversation to export yet.');
      return;
    }

    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Markdown (.md)', ext: 'md', fmt: 'md' as const },
        { label: 'Plain text (.txt)', ext: 'txt', fmt: 'txt' as const },
        { label: 'JSON (.json)', ext: 'json', fmt: 'json' as const }
      ],
      { title: 'Export Parley conversation', placeHolder: 'Choose a format' }
    );
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

  /** Tool runner for agent mode: read tools delegate to the read-only runner; writes/commands need UI + checkpoints. */
  private async runTool(call: ToolCall): Promise<string> {
    if (isMcpTool(call.name)) {
      return this.mcp.callTool(call.name, call.arguments);
    }
    if (call.name === 'read_file') {
      const result = await runAgentTool(call);
      await this.recordReadFromArgs(call.arguments);
      return result;
    }
    if (call.name === 'write_file') {
      return this.toolWriteFile(call);
    }
    if (call.name === 'edit_file') {
      return this.toolEditFile(call);
    }
    if (call.name === 'run_command') {
      return this.toolRunCommand(call);
    }
    if (call.name === 'update_plan') {
      return this.toolUpdatePlan(call);
    }
    if (call.name === 'web_search') {
      return this.toolWebSearch(call);
    }
    return runAgentTool(call);
  }

  private async toolWebSearch(call: ToolCall): Promise<string> {
    let query = '';
    try {
      query = String(JSON.parse(call.arguments || '{}').query ?? '');
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    const s = this.getSettings();
    return webSearch(query, {
      provider: s.webSearchProvider,
      apiKey: s.webSearchApiKey,
      googleCx: s.webSearchGoogleCx
    });
  }

  /** Render the agent's task checklist in the chat (Claude-Code / Codex style). */
  private toolUpdatePlan(call: ToolCall): string {
    let steps: Array<{ step?: string; status?: string }> = [];
    try {
      steps = (JSON.parse(call.arguments || '{}').steps ?? []) as Array<{ step?: string; status?: string }>;
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    const clean = steps
      .filter((s) => s && typeof s.step === 'string')
      .map((s) => ({
        step: String(s.step).slice(0, 200),
        status: s.status === 'done' || s.status === 'in_progress' ? s.status : 'pending'
      }));
    this.post({ type: 'plan', steps: clean });
    this.appendTranscript({
      kind: 'plan',
      steps: clean.map((s) => ({ text: s.step, status: s.status })),
      at: new Date().toISOString()
    });
    const done = clean.filter((s) => s.status === 'done').length;
    return `Plan updated (${done}/${clean.length} done).`;
  }

  // ---------- file staleness tracking ----------

  private static hashContent(text: string): string {
    return createHash('sha1').update(text).digest('hex');
  }

  /** Remember the on-disk content of a file the agent has just read (or we just wrote). */
  private recordFileState(fsPath: string, content: string): void {
    this.fileReadHashes.set(fsPath, ChatPanel.hashContent(content));
  }

  /** After a read_file tool call: hash the file so later writes can detect outside changes. */
  private async recordReadFromArgs(argsJson: string): Promise<void> {
    try {
      const rel = String((JSON.parse(argsJson || '{}') as { path?: string }).path ?? '').replace(/^[/\\]+/, '');
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!rel || !root) {
        return;
      }
      const uri = vscode.Uri.joinPath(root, rel);
      const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      this.recordFileState(uri.fsPath, content);
    } catch {
      // Unreadable/absent — nothing to record.
    }
  }

  /** Note appended to edit errors when the file changed on disk after the agent's last read. */
  private staleNote(fsPath: string, currentContent: string): string {
    const recorded = this.fileReadHashes.get(fsPath);
    if (recorded && recorded !== ChatPanel.hashContent(currentContent)) {
      return ' Note: the file has CHANGED on disk since you last read it (edited by the user or a tool) — trust the content shown below over your memory.';
    }
    return '';
  }

  private async toolWriteFile(call: ToolCall): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      return 'Error: no workspace folder is open.';
    }
    let args: { path?: string; content?: string };
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    const rel = String(args.path ?? '').replace(/^[/\\]+/, '');
    const content = String(args.content ?? '');
    if (!rel) {
      return 'Error: path is required.';
    }
    if (isSensitiveFile(rel)) {
      return 'Error: refusing to write a sensitive file.';
    }

    const uri = vscode.Uri.joinPath(root, rel);
    let original = '';
    let fileExists = true;
    try {
      original = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      original = '';
      fileExists = false;
    }
    // Overwriting an existing, non-empty file requires a fresh read — otherwise the agent
    // could clobber content it has never seen (e.g. the user edited it mid-conversation).
    if (fileExists && original.length > 0) {
      const recorded = this.fileReadHashes.get(uri.fsPath);
      if (!recorded) {
        return `Error: ${rel} already exists but you have not read it in this conversation. Call read_file first (so you don't overwrite unseen content), then re-issue write_file — or use edit_file for a targeted change.`;
      }
      if (recorded !== ChatPanel.hashContent(original)) {
        return `Error: ${rel} has changed on disk since you last read it. Call read_file again to see the current content, then re-issue write_file.`;
      }
    }
    const proposedText = content.endsWith('\n') ? content : `${content}\n`;
    return this.applyProposedEdit(uri, rel, original, proposedText);
  }

  /** Surgical edit: replace a unique snippet, then go through the same review/apply flow. */
  private async toolEditFile(call: ToolCall): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      return 'Error: no workspace folder is open.';
    }
    let args: { path?: string; old_text?: string; new_text?: string };
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    const rel = String(args.path ?? '').replace(/^[/\\]+/, '');
    const oldText = String(args.old_text ?? '');
    const newText = String(args.new_text ?? '');
    if (!rel) {
      return 'Error: path is required.';
    }
    if (!oldText) {
      return 'Error: old_text is required.';
    }
    if (isSensitiveFile(rel)) {
      return 'Error: refusing to edit a sensitive file.';
    }

    const uri = vscode.Uri.joinPath(root, rel);
    let original: string;
    try {
      original = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      return `Error: could not read "${rel}" — does it exist? Use write_file to create new files.`;
    }

    // Tiered matching: exact → trimmed lines → collapsed whitespace; a failed match
    // returns the closest real region so the model can repair old_text in one round.
    const match = applySnippetEdit(original, oldText, newText);
    if (match.kind === 'ambiguous') {
      return (
        `Error: old_text matches ${match.startLines.length} places in ${rel}` +
        ` (starting at lines ${match.startLines.slice(0, 8).join(', ')}).` +
        ' Include more surrounding context so it is unique.'
      );
    }
    if (match.kind === 'notfound') {
      const stale = this.staleNote(uri.fsPath, original);
      if (match.hint) {
        return (
          `Error: old_text was not found in ${rel}.${stale}` +
          ` Closest match is lines ${match.hint.startLine}-${match.hint.endLine}` +
          ` (${Math.round(match.hint.similarity * 100)}% of lines match) — the file actually contains:\n` +
          `${match.hint.excerpt}\n` +
          'Copy old_text EXACTLY from the lines above (watch punctuation and small wording differences), then retry edit_file.'
        );
      }
      return `Error: old_text was not found in ${rel}.${stale} Re-read the file with read_file and copy an exact snippet.`;
    }
    return this.applyProposedEdit(uri, rel, original, match.newText);
  }

  /** Apply a proposed file change: auto in edit/auto/full modes, diff-approval otherwise. Always checkpointed. */
  private async applyProposedEdit(
    uri: vscode.Uri,
    rel: string,
    original: string,
    proposedText: string
  ): Promise<string> {
    const preDiagnostics = ChatPanel.diagnosticsKeySet(uri);
    if (this.mode === 'edit' || this.mode === 'auto' || this.mode === 'full') {
      await this.checkpoints.applyWithCheckpoint(uri, proposedText, `edit ${rel}`);
      this.recordFileState(uri.fsPath, proposedText);
      this.postFileEdit(rel, original, proposedText);
      return `Applied edit to ${rel} (auto).${await this.newProblemsAfterEdit(uri, preDiagnostics)}`;
    }

    await showProposedDiff(
      { filePath: uri.fsPath, originalText: original, proposedText, title: `Agent edit: ${rel}` },
      this.commandDeps.diffProvider
    );
    const finalText = await reviewProposedEdit(rel, original, proposedText);
    if (finalText === undefined) {
      return `User rejected the edit to ${rel}.`;
    }
    await this.checkpoints.applyWithCheckpoint(uri, finalText, `edit ${rel}`);
    this.recordFileState(uri.fsPath, finalText);
    this.postFileEdit(rel, original, finalText);
    return `Applied edit to ${rel}.${await this.newProblemsAfterEdit(uri, preDiagnostics)}`;
  }

  // ---------- post-edit diagnostics feedback (the editor tells the agent what it broke) ----------

  /** Line-independent keys of a file's current diagnostics (errors + warnings). */
  private static diagnosticsKeySet(uri: vscode.Uri): Set<string> {
    const keys = new Set<string>();
    for (const d of vscode.languages.getDiagnostics(uri)) {
      if (d.severity <= vscode.DiagnosticSeverity.Warning) {
        keys.add(ChatPanel.diagnosticKey(d));
      }
    }
    return keys;
  }

  /** Keyed by severity+source+message (not line) so pre-existing problems that merely shift lines don't count as new. */
  private static diagnosticKey(d: vscode.Diagnostic): string {
    return `${d.severity}|${d.source ?? ''}|${d.message}`;
  }

  /**
   * After an applied edit, give language servers a moment to re-analyze, then report
   * any NEW errors/warnings back to the model — Claude-Code-style self-correction.
   * Opening the document (without showing it) makes language servers analyze files
   * that aren't open in any editor.
   */
  private async newProblemsAfterEdit(uri: vscode.Uri, before: Set<string>): Promise<string> {
    if (this.abortController?.signal.aborted) {
      return '';
    }
    try {
      await vscode.workspace.openTextDocument(uri);
    } catch {
      return '';
    }
    await waitMs(1500, this.abortController?.signal);
    const fresh = vscode.languages
      .getDiagnostics(uri)
      .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
      .filter((d) => !before.has(ChatPanel.diagnosticKey(d)));
    if (fresh.length === 0) {
      return '';
    }
    fresh.sort((a, b) => a.severity - b.severity || a.range.start.line - b.range.start.line);
    const label = (d: vscode.Diagnostic): string =>
      d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
    const shown = fresh
      .slice(0, 8)
      .map(
        (d) =>
          `- L${d.range.start.line + 1} ${label(d)}: ${d.message.split('\n')[0].slice(0, 200)}${d.source ? ` [${d.source}]` : ''}`
      );
    const more = fresh.length > 8 ? `\n(+${fresh.length - 8} more)` : '';
    dbg('tool', 'post-edit diagnostics', { file: uri.fsPath, fresh: fresh.length });
    return `\n\n⚠ This edit introduced ${fresh.length} new problem(s) according to the editor's diagnostics:\n${shown.join('\n')}${more}\nFix these before moving on (or explain why they are expected).`;
  }

  /** Show a Claude-Code-style inline diff card in the chat for an applied edit. */
  private postFileEdit(rel: string, original: string, applied: string): void {
    const diff = formatUnifiedDiff(original, applied);
    if (diff.added === 0 && diff.removed === 0) {
      return;
    }
    const MAX_ROWS = 500;
    const rows = diff.rows.length > MAX_ROWS ? diff.rows.slice(0, MAX_ROWS) : diff.rows;
    const truncated = diff.rows.length > MAX_ROWS;
    this.post({ type: 'fileEdit', path: rel, added: diff.added, removed: diff.removed, rows, truncated });
    this.appendTranscript({
      kind: 'fileEdit',
      path: rel,
      added: diff.added,
      removed: diff.removed,
      rows,
      truncated,
      status: 'applied',
      isNew: original.length === 0,
      at: new Date().toISOString()
    });
  }

  /** Render an interactive "Apply" card for a chat-mode proposed file change (Cursor-style). */
  private postProposedChange(change: { filePath: string; originalText: string; proposedText: string }): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const uri = vscode.Uri.file(change.filePath);
    const rel = root ? path.relative(root.fsPath, change.filePath).replace(/\\/g, '/') : change.filePath;
    const id = `chg${this.changeSeq++}`;
    this.pendingChanges.set(id, { uri, rel, original: change.originalText, proposedText: change.proposedText });
    const diff = formatUnifiedDiff(change.originalText, change.proposedText);
    const MAX_ROWS = 500;
    const rows = diff.rows.length > MAX_ROWS ? diff.rows.slice(0, MAX_ROWS) : diff.rows;
    const truncated = diff.rows.length > MAX_ROWS;
    const isNew = change.originalText.length === 0;
    this.post({
      type: 'proposedChange',
      id,
      path: rel,
      isNew,
      added: diff.added,
      removed: diff.removed,
      rows,
      truncated
    });
    this.appendTranscript({
      kind: 'fileEdit',
      id,
      path: rel,
      added: diff.added,
      removed: diff.removed,
      rows,
      truncated,
      status: 'proposed',
      isNew,
      at: new Date().toISOString()
    });
  }

  /** Update a proposed-change transcript entry's status (e.g. after Apply/Dismiss) and re-sync disk. */
  private resolveTranscriptChange(id: string, status: 'applied' | 'dismissed' | 'error'): void {
    const entry = this.transcript.find((e) => e.kind === 'fileEdit' && e.id === id);
    if (entry && entry.kind === 'fileEdit') {
      entry.status = status;
      this.syncTranscriptFile();
    }
  }

  /** Apply a pending proposed change when the user clicks its inline Apply button. */
  private async applyPendingChange(id: string): Promise<void> {
    const change = this.pendingChanges.get(id);
    if (!change) {
      // No longer pending (already resolved, or the extension reloaded and lost it) —
      // resolve the card anyway so no dead Apply button lingers in the webview.
      this.post({ type: 'changeResolved', id, status: 'dismissed' });
      return;
    }
    this.pendingChanges.delete(id);
    if (isSensitiveFile(change.rel)) {
      this.post({ type: 'changeResolved', id, status: 'error' });
      this.resolveTranscriptChange(id, 'error');
      await vscode.window.showErrorMessage(`Parley refused to write a sensitive file: ${change.rel}.`);
      return;
    }
    try {
      // The inline Apply click is the confirmation, so apply directly (still checkpointed/revertible).
      // The card already shows the diff, so we just flip it to "Applied" via changeResolved.
      await this.checkpoints.applyWithCheckpoint(change.uri, change.proposedText, `edit ${change.rel}`);
      this.recordFileState(change.uri.fsPath, change.proposedText);
      this.post({ type: 'changeResolved', id, status: 'applied' });
      this.resolveTranscriptChange(id, 'applied');
      await this.autosaveConversation();
    } catch (error) {
      this.post({ type: 'changeResolved', id, status: 'error' });
      this.resolveTranscriptChange(id, 'error');
      await vscode.window.showErrorMessage(
        `Parley could not apply ${change.rel}: ${error instanceof Error ? error.message : 'error'}`
      );
    }
  }

  private async toolRunCommand(call: ToolCall): Promise<string> {
    let args: { command?: string };
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    const command = String(args.command ?? '').trim();
    if (!command) {
      return 'Error: command is required.';
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    // Full-access mode runs commands without prompting; every other mode confirms —
    // unless the command matches a workspace allowlist rule the user approved earlier.
    if (this.mode !== 'full' && this.isCommandAllowed(command)) {
      dbg('tool', 'run_command auto-approved by allowlist', command.slice(0, 120));
    } else if (this.mode !== 'full') {
      const ALWAYS = 'Always Allow';
      const answer = await vscode.window.showWarningMessage(
        `Parley agent wants to run a command in ${folder?.name ?? 'the workspace'}:\n\n${command}\n\n` +
          `"${ALWAYS}" also approves future commands that start with this text (this workspace only; ` +
          'review with "Parley: Manage Allowed Commands").',
        { modal: true },
        'Run',
        ALWAYS,
        'Skip'
      );
      if (answer === ALWAYS) {
        const rules = this.allowedCommands();
        if (!rules.includes(command)) {
          await this.state.update('parley.allowedCommands', [...rules, command]);
        }
      } else if (answer !== 'Run') {
        return 'User declined to run the command.';
      }
    }
    const output = await runShellCommand(
      command,
      folder?.uri.fsPath,
      this.getSettings().commandTimeoutSeconds * 1000,
      this.abortController?.signal
    );
    // Mirror the command + its full output to a visible channel (Claude-Code/Cursor-style),
    // while still returning the captured output to the model.
    const channel = this.agentChannel();
    channel.appendLine(`$ ${command}`);
    channel.appendLine(output);
    channel.appendLine('');
    channel.show(true);
    return output;
  }

  private agentChannel(): vscode.OutputChannel {
    if (!this.commandChannel) {
      this.commandChannel = vscode.window.createOutputChannel('Parley Agent');
    }
    return this.commandChannel;
  }

  // ---------- command allowlist (workspace-scoped) ----------

  private allowedCommands(): string[] {
    const rules = this.state.get<string[]>('parley.allowedCommands', []);
    return Array.isArray(rules) ? rules.filter((r) => typeof r === 'string' && r.trim().length > 0) : [];
  }

  /** A rule matches its exact command or any command that extends it with further arguments. */
  private isCommandAllowed(command: string): boolean {
    return this.allowedCommands().some((rule) => command === rule || command.startsWith(`${rule} `));
  }

  /** Review/remove the workspace's approved agent commands ("Parley: Manage Allowed Commands"). */
  public async manageAllowedCommands(): Promise<void> {
    const rules = this.allowedCommands();
    if (rules.length === 0) {
      await vscode.window.showInformationMessage(
        'Parley: no allowed commands yet. Approve one with "Always Allow" when the agent asks to run a command.'
      );
      return;
    }
    const picks = await vscode.window.showQuickPick(
      rules.map((rule) => ({ label: rule, picked: true })),
      {
        canPickMany: true,
        title: 'Parley: allowed agent commands (uncheck to remove)',
        placeHolder:
          'Checked commands (and anything starting with them + more arguments) run without asking in this workspace'
      }
    );
    if (!picks) {
      return;
    }
    const keep = picks.map((p) => p.label);
    await this.state.update('parley.allowedCommands', keep);
    const removed = rules.length - keep.length;
    await vscode.window.showInformationMessage(
      removed > 0
        ? `Parley: removed ${removed} allowed command${removed === 1 ? '' : 's'} (${keep.length} kept).`
        : `Parley: keeping all ${keep.length} allowed command${keep.length === 1 ? '' : 's'}.`
    );
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

    // @path — a file's contents, or a folder's listing.
    for (const rel of extractMentionPaths(prompt)) {
      if (rel === 'git' || rel === 'codebase' || /^https?:/i.test(rel) || isSensitiveFile(rel)) {
        continue;
      }
      try {
        const uri = vscode.Uri.joinPath(root, rel);
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type === vscode.FileType.Directory) {
          const files = await vscode.workspace.findFiles(
            `${rel.replace(/[/\\]+$/, '')}/**/*`,
            '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}',
            60
          );
          const listing =
            files
              .map((u) => path.relative(root.fsPath, u.fsPath).replace(/\\/g, '/'))
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
        const content = raw.length > cap ? raw.slice(0, cap) : raw;
        out.push({
          id: `mention-${rel}`,
          kind: 'user-file',
          label: `@${rel}`,
          filePath: uri.fsPath,
          content,
          characterCount: content.length,
          truncated: raw.length > content.length
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
    const docs = await this.gatherCodebaseDocs(root);
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

  /** Read indexable workspace files (skip binaries, huge files, node_modules, sensitive). */
  private async gatherCodebaseDocs(root: vscode.Uri): Promise<RankDoc[]> {
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
    const docs: RankDoc[] = [];
    for (const uri of files) {
      const rel = path.relative(root.fsPath, uri.fsPath).replace(/\\/g, '/');
      if (isSensitiveFile(rel)) {
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
          const docs = await this.gatherCodebaseDocs(root);
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

  /** Answer an @-mention autocomplete query with matching workspace file paths. */
  private async sendMentionResults(query: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.post({ type: 'mentionResults', items: [] });
      return;
    }
    const cleaned = query.replace(/[^\w./-]/g, '');
    const glob = cleaned ? `**/*${cleaned}*` : '**/*';
    let items: string[] = [];
    try {
      const files = await vscode.workspace.findFiles(glob, '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}', 30);
      items = files
        .map((uri) => path.relative(root, uri.fsPath).replace(/\\/g, '/'))
        .filter((rel) => !isSensitiveFile(rel))
        .sort((a, b) => a.length - b.length)
        .slice(0, 8);
    } catch {
      items = [];
    }
    this.post({ type: 'mentionResults', items });
  }

  /** Read the first present project-rules file and return its contents for the system prompt. */
  private async readProjectRules(): Promise<string | undefined> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      return undefined;
    }
    for (const name of PROJECT_RULES_FILES) {
      try {
        const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, name))).toString('utf8');
        if (raw.trim().length > 0) {
          return raw.slice(0, 8000);
        }
      } catch {
        // Not present; try the next.
      }
    }
    return undefined;
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
    void this.view?.webview.postMessage(message);
  }

  private async postState(): Promise<void> {
    this.save();
    const hasKey = Boolean(await this.commandDeps.auth.getToken());
    const model = this.selectedAgentId || this.getSettings().defaultAgent;
    const window = contextWindowFor(model);
    const contextPct = window ? Math.min(100, Math.round((this.estimateHistoryTokens() / window) * 100)) : undefined;
    this.post({
      type: 'state',
      history: this.history,
      transcript: this.transcript,
      pendingChangeIds: Array.from(this.pendingChanges.keys()),
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
      customCommands: this.customCommandNames,
      contextOptions: this.contextOptions,
      attachments: this.attachments.map((a) => ({ id: a.id, label: a.label, kind: a.kind }))
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    // The webview script is bundled (media/chat.js + markdown-it + highlight.js → dist/webview.js).
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chat.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      'img-src data:',
      'font-src data:'
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Parley</title>
</head>
<body>
  <div class="shell">
    <div class="toolbar">
      <span class="title">Parley</span>
      <span id="sessionTok" class="sessiontok" title="Tokens used in this conversation (and estimated cost)"></span>
      <span id="ctx" class="ctx-meter" title="Context window used"><span class="ctxring"></span><span class="ctxnum">–</span></span>
      <span class="grow"></span>
      <button id="newChat" title="New conversation" aria-label="New conversation">＋</button>
      <button id="historyBtn" title="Past conversations" aria-label="Past conversations">🕘</button>
      <button id="compact" title="Compact conversation (summarize to free up context)" aria-label="Compact conversation">⊟</button>
      <button id="export" title="Export conversation" aria-label="Export conversation">⤓</button>
      <button id="refresh" title="Refresh model list" aria-label="Refresh model list">↻</button>
    </div>
    <div id="banner" class="banner"></div>
    <div class="histwrap">
      <div id="history" class="history"><div class="empty">Ask Parley about your code.</div></div>
      <button id="jump" type="button" title="Jump to latest" aria-label="Jump to latest">↓</button>
    </div>
    <div id="status" class="status" style="display:none"></div>
    <form id="composer" class="composer">
      <details class="ctx-wrap">
        <summary>Context</summary>
        <div class="ctx">
          <label><input id="includeSelection" type="checkbox" checked> Selection</label>
          <label><input id="includeCurrentFile" type="checkbox"> File</label>
          <label><input id="includeOpenEditors" type="checkbox"> Open editors</label>
          <label><input id="includeDiagnostics" type="checkbox"> Diagnostics</label>
          <label><input id="includeUserSelectedFiles" type="checkbox"> Pick files</label>
        </div>
      </details>
      <div id="attachments" class="attachments"></div>
      <div class="inputbox">
        <div id="mentions" class="mentions" style="display:none"></div>
        <div id="slashMenu" class="mentions" style="display:none"></div>
        <div id="modePanel" class="modepanel" style="display:none">
          <div class="mp-head">Modes</div>
          <button type="button" class="mp-item" data-mode="chat"><span class="mp-name">Chat</span><span class="mp-desc">Answer only — no agent, no file access</span></button>
          <button type="button" class="mp-item" data-mode="ask"><span class="mp-name">Ask before edits</span><span class="mp-desc">Agent proposes edits; you approve each one</span></button>
          <button type="button" class="mp-item" data-mode="edit"><span class="mp-name">Edit automatically</span><span class="mp-desc">Agent applies edits without asking (revertible)</span></button>
          <button type="button" class="mp-item" data-mode="plan"><span class="mp-name">Plan mode</span><span class="mp-desc">Agent explores read-only and presents a plan</span></button>
          <button type="button" class="mp-item" data-mode="auto"><span class="mp-name">Auto mode</span><span class="mp-desc">Agent decides and applies edits automatically</span></button>
          <button type="button" class="mp-item" data-mode="full"><span class="mp-name">Full access <span class="mp-caution">⚠ CAUTION</span></span><span class="mp-desc">Auto-applies edits AND runs shell commands without asking</span></button>
          <div class="mp-sep"></div>
          <div class="mp-head">Extended thinking <span class="mp-note">— effective on Claude &amp; Gemini</span></div>
          <div class="mp-thinking">
            <button type="button" data-thinking="off">Off</button>
            <button type="button" data-thinking="adaptive">Adaptive</button>
            <button type="button" data-thinking="low">Low</button>
            <button type="button" data-thinking="medium">Med</button>
            <button type="button" data-thinking="high">High</button>
          </div>
          <div class="mp-sep"></div>
          <div class="mp-head">Speed <span class="mp-note">— OpenAI / ChatGPT only</span></div>
          <div class="mp-speed">
            <button type="button" data-speed="standard">Standard</button>
            <button type="button" data-speed="fast">⚡ Fast</button>
          </div>
          <div class="mp-foot">Thinking shows the model's reasoning (uses more output tokens). Verified live: it works on <strong>Claude</strong> &amp; <strong>Gemini</strong>; <strong>OpenAI</strong> accepts a reasoning level but Parley doesn't currently apply it. <strong>Fast</strong> requests OpenAI's priority tier (accepted by the gateway; actual ≈1.5× speed depends on your account). Shell commands ask before running — except in <strong>Full access</strong> mode.</div>
        </div>
        <textarea id="prompt" placeholder="Ask Parley…  (@file to attach · paste or drop an image/PDF/audio · Enter to send · Shift+Enter for newline)"></textarea>
        <div class="actions">
          <select id="agent" class="model" aria-label="Parley model"></select>
          <button type="button" id="modeBtn" class="modebtn" title="Mode &amp; thinking" aria-label="Mode">Chat ▾</button>
          <button type="button" id="attach" title="Attach files or images" aria-label="Attach files or images">📎</button>
          <span class="grow"></span>
          <button type="button" id="stop" style="display:none">Stop</button>
          <button type="submit" id="sendBtn" class="primary">Send</button>
        </div>
      </div>
    </form>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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

/** Abort-aware pause that RESOLVES (never rejects) when the signal fires — for best-effort waits. */
function waitMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Short, Claude-style one-line summary of a tool result for the `⎿` line. */
function summarizeToolResult(name: string, result: string): string {
  const lines = result.split('\n');
  const firstLine = lines.find((l) => l.trim()) ?? '';
  const clip = (s: string): string => (s.length > 100 ? `${s.slice(0, 100)}…` : s);
  switch (name) {
    case 'read_file':
      return `Read ${lines.length} line${lines.length === 1 ? '' : 's'}`;
    case 'list_directory': {
      const n = lines.filter((l) => l.trim()).length;
      return `${n} entr${n === 1 ? 'y' : 'ies'}`;
    }
    case 'find_files': {
      const n = lines.filter((l) => l.trim()).length;
      return `${n} file${n === 1 ? '' : 's'}`;
    }
    case 'search_text':
    case 'grep':
      return /^\[?no\b/i.test(firstLine) ? 'No matches' : `${lines.filter((l) => l.trim()).length} match line(s)`;
    case 'run_command':
      return clip(firstLine || '(no output)');
    case 'fetch_url':
      return `${result.length.toLocaleString()} chars`;
    default:
      return clip(firstLine);
  }
}

function runShellCommand(
  command: string,
  cwd: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal },
      (error, stdout, stderr) => {
        if (error && (error as { name?: string }).name === 'AbortError') {
          resolve('Command was stopped by the user.');
          return;
        }
        const out = `${stdout ?? ''}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim();
        // Keep head + tail with an explicit marker — for command output the tail
        // (the actual error) matters most, so never cut it off silently.
        const body = clampMiddle(out, 16000);
        // exec kills on timeout with SIGTERM and sets error.killed — tell the model so it can retry/split.
        if (error && (error as { killed?: boolean }).killed && (error as { signal?: string }).signal) {
          const secs = Math.round(timeoutMs / 1000);
          resolve(
            `[Command exceeded the ${secs}s timeout and was terminated. If it legitimately needs longer (e.g. a big install/build), raise "parley.commandTimeoutSeconds" or split it into smaller steps.]` +
              (body ? `\n\nPartial output:\n${body}` : '')
          );
          return;
        }
        if (error && !out) {
          resolve(`Command failed: ${error.message}`);
        } else {
          resolve(body || '(no output)');
        }
      }
    );
  });
}

function getNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}
