import type { DiffRow } from '../diff/lineDiff';

/**
 * A faithful, ordered record of everything shown in the chat: messages, tool
 * activity (⏺/⎿), file-edit diffs, plans, and system notes. This is the canonical
 * transcript used for display, persistence, and export — distinct from the message
 * history sent to the model. Kept pure (no `vscode`/`fs`) so it is unit-testable.
 */

export interface TranscriptMeta {
  id: string;
  title: string;
  createdAt: string;
  exportedAt?: string;
  models: string[];
  mode: string;
  thinking: string;
  speed: string;
  messages: number;
  sessionTokens: number;
  estimatedCostUsd: number;
}

export type TranscriptEntry =
  | { kind: 'user'; text: string; images?: string[]; at: string }
  | { kind: 'assistant'; text: string; model?: string; thinking?: string; tokens?: number; at: string }
  | { kind: 'tool'; action: string; result?: string; at: string }
  | {
      kind: 'fileEdit';
      id?: string;
      path: string;
      added: number;
      removed: number;
      rows: DiffRow[];
      truncated?: boolean;
      status: 'applied' | 'proposed' | 'dismissed' | 'error';
      isNew?: boolean;
      at: string;
    }
  | { kind: 'plan'; steps: Array<{ text: string; status: string }>; at: string }
  | { kind: 'note'; text: string; at: string };

/**
 * Everything before the nth user message (0-based ordinal) — used by "edit & resend"
 * to rewind the conversation to just before that message. Returns `undefined` when
 * there is no such user message (nothing to rewind).
 */
export function truncateBeforeUserMessage(
  entries: readonly TranscriptEntry[],
  ordinal: number
): TranscriptEntry[] | undefined {
  const idx = indexOfUserMessage(entries, ordinal);
  return idx === undefined ? undefined : entries.slice(0, idx);
}

/** Transcript index of the nth user message (0-based ordinal), or undefined. */
export function indexOfUserMessage(entries: readonly TranscriptEntry[], ordinal: number): number | undefined {
  let seen = 0;
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].kind === 'user') {
      if (seen === ordinal) {
        return i;
      }
      seen += 1;
    }
  }
  return undefined;
}

/** Render diff rows as a plain unified-diff-style text block. */
export function diffRowsToText(rows: readonly DiffRow[]): string {
  return rows
    .map((r) => {
      if (r.kind === 'gap') {
        return '         ⋯';
      }
      const sign = r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' ';
      return `${sign} ${r.text}`;
    })
    .join('\n');
}

function metaPairs(meta: TranscriptMeta): Array<{ label: string; value: string }> {
  return [
    { label: 'Title', value: meta.title },
    { label: 'Started', value: safeLocale(meta.createdAt) },
    { label: 'Exported', value: safeLocale(meta.exportedAt ?? meta.createdAt) },
    { label: 'Model(s)', value: meta.models.join(', ') || '—' },
    { label: 'Mode', value: meta.mode },
    { label: 'Extended thinking', value: meta.thinking },
    { label: 'Speed', value: meta.speed },
    { label: 'Messages', value: String(meta.messages) },
    { label: 'Session tokens', value: meta.sessionTokens.toLocaleString() },
    { label: 'Estimated cost', value: `~$${meta.estimatedCostUsd.toFixed(2)}` }
  ];
}

function safeLocale(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function fileEditLabel(status: string, isNew?: boolean): string {
  switch (status) {
    case 'applied':
      return isNew ? 'Created' : 'Applied';
    case 'proposed':
      return isNew ? 'New file (proposed)' : 'Proposed edit';
    case 'dismissed':
      return 'Dismissed';
    case 'error':
      return 'Failed';
    default:
      return status;
  }
}

/** Full Markdown export of a transcript — includes tool activity, diffs, and plans. */
export function transcriptToMarkdown(meta: TranscriptMeta, entries: readonly TranscriptEntry[]): string {
  const lines: string[] = ['# Parley conversation', ''];
  for (const { label, value } of metaPairs(meta)) {
    lines.push(`- **${label}:** ${value}`);
  }
  lines.push('');

  for (const e of entries) {
    switch (e.kind) {
      case 'user':
        lines.push('## You', '', e.text, '');
        break;
      case 'assistant':
        lines.push(`## Parley${e.model ? ` · ${e.model}` : ''}`, '');
        if (e.thinking) {
          lines.push('<details><summary>💭 Thinking</summary>', '', '```', e.thinking, '```', '', '</details>', '');
        }
        lines.push(e.text || '_(no text)_', '');
        break;
      case 'tool':
        lines.push(`> ⏺ ${e.action}`);
        if (e.result) {
          lines.push(`> ⎿ ${e.result.replace(/\n/g, '\n> ')}`);
        }
        lines.push('');
        break;
      case 'fileEdit':
        lines.push(
          `**${fileEditLabel(e.status, e.isNew)}: \`${e.path}\`** (+${e.added} −${e.removed})`,
          '',
          '```diff',
          diffRowsToText(e.rows) + (e.truncated ? '\n         ⋯ (diff truncated)' : ''),
          '```',
          ''
        );
        break;
      case 'plan':
        lines.push('**Plan**', '');
        for (const s of e.steps) {
          const box = s.status === 'done' ? '[x]' : s.status === 'in_progress' ? '[~]' : '[ ]';
          lines.push(`- ${box} ${s.text}`);
        }
        lines.push('');
        break;
      case 'note':
        lines.push(`_${e.text}_`, '');
        break;
    }
  }
  return lines.join('\n');
}

/** Full plain-text export of a transcript. */
export function transcriptToPlainText(meta: TranscriptMeta, entries: readonly TranscriptEntry[]): string {
  const lines: string[] = ['Parley conversation'];
  for (const { label, value } of metaPairs(meta)) {
    lines.push(`${label}: ${value}`);
  }
  lines.push('', '='.repeat(60), '');

  for (const e of entries) {
    switch (e.kind) {
      case 'user':
        lines.push('### You', '', e.text, '', '-'.repeat(40), '');
        break;
      case 'assistant':
        lines.push(`### Parley${e.model ? ` (${e.model})` : ''}`, '');
        if (e.thinking) {
          lines.push('[Thinking]', e.thinking, '');
        }
        lines.push(e.text || '(no text)', '', '-'.repeat(40), '');
        break;
      case 'tool':
        lines.push(`  > ${e.action}`);
        if (e.result) {
          lines.push(`    ${e.result.replace(/\n/g, '\n    ')}`);
        }
        break;
      case 'fileEdit':
        lines.push(
          `  [${fileEditLabel(e.status, e.isNew)}] ${e.path}  (+${e.added} -${e.removed})`,
          diffRowsToText(e.rows) + (e.truncated ? '\n         ... (diff truncated)' : ''),
          ''
        );
        break;
      case 'plan':
        lines.push('  Plan:');
        for (const s of e.steps) {
          const box = s.status === 'done' ? '[x]' : s.status === 'in_progress' ? '[~]' : '[ ]';
          lines.push(`    ${box} ${s.text}`);
        }
        lines.push('');
        break;
      case 'note':
        lines.push(`  (${e.text})`, '');
        break;
    }
  }
  return lines.join('\n');
}
