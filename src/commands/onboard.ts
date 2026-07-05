import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';
import { runShellCommand } from '../webview/toolExecutor';

const MAX_TREE_CHARS = 8000;
const MAX_DOC_CHARS = 6000;

async function readFirst(root: vscode.Uri, names: string[], cap: number): Promise<string> {
  for (const name of names) {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, name));
      const text = Buffer.from(bytes).toString('utf8');
      return text.length > cap ? `${text.slice(0, cap)}\n…(truncated)` : text;
    } catch {
      // try the next candidate
    }
  }
  return '';
}

/**
 * `Parley: Onboard Me to This Repo` — produce a new-contributor briefing: what the project is,
 * its architecture, the key files, how to build/test/run, and a Mermaid structure diagram.
 */
export function registerOnboardCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.onboard', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        await vscode.window.showInformationMessage('Parley: open a repository to onboard.');
        return;
      }
      const rawTree = (await runShellCommand('git --no-pager ls-files', root.fsPath, 15000)).trim();
      const treeText =
        rawTree && !/fatal|not a git repository/i.test(rawTree)
          ? rawTree.split('\n').slice(0, 600).join('\n')
          : '(not a git repository — infer structure from the README and package files)';
      const tree = treeText.length > MAX_TREE_CHARS ? `${treeText.slice(0, MAX_TREE_CHARS)}\n…(truncated)` : treeText;
      const readme = await readFirst(root, ['README.md', 'readme.md', 'README', 'docs/README.md'], MAX_DOC_CHARS);
      const manifest = await readFirst(
        root,
        ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle'],
        2500
      );
      const prompt =
        'Onboard me to this repository as a new contributor. Cover, with concrete file references:\n' +
        '1. What the project is and does.\n' +
        '2. The high-level architecture and the main modules/directories.\n' +
        '3. The key files and entry points to read first.\n' +
        '4. How to install, build, test, and run it.\n' +
        '5. Notable conventions or gotchas.\n' +
        'Finish with a ```mermaid diagram of the high-level structure.\n\n' +
        (readme ? `README:\n${readme}\n\n` : '') +
        (manifest ? `Project manifest:\n${manifest}\n\n` : '') +
        `Tracked files:\n${tree}`;
      await runPromptCommand(deps, prompt, {});
    })
  );
}
