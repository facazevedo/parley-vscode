import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { recentErrors } from '../logging/errorReporter';

const ISSUES_NEW_URL = 'https://github.com/facazevedo/parley-vscode/issues/new';
// GitHub rejects very long issue URLs; keep the prefilled body well under the limit.
const MAX_PREFILL_CHARS = 6000;

/**
 * "Parley: Report an Issue" — the opt-in error channel. Assembles a sanitized
 * bug report (environment + recent captured errors, secrets and home path already
 * stripped), shows it to the user for review, and only opens a prefilled GitHub
 * issue if they choose to. Nothing is transmitted automatically.
 */
export function registerReportIssueCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.reportIssue', async () => {
      const version = String((context.extension?.packageJSON as { version?: string })?.version ?? 'unknown');
      const settings = deps.getSettings();
      const env = [
        `- Parley extension: ${version}`,
        `- VS Code: ${vscode.version}`,
        `- OS: ${process.platform}`,
        `- Model: ${settings.defaultAgent}`,
        `- Mode: ${settings.defaultMode}`
      ].join('\n');

      const errors = recentErrors();
      const errorBlock = errors.length
        ? errors
            .slice(-10)
            .map((e) => `[${e.at}] ${e.message}${e.detail ? `\n${e.detail.split('\n').slice(0, 6).join('\n')}` : ''}`)
            .join('\n\n')
        : 'No errors were captured this session.';

      const body = [
        '## What happened',
        '',
        '<!-- Describe the problem. -->',
        '',
        '## Steps to reproduce',
        '',
        '1. ',
        '',
        '## Environment',
        '',
        env,
        '',
        '## Recent Parley errors',
        '',
        '_Auto-collected and sanitized (secrets and your home path removed). Please review before submitting._',
        '',
        '```',
        errorBlock,
        '```'
      ].join('\n');

      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: body });
      await vscode.window.showTextDocument(doc, { preview: true });

      const OPEN = 'Open GitHub Issue';
      const COPY = 'Copy Report';
      const choice = await vscode.window.showInformationMessage(
        'Review this report. Nothing is sent until you submit it on GitHub — secrets and your home path have been stripped.',
        OPEN,
        COPY
      );
      if (choice === COPY) {
        await vscode.env.clipboard.writeText(body);
        void vscode.window.showInformationMessage('Parley: report copied to the clipboard.');
        return;
      }
      if (choice === OPEN) {
        // The full report is in the open document; the URL only prefills (and is length-capped).
        const prefill =
          body.length > MAX_PREFILL_CHARS
            ? `${body.slice(0, MAX_PREFILL_CHARS)}\n\n<!-- truncated — paste the rest from the report document -->`
            : body;
        const url = `${ISSUES_NEW_URL}?body=${encodeURIComponent(prefill)}`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    })
  );
}
