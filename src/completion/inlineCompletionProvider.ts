import * as vscode from 'vscode';
import type { ParleySettings } from '../config/settings';
import type { Logger } from '../logging/logger';
import type { ParleyAuthStore } from '../parley/auth';
import type { ParleyProvider } from '../parley/ParleyProvider';

const MAX_PREFIX_CHARS = 2000;
const MAX_SUFFIX_CHARS = 1000;

/**
 * Cursor-style ghost-text completion. On a typing pause VS Code calls this; we
 * debounce, send the prefix/suffix around the cursor to a fast model, and render
 * the returned snippet as an inline suggestion.
 */
export class ParleyInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  public constructor(
    private readonly getProvider: () => ParleyProvider,
    private readonly getSettings: () => ParleySettings,
    private readonly auth: ParleyAuthStore,
    private readonly logger: Logger
  ) {}

  public async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const settings = this.getSettings();
    if (!settings.inlineCompletionEnabled) {
      return undefined;
    }
    // Only complete in real editor documents, not output/SCM/debug input boxes.
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
      return undefined;
    }
    if (!(await this.auth.getToken())) {
      return undefined;
    }

    // Debounce: a newer keystroke cancels this token, so we simply bail out.
    await delay(settings.inlineCompletionDebounceMs);
    if (token.isCancellationRequested) {
      return undefined;
    }

    const prefix = clampStart(document.getText(new vscode.Range(new vscode.Position(0, 0), position)), MAX_PREFIX_CHARS);
    const lastLine = document.lineCount - 1;
    const suffix = clampEnd(
      document.getText(new vscode.Range(position, document.lineAt(lastLine).range.end)),
      MAX_SUFFIX_CHARS
    );
    if (prefix.trim().length === 0) {
      return undefined;
    }

    const controller = new AbortController();
    const cancelSub = token.onCancellationRequested(() => controller.abort());
    try {
      const completion = await this.getProvider().complete(
        {
          prefix,
          suffix,
          languageId: document.languageId,
          model: settings.inlineCompletionModel,
          reasoningEffort: settings.reasoningEffort
        },
        controller.signal
      );
      if (token.isCancellationRequested || completion.trim().length === 0) {
        return undefined;
      }
      return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
    } catch (error) {
      if ((error as { name?: string })?.name !== 'AbortError') {
        this.logger.debug(`Inline completion failed: ${error instanceof Error ? error.message : 'unknown'}`);
      }
      return undefined;
    } finally {
      cancelSub.dispose();
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function clampStart(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

function clampEnd(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}
