import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { reportProviderError } from './common';
import type { CheckpointStore } from '../diff/checkpoints';
import { reviewProposedEdit } from '../diff/reviewEdit';
import { showProposedDiff } from '../diff/showDiff';
import { runShellCommand } from '../webview/toolExecutor';

const MAX_TREE_CHARS = 8000;
const MAX_EXISTING_CHARS = 8000;

async function readFirst(root: vscode.Uri, names: string[], cap: number): Promise<string> {
  for (const name of names) {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, name));
      const text = Buffer.from(bytes).toString('utf8');
      return text.length > cap ? `${text.slice(0, cap)}\n…(truncated)` : text;
    } catch {
      // next candidate
    }
  }
  return '';
}

function stripOuterFence(text: string): string {
  const m = text.match(/^```[\w.+-]*\n([\s\S]*?)```\s*$/);
  return (m ? m[1] : text).replace(/\s+$/, '') + '\n';
}

/**
 * `Parley: Generate / Update README` — write (or update) the project's `README.md` from the
 * code, and apply it through the diff-review + checkpoint flow (a reviewable edit).
 */
export function registerGenerateReadmeCommand(
  context: vscode.ExtensionContext,
  deps: CommandDependencies,
  checkpoints: CheckpointStore
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.generateReadme', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        await vscode.window.showInformationMessage('Parley: open a project to generate a README.');
        return;
      }
      const readmeUri = vscode.Uri.joinPath(root, 'README.md');
      const existing = await readFirst(root, ['README.md'], MAX_EXISTING_CHARS);
      const rawTree = (await runShellCommand('git --no-pager ls-files', root.fsPath, 15000)).trim();
      const tree =
        rawTree && !/fatal|not a git repository/i.test(rawTree) ? rawTree.split('\n').slice(0, 600).join('\n') : '';
      const treeCapped = tree.length > MAX_TREE_CHARS ? `${tree.slice(0, MAX_TREE_CHARS)}\n…(truncated)` : tree;
      const manifest = await readFirst(root, ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'], 2500);

      const prompt =
        `${existing ? 'Update' : 'Write'} the project's README.md. Include a title + one-line description, what it does / ` +
        'key features, install, usage (with a concrete example), configuration, and a short contributing/dev note — all ' +
        'grounded in the actual code. Output ONLY the complete README.md markdown (no surrounding code fence, no preamble).\n\n' +
        (existing ? `Current README (update it; keep what's still accurate):\n${existing}\n\n` : '') +
        (manifest ? `Project manifest:\n${manifest}\n\n` : '') +
        `Tracked files:\n${treeCapped}`;

      let text: string;
      try {
        text = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Parley: writing README…', cancellable: true },
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
            return stripOuterFence(resp.message.content.trim());
          }
        );
      } catch (error) {
        if ((error as { name?: string })?.name !== 'AbortError') {
          await reportProviderError(deps, error);
        }
        return;
      }
      if (!text.trim()) {
        await vscode.window.showWarningMessage('Parley: the model returned an empty README.');
        return;
      }
      const original = existing;
      if (text === original) {
        await vscode.window.showInformationMessage('Parley: the README is already up to date.');
        return;
      }
      await showProposedDiff(
        {
          filePath: readmeUri.fsPath,
          originalText: original,
          proposedText: text,
          title: existing ? 'Update README.md' : 'Create README.md'
        },
        deps.diffProvider
      );
      const finalText = await reviewProposedEdit('README.md', original, text);
      if (finalText !== undefined) {
        await checkpoints.applyWithCheckpoint(readmeUri, finalText, existing ? 'update README' : 'create README');
        await vscode.window.showTextDocument(readmeUri, { preview: false });
      }
    })
  );
}
