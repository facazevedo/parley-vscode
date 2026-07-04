import * as vscode from 'vscode';

/**
 * CodeLens actions above functions/classes: "$(sparkle) Parley: Explain · Test · Doc".
 * Opt-in (parley.codeLens.enabled, default off) since lenses can be noisy. Each lens focuses
 * the symbol's range and invokes the matching selection command.
 */
class ParleyCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.changeEmitter.event;

  public refresh(): void {
    this.changeEmitter.fire();
  }

  public async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!vscode.workspace.getConfiguration('parley').get<boolean>('codeLens.enabled', false)) {
      return [];
    }
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
      return [];
    }
    let symbols: vscode.DocumentSymbol[] | undefined;
    try {
      symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri
      );
    } catch {
      return [];
    }
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return [];
    }
    const wanted = new Set([
      vscode.SymbolKind.Function,
      vscode.SymbolKind.Method,
      vscode.SymbolKind.Class,
      vscode.SymbolKind.Constructor,
      vscode.SymbolKind.Interface
    ]);
    const lenses: vscode.CodeLens[] = [];
    const walk = (arr: vscode.DocumentSymbol[], depth: number): void => {
      for (const s of arr) {
        if (wanted.has(s.kind)) {
          const at = new vscode.Range(s.selectionRange.start, s.selectionRange.start);
          const args = [
            document.uri.toString(),
            s.range.start.line,
            s.range.start.character,
            s.range.end.line,
            s.range.end.character
          ];
          lenses.push(
            new vscode.CodeLens(at, {
              title: '$(sparkle) Parley: Explain',
              command: 'parley.codeLens.explain',
              arguments: args
            }),
            new vscode.CodeLens(at, { title: 'Test', command: 'parley.codeLens.test', arguments: args }),
            new vscode.CodeLens(at, { title: 'Doc', command: 'parley.codeLens.doc', arguments: args })
          );
        }
        if (s.children && s.children.length > 0 && depth < 2) {
          walk(s.children, depth + 1);
        }
      }
    };
    walk(symbols, 0);
    return lenses;
  }
}

async function focusRange(uriStr: string, sl: number, sc: number, el: number, ec: number): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriStr));
    const editor = await vscode.window.showTextDocument(doc);
    const range = new vscode.Range(sl, sc, el, ec);
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch {
    // best-effort — the invoked command falls back to the active editor
  }
}

export function registerParleyCodeLens(context: vscode.ExtensionContext): void {
  const provider = new ParleyCodeLensProvider();
  const run =
    (target: string) =>
    async (uriStr: string, sl: number, sc: number, el: number, ec: number): Promise<void> => {
      await focusRange(uriStr, sl, sc, el, ec);
      await vscode.commands.executeCommand(target);
    };
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: 'untitled' }], provider),
    vscode.commands.registerCommand('parley.codeLens.explain', run('parley.explainFile')),
    vscode.commands.registerCommand('parley.codeLens.test', run('parley.generateTests')),
    vscode.commands.registerCommand('parley.codeLens.doc', run('parley.addDocs')),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('parley.codeLens.enabled')) {
        provider.refresh();
      }
    })
  );
}
