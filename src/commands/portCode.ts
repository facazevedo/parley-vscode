import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { reportProviderError } from './common';

interface Target extends vscode.QuickPickItem {
  readonly languageId: string;
}

const TARGETS: Target[] = [
  { label: 'TypeScript', languageId: 'typescript' },
  { label: 'JavaScript', languageId: 'javascript' },
  { label: 'Python', languageId: 'python' },
  { label: 'Go', languageId: 'go' },
  { label: 'Rust', languageId: 'rust' },
  { label: 'Java', languageId: 'java' },
  { label: 'C#', languageId: 'csharp' },
  { label: 'C++', languageId: 'cpp' },
  { label: 'Ruby', languageId: 'ruby' },
  { label: 'PHP', languageId: 'php' },
  { label: 'Swift', languageId: 'swift' },
  { label: 'Kotlin', languageId: 'kotlin' }
];

function stripFences(text: string): string {
  const m = text.match(/^```[\w.+-]*\n([\s\S]*?)```\s*$/);
  return (m ? m[1] : text).replace(/\s+$/, '');
}

/**
 * `Parley: Port / Translate Code` — translate the selection (or whole file) to another
 * language and open the result in a new untitled document.
 */
export function registerPortCodeCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.portCode', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        await vscode.window.showInformationMessage('Parley: open a file (or select code) to port.');
        return;
      }
      const code = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
      if (!code.trim()) {
        await vscode.window.showInformationMessage('Parley: nothing to port.');
        return;
      }
      const sourceLang = editor.document.languageId;
      const pick = await vscode.window.showQuickPick(
        TARGETS.filter((t) => t.languageId !== sourceLang),
        { title: 'Parley: Port / Translate Code', placeHolder: `Translate this ${sourceLang} code to…` }
      );
      if (!pick) {
        return;
      }
      const prompt =
        `Port the following ${sourceLang} code to ${pick.label}, idiomatically and preserving behavior. ` +
        "Keep names/structure where sensible, use the target language's conventions and standard library, and add a brief " +
        'comment on any non-obvious translation choice. Output ONLY the translated code — no fences, no prose.\n\n' +
        `\`\`\`${sourceLang}\n${code}\n\`\`\``;
      try {
        const reply = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Parley: porting to ${pick.label}…`,
            cancellable: true
          },
          async (_p, token) => {
            const controller = new AbortController();
            token.onCancellationRequested(() => controller.abort());
            const resp = await deps.getProvider().sendMessage(
              {
                prompt,
                messages: [{ role: 'user', content: prompt, createdAt: new Date().toISOString() }],
                context: [],
                agentId: deps.getSettings().defaultAgent
              },
              { signal: controller.signal }
            );
            return resp.message.content;
          }
        );
        const ported = stripFences(reply);
        if (!ported.trim()) {
          await vscode.window.showWarningMessage('Parley: the model returned nothing to port.');
          return;
        }
        const doc = await vscode.workspace.openTextDocument({ language: pick.languageId, content: ported });
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
      } catch (error) {
        if ((error as { name?: string })?.name !== 'AbortError') {
          await reportProviderError(deps, error);
        }
      }
    })
  );
}
