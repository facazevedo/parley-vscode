import * as vscode from 'vscode';
import { registerAskSelectionCommand } from './commands/askSelection';
import type { CommandDependencies } from './commands/common';
import { registerExplainFileCommand } from './commands/explainFile';
import { registerAddDocsCommand } from './commands/addDocs';
import { registerDiagramCommand } from './commands/diagram';
import { registerTriageTodosCommand } from './commands/triageTodos';
import { registerAuditDependenciesCommand } from './commands/auditDependencies';
import { registerCoverageTestsCommand } from './commands/coverageTests';
import { registerParleyCodeActions } from './commands/parleyCodeActions';
import { registerMcpStatusCommand } from './commands/mcpStatus';
import { registerFixDiagnosticsCommand } from './commands/fixDiagnostics';
import { registerGenerateCommitMessageCommand } from './commands/generateCommitMessage';
import { registerReviewBranchCommand } from './commands/reviewBranch';
import { registerGeneratePrDescriptionCommand } from './commands/generatePrDescription';
import { registerFileEditHistoryCommand } from './commands/fileEditHistory';
import { MEMORY_HEADER, memoryUri } from './context/projectMemory';
import { registerFixLastCommandCommand } from './commands/fixLastCommand';
import { registerUsageHistoryCommand } from './commands/usageHistory';
import { registerGenerateImageCommand } from './commands/generateImage';
import { registerGenerateTestsCommand } from './commands/generateTests';
import { registerFixFailingTestsCommand } from './commands/fixFailingTests';
import { registerInitProjectRulesCommand } from './commands/initProjectRules';
import { registerInlineEditCommand } from './commands/inlineEdit';
import { registerPredictNextEditCommand } from './commands/predictNextEdit';
import { registerRunDiagnosticsCommand } from './commands/runDiagnostics';
import { registerRefactorSelectionCommand } from './commands/refactorSelection';
import { registerSetApiKeyCommand } from './commands/setApiKey';
import { registerShowUsageCommand } from './commands/showUsage';
import { registerReportIssueCommand } from './commands/reportIssue';
import { registerSignOutCommand } from './commands/signOut';
import { registerSuggestTerminalCommand } from './commands/suggestTerminalCommand';
import { registerToggleInlineCompletionCommand } from './commands/toggleInlineCompletion';
import { ParleyInlineCompletionProvider } from './completion/inlineCompletionProvider';
import { ParleyStatusBar } from './statusBar';
import { activateRecentEdits } from './completion/recentEdits';
import { activateTerminalLog } from './context/terminalLog';
import { getSettings } from './config/settings';
import { dbg, debugLogPath, initDebug } from './debug/debug';
import { CheckpointStore } from './diff/checkpoints';
import { ProposedContentProvider } from './diff/showDiff';
import { Logger } from './logging/logger';
import { McpManager } from './mcp/McpManager';
import { closeSharedBrowser } from './browser/browserManager';
import { ParleyAuthStore } from './parley/auth';
import { createParleyProvider } from './parley/providerFactory';
import type { ParleyProvider } from './parley/ParleyProvider';
import { toolRelPath } from './parley/tools';
import { ChatPanel } from './webview/ChatPanel';

