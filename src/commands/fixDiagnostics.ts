import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';

export function registerFixDiagnosticsCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.fixDiagnostics', async () => {
      await runPromptCommand(deps, 'Fix the reported diagnostics with the smallest safe code change. Explain each change.', {
        includeCurrentFile: true,
        includeDiagnostics: true
      });
    })
  );
}
