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
import { totalCharacters } from '../context/contextPreview';
import { isSensitiveFile } from '../context/sensitiveFileFilter';
import type { CheckpointStore } from '../diff/checkpoints';
import { reviewProposedEdit } from '../diff/reviewEdit';
import { showProposedDiff } from '../diff/showDiff';
import type { Logger } from '../logging/logger';
import type { ParleyProvider } from '../parley/ParleyProvider';
import { extractMentionPaths } from '../parley/parsing';
import { AGENT_TOOLS, READ_ONLY_TOOLS, runAgentTool } from '../parley/tools';
import { normalizeThinkingLevel, resolveThinking, type ThinkingLevel } from '../parley/thinking';
import { audioFormatFromExt, audioFormatFromMime, modelSupportsAudio } from '../parley/audio';
import { documentProviderFor } from '../parley/files';
import { contextWindowFor, modelSupportsThinking } from '../parley/models';
import { estimateCostUsd, formatUsd } from '../parley/pricing';
import {
  extractAudioMp3,
  extractFrames,
  hasFfmpeg,
  resolveFfprobePath,
  type FfmpegBinaries
} from '../video/ffmpeg';
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
    | 'attachFiles'
    | 'pasteFile'
    | 'removeAttachment'
    | 'export'
    | 'compact'
    | 'openHistory'
    | 'copyText'
    | 'openLink'
    | 'mentionQuery'
    | 'setApiKey';
  readonly prompt?: string;
  readonly agentId?: string;
  readonly thinking?: string;
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
}

