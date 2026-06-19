import * as vscode from 'vscode';
import type { ProposedFileChange } from '../parley/types';

export class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly documents = new Map<string, string>();

  public readonly onDidChange = this.emitter.event;

  public set(uri: vscode.Uri, content: string): void {
    this.documents.set(uri.toString(), content);
    this.emitter.fire(uri);
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.toString()) ?? '';
  }
}

export async function showProposedDiff(change: ProposedFileChange, provider: ProposedContentProvider): Promise<void> {
  const originalUri = vscode.Uri.file(change.filePath);
  const proposedUri = vscode.Uri.parse(`parley-diff:${encodeURIComponent(change.filePath)}?${Date.now()}`);
  provider.set(proposedUri, change.proposedText);

  await vscode.commands.executeCommand(
    'vscode.diff',
    originalUri,
    proposedUri,
    `Parley: ${change.title ?? change.filePath}`
  );
}
