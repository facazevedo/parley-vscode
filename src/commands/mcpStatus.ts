import * as vscode from 'vscode';
import type { McpManager, McpServerStatus } from '../mcp/McpManager';

type StatusItem = vscode.QuickPickItem & { server?: McpServerStatus; action?: 'reconnect' | 'settings' };

/**
 * `Parley: MCP Server Status` — a QuickPick showing each configured MCP server
 * (connected vs. failed, transport, tool count), drilling into a server to list
 * its tools, or showing the error for a failed one. Previously this info lived
 * only in a transient toast and the output log.
 */
export function registerMcpStatusCommand(context: vscode.ExtensionContext, mcp: McpManager): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.mcpStatus', async () => {
      const statuses = mcp.serverStatuses();
      if (statuses.length === 0) {
        const action = await vscode.window.showInformationMessage(
          'Parley: no MCP servers configured. Add them under the "parley.mcpServers" setting.',
          'Open Settings',
          'Reconnect'
        );
        if (action === 'Open Settings') {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'parley.mcpServers');
        } else if (action === 'Reconnect') {
          await vscode.commands.executeCommand('parley.reconnectMcp');
        }
        return;
      }

      const connected = statuses.filter((s) => s.state === 'connected').length;
      const totalTools = statuses.reduce((n, s) => n + s.tools.length, 0);
      const items: StatusItem[] = statuses.map((s) => ({
        label: `${s.state === 'connected' ? '$(pass-filled)' : '$(error)'} ${s.name}`,
        description: `${s.kind} · ${s.state === 'connected' ? `${s.tools.length} tool(s)` : 'failed'}`,
        detail: s.state === 'failed' ? `⚠ ${s.error ?? 'failed to start'}` : s.detail,
        server: s
      }));
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: '$(refresh) Reconnect all MCP servers', action: 'reconnect' });
      items.push({ label: '$(gear) Open MCP settings', action: 'settings' });

      const picked = await vscode.window.showQuickPick(items, {
        title: `MCP: ${connected}/${statuses.length} connected · ${totalTools} tool(s)`,
        placeHolder: 'Select a server to see its tools'
      });
      if (!picked) {
        return;
      }
      if (picked.action === 'reconnect') {
        await vscode.commands.executeCommand('parley.reconnectMcp');
        return;
      }
      if (picked.action === 'settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'parley.mcpServers');
        return;
      }
      const server = picked.server;
      if (!server) {
        return;
      }
      if (server.state === 'failed') {
        const action = await vscode.window.showErrorMessage(
          `MCP "${server.name}" failed: ${server.error ?? 'unknown error'}`,
          'Reconnect',
          'Open Settings'
        );
        if (action === 'Reconnect') {
          await vscode.commands.executeCommand('parley.reconnectMcp');
        } else if (action === 'Open Settings') {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'parley.mcpServers');
        }
        return;
      }
      if (server.tools.length === 0) {
        await vscode.window.showInformationMessage(`MCP "${server.name}" connected but exposes no tools.`);
        return;
      }
      await vscode.window.showQuickPick(
        server.tools.map((t) => ({
          label: `mcp__${server.name}__${t.name}`,
          detail: t.description?.split('\n')[0] || 'No description.'
        })),
        { title: `${server.name} — ${server.tools.length} tool(s)`, placeHolder: 'Tools exposed to the agent' }
      );
    })
  );
}