export class ChatPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'parley.chatView';

  private view?: vscode.WebviewView;
  private readonly history: ChatMessage[] = [];
  private agents: readonly AgentInfo[] = [];
  private selectedAgentId = '';
  private selectedThinking: ThinkingLevel = 'off';
  private contextOptions: Required<ContextOptions> = { ...DEFAULT_CONTEXT_OPTIONS };
  private mode: ChatMode = 'chat';
  private sessionTokens = 0;
  private sessionCost = 0;
  private jsonNext = false; // one-shot: request the next reply as a JSON object (/json)
  private attachments: PendingAttachment[] = [];
  private busy = false;
  private abortController?: AbortController;

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
    private readonly checkpoints: CheckpointStore
  ) {
    const settings = this.getSettings();
    // Restore the previous session if present, else fall back to settings defaults.
    const savedHistory = this.state.get<ChatMessage[]>('parley.history');
    if (Array.isArray(savedHistory)) {
      this.history.push(...savedHistory);
    }
    this.selectedAgentId = this.state.get<string>('parley.selectedAgentId', settings.defaultAgent);
    this.selectedThinking = normalizeThinkingLevel(this.state.get<string>('parley.selectedThinking', settings.thinking));
    this.mode = normalizeMode(this.state.get<string>('parley.mode', settings.defaultMode));
    this.sessionTokens = this.state.get<number>('parley.sessionTokens', 0);
    this.sessionCost = this.state.get<number>('parley.sessionCost', 0);
  }

  private save(): void {
    void this.state.update('parley.history', this.history);
    void this.state.update('parley.selectedAgentId', this.selectedAgentId);
    void this.state.update('parley.selectedThinking', this.selectedThinking);
    void this.state.update('parley.mode', this.mode);
    void this.state.update('parley.sessionTokens', this.sessionTokens);
    void this.state.update('parley.sessionCost', this.sessionCost);
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
        this.archiveCurrent();
        this.history.length = 0;
        this.attachments = [];
        this.sessionTokens = 0;
        this.sessionCost = 0;
        await this.postState();
        return;
      case 'openHistory':
        await this.openPastConversation();
        return;
      case 'agentChanged':
        this.selectedAgentId = message.agentId ?? this.selectedAgentId;
        this.save();
        return;
      case 'modeChanged':
        this.mode = normalizeMode(message.mode);
        this.save();
        await this.postState();
        return;
      case 'thinkingChanged':
        this.selectedThinking = normalizeThinkingLevel(message.thinking);
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
        this.archiveCurrent();
        this.history.length = 0;
        this.attachments = [];
        this.sessionTokens = 0;
        this.sessionCost = 0;
        await this.postState();
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
            '**Slash commands**\n- `/clear` (or `/new`) — start a new conversation\n- `/compact` — summarize to free up context (choose keep-recent or all)\n- `/cost` — show this conversation\'s token/cost usage\n- `/model` — switch the model\n- `/init` — create a project rules file (AGENTS.md)\n- `/json` — make the next reply a JSON object\n- `/help` — this list\n\nMost actions also have commands in the Command Palette (search "Parley").',
          createdAt: new Date().toISOString()
        });
        await this.postState();
        return true;
      default:
        return false;
    }
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

    let turnTokens = 0;
    const cpStart = this.checkpoints.size;
    this.post({ type: 'tokens', total: 0 });

    try {
      let auto = 0;
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
            responseFormat,
            systemExtra
          },
          {
            signal: this.abortController.signal,
            onToken: useStream ? (delta) => this.post({ type: 'streamDelta', delta }) : undefined,
            onThinking: useStream ? (delta) => this.post({ type: 'thinkingDelta', delta }) : undefined,
            tools: toolsEnabled ? (this.mode === 'plan' ? READ_ONLY_TOOLS : AGENT_TOOLS) : undefined,
            runTool: toolsEnabled ? (call) => this.runTool(call) : undefined,
            onToolEvent: toolsEnabled
              ? (event) => {
                  stepActions.push(this.describeToolEvent(event.name, event.args));
                  this.post({ type: 'toolEvent', name: event.name, args: event.args });
                }
              : undefined,
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
        const madeProgress = cleaned.trim().length > 0 || stepActions.length > 0;

        if (!madeProgress) {
          // Empty response with no tool actions: don't render a blank bubble or keep looping.
          this.history.push({
            role: 'assistant',
            content: canAutoContinue
              ? '⏸ Stopped: the model returned an empty response and took no actions. Try rephrasing, switching models, or another mode.'
              : '_(The model returned an empty response.)_',
            createdAt: new Date().toISOString(),
            model: agentId
          });
          this.post({ type: 'streamEnd' });
          await this.postState();
          break;
        }

        // If the model worked through tools but didn't narrate, persist a summary of what it did
        // so the conversation and exports aren't blank (Claude-Code-style activity log).
        if (!cleaned.trim()) {
          cleaned = stepActions.map((a) => `⏺ ${a}`).join('\n');
        }
        this.history.push({ ...response.message, content: cleaned, model: agentId });
        this.post({ type: 'streamEnd' });
        await this.postState();
        await handleResponse(this.commandDeps, response, { skipMessageDisplay: true });

        if (!canAutoContinue || done || this.abortController.signal.aborted) {
          break;
        }
        if (settings.tokenLimit > 0 && this.sessionTokens >= settings.tokenLimit) {
          this.history.push({
            role: 'assistant',
            content: `⏸ Stopped — token limit reached (${this.sessionTokens.toLocaleString()} / ${settings.tokenLimit.toLocaleString()}). Raise "parley.tokenLimit" or start a new conversation.`,
            createdAt: new Date().toISOString()
          });
          await this.postState();
          break;
        }
        if (auto >= settings.maxAutoContinue) {
          // Don't stop silently — tell the user why and how to resume.
          this.history.push({
            role: 'assistant',
            content: `⏸ Paused after ${settings.maxAutoContinue} automatic steps to avoid runaway usage. Type "continue" to keep going.`,
            createdAt: new Date().toISOString()
          });
          await this.postState();
          break;
        }
        auto += 1;
        continuation = 'Continue. If the task is already fully complete, reply with <DONE>.';
      }

      const changed = this.checkpoints.changedSince(cpStart);
      if (changed.length > 0) {
        this.history.push({
          role: 'assistant',
          content: `✏️ Changed ${changed.length} file${changed.length === 1 ? '' : 's'}: ${changed.join(', ')}\n_Run "Parley: Revert Last Edit" or "Parley: Revert All Edits" to undo._`,
          createdAt: new Date().toISOString()
        });
      }
      this.busy = false;
      this.abortController = undefined;
      await this.postState();
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
      modeNote =
        'You are an autonomous coding agent in VS Code. Keep working — read files (use read_file start_line/end_line for large files), search, edit (use edit_file for precise changes to existing files, write_file for new ones), and run commands — until the user\'s request is FULLY complete. Do not stop to ask whether to continue or wait for confirmation.\n\n' +
        'IMPORTANT — always communicate in plain text as you work: before each tool call, write a short sentence saying what you are about to do and why; after finishing a logical chunk, summarize what changed. NEVER reply with only tool calls and no text, and never return an empty message. When the entire task is finished, give a brief summary of everything you did and end your final message with <DONE> on its own line.';
    }
    return [rules, modeNote].filter(Boolean).join('\n\n') || undefined;
  }

  /** Short human label for a tool call, used to persist an activity log when the model doesn't narrate. */
  private describeToolEvent(name: string, argsJson: string): string {
    let a: { path?: string; glob?: string; query?: string; command?: string; url?: string } = {};
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

    const FRAMES = { label: 'Sample frames (visual)', detail: 'Extract frames and send them as images to a vision model' };
    const AUDIO = { label: 'Extract audio (spoken)', detail: 'Send the audio track for transcription/understanding (OpenAI/Google)' };
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
      this.attachments.push({ id, label, kind: 'document', document: { filename: label, mimeType: 'application/pdf', base64 } });
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
    const KEEP = { label: 'Summarize older, keep recent', detail: 'Summarize all but the last few messages (kept verbatim)' };
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
    }
  }

  /** Archive the current conversation into the saved-sessions list (most recent first, capped). */
  private archiveCurrent(): void {
    if (this.history.length === 0) {
      return;
    }
    const firstUser = this.history.find((m) => m.role === 'user');
    const title = (firstUser?.content ?? 'Conversation').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Conversation';
    const sessions = this.state.get<SavedSession[]>('parley.sessions', []);
    sessions.unshift({ title, savedAt: new Date().toISOString(), history: [...this.history] });
    void this.state.update('parley.sessions', sessions.slice(0, 20));
  }

  /** Pick a previously archived conversation and load it back into the chat. */
  public async openPastConversation(): Promise<void> {
    const sessions = this.state.get<SavedSession[]>('parley.sessions', []);
    if (sessions.length === 0) {
      await vscode.window.showInformationMessage('Parley: no saved conversations yet. (Conversations are archived when you start a new one.)');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      sessions.map((s, index) => ({
        label: s.title || 'Conversation',
        description: `${new Date(s.savedAt).toLocaleString()} · ${s.history.length} msgs`,
        index
      })),
      { title: 'Open a past Parley conversation' }
    );
    if (!pick) {
      return;
    }
    const chosen = sessions[pick.index];
    this.archiveCurrent();
    this.history.length = 0;
    this.history.push(...chosen.history);
    this.attachments = [];
    this.sessionTokens = 0;
    this.sessionCost = 0;
    await vscode.commands.executeCommand('workbench.view.extension.parley');
    await vscode.commands.executeCommand('parley.chatView.focus');
    await this.ready;
    await this.postState();
  }

  /** Export the current conversation to a Markdown or JSON file. */
  public async exportConversation(): Promise<void> {
    if (this.history.length === 0) {
      await vscode.window.showInformationMessage('Parley: there is no conversation to export yet.');
      return;
    }

    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Markdown (.md)', ext: 'md', json: false },
        { label: 'JSON (.json)', ext: 'json', json: true }
      ],
      { title: 'Export Parley conversation', placeHolder: 'Choose a format' }
    );
    if (!choice) {
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `parley-conversation-${stamp}.${choice.ext}`;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder, fileName) : undefined,
      saveLabel: 'Export',
      filters: choice.json ? { JSON: ['json'] } : { Markdown: ['md'] }
    });
    if (!uri) {
      return;
    }

    const content = choice.json ? JSON.stringify(this.history, null, 2) : this.toMarkdown();
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    await vscode.commands.executeCommand('vscode.open', uri);
    void vscode.window.showInformationMessage(`Parley conversation exported to ${vscode.workspace.asRelativePath(uri)}.`);
  }

  private toMarkdown(): string {
    const lines: string[] = ['# Parley conversation', '', `_Exported ${new Date().toLocaleString()}_`, ''];
    for (const message of this.history) {
      if (message.role === 'user') {
        lines.push('## You', '', message.content, '');
      } else if (message.role === 'assistant') {
        lines.push(`## Parley${message.model ? ` · ${message.model}` : ''}`, '', message.content, '');
      } else {
        lines.push(`## ${message.role}`, '', message.content, '');
      }
    }
    return lines.join('\n');
  }

  /** Tool runner for agent mode: read tools delegate to the read-only runner; writes/commands need UI + checkpoints. */
  private async runTool(call: ToolCall): Promise<string> {
    if (call.name === 'write_file') {
      return this.toolWriteFile(call);
    }
    if (call.name === 'edit_file') {
      return this.toolEditFile(call);
    }
    if (call.name === 'run_command') {
      return this.toolRunCommand(call);
    }
    return runAgentTool(call);
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
    try {
      original = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      original = '';
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
    const idx = original.indexOf(oldText);
    let proposedText: string | undefined;
    if (idx !== -1) {
      if (original.indexOf(oldText, idx + oldText.length) !== -1) {
        return `Error: old_text appears more than once in ${rel}. Include more surrounding context so it is unique.`;
      }
      proposedText = original.slice(0, idx) + newText + original.slice(idx + oldText.length);
    } else {
      // Fallback: match by trimmed lines so indentation/trailing-whitespace differences still apply.
      proposedText = replaceByTrimmedLines(original, oldText, newText);
      if (proposedText === undefined) {
        return `Error: old_text was not found in ${rel} (even ignoring indentation). Re-read the file with read_file and copy an exact snippet.`;
      }
      if (proposedText === '') {
        return `Error: old_text matches more than one place in ${rel}. Include more surrounding context so it is unique.`;
      }
    }
    return this.applyProposedEdit(uri, rel, original, proposedText);
  }

  /** Apply a proposed file change: auto in edit/auto/full modes, diff-approval otherwise. Always checkpointed. */
  private async applyProposedEdit(uri: vscode.Uri, rel: string, original: string, proposedText: string): Promise<string> {
    if (this.mode === 'edit' || this.mode === 'auto' || this.mode === 'full') {
      await this.checkpoints.applyWithCheckpoint(uri, proposedText, `edit ${rel}`);
      return `Applied edit to ${rel} (auto).`;
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
    return `Applied edit to ${rel}.`;
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
    // Full-access mode runs commands without prompting; every other mode confirms.
    if (this.mode !== 'full') {
      const answer = await vscode.window.showWarningMessage(
        `Parley agent wants to run a command in ${folder?.name ?? 'the workspace'}:\n\n${command}`,
        { modal: true },
        'Run',
        'Skip'
      );
      if (answer !== 'Run') {
        return 'User declined to run the command.';
      }
    }
    return runShellCommand(command, folder?.uri.fsPath, this.abortController?.signal);
  }

  /** Resolve `@path` mentions in the prompt into file context attachments. */
  private async resolveMentions(prompt: string, settings: ParleySettings): Promise<ContextAttachment[]> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      return [];
    }
    const out: ContextAttachment[] = [];
    for (const rel of extractMentionPaths(prompt)) {
      if (isSensitiveFile(rel)) {
        continue;
      }
      try {
        const uri = vscode.Uri.joinPath(root, rel);
        const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        const content = raw.length > settings.contextMaxCharacters ? raw.slice(0, settings.contextMaxCharacters) : raw;
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
        // Not a readable file (probably a normal "@mention" word) — ignore.
      }
    }
    return out;
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
        this.selectedAgentId = ids.has(preferred) ? preferred : this.agents[0]?.id ?? preferred;
      }
    } catch (error) {
      this.logger.warn(error instanceof Error ? error.message : 'Failed to list Parley agents.');
      this.agents = [{ id: this.getSettings().defaultAgent, label: this.getSettings().defaultAgent }];
    }
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
      agents: this.agents,
      hasKey,
      busy: this.busy,
      mode: this.mode,
      sessionTokens: this.sessionTokens,
      sessionCostUsd: this.sessionCost,
      contextPct,
      selectedAgentId: this.selectedAgentId,
      selectedThinking: this.selectedThinking,
      contextOptions: this.contextOptions,
      attachments: this.attachments.map((a) => ({ id: a.id, label: a.label, kind: a.kind }))
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chat.js'));
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
      <span id="ctx" class="ctx-meter" style="display:none"><span class="ctxring"></span><span class="ctxnum"></span></span>
      <span class="grow"></span>
      <button id="newChat" title="New conversation" aria-label="New conversation">＋</button>
      <button id="historyBtn" title="Past conversations" aria-label="Past conversations">🕘</button>
      <button id="compact" title="Compact conversation (summarize to free up context)" aria-label="Compact conversation">⊟</button>
      <button id="export" title="Export conversation" aria-label="Export conversation">⤓</button>
      <button id="refresh" title="Refresh model list" aria-label="Refresh model list">↻</button>
    </div>
    <div id="banner" class="banner"></div>
    <div id="history" class="history"><div class="empty">Ask Parley about your code.</div></div>
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
          <div class="mp-head">Extended thinking <span class="mp-note">— Claude, GPT-5, Gemini</span></div>
          <div class="mp-thinking">
            <button type="button" data-thinking="off">Off</button>
            <button type="button" data-thinking="adaptive">Adaptive</button>
            <button type="button" data-thinking="low">Low</button>
            <button type="button" data-thinking="medium">Med</button>
            <button type="button" data-thinking="high">High</button>
          </div>
          <div class="mp-foot">Thinking shows the model's reasoning before it answers (uses more output tokens). Shell commands ask before running — except in <strong>Full access</strong> mode.</div>
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

