import * as vscode from 'vscode';
import type { ParleySettings } from '../config/settings';
import { collectDiagnosticsContext } from '../context/collectDiagnosticsContext';
import { collectFileContext } from '../context/collectFileContext';
import { collectOpenEditorsContext } from '../context/collectOpenEditorsContext';
import { collectSelectionContext } from '../context/collectSelectionContext';
import { collectUserSelectedFilesContext } from '../context/collectUserSelectedFilesContext';
import { renderContextPreview, totalCharacters } from '../context/contextPreview';
import { loadIgnoreMatcher } from '../context/ignoreRules';
import { confirmAndApplyChange } from '../diff/applyWorkspaceEdit';
import { ProposedContentProvider, showProposedDiff } from '../diff/showDiff';
import type { Logger } from '../logging/logger';
import type { ParleyAuthStore } from '../parley/auth';
import type { ParleyProvider } from '../parley/ParleyProvider';
import {
  ParleyApiError,
  ParleyAuthRequiredError,
  type ChatMessage,
  type ChatResponse,
  type ContextAttachment
} from '../parley/types';

export interface CommandDependencies {
  readonly getProvider: () => ParleyProvider;
  readonly getSettings: () => ParleySettings;
  readonly auth: ParleyAuthStore;
  readonly logger: Logger;
  readonly diffProvider: ProposedContentProvider;
  /**
   * When set, prompt-style commands route their turn into the chat panel so the
   * reply streams in the conversation instead of a popup. Wired in extension.ts
   * once the {@link ChatPanel} exists.
   */
  runPrompt?: (prompt: string, options: ContextOptions) => Promise<void>;
}

export interface ContextOptions {
  readonly includeSelection?: boolean;
  readonly includeCurrentFile?: boolean;
  readonly includeOpenEditors?: boolean;
  readonly includeDiagnostics?: boolean;
  readonly includeUserSelectedFiles?: boolean;
}

export async function collectCommandContext(options: ContextOptions, settings: ParleySettings): Promise<ContextAttachment[]> {
  const editor = vscode.window.activeTextEditor;
  const attachments: ContextAttachment[] = [];
  const workspaceFolder = editor ? vscode.workspace.getWorkspaceFolder(editor.document.uri) : undefined;
  const ignoreMatcher =
    workspaceFolder && workspaceFolder.uri.scheme === 'file'
      ? await loadIgnoreMatcher(workspaceFolder.uri.fsPath, settings.respectGitignore)
      : undefined;

  if (options.includeSelection && editor) {
    const selection = collectSelectionContext(editor, settings.contextMaxCharacters);
    if (selection) {
      attachments.push(selection);
    }
  }

  if (options.includeCurrentFile && editor) {
    const file = await collectFileContext(editor.document, settings.contextMaxCharacters, ignoreMatcher);
    if (file) {
      attachments.push(file);
    }
  }

  if (options.includeOpenEditors) {
    attachments.push(...(await collectOpenEditorsContext(settings.contextMaxCharacters, ignoreMatcher)));
  }

  if (options.includeDiagnostics && settings.includeDiagnostics) {
    const diagnostics = collectDiagnosticsContext(settings.contextMaxCharacters, editor?.document.uri, ignoreMatcher);
    if (diagnostics) {
      attachments.push(diagnostics);
    }
  }

  if (options.includeUserSelectedFiles) {
    attachments.push(...(await collectUserSelectedFilesContext(settings.contextMaxCharacters, ignoreMatcher)));
  }

  return attachments;
}

export async function previewAndConfirmContext(
  attachments: readonly ContextAttachment[],
  settings: ParleySettings
): Promise<boolean> {
  if (attachments.length === 0) {
    return true;
  }

  const total = totalCharacters(attachments);
  const shouldPreview = settings.confirmBeforeSendingLargeContext || total > settings.contextMaxCharacters / 2;
  if (!shouldPreview) {
    return true;
  }

  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: renderContextPreview(attachments)
  });
  await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });

  const answer = await vscode.window.showInformationMessage(
    `Send ${attachments.length} context attachment(s), ${total} characters, to Parley?`,
    { modal: true },
    'Send',
    'Cancel'
  );
  return answer === 'Send';
}

