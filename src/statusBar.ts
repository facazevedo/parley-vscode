import * as vscode from 'vscode';
import { formatUsd } from './parley/pricing';

/**
 * Status-bar ticker for the sidebar conversation: session tokens + estimated
 * cost, with a spinner while Parley is working. Clicking focuses the chat view.
 * Only the sidebar panel drives it (tab chats are visible editors with their
 * own header) — extension.ts assigns the sink to the sidebar instance only.
 */

export interface ChatStatus {
  readonly sessionTokens: number;
  readonly sessionCostUsd: number;
  readonly busy: boolean;
}

/** The item's text for a given status (pure — unit-tested). */
export function formatStatusText(s: ChatStatus): string {
  if (s.busy) {
    return '$(loading~spin) Parley working…';
  }
  const tokens =
    s.sessionTokens >= 1000
      ? (s.sessionTokens / 1000).toFixed(s.sessionTokens >= 10000 ? 0 : 1) + 'k'
      : String(s.sessionTokens);
  return `$(sparkle) ${tokens}${s.sessionCostUsd > 0 ? ' · ~' + formatUsd(s.sessionCostUsd) : ''}`;
}

export class ParleyStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private last: ChatStatus = { sessionTokens: 0, sessionCostUsd: 0, busy: false };

  public constructor(private readonly isEnabled: () => boolean) {
    this.item = vscode.window.createStatusBarItem('parley.status', vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'Parley';
    this.item.command = 'parley.chatView.focus';
  }

  public update(status: ChatStatus): void {
    this.last = status;
    if (!this.isEnabled()) {
      this.item.hide();
      return;
    }
    this.item.text = formatStatusText(status);
    this.item.tooltip = status.busy
      ? 'Parley is responding — click to open the chat.'
      : `Parley — this conversation: ${status.sessionTokens.toLocaleString()} tokens` +
        (status.sessionCostUsd > 0 ? `, ~${formatUsd(status.sessionCostUsd)} estimated` : '') +
        '. Click to open the chat.';
    this.item.show();
  }

  /** Re-apply the last status (after a configuration change). */
  public refresh(): void {
    this.update(this.last);
  }

  public dispose(): void {
    this.item.dispose();
  }
}
