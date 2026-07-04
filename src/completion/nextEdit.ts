import * as vscode from 'vscode';
import type { ParleySettings } from '../config/settings';
import type { ParleyProvider } from '../parley/ParleyProvider';
import type { ParleyAuthStore } from '../parley/auth';
import type { Logger } from '../logging/logger';
import { isSensitiveFile } from '../context/sensitiveFileFilter';
import { recentEditsSummary } from './recentEdits';
import { buildNextEditPrompt, parsePrediction } from '../commands/predictionParse';

interface Pending {
  readonly uri: vscode.Uri;
  readonly version: number;
  readonly range: vscode.Range;
  readonly find: string;
  readonly replace: string;
  readonly why: string;
}

/**
 * Cursor-Tab-style "next edit" prototype. After a prediction, the target location is marked
 * with a decoration + status-bar hint and the `parley.hasNextEdit` context key is set. Pressing
 * Tab (gated by that key, and only when no native suggestion is showing) jumps the cursor to the
 * target — which makes VS Code query this InlineCompletionItemProvider, rendering the replacement
 * as native ghost text; a second Tab (native inline-accept) applies it. Escape dismisses.
 *
 * Acceptance rides VS Code's native inline-completion accept (multi-line, reliable) rather than a
 * custom Tab handler, so it never fights normal Tab behavior.
 */
export class NextEditController implements vscode.InlineCompletionItemProvider {
  private pending?: Pending;
  private predicting = false;
  private autoTimer?: ReturnType<typeof setTimeout>;
  private readonly decoration: vscode.TextEditorDecorationType;
  private readonly status: vscode.StatusBarItem;

  public constructor(
    private readonly getProvider: () => ParleyProvider,
    private readonly getSettings: () => ParleySettings,
    private readonly auth: ParleyAuthStore,
    private readonly logger: Logger
  ) {
    this.decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
      border: '1px solid',
      borderColor: new vscode.ThemeColor('editorInfo.foreground'),
      overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      after: { color: new vscode.ThemeColor('editorGhostText.foreground'), margin: '0 0 0 1.5rem' }
    });
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.command = 'parley.jumpToNextEdit';
  }

  public register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this.decoration,
      this.status,
      vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, this),
      vscode.commands.registerCommand('parley.predictNextEdit', () => this.predict()),
      vscode.commands.registerCommand('parley.jumpToNextEdit', () => this.jump()),
      vscode.commands.registerCommand('parley.dismissNextEdit', () => this.clear()),
      vscode.window.onDidChangeActiveTextEditor(() => this.clear()),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocChange(e))
    );
  }

  /** Native ghost text: offered only for the pending replacement, at its exact start. */
  public provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.InlineCompletionItem[] | undefined {
    const p = this.pending;
    if (!p || document.uri.toString() !== p.uri.toString() || document.version !== p.version) {
      return undefined;
    }
    if (!position.isEqual(p.range.start)) {
      return undefined; // only when the caret has jumped to the target
    }
    if (document.getText(p.range) !== p.find) {
      return undefined; // stale
    }
    return [new vscode.InlineCompletionItem(p.replace, p.range)];
  }

  /** Predict the next edit for the active editor and show the hint. */
  public async predict(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (this.predicting || !editor || editor.document.uri.scheme !== 'file') {
      return;
    }
    if (isSensitiveFile(editor.document.uri.fsPath) || !(await this.auth.getToken())) {
      return;
    }
    this.predicting = true;
    this.status.text = '$(sync~spin) Parley: predicting…';
    this.status.tooltip = undefined;
    this.status.show();
    try {
      const doc = editor.document;
      const version = doc.version;
      const full = doc.getText();
      const prompt = buildNextEditPrompt(
        vscode.workspace.asRelativePath(doc.uri),
        doc.languageId,
        full,
        recentEditsSummary('') ?? '(no recent edits recorded yet)'
      );
      const response = await this.getProvider().sendMessage({
        prompt,
        messages: [{ role: 'user', content: prompt, createdAt: new Date().toISOString() }],
        context: [],
        agentId: this.getSettings().defaultAgent
      });
      // Bail if the document moved on while we were predicting.
      if (vscode.window.activeTextEditor?.document !== doc || doc.version !== version) {
        this.clear();
        return;
      }
      const pred = parsePrediction(response.message.content);
      if (!pred || pred.none || !pred.find || pred.replace === undefined) {
        this.flash('Parley: no next edit');
        return;
      }
      const idx = full.indexOf(pred.find);
      if (idx === -1 || full.indexOf(pred.find, idx + 1) !== -1) {
        this.flash('Parley: no clear next edit'); // not found or ambiguous
        return;
      }
      const range = new vscode.Range(doc.positionAt(idx), doc.positionAt(idx + pred.find.length));
      this.pending = {
        uri: doc.uri,
        version,
        range,
        find: pred.find,
        replace: pred.replace,
        why: pred.why ?? 'next edit'
      };
      this.show(editor);
    } catch (error) {
      this.logger.debug(`Next-edit prediction failed: ${error instanceof Error ? error.message : 'error'}`);
      this.clear();
    } finally {
      this.predicting = false;
    }
  }

  private show(editor: vscode.TextEditor): void {
    const p = this.pending;
    if (!p) {
      return;
    }
    void vscode.commands.executeCommand('setContext', 'parley.hasNextEdit', true);
    editor.setDecorations(this.decoration, [
      { range: p.range, renderOptions: { after: { contentText: `⇥ Tab — ${p.why}` } } }
    ]);
    const onScreen = editor.visibleRanges.some((r) => r.intersection(p.range));
    this.status.text = `$(arrow-right) Parley: next edit${onScreen ? '' : ' ↓'} — Tab`;
    this.status.tooltip = p.why;
    this.status.show();
  }

  /** Tab handler: jump the caret to the pending edit so the native ghost appears. */
  private async jump(): Promise<void> {
    const p = this.pending;
    const editor = vscode.window.activeTextEditor;
    if (!p || !editor || editor.document.uri.toString() !== p.uri.toString() || editor.document.version !== p.version) {
      this.clear();
      return;
    }
    editor.selection = new vscode.Selection(p.range.start, p.range.start);
    editor.revealRange(p.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    // Nudge VS Code to query this provider so the ghost renders at the new caret position.
    await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
  }

  private flash(message: string): void {
    this.clear();
    this.status.text = message;
    this.status.show();
    const timer = setTimeout(() => this.status.hide(), 2500);
    // don't leak the timer if we clear again
    void timer;
  }

  private clear(): void {
    this.pending = undefined;
    void vscode.commands.executeCommand('setContext', 'parley.hasNextEdit', false);
    for (const ed of vscode.window.visibleTextEditors) {
      ed.setDecorations(this.decoration, []);
    }
    this.status.hide();
  }

  private onDocChange(e: vscode.TextDocumentChangeEvent): void {
    // Once the pending doc changes (the edit was accepted, or the user typed), the stored
    // offsets are stale — drop the hint. The recent-edits tracker still records the change.
    if (this.pending && e.document.uri.toString() === this.pending.uri.toString() && e.contentChanges.length > 0) {
      this.clear();
    }
    // Optional auto-trigger: predict shortly after edits settle (opt-in; off by default).
    if (!this.getSettings().nextEditAutoTrigger) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (
      !editor ||
      e.document !== editor.document ||
      e.document.uri.scheme !== 'file' ||
      e.contentChanges.length === 0
    ) {
      return;
    }
    if (this.autoTimer) {
      clearTimeout(this.autoTimer);
    }
    this.autoTimer = setTimeout(() => void this.predict(), 1500);
  }
}
