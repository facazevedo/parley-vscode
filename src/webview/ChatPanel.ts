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
import { showProposedDiff } from '../diff/showDiff';
import type { Logger } from '../logging/logger';
import type { ParleyProvider } from '../parley/ParleyProvider';
import { extractMentionPaths } from '../parley/parsing';
import { AGENT_TOOLS, READ_ONLY_TOOLS, runAgentTool } from '../parley/tools';
import type {
  AgentInfo,
  ChatMessage,
  ContextAttachment,
  ImageAttachment,
  ReasoningEffort,
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
    | 'effortChanged'
    | 'attachFiles'
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
  readonly effort?: string;
  readonly mode?: string;
  readonly value?: boolean;
  readonly id?: string;
  readonly text?: string;
  readonly url?: string;
  readonly query?: string;
  readonly contextOptions?: ContextOptions;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

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
  readonly kind: 'image' | 'text';
  readonly image?: ImageAttachment;
  readonly text?: ContextAttachment;
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
  private selectedEffort: ReasoningEffort = '';
  private contextOptions: Required<ContextOptions> = { ...DEFAULT_CONTEXT_OPTIONS };
  private mode: ChatMode = 'chat';
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
    this.selectedEffort = normalizeEffort(this.state.get<string>('parley.selectedEffort', settings.reasoningEffort));
    this.mode = normalizeMode(this.state.get<string>('parley.mode', settings.defaultMode));
  }

  private save(): void {
    void this.state.update('parley.history', this.history);
    void this.state.update('parley.selectedAgentId', this.selectedAgentId);
    void this.state.update('parley.selectedEffort', this.selectedEffort);
    void this.state.update('parley.mode', this.mode);
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
      case 'effortChanged':
        this.selectedEffort = normalizeEffort(message.effort);
        this.save();
        return;
      case 'attachFiles':
        await this.pickAttachments();
        return;
      case 'export':
        await this.exportConversation();
        return;
      case 'compact':
        await this.compactConversation();
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
          await this.runTurn(message.prompt.trim(), this.contextOptions);
        }
        return;
      default:
        return;
    }
  }

  private async runTurn(prompt: string, contextOptions: ContextOptions): Promise<void> {
    if (this.busy) {
      await vscode.window.showInformationMessage('Parley is still responding. Stop the current reply first.');
      return;
    }

    const settings = this.getSettings();
    const collected = await collectCommandContext(contextOptions, settings);
    const textAttachments = this.attachments.filter((a) => a.kind === 'text').map((a) => a.text!);
    const mentions = await this.resolveMentions(prompt, settings);
    const context = [...collected, ...textAttachments, ...mentions];
    const images = this.attachments.filter((a) => a.kind === 'image').map((a) => a.image!);
    const toolsEnabled = this.mode !== 'chat';
    const planNote =
      this.mode === 'plan'
        ? 'You are in PLAN mode. Do NOT edit files or run commands. Use the read-only tools to explore the codebase, then present a concise, numbered plan of the changes you would make.'
        : undefined;
    const systemExtra = [await this.readProjectRules(), planNote].filter(Boolean).join('\n\n') || undefined;

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
    await this.postState();

    this.busy = true;
    this.abortController = new AbortController();
    const useStream = settings.stream;
    const provider = this.getProvider();
    const agentId = this.selectedAgentId || settings.defaultAgent;

    if (useStream) {
      this.post({ type: 'streamStart' });
    }

    try {
      const response = await provider.sendMessage(
        {
          prompt,
          messages: this.history,
          context,
          agentId,
          images: images.length > 0 ? images : undefined,
          reasoningEffort: this.selectedEffort || undefined,
          systemExtra
        },
        {
          signal: this.abortController.signal,
          onToken: useStream ? (delta) => this.post({ type: 'streamDelta', delta }) : undefined,
          tools: toolsEnabled ? (this.mode === 'plan' ? READ_ONLY_TOOLS : AGENT_TOOLS) : undefined,
          runTool: toolsEnabled ? (call) => this.runTool(call) : undefined,
          onToolEvent: toolsEnabled
            ? (event) => this.post({ type: 'toolEvent', name: event.name, args: event.args })
            : undefined
        }
      );

      this.history.push({ ...response.message, model: agentId });
      this.busy = false;
      this.abortController = undefined;
      this.post({ type: 'streamEnd' });
      await this.postState();
      await handleResponse(this.commandDeps, response, { skipMessageDisplay: true });
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
        const bytes = await vscode.workspace.fs.readFile(uri);
        const label = path.basename(uri.fsPath);
        const ext = path.extname(uri.fsPath).toLowerCase();
        const id = `att-${Date.now()}-${this.attachments.length}`;

        if (IMAGE_EXTENSIONS.has(ext)) {
          const mime = ext === '.jpg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
          const dataUri = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
          this.attachments.push({ id, label, kind: 'image', image: { label, dataUri } });
        } else {
          const raw = Buffer.from(bytes).toString('utf8');
          const content = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
          this.attachments.push({
            id,
            label,
            kind: 'text',
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

  /**
   * Compact the conversation: ask the model to summarize it, then replace the
   * history with that summary so the chat can continue with far fewer tokens.
   * This is a client-side feature built on the normal chat endpoint — it works
   * with any model; Parley itself has no compaction endpoint.
   */
  public async compactConversation(): Promise<void> {
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
    const transcript = this.history
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
            agentId: model,
            reasoningEffort: this.selectedEffort || undefined
          });
          return response.message.content;
        }
      );

      this.history.length = 0;
      this.history.push({
        role: 'assistant',
        content: `📦 **Compacted summary of the conversation so far**\n\n${summary}`,
        createdAt: new Date().toISOString(),
        model
      });
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

    // "edit"/"auto"/"full" apply without prompting; "ask" shows a diff to approve.
    if (this.mode === 'edit' || this.mode === 'auto' || this.mode === 'full') {
      await this.checkpoints.applyWithCheckpoint(uri, proposedText, `edit ${rel}`);
      return `Applied edit to ${rel} (auto).`;
    }

    await showProposedDiff(
      { filePath: uri.fsPath, originalText: original, proposedText, title: `Agent edit: ${rel}` },
      this.commandDeps.diffProvider
    );
    const answer = await vscode.window.showInformationMessage(
      `Parley agent wants to ${original ? 'edit' : 'create'} ${rel}. Apply?`,
      { modal: true },
      'Apply',
      'Reject'
    );
    if (answer !== 'Apply') {
      return `User rejected the edit to ${rel}.`;
    }
    await this.checkpoints.applyWithCheckpoint(uri, proposedText, `edit ${rel}`);
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
    return runShellCommand(command, folder?.uri.fsPath);
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
    this.post({
      type: 'state',
      history: this.history,
      agents: this.agents,
      hasKey,
      busy: this.busy,
      mode: this.mode,
      selectedAgentId: this.selectedAgentId,
      selectedEffort: this.selectedEffort,
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
      <span class="grow"></span>
      <button id="newChat" title="New conversation" aria-label="New conversation">＋</button>
      <button id="historyBtn" title="Past conversations" aria-label="Past conversations">🕘</button>
      <button id="compact" title="Compact conversation (summarize to free up context)" aria-label="Compact conversation">⊟</button>
      <button id="export" title="Export conversation" aria-label="Export conversation">⤓</button>
      <button id="refresh" title="Refresh model list" aria-label="Refresh model list">↻</button>
    </div>
    <div id="banner" class="banner"></div>
    <div id="history" class="history"><div class="empty">Ask Parley about your code.</div></div>
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
        <div id="modePanel" class="modepanel" style="display:none">
          <div class="mp-head">Modes</div>
          <button type="button" class="mp-item" data-mode="chat"><span class="mp-name">Chat</span><span class="mp-desc">Answer only — no file access</span></button>
          <button type="button" class="mp-item" data-mode="ask"><span class="mp-name">Ask before edits</span><span class="mp-desc">Agent proposes edits; you approve each one</span></button>
          <button type="button" class="mp-item" data-mode="edit"><span class="mp-name">Edit automatically</span><span class="mp-desc">Agent applies edits without asking (revertible)</span></button>
          <button type="button" class="mp-item" data-mode="plan"><span class="mp-name">Plan mode</span><span class="mp-desc">Agent explores read-only and presents a plan</span></button>
          <button type="button" class="mp-item" data-mode="auto"><span class="mp-name">Auto mode</span><span class="mp-desc">Agent decides and applies edits automatically</span></button>
          <button type="button" class="mp-item" data-mode="full"><span class="mp-name">Full access <span class="mp-caution">⚠ CAUTION</span></span><span class="mp-desc">Auto-applies edits AND runs shell commands without asking</span></button>
          <div class="mp-sep"></div>
          <div class="mp-head">Reasoning effort <span class="mp-note">— not honored by Parley yet</span></div>
          <div class="mp-effort">
            <button type="button" data-effort="">Default</button>
            <button type="button" data-effort="minimal">Min</button>
            <button type="button" data-effort="low">Low</button>
            <button type="button" data-effort="medium">Med</button>
            <button type="button" data-effort="high">High</button>
          </div>
          <div class="mp-foot">Shell commands ask before running — except in <strong>Full access</strong> mode.</div>
        </div>
        <textarea id="prompt" placeholder="Ask Parley…  (@file to attach · Enter to send · Shift+Enter for newline)"></textarea>
        <div class="actions">
          <select id="agent" class="model" aria-label="Parley model"></select>
          <button type="button" id="modeBtn" class="modebtn" title="Mode &amp; effort" aria-label="Mode">Chat ▾</button>
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

function normalizeEffort(value: string | undefined): ReasoningEffort {
  return value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' ? value : '';
}

function normalizeMode(value: string | undefined): ChatMode {
  return value === 'ask' || value === 'edit' || value === 'plan' || value === 'auto' || value === 'full' ? value : 'chat';
}

/** Run a shell command in cwd, returning combined stdout/stderr (truncated). User-approved per call. */
function runShellCommand(command: string, cwd: string | undefined): Promise<string> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
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
