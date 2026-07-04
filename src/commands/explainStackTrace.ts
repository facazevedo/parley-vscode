import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';
import { resolveAcrossRoots } from '../parley/tools';
import { parseTraceFrames } from './traceParse';

/**
 * `Parley: Explain Stack Trace` — take a stack trace (from the selection, clipboard, or an
 * input box), open the top frame that lives in this workspace, and explain the failure + a fix.
 */
export function registerExplainStackTraceCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.explainStackTrace', async () => {
      const editor = vscode.window.activeTextEditor;
      let trace = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
      if (!trace.trim()) {
        const clip = (await vscode.env.clipboard.readText()).trim();
        if (/\n/.test(clip) && /:\d+|line \d+/.test(clip)) {
          trace = clip;
        }
      }
      if (!trace.trim()) {
        trace =
          (await vscode.window.showInputBox({
            title: 'Parley: Explain Stack Trace',
            prompt: 'Paste the stack trace / error output.',
            ignoreFocusOut: true
          })) ?? '';
      }
      if (!trace.trim()) {
        return;
      }

      // Open the first frame that resolves to a workspace file, so it's in context.
      let opened = false;
      for (const frame of parseTraceFrames(trace)) {
        try {
          let uri: vscode.Uri | undefined;
          if (path.isAbsolute(frame.file) && fs.existsSync(frame.file)) {
            uri = vscode.Uri.file(frame.file);
          } else {
            uri = await resolveAcrossRoots(frame.file);
          }
          if (!uri) {
            continue;
          }
          const doc = await vscode.workspace.openTextDocument(uri);
          const ed = await vscode.window.showTextDocument(doc);
          const pos = new vscode.Position(Math.max(0, frame.line - 1), 0);
          ed.selection = new vscode.Selection(pos, pos);
          ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          opened = true;
          break;
        } catch {
          // try the next frame
        }
      }

      const capped = trace.length > 8000 ? `${trace.slice(0, 8000)}\n[truncated]` : trace;
      const prompt =
        'Explain this stack trace / error: what failed, the most likely root cause, and how to fix it. ' +
        `Point at the specific ${opened ? 'lines (the top workspace frame is open in the editor)' : 'files/lines'} ` +
        'involved, and give the smallest safe fix.\n\n' +
        `\`\`\`\n${capped}\n\`\`\``;
      await runPromptCommand(deps, prompt, opened ? { includeCurrentFile: true } : {});
    })
  );
}
