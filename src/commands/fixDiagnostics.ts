import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { runPromptCommand } from './common';

const MAX_DIAGNOSTICS = 5;
const MAX_MESSAGE_CHARS = 300;
const CONTEXT_LINES = 3; // lines of code shown around each diagnostic
const MAX_EXCERPT_LINES = 60;

type DiagnosticLike = Pick<vscode.Diagnostic, 'message' | 'range' | 'severity' | 'source' | 'code'>;

const SEVERITY_LABELS = ['Error', 'Warning', 'Info', 'Hint'];

/** Build a self-contained "fix these diagnostics" prompt: quoted messages plus a
 *  line-numbered excerpt of the offending code (pure — unit-testable). */
export function buildFixDiagnosticPrompt(
  relPath: string,
  languageId: string,
  docText: string,
  diagnostics: readonly DiagnosticLike[]
): string {
  const lines = docText.split(/\r?\n/);
  const diagLines = diagnostics.map((d) => {
    const sev = SEVERITY_LABELS[d.severity] ?? 'Problem';
    const msg = d.message.split('\n')[0].slice(0, MAX_MESSAGE_CHARS);
    const codeVal = typeof d.code === 'object' && d.code !== null ? d.code.value : d.code;
    const origin = [d.source, codeVal].filter((x) => x !== undefined && x !== '').join(' ');
    return `- ${sev} L${d.range.start.line + 1}: ${msg}${origin ? ` [${origin}]` : ''}`;
  });

  // Union of ±CONTEXT_LINES around each diagnostic, merged into runs, capped.
  const wanted = new Set<number>();
  for (const d of diagnostics) {
    const from = Math.max(0, d.range.start.line - CONTEXT_LINES);
    const to = Math.min(lines.length - 1, d.range.end.line + CONTEXT_LINES);
    for (let i = from; i <= to && wanted.size < MAX_EXCERPT_LINES; i += 1) {
      wanted.add(i);
    }
  }
  const sorted = [...wanted].sort((a, b) => a - b);
  const gutter = String((sorted[sorted.length - 1] ?? 0) + 1).length;
  const excerpt: string[] = [];
  let prev = -2;
  for (const i of sorted) {
    if (i !== prev + 1 && prev >= 0) {
      excerpt.push('⋮');
    }
    excerpt.push(`${String(i + 1).padStart(gutter)} | ${lines[i] ?? ''}`);
    prev = i;
  }

  return (
    `Fix the following diagnostic${diagnostics.length === 1 ? '' : 's'} in \`${relPath}\` with the smallest safe code change. Explain each change briefly.\n\n` +
    `Diagnostics:\n${diagLines.join('\n')}\n\n` +
    `Offending code (line numbers included):\n\`\`\`${languageId}\n${excerpt.join('\n')}\n\`\`\``
  );
}

/** Lightbulb provider: one bundled "Fix with Parley" QuickFix when the invoked
 *  range has non-Hint diagnostics. */
class ParleyQuickFixProvider implements vscode.CodeActionProvider {
  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const seen = new Set<string>();
    const diags = context.diagnostics
      .filter((d) => d.severity !== vscode.DiagnosticSeverity.Hint) // spell checkers etc. spam hints
      .filter((d) => {
        const key = `${d.range.start.line}:${d.range.start.character}:${d.message}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .slice(0, MAX_DIAGNOSTICS);
    if (diags.length === 0) {
      return [];
    }
    const title =
      diags.length === 1
        ? `Fix with Parley: ${diags[0].message.split('\n')[0].slice(0, 60)}`
        : `Fix ${diags.length} problems with Parley`;
    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    action.diagnostics = [...diags];
    action.command = { command: 'parley.fixDiagnostic', title, arguments: [document.uri, range, diags] };
    return [action];
  }
}

export function registerFixDiagnosticsCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    // Palette command — active file + all its diagnostics (unchanged behavior).
    vscode.commands.registerCommand('parley.fixDiagnostics', async () => {
      await runPromptCommand(
        deps,
        'Fix the reported diagnostics with the smallest safe code change. Explain each change.',
        {
          includeCurrentFile: true,
          includeDiagnostics: true
        }
      );
    }),
    // Lightbulb command — the SPECIFIC diagnostics under the cursor ride inside the
    // prompt; includeDiagnostics stays off so unrelated file problems don't drown them.
    vscode.commands.registerCommand(
      'parley.fixDiagnostic',
      async (uri: vscode.Uri, _range: vscode.Range, diagnostics: vscode.Diagnostic[]) => {
        const doc = await vscode.workspace.openTextDocument(uri);
        const rel = vscode.workspace.asRelativePath(uri);
        const prompt = buildFixDiagnosticPrompt(rel, doc.languageId, doc.getText(), diagnostics ?? []);
        await runPromptCommand(deps, prompt, { includeCurrentFile: true });
      }
    ),
    vscode.languages.registerCodeActionsProvider('*', new ParleyQuickFixProvider(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
    })
  );
}
