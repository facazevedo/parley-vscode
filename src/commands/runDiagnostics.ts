import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import { resolveThinking } from '../parley/thinking';
import type { ChatMessage } from '../parley/types';

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * `Parley: Run Diagnostics` — exercises the live gateway with cheap calls and
 * reports what actually works on the user's key/account, including whether the
 * `thinking` parameter is honored (the empirical answer the docs can't give).
 * Image generation is intentionally NOT exercised (it costs real money).
 */
export function registerRunDiagnosticsCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.runDiagnostics', async () => {
      const settings = deps.getSettings();
      const model = settings.defaultAgent;
      const now = () => new Date().toISOString();
      const userMsg = (content: string): ChatMessage[] => [{ role: 'user', content, createdAt: now() }];

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Running Parley diagnostics…' },
        async (progress) => {
          const provider = deps.getProvider();
          const checks: Check[] = [];

          progress.report({ message: 'models' });
          try {
            const agents = await provider.listAgents();
            checks.push({ name: 'API key & /v1/models', ok: agents.length > 0, detail: `${agents.length} models available` });
          } catch (error) {
            checks.push({ name: 'API key & /v1/models', ok: false, detail: msg(error) });
          }

          progress.report({ message: 'chat' });
          try {
            const resp = await provider.sendMessage({
              prompt: 'Reply with exactly: OK',
              messages: userMsg('Reply with exactly: OK'),
              context: [],
              agentId: model
            });
            const text = resp.message.content.trim();
            checks.push({ name: `chat completion (${model})`, ok: text.length > 0, detail: text ? `replied "${text.slice(0, 40)}"` : 'empty reply' });
          } catch (error) {
            checks.push({ name: `chat completion (${model})`, ok: false, detail: msg(error) });
          }

          progress.report({ message: 'count_tokens' });
          try {
            const n = await provider.countTokens(model, userMsg('hello world'));
            checks.push({
              name: '/v1/messages/count_tokens',
              ok: typeof n === 'number',
              detail: typeof n === 'number' ? `counted ${n} tokens` : 'endpoint unavailable (falls back to estimate)'
            });
          } catch (error) {
            checks.push({ name: '/v1/messages/count_tokens', ok: false, detail: msg(error) });
          }

          progress.report({ message: 'thinking' });
          try {
            const resp = await provider.sendMessage({
              prompt: 'What is 17 * 24? Think step by step.',
              messages: userMsg('What is 17 * 24? Think step by step.'),
              context: [],
              agentId: model,
              thinking: resolveThinking('low')
            });
            const thinkingLen = resp.message.thinking?.length ?? 0;
            checks.push({
              name: `extended thinking (${model})`,
              ok: thinkingLen > 0,
              detail:
                thinkingLen > 0
                  ? `HONORED — returned ${thinkingLen} chars of reasoning`
                  : 'accepted, but this model returned no thinking content'
            });
          } catch (error) {
            checks.push({ name: `extended thinking (${model})`, ok: false, detail: msg(error) });
          }

          const accountId = vscode.workspace.getConfiguration('parley').get<string>('accountId', '').trim();
          if (accountId) {
            progress.report({ message: 'usage' });
            try {
              const usage = await provider.getUsage(accountId);
              checks.push({ name: 'account usage', ok: true, detail: `$${usage.costUsd.toFixed(4)} this month, ${usage.interactionsCount} requests` });
            } catch (error) {
              checks.push({ name: 'account usage', ok: false, detail: msg(error) });
            }
          } else {
            checks.push({ name: 'account usage', ok: true, detail: 'skipped (set "parley.accountId" to test)' });
          }

          const passed = checks.filter((c) => c.ok).length;
          const report = [
            '# Parley diagnostics',
            '',
            `Endpoint: \`${settings.endpoint}\`  `,
            `Default model: \`${model}\`  `,
            `Run at: ${now()}`,
            '',
            `**${passed} / ${checks.length} checks passed.**`,
            '',
            '| Check | Result | Detail |',
            '| --- | :---: | --- |',
            ...checks.map((c) => `| ${c.name} | ${c.ok ? '✅' : '❌'} | ${c.detail.replace(/\|/g, '\\|')} |`),
            '',
            '_Image generation is not exercised here because it incurs real cost. Tiny chat/thinking probes use a few tokens._'
          ].join('\n');

          const doc = await vscode.workspace.openTextDocument({ content: report, language: 'markdown' });
          await vscode.window.showTextDocument(doc, { preview: false });
        }
      );
    })
  );
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
