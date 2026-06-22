import * as vscode from 'vscode';
import { registerAskSelectionCommand } from './commands/askSelection';
import type { CommandDependencies } from './commands/common';
import { registerExplainFileCommand } from './commands/explainFile';
import { registerFixDiagnosticsCommand } from './commands/fixDiagnostics';
import { registerGenerateImageCommand } from './commands/generateImage';
import { registerGenerateTestsCommand } from './commands/generateTests';
import { registerInlineEditCommand } from './commands/inlineEdit';
import { registerRefactorSelectionCommand } from './commands/refactorSelection';
import { registerSetApiKeyCommand } from './commands/setApiKey';
import { registerSignOutCommand } from './commands/signOut';
import { registerSuggestTerminalCommand } from './commands/suggestTerminalCommand';
import { registerToggleInlineCompletionCommand } from './commands/toggleInlineCompletion';
import { ParleyInlineCompletionProvider } from './completion/inlineCompletionProvider';
import { getSettings } from './config/settings';
import { CheckpointStore } from './diff/checkpoints';
import { ProposedContentProvider } from './diff/showDiff';
import { Logger } from './logging/logger';
import { ParleyAuthStore } from './parley/auth';
import { createParleyProvider } from './parley/providerFactory';
import type { ParleyProvider } from './parley/ParleyProvider';
import { ChatPanel } from './webview/ChatPanel';

export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger();
  const auth = new ParleyAuthStore(context.secrets);
  const diffProvider = new ProposedContentProvider();
  const checkpoints = new CheckpointStore();
  let settings = getSettings();
  let provider: ParleyProvider = createParleyProvider(settings, auth, logger);
  logger.setLevel(settings.logLevel);
  logger.info(`Activated Parley extension with provider: ${provider.id}`);
  context.subscriptions.push(logger);

  const refreshConfiguration = (): void => {
    settings = getSettings();
    logger.setLevel(settings.logLevel);
    provider = createParleyProvider(settings, auth, logger);
    logger.info(`Parley configuration refreshed; provider: ${provider.id}`);
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
    checkpoints
  );
  // Route prompt-style commands into the chat panel so replies stream in-conversation.
  commandDeps.runPrompt = (prompt, options) => chatPanel.submitExternalPrompt(prompt, options);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanel.viewType, chatPanel, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      new ParleyInlineCompletionProvider(() => provider, () => settings, auth, logger)
    ),
    vscode.commands.registerCommand('parley.openChatWindow', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.parley');
      await vscode.commands.executeCommand('parley.chatView.focus');
      await vscode.window.showInformationMessage(
        'Parley is open. To dock it like Codex, drag the Parley view header into the Secondary Side Bar, or use View: Toggle Secondary Side Bar Visibility first.'
      );
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
        value === 0 ? 'Parley token limit set to unlimited.' : `Parley token limit set to ${value.toLocaleString()} per conversation.`
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
  registerToggleInlineCompletionCommand(context);
  registerSignOutCommand(context, commandDeps);
}

export function deactivate(): void {
  return;
}