function normalizeMode(value: string | undefined): ChatMode {
  return value === 'ask' || value === 'edit' || value === 'plan' || value === 'auto' || value === 'full' ? value : 'chat';
}

/** Heuristic: model families on Parley that accept image input. */
function isLikelyVisionModel(model: string): boolean {
  return /claude|gemini|gpt-5/i.test(model);
}

/**
 * Apply an edit by matching trimmed lines (tolerant of indentation / trailing whitespace).
 * Returns the new text, `undefined` if no match, or `''` if the match is ambiguous.
 */
function replaceByTrimmedLines(original: string, oldText: string, newText: string): string | undefined | '' {
  const oldLines = oldText.replace(/\r/g, '').split('\n').map((l) => l.trim());
  while (oldLines.length && oldLines[0] === '') {
    oldLines.shift();
  }
  while (oldLines.length && oldLines[oldLines.length - 1] === '') {
    oldLines.pop();
  }
  if (oldLines.length === 0) {
    return undefined;
  }

  const fileLines = original.split('\n');
  const fileTrim = fileLines.map((l) => l.trim());
  const matches: number[] = [];
  for (let i = 0; i + oldLines.length <= fileTrim.length; i += 1) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      if (fileTrim[i + j] !== oldLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      matches.push(i);
    }
  }
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length > 1) {
    return '';
  }
  const at = matches[0];
  const replaced = [...fileLines.slice(0, at), ...newText.replace(/\r/g, '').split('\n'), ...fileLines.slice(at + oldLines.length)];
  return replaced.join('\n');
}

/** Run a shell command in cwd, returning combined stdout/stderr (truncated). User-approved per call.
 *  Passing the turn's AbortSignal lets Stop actually kill the child process. */
function runShellCommand(command: string, cwd: string | undefined, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true, signal }, (error, stdout, stderr) => {
      if (error && (error as { name?: string }).name === 'AbortError') {
        resolve('Command was stopped by the user.');
        return;
      }
      const out = `${stdout ?? ''}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim();
      const body = out.length > 8000 ? `${out.slice(0, 8000)}\n[truncated]` : out;
      if (error && !out) {
        resolve(`Command failed: ${error.message}`);
      } else {
        resolve(body || '(no output)');
      }
    });
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
