import * as vscode from 'vscode';

/**
 * Surfaces Parley's selection commands in the Ctrl+. / lightbulb "Refactor" menu
 * whenever there is a non-empty selection — so Refactor / Edit / Generate tests /
 * Add docs / Explain are reachable at the cursor, not just from the right-click
 * submenu or the command palette. Each action simply invokes the existing command,
 * which reads the active selection itself.
 */
class ParleyRefactorProvider implements vscode.CodeActionProvider {
  public static readonly kinds = [vscode.CodeActionKind.RefactorRewrite];

  public provideCodeActions(
    _document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.CodeAction[] {
    if (range.isEmpty) {
      return [];
    }
    const make = (title: string, command: string): vscode.CodeAction => {
      const action = new vscode.CodeAction(title, vscode.CodeActionKind.RefactorRewrite);
      action.command = { command, title };
      return action;
    };
    return [
      make('Refactor with Parley', 'parley.refactorSelection'),
      make('Edit with Parley…', 'parley.inlineEdit'),
      make('Generate tests with Parley', 'parley.generateTests'),
      make('Add docs with Parley', 'parley.addDocs'),
      make('Explain with Parley', 'parley.explainFile')
    ];
  }
}

export function registerParleyCodeActions(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider('*', new ParleyRefactorProvider(), {
      providedCodeActionKinds: ParleyRefactorProvider.kinds
    })
  );
}