export async function sendPrompt(
  deps: CommandDependencies,
  prompt: string,
  attachments: readonly ContextAttachment[],
  agentId?: string
): Promise<ChatResponse | undefined> {
  const provider = deps.getProvider();
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: prompt,
      createdAt: new Date().toISOString()
    }
  ];

  try {
    return await provider.sendMessage({
      prompt,
      messages,
      context: attachments,
      agentId: agentId ?? deps.getSettings().defaultAgent
    });
  } catch (error) {
    await reportProviderError(deps, error);
    return undefined;
  }
}

/** Surface a provider/transport error with the most actionable message available. */
export async function reportProviderError(deps: CommandDependencies, error: unknown): Promise<void> {
  if (error instanceof ParleyAuthRequiredError) {
    const action = await vscode.window.showErrorMessage(error.message, 'Set API Key');
    if (action === 'Set API Key') {
      await vscode.commands.executeCommand('parley.setApiKey');
    }
    return;
  }

  if (error instanceof ParleyApiError) {
    deps.logger.error(`Parley API error (HTTP ${error.status})`, error);
    const showSetKey = error.status === 401 || error.status === 403;
    const action = await vscode.window.showErrorMessage(error.message, ...(showSetKey ? ['Set API Key'] : []));
    if (action === 'Set API Key') {
      await vscode.commands.executeCommand('parley.setApiKey');
    }
    return;
  }

  deps.logger.error('Parley request failed', error);
  await vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Parley request failed.');
}

export interface HandleResponseOptions {
  /** Skip the assistant-message popup when the caller already rendered it (e.g. the chat panel). */
  readonly skipMessageDisplay?: boolean;
  /** Skip the modal proposed-changes review (the chat panel renders inline Apply cards instead). */
  readonly skipProposedChanges?: boolean;
}

export async function handleResponse(
  deps: CommandDependencies,
  response: ChatResponse,
  options: HandleResponseOptions = {}
): Promise<void> {
  if (!options.skipMessageDisplay) {
    await vscode.window.showInformationMessage(response.message.content.slice(0, 500));
  }

  for (const suggestion of response.terminalSuggestions ?? []) {
    const answer = await vscode.window.showInformationMessage(
      `${suggestion.explanation}\n\nCommand: ${suggestion.command}`,
      { modal: true },
      'Insert in Terminal',
      'Copy',
      'Skip'
    );

    if (answer === 'Insert in Terminal') {
      const terminal = vscode.window.createTerminal('Parley Suggested Command');
      terminal.show();
      terminal.sendText(suggestion.command, false);
    } else if (answer === 'Copy') {
      await vscode.env.clipboard.writeText(suggestion.command);
    }
  }

  if (options.skipProposedChanges) {
    return;
  }

  for (const change of response.proposedChanges ?? []) {
    await showProposedDiff(change, deps.diffProvider);
    const answer = await vscode.window.showInformationMessage(
      `Review proposed changes for ${change.filePath}`,
      'Accept',
      'Reject',
      'Keep Diff Open'
    );

    if (answer === 'Accept') {
      const applied = await confirmAndApplyChange(change);
      if (!applied) {
        await vscode.window.showWarningMessage('Parley changes were not applied.');
      }
    }
  }
}

export async function runPromptCommand(
  deps: CommandDependencies,
  prompt: string,
  options: ContextOptions
): Promise<void> {
  // Prefer streaming the turn into the chat panel for a unified, Cursor-like UX.
  if (deps.runPrompt) {
    await deps.runPrompt(prompt, options);
    return;
  }

  const settings = deps.getSettings();
  const attachments = await collectCommandContext(options, settings);
  const confirmed = await previewAndConfirmContext(attachments, settings);
  if (!confirmed) {
    return;
  }

  const response = await sendPrompt(deps, prompt, attachments);
  if (response) {
    await handleResponse(deps, response);
  }
}
