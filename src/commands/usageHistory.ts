import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandDependencies } from './common';
import * as transcriptStore from '../transcript/store';
import { formatUsd } from '../parley/pricing';

/**
 * `Parley: Usage History` — a webview panel that aggregates the estimated token
 * spend Parley already records per conversation (in each `.parley` index) into a
 * by-day chart and a by-model table, across this workspace and every repo in the
 * global registry. This is the local *estimate* over time; `Parley: Show Usage`
 * remains the authoritative billed figure from the gateway.
 */

interface IndexLike {
  savedAt: string;
  model: string;
  tokens?: number;
  costUsd?: number;
}

export interface UsageSummary {
  totalTokens: number;
  totalCost: number;
  totalConversations: number;
  byDay: Array<{ date: string; tokens: number; cost: number; count: number }>;
  byModel: Array<{ model: string; tokens: number; cost: number; count: number }>;
}

/** Aggregate index entries into by-day (last 30 days) and by-model totals (pure/tested). */
export function aggregateUsage(entries: readonly IndexLike[], todayIso: string): UsageSummary {
  let totalTokens = 0;
  let totalCost = 0;
  const dayMap = new Map<string, { tokens: number; cost: number; count: number }>();
  const modelMap = new Map<string, { tokens: number; cost: number; count: number }>();
  for (const e of entries) {
    const tokens = e.tokens ?? 0;
    const cost = e.costUsd ?? 0;
    totalTokens += tokens;
    totalCost += cost;
    const day = (e.savedAt || '').slice(0, 10);
    if (day) {
      const d = dayMap.get(day) ?? { tokens: 0, cost: 0, count: 0 };
      d.tokens += tokens;
      d.cost += cost;
      d.count += 1;
      dayMap.set(day, d);
    }
    const model = e.model || 'unknown';
    const m = modelMap.get(model) ?? { tokens: 0, cost: 0, count: 0 };
    m.tokens += tokens;
    m.cost += cost;
    m.count += 1;
    modelMap.set(model, m);
  }

  // Fill a continuous 30-day window ending today so the chart has no gaps.
  const byDay: UsageSummary['byDay'] = [];
  const end = new Date(`${todayIso.slice(0, 10)}T00:00:00Z`);
  for (let i = 29; i >= 0; i -= 1) {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    const hit = dayMap.get(key);
    byDay.push({ date: key, tokens: hit?.tokens ?? 0, cost: hit?.cost ?? 0, count: hit?.count ?? 0 });
  }
  const byModel = [...modelMap.entries()]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

  return { totalTokens, totalCost, totalConversations: entries.length, byDay, byModel };
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

function renderHtml(summary: UsageSummary, nonce: string): string {
  const maxCost = Math.max(...summary.byDay.map((d) => d.cost), 0.0001);
  const bars = summary.byDay
    .map((d) => {
      const h = Math.round((d.cost / maxCost) * 100);
      const tip = `${d.date}: ${formatUsd(d.cost)} · ${d.tokens.toLocaleString()} tok · ${d.count} conv`;
      return `<div class="bar" title="${esc(tip)}"><div class="fill" style="height:${h}%"></div></div>`;
    })
    .join('');
  const modelRows =
    summary.byModel
      .map(
        (m) =>
          `<tr><td>${esc(m.model)}</td><td class="n">${formatUsd(m.cost)}</td><td class="n">${m.tokens.toLocaleString()}</td><td class="n">${m.count}</td></tr>`
      )
      .join('') || '<tr><td colspan="4" class="empty">No saved conversations yet.</td></tr>';
  const firstDay = summary.byDay[0]?.date ?? '';
  const lastDay = summary.byDay[summary.byDay.length - 1]?.date ?? '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 20px; }
  h1 { font-size: 1.15em; margin: 0 0 4px; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 18px; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 22px; }
  .card { flex: 1; min-width: 130px; border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.3)); border-radius: 8px; padding: 12px 14px; }
  .card .v { font-size: 1.5em; font-weight: 600; }
  .card .l { color: var(--vscode-descriptionForeground); font-size: 0.8em; margin-top: 2px; }
  h2 { font-size: 0.95em; margin: 18px 0 8px; }
  .chart { display: flex; align-items: flex-end; gap: 2px; height: 120px; border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,.3)); padding-bottom: 2px; }
  .bar { flex: 1; display: flex; align-items: flex-end; height: 100%; }
  .fill { width: 100%; min-height: 1px; background: var(--vscode-charts-blue, var(--vscode-progressBar-background)); border-radius: 2px 2px 0 0; }
  .fill:hover { background: var(--vscode-charts-yellow, #d9a400); }
  .axis { display: flex; justify-content: space-between; color: var(--vscode-descriptionForeground); font-size: 0.72em; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,.25)); }
  th.n, td.n { text-align: right; }
  .empty { color: var(--vscode-descriptionForeground); text-align: center; }
  .note { color: var(--vscode-descriptionForeground); font-size: 0.78em; margin-top: 18px; }
</style></head><body>
  <h1>Parley usage history</h1>
  <div class="sub">Estimated spend across your saved conversations (this workspace + all repos).</div>
  <div class="cards">
    <div class="card"><div class="v">${formatUsd(summary.totalCost)}</div><div class="l">Estimated total</div></div>
    <div class="card"><div class="v">${summary.totalTokens.toLocaleString()}</div><div class="l">Tokens</div></div>
    <div class="card"><div class="v">${summary.totalConversations}</div><div class="l">Conversations</div></div>
  </div>
  <h2>Last 30 days (estimated cost/day)</h2>
  <div class="chart">${bars}</div>
  <div class="axis"><span>${esc(firstDay)}</span><span>${esc(lastDay)}</span></div>
  <h2>By model</h2>
  <table><thead><tr><th>Model</th><th class="n">Est. cost</th><th class="n">Tokens</th><th class="n">Conversations</th></tr></thead>
  <tbody>${modelRows}</tbody></table>
  <div class="note">These are Parley's local per-conversation <em>estimates</em> (from published model rates), summed from each <code>.parley</code> index. For your authoritative billed spend, run <strong>Parley: Show Usage</strong>.</div>
</body></html>`;
}

function nonce(): string {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 24; i += 1) {
    s += a.charAt(Math.floor(Math.random() * a.length));
  }
  return s;
}

export function registerUsageHistoryCommand(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('parley.usageHistory', async () => {
      const settings = deps.getSettings();
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const globalStorage = context.globalStorageUri.fsPath;
      const currentBase =
        settings.conversationsDir || (ws ? path.join(ws, '.parley') : path.join(globalStorage, 'parley'));

      const bases = new Set<string>([path.resolve(currentBase)]);
      try {
        for (const b of await transcriptStore.readBases(globalStorage)) {
          bases.add(path.resolve(b.base));
        }
      } catch {
        // registry may not exist yet
      }
      const entries: IndexLike[] = [];
      for (const base of bases) {
        try {
          entries.push(...(await transcriptStore.readIndex(base)));
        } catch {
          // skip unreadable base
        }
      }
      const summary = aggregateUsage(entries, new Date().toISOString());

      const panel = vscode.window.createWebviewPanel(
        'parley.usageHistory',
        'Parley Usage History',
        vscode.ViewColumn.Active,
        {
          enableScripts: false
        }
      );
      panel.webview.html = renderHtml(summary, nonce());
    })
  );
}
