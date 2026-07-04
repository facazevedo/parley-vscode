import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';

interface DiagramKind extends vscode.QuickPickItem {
  readonly hint: string;
}

const KINDS: DiagramKind[] = [
  {
    label: 'Structure',
    detail: 'Flowchart of the main functions/classes and how they relate',
    hint: 'a Mermaid flowchart (graph TD) of the main functions/classes/modules and how they relate'
  },
  {
    label: 'Class diagram',
    detail: 'Classes with their fields, methods, and relationships',
    hint: 'a Mermaid classDiagram of the classes/interfaces with key fields, methods, and their relationships'
  },
  {
    label: 'Call / sequence flow',
    detail: 'How calls flow through the code for the main path',
    hint: 'a Mermaid sequenceDiagram showing how calls flow through the code for the primary execution path'
  },
  {
    label: 'Dependencies',
    detail: 'What this file imports and what depends on it',
    hint: "a Mermaid flowchart (graph LR) of this file's imports and exports / dependency relationships"
  }
];

/**
 * `Parley: Diagram This` — produce a Mermaid diagram of the selected code / current file
 * and stream it into the chat, where it renders inline (the webview renders Mermaid).
 */
export function registerDiagramCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.diagram', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        await vscode.window.showInformationMessage('Parley: open a file to diagram.');
        return;
      }
      const pick = await vscode.window.showQuickPick(KINDS, {
        title: 'Parley: Diagram This',
        placeHolder: 'What kind of diagram?'
      });
      if (!pick) {
        return;
      }
      const hasSelection = !editor.selection.isEmpty;
      const target = hasSelection ? 'the selected code' : 'the current file';
      const prompt =
        `Create ${pick.hint}, for ${target}. ` +
        'Output a one-line title followed by ONE ```mermaid code block containing valid Mermaid syntax and nothing else — no prose after it. ' +
        'Keep it readable: label nodes clearly, show only the important relationships, and omit trivial detail. ' +
        'Quote any node text that contains special characters so the diagram parses.';
      await runPromptCommand(
        deps,
        prompt,
        hasSelection ? { includeSelection: true, includeCurrentFile: true } : { includeCurrentFile: true }
      );
    })
  );
}
