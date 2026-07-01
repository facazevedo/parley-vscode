import * as vscode from 'vscode';
import { registerAskSelectionCommand } from './commands/askSelection';
import type { CommandDependencies } from './commands/common';
import { registerExplainFileCommand } from './commands/explainFile';
import { registerFixDiagnosticsCommand } from './commands/fixDiagnostics';
import { registerGenerateCommitMessageCommand } from './commands/generateCommitMessage';
import { registerGenerateImageCommand } from './commands/generateImage';
import { registerGenerateTestsCommand } from './commands/generateTests';
import { registerInitProjectRulesCommand } from './commands/initProjectRules';
import { registerInlineEditCommand } from './commands/inlineEdit';
import { registerRunDiagnosticsCommand } from './commands/runDiagnostics';
import { registerRefactorSelectionCommand } from './commands/refactorSelection';
import { registerSetApiKeyCommand } from './commands/setApiKey';
import { registerShowUsageCommand } from './commands/showUsage';
import { registerSignOutCommand } from './commands/signOut';
import { registerSuggestTerminalCommand } from './commands/suggestTerminalCommand';
import { registerToggleInlineCompletionCommand } from './commands/toggleInlineCompletion';
import { ParleyInlineCompletionProvider } from './completion/inlineCompletionProvider';
import { getSettings } from './config/settings';
import { dbg, debugLogPath, initDebug } from './debug/debug';
import { CheckpointStore } from './diff/checkpoints';
import { ProposedContentProvider } from './diff/showDiff';
import { Logger } from './logging/logger';
import { McpManager } from './mcp/McpManager';
import { ParleyAuthStore } from './parley/auth';
import { createParleyProvider } from './parley/providerFactory';
import type { ParleyProvider } from './parley/ParleyProvider';
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
  void mcp.start(settings.mcpServers);

  const refreshConfiguration = (): void => {
    const prevMcp = JSON.stringify(settings.mcpServers);
    settings = getSettings();
    logger.setLevel(settings.logLevel);
    provider = createParleyProvider(settings, auth, logger);
    logger.info(`Parley configuration refreshed; provider: ${provider.id}`);
    if (JSON.stringify(settings.mcpServers) !== prevMcp) {
      void mcp.start(settings.mcpServers);
    }
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
    vscode.commands.registerCommand('parley.manageAllowedCommands', () => chatPanel.manageAllowedCommands()),
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
    vscode.commands.registerCommand('parley.exportConversation', () => chatPanel.exportConversation()),
    vscode.commands.registerCommand('parley.compactConversation', () => chatPanel.compactConversation()),
    vscode.commands.registerCommand('parley.regenerate', () => chatPanel.regenerateLast()),
    vscode.commands.registerCommand('parley.openPastConversation', () => chatPanel.openPastConversation()),
    vscode.commands.registerCommand('parley.revertLastEdit', async () => {
      const label = await checkpoints.revertLast();
      await vscode.window.showInformationMessage(label ? `Parley reverted: ${label}.` : 'Parley: nothing to revert.');
    }),
    vscode.commands.registerCommand('parley.revertAll', async () => {
      const count = await checkpoints.revertAll();
      await vscode.window.showInformationMessage(
        count > 0 ? `Parley reverted ${count} edit${count === 1 ? '' : 's'}.` : 'Parley: nothing to revert.'
      );
    }),
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
  registerAskSelectionCommand(context, commandDeps);
  registerExplainFileCommand(context, commandDeps);
  registerRefactorSelectionCommand(context, commandDeps);
  registerGenerateTestsCommand(context, commandDeps);
  registerFixDiagnosticsCommand(context, commandDeps);
  registerSuggestTerminalCommand(context, commandDeps);
  registerGenerateImageCommand(context, commandDeps);
  registerGenerateCommitMessageCommand(context, commandDeps);
  registerToggleInlineCompletionCommand(context);
  registerShowUsageCommand(context, commandDeps);
  registerRunDiagnosticsCommand(context, commandDeps);
  registerInitProjectRulesCommand(context);
  registerSignOutCommand(context, commandDeps);
}

export function deactivate(): void {
  return;
}
