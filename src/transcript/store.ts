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

// Per-file write serialization. append/rewrite of one JSONL log, and the shared
// index.json / state.json, are fire-and-forget from several ChatPanels in this one
// process; without ordering, a concurrent appendFile + full rewrite can interleave
// (Node documents concurrent appendFile as unsafe) or a stale-read upsert can drop
// entries. All writes to a given path go through one FIFO chain keyed by that path.
const writeChains = new Map<string, Promise<unknown>>();
let tmpSeq = 0;

function serialize<T>(key: string, op: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(key);
  const prev = writeChains.get(resolved) ?? Promise.resolve();
  const tail = prev.catch(() => undefined);
  const next = tail.then(op);
  writeChains.set(
    resolved,
    next.catch(() => undefined)
  );
  return next;
}

/** Atomic full-file write: temp file in the same dir, then rename over the target. */
async function atomicWrite(file: string, data: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${tmpSeq++}`;
  await fsp.writeFile(tmp, data, 'utf8');
  await fsp.rename(tmp, file);
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
  await serialize(file, async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
  });
}

/** Overwrite the whole JSONL log from an in-memory array (used to repair/sync). */
export async function writeEvents(base: string, id: string, entries: readonly TranscriptEntry[]): Promise<void> {
  const file = jsonlPath(base, id);
  // Serialized against concurrent appends to the same log, and written atomically
  // (temp + rename) so a crash mid-write can't truncate/zero the canonical log.
  await serialize(file, () =>
    atomicWrite(file, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''))
  );
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
  const file = path.join(base, 'index.json');
  // The read-modify-write must be one critical section (keyed by index.json), or two
  // panels finishing at once both read the old list and the second clobbers the first,
  // dropping a conversation from the picker. atomicWrite avoids a torn index on crash.
  await serialize(file, async () => {
    const list = (await readIndex(base)).filter((e) => e.id !== entry.id);
    list.unshift(entry);
    await atomicWrite(file, JSON.stringify(list.slice(0, 200), null, 2));
  });
}

export async function writeState(base: string, state: Record<string, unknown>): Promise<void> {
  const file = path.join(base, 'state.json');
  await serialize(file, () => atomicWrite(file, JSON.stringify(state, null, 2)));
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
