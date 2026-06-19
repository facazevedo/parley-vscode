import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { reportProviderError } from './common';

const IMAGE_MODEL = 'openai/gpt-image-1';
const SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'];

export function registerGenerateImageCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.generateImage', async () => {
      const prompt = await vscode.window.showInputBox({
        title: 'Parley: Generate Image',
        prompt: 'Describe the image to generate with gpt-image-1.',
        ignoreFocusOut: true
      });
      if (!prompt?.trim()) {
        return;
      }

      const size = await vscode.window.showQuickPick(SIZES, {
        title: 'Image size',
        placeHolder: 'Choose an output size'
      });
      if (!size) {
        return;
      }

      const uri = await chooseSaveUri(prompt);
      if (!uri) {
        return;
      }

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Generating image…', cancellable: true },
          async (_progress, token) => {
            const controller = new AbortController();
            token.onCancellationRequested(() => controller.abort());

            const result = await deps.getProvider().generateImage(
              { prompt: prompt.trim(), size, model: IMAGE_MODEL },
              controller.signal
            );
            await vscode.workspace.fs.writeFile(uri, Buffer.from(result.base64, 'base64'));
          }
        );
      } catch (error) {
        if ((error as { name?: string })?.name === 'AbortError') {
          return;
        }
        await reportProviderError(deps, error);
        return;
      }

      await vscode.commands.executeCommand('vscode.open', uri);
      void vscode.window.showInformationMessage(`Parley saved the image to ${vscode.workspace.asRelativePath(uri)}.`);
    })
  );
}

async function chooseSaveUri(prompt: string): Promise<vscode.Uri | undefined> {
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
  const fileName = `parley-${slug}-${Date.now()}.png`;
  const folder = vscode.workspace.workspaceFolders?.[0];

  if (folder) {
    const dir = vscode.Uri.joinPath(folder.uri, 'parley-images');
    await vscode.workspace.fs.createDirectory(dir);
    return vscode.Uri.joinPath(dir, fileName);
  }

  return vscode.window.showSaveDialog({
    saveLabel: 'Save image',
    filters: { Images: ['png'] }
  });
}