export function activate(context: vscode.ExtensionContext): void {
  initDebug(context);
  const logger = new Logger();
  const auth = new ParleyAuthStore(context.secrets);
  const diffProvider = new ProposedContentProvider();
  const checkpoints = new CheckpointStore();
  const mcp = new McpManager(logger);
  context.subscriptions.push({ dispose: () => mcp.dispose() });
  let settings = getSettings();
  let provider: ParleyProvider = createParleyProvider(settings, auth, logger);
  logger.setLevel(settings.logLevel);
  logger.info(`Activated Parley extension with provider: ${provider.id}`);
  dbg('activate', 'extension activated', {
    endpoint: settings.endpoint,
    defaultAgent: settings.defaultAgent,
    mode: settings.defaultMode
  });
  context.subscriptions.push(logger);
  activateTerminalLog(context); // for the @terminal mention (feature-detected)
  activateRecentEdits(context); // recent-edit context for ghost-text completions
  void mcp.start(settings.mcpServers);

  const statusBar = new ParleyStatusBar(() => settings.statusBarEnabled);
  context.subscriptions.push(statusBar);

  const refreshConfiguration = (): void => {
    const prevMcp = JSON.stringify(settings.mcpServers);
    settings = getSettings();
    logger.setLevel(settings.logLevel);
    provider = createParleyProvider(settings, auth, logger);
    logger.info(`Parley configuration refreshed; provider: ${provider.id}`);
    if (JSON.stringify(settings.mcpServers) !== prevMcp) {
      void mcp.start(settings.mcpServers);
    }
    statusBar.refresh();
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('parley')) {
        refreshConfiguration();
      }
    }),
    vscode.workspace.registerTextDocumentContentProvider('parley-diff', diffProvider)
  );

  const commandDeps: CommandDependencies = {
    getProvider: () => provider,
    getSettings: () => settings,
    auth,
    logger,
    diffProvider
  };

  const chatPanel = new ChatPanel(
    context.extensionUri,
    () => provider,
    () => settings,
    logger,
    commandDeps,
    context.workspaceState,
    checkpoints,
    context.globalStorageUri,
    mcp
  );
  // Route prompt-style commands into the chat panel so replies stream in-conversation.
  commandDeps.runPrompt = (prompt, options) => chatPanel.submitExternalPrompt(prompt, options);
  // Only the sidebar conversation drives the status-bar ticker (tab chats are visible editors).
  chatPanel.statusSink = (s) => statusBar.update(s);
  // Generated images render inline in the chat (in whichever chat is active).
  commandDeps.showImage = (dataUri, label) => (ChatPanel.current ?? chatPanel).showGeneratedImage(dataUri, label);
  // Palette commands act on the last-focused chat (sidebar or tab).
  const currentChat = (): ChatPanel => ChatPanel.current ?? chatPanel;

  // A parallel conversation in an editor tab: its own ChatPanel instance with
  // prefix-isolated memento state and its own checkpoint store. Transcripts
  // land in the same .parley store, so the history picker sees them.
  const openTabConversation = (): void => {
    const panel = vscode.window.createWebviewPanel('parley.chatTab', 'Parley Chat', vscode.ViewColumn.Beside, {
      retainContextWhenHidden: true
    });
    const prefix = `parley.tab.${Date.now()}.`;
    const tabState = prefixedMemento(context.workspaceState, prefix);
    const tabChat = new ChatPanel(
      context.extensionUri,
      () => provider,
      () => settings,
      logger,
      commandDeps,
      tabState,
      new CheckpointStore(),
      context.globalStorageUri,
      mcp
    );
    tabChat.attachPanel(panel);
    panel.onDidDispose(() => {
      // Don't leave the tab's memento keys behind (its transcript stays in .parley).
      for (const key of context.workspaceState.keys()) {
        if (key.startsWith(prefix)) {
          void context.workspaceState.update(key, undefined);
        }
      }
    });
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanel.viewType, chatPanel, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      new ParleyInlineCompletionProvider(
        () => provider,
        () => settings,
        auth,
        logger
      )
    ),
    vscode.commands.registerCommand('parley.openChatWindow', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.parley');
      await vscode.commands.executeCommand('parley.chatView.focus');
      await vscode.window.showInformationMessage(
        'Parley is open. To dock it like Codex, drag the Parley view header into the Secondary Side Bar, or use View: Toggle Secondary Side Bar Visibility first.'
      );
    }),
    vscode.commands.registerCommand('parley.reconnectMcp', async () => {
      await mcp.start(getSettings().mcpServers);
      const status = mcp.status();
      await vscode.window.showInformationMessage(
        status.length
          ? `Parley MCP: ${status.join(', ')}.`
          : 'Parley: no MCP servers configured (set "parley.mcpServers").'
      );
    }),
    vscode.commands.registerCommand('parley.rebuildCodebaseIndex', () => chatPanel.rebuildCodebaseIndex()),
    vscode.commands.registerCommand('parley.manageAllowedCommands', () => currentChat().manageAllowedCommands()),
    vscode.commands.registerCommand('parley.selectOutputStyle', () => currentChat().selectOutputStyle()),
    vscode.commands.registerCommand('parley.showContextBreakdown', () => currentChat().showContextBreakdown()),
    vscode.commands.registerCommand('parley.closeBrowser', async () => {
      const closed = await closeSharedBrowser();
      await vscode.window.showInformationMessage(
        closed ? 'Parley: closed the local browser.' : 'Parley: no browser was open.'
      );
    }),
    vscode.commands.registerCommand('parley.newConversationInTab', () => openTabConversation()),
    vscode.commands.registerCommand('parley.newConversationInWindow', async () => {
      // Same tab conversation, floated into its own OS window.
      openTabConversation();
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    }),
    vscode.commands.registerCommand('parley.insertSelectionMention', async () => {
      // Alt+K (Claude-Code-style): drop an @-mention of the current file — with the
      // selected line range when there is a selection — into the chat composer.
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') {
        await vscode.window.showInformationMessage('Parley: open a file to mention it in the chat.');
        return;
      }
      const chat = currentChat();
      const rel = toolRelPath(editor.document.uri);
      if (!vscode.workspace.getWorkspaceFolder(editor.document.uri) || /\s/.test(rel)) {
        // Out-of-workspace files can't be resolved from a mention, and mentions are
        // space-delimited — both attach the whole file instead (range is lost).
        await chat.attachUris([editor.document.uri]);
        return;
      }
      const sel = editor.selection;
      const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
      const range = sel.isEmpty ? '' : `#${sel.start.line + 1}-${endLine}`;
      await chat.insertComposerText(`@${rel}${range} `);
    }),
    vscode.commands.registerCommand('parley.addFileToChat', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      // Explorer/editor right-click "Add to Parley Chat" (multi-select supported).
      const targets = (uris && uris.length > 0 ? uris : uri ? [uri] : []).filter((u) => u instanceof vscode.Uri);
      if (targets.length === 0) {
        const active = vscode.window.activeTextEditor?.document.uri;
        if (active && active.scheme === 'file') {
          targets.push(active);
        }
      }
      if (targets.length === 0) {
        await vscode.window.showInformationMessage('Parley: no file selected to add to the chat.');
        return;
      }
      await currentChat().attachUris(targets);
    }),
    vscode.commands.registerCommand('parley.newConversation', () => chatPanel.newConversation()),
    vscode.commands.registerCommand('parley.openConversationsFolder', () => chatPanel.openConversationsFolder()),
    vscode.commands.registerCommand('parley.openDebugLog', async () => {
      const file = debugLogPath();
      if (!file) {
        await vscode.window.showInformationMessage('Parley debug logging is off (set DEBUG in src/debug/debug.ts).');
        return;
      }
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch {
        await vscode.window.showInformationMessage(`Parley debug log not created yet: ${file}`);
      }
    }),
    vscode.commands.registerCommand('parley.exportConversation', () => currentChat().exportConversation()),
    vscode.commands.registerCommand('parley.compactConversation', () => currentChat().compactConversation()),
    vscode.commands.registerCommand('parley.regenerate', () => currentChat().regenerateLast()),
    vscode.commands.registerCommand('parley.openPastConversation', () => currentChat().openPastConversation()),
    vscode.commands.registerCommand('parley.revertLastEdit', () => currentChat().revertLastEdit()),
    vscode.commands.registerCommand('parley.revertAll', () => currentChat().revertAllEdits()),
    vscode.commands.registerCommand('parley.setTokenLimit', async () => {
      const current = getSettings().tokenLimit;
      const input = await vscode.window.showInputBox({
        title: 'Parley: Set Token Limit',
        prompt: 'Max tokens per conversation before Parley pauses. Enter 0 for unlimited.',
        value: String(current),
        validateInput: (v) => (/^\d+$/.test(v.trim()) ? undefined : 'Enter a whole number (0 = unlimited).')
      });
      if (input === undefined) {
        return;
      }
      const value = Math.max(0, Math.floor(Number(input.trim())));
      await vscode.workspace.getConfiguration('parley').update('tokenLimit', value, vscode.ConfigurationTarget.Global);
      await vscode.window.showInformationMessage(
        value === 0
          ? 'Parley token limit set to unlimited.'
          : `Parley token limit set to ${value.toLocaleString()} per conversation.`
      );
    })
  );

  registerSetApiKeyCommand(context, commandDeps);
  registerInlineEditCommand(context, commandDeps, checkpoints);
  registerPredictNextEditCommand(context, commandDeps, checkpoints);
  registerAskSelectionCommand(context, commandDeps);
  registerExplainFileCommand(context, commandDeps);
  registerRefactorSelectionCommand(context, commandDeps);
  registerGenerateTestsCommand(context, commandDeps);
  registerFixFailingTestsCommand(context, commandDeps);
  registerAddDocsCommand(context, commandDeps);
  registerDiagramCommand(context, commandDeps);
  registerTriageTodosCommand(context, commandDeps);
  registerAuditDependenciesCommand(context, commandDeps);
  registerCoverageTestsCommand(context, commandDeps);
  registerParleyCodeActions(context);
  registerMcpStatusCommand(context, mcp);
  registerFixDiagnosticsCommand(context, commandDeps);
  registerSuggestTerminalCommand(context, commandDeps);
  registerGenerateImageCommand(context, commandDeps);
  registerGenerateCommitMessageCommand(context, commandDeps);
  registerReviewBranchCommand(context, commandDeps);
  registerGeneratePrDescriptionCommand(context, commandDeps);
  registerFileEditHistoryCommand(context, commandDeps);
  registerFixLastCommandCommand(context, commandDeps);
  registerUsageHistoryCommand(context, commandDeps);
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.openProjectMemory', async () => {
      const uri = memoryUri();
      if (!uri) {
        await vscode.window.showInformationMessage('Parley: open a workspace to use project memory.');
        return;
      }
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
        await vscode.workspace.fs.writeFile(uri, Buffer.from(MEMORY_HEADER, 'utf8'));
      }
      await vscode.window.showTextDocument(uri);
    })
  );
  registerToggleInlineCompletionCommand(context);
  registerShowUsageCommand(context, commandDeps);
  registerReportIssueCommand(context, commandDeps);
  registerRunDiagnosticsCommand(context, commandDeps);
  registerInitProjectRulesCommand(context, () => currentChat().startInit());
  registerSignOutCommand(context, commandDeps);

  // Scaffold a new Agent Skill: .parley/skills/<name>/SKILL.md with a template.
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.createSkill', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        await vscode.window.showWarningMessage('Parley: open a folder first to create a skill.');
        return;
      }
      const name = (
        await vscode.window.showInputBox({
          title: 'Parley: Create Skill',
          prompt: 'Skill name (folder under .parley/skills/) — letters, numbers, hyphens',
          placeHolder: 'pdf-form-filler',
          validateInput: (v) => (/^[a-z0-9][a-z0-9-]*$/i.test(v.trim()) ? undefined : 'Use letters, numbers, hyphens.')
        })
      )?.trim();
      if (!name) {
        return;
      }
      const dir = vscode.Uri.joinPath(folder.uri, '.parley', 'skills', name);
      const skillMd = vscode.Uri.joinPath(dir, 'SKILL.md');
      try {
        await vscode.workspace.fs.stat(skillMd);
        await vscode.window.showInformationMessage(`Parley: skill "${name}" already exists.`);
      } catch {
        const template =
          `---\ndescription: One line telling the agent WHEN to use this skill (shown always; keep it specific).\n---\n\n` +
          `# ${name}\n\nStep-by-step instructions the agent follows once this skill is loaded.\n\n` +
          `- Reference bundled files by relative path, e.g. \`.parley/skills/${name}/script.py\`, and read/run them with the normal tools.\n` +
          `- Be concrete: exact commands, file names, and the expected result.\n`;
        await vscode.workspace.fs.createDirectory(dir);
        await vscode.workspace.fs.writeFile(skillMd, Buffer.from(template, 'utf8'));
      }
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(skillMd));
    })
  );
}

/** Workspace-wide keys every chat shares (the command allowlist must not fragment per tab). */
const SHARED_MEMENTO_KEYS = new Set(['parley.allowedCommands', 'parley.promptHistory']);

/** A Memento view whose keys are namespaced, so tab conversations don't share sidebar state. */
function prefixedMemento(base: vscode.Memento, prefix: string): vscode.Memento {
  const mapKey = (key: string): string => (SHARED_MEMENTO_KEYS.has(key) ? key : prefix + key);
  return {
    keys: () => base.keys().filter((k) => k.startsWith(prefix) || SHARED_MEMENTO_KEYS.has(k)),
    get: (<T>(key: string, defaultValue?: T): T | undefined =>
      base.get<T>(mapKey(key), defaultValue as T)) as vscode.Memento['get'],
    update: (key: string, value: unknown) => base.update(mapKey(key), value)
  };
}

export function deactivate(): void {
  return;
}
