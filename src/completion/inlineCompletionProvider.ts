import * as vscode from 'vscode';
import type { ParleySettings } from '../config/settings';
import type { Logger } from '../logging/logger';
import type { ParleyAuthStore } from '../parley/auth';
import type { ParleyProvider } from '../parley/ParleyProvider';
import { openTabsSummary, recentEditsSummary } from './recentEdits';

const MAX_PREFIX_CHARS = 2000;
const MAX_SUFFIX_CHARS = 1000;

interface CachedCompletion {
  readonly docKey: string;
  readonly prefix: string;
  readonly completion: string;
}

/**
 * Cursor-style ghost-text completion. On a typing pause VS Code calls this; we
 * debounce, send the prefix/suffix around the cursor to a fast model, and render
 * the returned snippet as an inline suggestion.
 */
export class ParleyInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private lastCompletion?: CachedCompletion;

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

    // Prefix-extension cache: while the user types exactly what the last completion
    // suggested, serve the remainder locally — zero latency, zero API calls.
    const docKey = document.uri.toString();
    const fullPrefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    const cached = this.lastCompletion;
    if (cached && cached.docKey === docKey && fullPrefix.startsWith(cached.prefix)) {
      const typed = fullPrefix.slice(cached.prefix.length);
      if (typed.length > 0 && cached.completion.startsWith(typed) && cached.completion.length > typed.length) {
        return [
          new vscode.InlineCompletionItem(cached.completion.slice(typed.length), new vscode.Range(position, position))
        ];
      }
    }

    // Debounce: a newer keystroke cancels this token, so we simply bail out.
    await delay(settings.inlineCompletionDebounceMs);
    if (token.isCancellationRequested) {
      return undefined;
    }

    const prefix = clampStart(fullPrefix, MAX_PREFIX_CHARS);
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
      const raw = await this.getProvider().complete(
        {
          prefix,
          suffix,
          languageId: document.languageId,
          model: settings.inlineCompletionModel,
          recentEdits: recentEditsSummary(document.uri.fsPath),
          openFiles: openTabsSummary(document.uri.fsPath)
        },
        controller.signal
      );
      // Stop at the first blank line: keeps suggestions to one coherent block
      // instead of the model free-running into the next function.
      const completion = stopAtBlankLine(raw);
      if (token.isCancellationRequested || completion.trim().length === 0) {
        return undefined;
      }
      this.lastCompletion = { docKey, prefix: fullPrefix, completion };
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

function stopAtBlankLine(text: string): string {
  const at = text.search(/\n[ \t]*\n/);
  return at === -1 ? text : text.slice(0, at);
}

function clampStart(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

function clampEnd(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}
