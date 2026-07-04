import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';

interface ExplainArg {
  readonly word?: string;
  readonly uri?: string;
  readonly line?: number;
  readonly character?: number;
}

/** Adds a lightweight "Explain with Parley" link to the hover of any symbol. It's just an
 *  entry point (no model call until clicked), so it never spams the gateway on hover. */
class ParleyExplainHover implements vscode.HoverProvider {
  public provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (!vscode.workspace.getConfiguration('parley').get<boolean>('hover.explain', true)) {
      return undefined;
    }
    const range = document.getWordRangeAtPosition(position);
    if (!range) {
      return undefined;
    }
    const word = document.getText(range);
    if (word.trim().length < 2) {
      return undefined;
    }
    const args = encodeURIComponent(
      JSON.stringify([{ word, uri: document.uri.toString(), line: range.start.line, character: range.start.character }])
    );
    const md = new vscode.MarkdownString(
      `[$(sparkle) Explain \`${word}\` with Parley](command:parley.explainSymbol?${args})`
    );
    md.isTrusted = { enabledCommands: ['parley.explainSymbol'] };
    md.supportThemeIcons = true;
    return new vscode.Hover(md, range);
  }
}

/**
 * `Parley: Explain Symbol` — explain the symbol under the cursor (or the one clicked from a
 * hover) using the current file as context. Also registers the hover entry point.
 */
export function registerExplainSymbolCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.explainSymbol', async (arg?: ExplainArg) => {
      let editor = vscode.window.activeTextEditor;
      // When invoked from a hover link, focus that document + position first.
      if (arg?.uri) {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(arg.uri));
          editor = await vscode.window.showTextDocument(doc);
          if (typeof arg.line === 'number' && typeof arg.character === 'number') {
            const pos = new vscode.Position(arg.line, arg.character);
            editor.selection = new vscode.Selection(pos, pos);
          }
        } catch {
          // fall back to the active editor
        }
      }
      if (!editor) {
        await vscode.window.showInformationMessage('Parley: open a file and place the cursor on a symbol.');
        return;
      }
      let word = arg?.word;
      if (!word) {
        const sel = editor.selection;
        if (!sel.isEmpty) {
          word = editor.document.getText(sel);
        } else {
          const r = editor.document.getWordRangeAtPosition(sel.active);
          word = r ? editor.document.getText(r) : '';
        }
      }
      if (!word?.trim()) {
        await vscode.window.showInformationMessage('Parley: place the cursor on a symbol to explain.');
        return;
      }
      const prompt =
        `Explain \`${word}\` as used in this file: what it is, what it does, its key parameters/return value ` +
        "(if it's a function/method), and where and how it's used. Be concise.";
      await runPromptCommand(deps, prompt, { includeCurrentFile: true });
    }),
    vscode.languages.registerHoverProvider([{ scheme: 'file' }, { scheme: 'untitled' }], new ParleyExplainHover())
  );
}
