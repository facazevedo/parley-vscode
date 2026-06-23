import { promises as fsp } from 'fs';
import * as path from 'path';
import type { TranscriptEntry } from './transcript';

/**
 * On-disk persistence for conversation transcripts, under a `.parley` folder:
 *
 *   <base>/conversations/<id>.jsonl   append-only event log (canonical, complete)
 *   <base>/conversations/<id>.md      human-readable copy, rewritten per turn
 *   <base>/index.json                 list of conversations for the picker
 *   <base>/state.json                 Parley params (selected model/mode/…)
 *
 * The JSONL log is appended one event at a time, so the full transcript is durable
 * on disk and never depends on the extension's in-memory state.
 */

export interface ConversationIndexEntry {
  id: string;
  title: string;
  savedAt: string;
  model: string;
  events: number;
}

export function conversationsDir(base: string): string {
  return path.join(base, 'conversations');
}

export function jsonlPath(base: string, id: string): string {
  return path.join(conversationsDir(base), `${id}.jsonl`);
}

export function markdownPath(base: string, id: string): string {
  return path.join(conversationsDir(base), `${id}.md`);
}

/** Append a single transcript event to the conversation's JSONL log (creates dirs as needed). */
export async function appendEvent(base: string, id: string, entry: TranscriptEntry): Promise<void> {
  const file = jsonlPath(base, id);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
}

/** Overwrite the whole JSONL log from an in-memory array (used to repair/sync). */
export async function writeEvents(base: string, id: string, entries: readonly TranscriptEntry[]): Promise<void> {
  const file = jsonlPath(base, id);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
}

/** Read and parse a conversation's JSONL log. Returns [] if missing/unreadable. */
export async function readEvents(base: string, id: string): Promise<TranscriptEntry[]> {
  try {
    const raw = await fsp.readFile(jsonlPath(base, id), 'utf8');
    const out: TranscriptEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        out.push(JSON.parse(trimmed) as TranscriptEntry);
      } catch {
        // skip a corrupt line rather than losing the whole transcript
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function writeMarkdown(base: string, id: string, markdown: string): Promise<void> {
  const file = markdownPath(base, id);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, markdown, 'utf8');
}

export async function readIndex(base: string): Promise<ConversationIndexEntry[]> {
  try {
    const raw = await fsp.readFile(path.join(base, 'index.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ConversationIndexEntry[]) : [];
  } catch {
    return [];
  }
}

/** Insert or update a conversation's index entry, newest first. */
export async function upsertIndex(base: string, entry: ConversationIndexEntry): Promise<void> {
  const list = (await readIndex(base)).filter((e) => e.id !== entry.id);
  list.unshift(entry);
  await fsp.mkdir(base, { recursive: true });
  await fsp.writeFile(path.join(base, 'index.json'), JSON.stringify(list.slice(0, 200), null, 2), 'utf8');
}

export async function writeState(base: string, state: Record<string, unknown>): Promise<void> {
  await fsp.mkdir(base, { recursive: true });
  await fsp.writeFile(path.join(base, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Create a `.gitignore` inside the base folder (once) so conversation logs aren't
 * accidentally committed. Never overwrites an existing one — the user can opt in.
 */
export async function ensureGitignore(base: string): Promise<void> {
  const file = path.join(base, '.gitignore');
  try {
    await fsp.access(file);
  } catch {
    await fsp.mkdir(base, { recursive: true });
    await fsp.writeFile(file, '# Parley conversation logs — remove this file to commit them.\n*\n', 'utf8');
  }
}
