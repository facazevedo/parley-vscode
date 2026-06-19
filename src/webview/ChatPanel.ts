import * as path from 'path';
import * as vscode from 'vscode';
import type { ParleySettings } from '../config/settings';
import {
  collectCommandContext,
  handleResponse,
  previewAndConfirmContext,
  reportProviderError,
  type CommandDependencies,
  type ContextOptions
} from '../commands/common';
import { totalCharacters } from '../context/contextPreview';
import type { Logger } from '../logging/logger';
import type { ParleyProvider } from '../parley/ParleyProvider';
import { AGENT_TOOLS, runAgentTool } from '../parley/tools';
import type { AgentInfo, ChatMessage, ContextAttachment, ImageAttachment } from '../parley/types';

interface ChatPanelMessage {
  readonly type:
    | 'send'
    | 'stop'
    | 'newChat'
    | 'refreshAgents'
    | 'contextOptionsChanged'
    | 'agentChanged'
    | 'agentModeChanged'
    | 'attachFiles'
    | 'removeAttachment'
    | 'setApiKey';
  readonly prompt?: string;
  readonly agentId?: string;
  readonly value?: boolean;
  readonly id?: string;
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

export class ChatPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'parley.chatView';

  private view?: vscode.WebviewView;
  private readonly history: ChatMessage[] = [];
  private agents: readonly AgentInfo[] = [];
  private selectedAgentId = '';
  private contextOptions: Required<ContextOptions> = { ...DEFAULT_CONTEXT_OPTIONS };
  private agentMode = false;
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
    private readonly commandDeps: CommandDependencies
  ) {
    this.selectedAgentId = this.getSettings().defaultAgent;
    this.agentMode = this.getSettings().agentMode;
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
        this.history.length = 0;
        this.attachments = [];
        await this.postState();
        return;
      case 'agentChanged':
        this.selectedAgentId = message.agentId ?? this.selectedAgentId;
        return;
      case 'agentModeChanged':
        this.agentMode = Boolean(message.value);
        return;
      case 'attachFiles':
        await this.pickAttachments();
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
    const context = [...collected, ...textAttachments];
    const images = this.attachments.filter((a) => a.kind === 'image').map((a) => a.image!);

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
        { prompt, messages: this.history, context, agentId, images: images.length > 0 ? images : undefined },
        {
          signal: this.abortController.signal,
          onToken: useStream ? (delta) => this.post({ type: 'streamDelta', delta }) : undefined,
          tools: this.agentMode ? AGENT_TOOLS : undefined,
          runTool: this.agentMode ? runAgentTool : undefined,
          onToolEvent: this.agentMode
            ? (event) => this.post({ type: 'toolEvent', name: event.name, args: event.args })
            : undefined
        }
      );

      this.history.push(response.message);
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
    const hasKey = Boolean(await this.commandDeps.auth.getToken());
    this.post({
      type: 'state',
      history: this.history,
      agents: this.agents,
      hasKey,
      busy: this.busy,
      agentMode: this.agentMode,
      selectedAgentId: this.selectedAgentId,
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
      <select id="agent" aria-label="Parley model"></select>
      <button id="refresh" title="Refresh model list">↻</button>
      <button id="newChat" title="New conversation">+ New</button>
    </div>
    <div id="banner" class="banner"></div>
    <div id="history" class="history"><div class="empty">Ask Parley about your code.</div></div>
    <form id="composer" class="composer">
      <div class="ctx">
        <label><input id="includeSelection" type="checkbox" checked> Selection</label>
        <label><input id="includeCurrentFile" type="checkbox"> File</label>
        <label><input id="includeOpenEditors" type="checkbox"> Open editors</label>
        <label><input id="includeDiagnostics" type="checkbox"> Diagnostics</label>
        <label><input id="includeUserSelectedFiles" type="checkbox"> Pick files</label>
        <label title="Let Parley read files, list directories, and search the workspace on its own"><input id="agentMode" type="checkbox"> Agent</label>
      </div>
      <div id="attachments" class="attachments"></div>
      <textarea id="prompt" placeholder="Ask Parley…  (Enter to send, Shift+Enter for newline)"></textarea>
      <div class="row">
        <button type="button" id="attach" title="Attach files or images">📎</button>
        <span class="grow"></span>
        <button type="button" id="stop" style="display:none">Stop</button>
        <button type="submit" id="sendBtn" class="primary">Send</button>
      </div>
    </form>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}
