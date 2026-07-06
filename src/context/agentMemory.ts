import * as path from 'path';

/**
 * Emulates the "instruction/memory file" loading semantics shared by Claude Code
 * (`CLAUDE.md`) and Gemini CLI (`GEMINI.md`). Unlike the single mutually-exclusive
 * rules file (.parleyrules / AGENTS.md / .cursorrules), these files are always-on
 * memory gathered from several places, in order of increasing specificity:
 *
 *   1. Global user memory — `~/<globalSubdir>/<fileName>` (e.g. ~/.claude/CLAUDE.md,
 *      ~/.gemini/GEMINI.md).
 *   2. Project hierarchy — `<fileName>` from each workspace root walking UP to the
 *      home directory (parent dirs are more general, so they come first).
 *   3. Subtree memory — `<fileName>` in the directories of files opened or touched
 *      this conversation, loaded on demand (monorepo/package-level rules).
 *
 * Each file may pull in others with `@path` imports (relative, absolute, or
 * `~`-rooted), resolved recursively up to {@link MAX_IMPORT_DEPTH} hops and
 * cycle-safe. Imports inside fenced code blocks or inline `code spans`, and
 * escaped `\@` references, are ignored — matching both tools.
 *
 * The pure pieces ({@link extractImports}, {@link expandTilde}) and the reader-
 * injected {@link collectAgentMemory} are unit-testable without a real fs.
 */

/** An agent's instruction-file convention: the file name + its global home dir. */
export interface MemorySpec {
  /** The instruction file name (e.g. 'CLAUDE.md', 'GEMINI.md'). */
  readonly fileName: string;
  /** The home-relative dir holding the global file (e.g. '.claude', '.gemini'). */
  readonly globalSubdir: string;
}

/** Claude Code — `~/.claude/CLAUDE.md` + the `CLAUDE.md` hierarchy. */
export const CLAUDE_MEMORY: MemorySpec = { fileName: 'CLAUDE.md', globalSubdir: '.claude' };
/** Gemini CLI — `~/.gemini/GEMINI.md` + the `GEMINI.md` hierarchy. */
export const GEMINI_MEMORY: MemorySpec = { fileName: 'GEMINI.md', globalSubdir: '.gemini' };
/** All agent-memory conventions Parley honors, so Claude Code / Gemini CLI repos work as-is. */
export const AGENT_MEMORY_SPECS: readonly MemorySpec[] = [CLAUDE_MEMORY, GEMINI_MEMORY];

/** Max `@import` recursion depth (Claude Code caps hops at 5). */
export const MAX_IMPORT_DEPTH = 5;
/** Per-file injection cap, matching the per-source cap used elsewhere. */
export const MAX_MEMORY_FILE_CHARS = 8000;
/** Combined cap across all agent-memory files. */
export const MAX_MEMORY_CHARS = 12000;

/** Reads a file's UTF-8 content, or resolves to undefined when absent/unreadable. */
export type FileReader = (absPath: string) => Promise<string | undefined>;

export interface AgentMemoryInput {
  /** Absolute fs paths of the workspace roots. */
  readonly workspaceFolders: readonly string[];
  /** Absolute fs path of the active editor file, if any. */
  readonly activeFile?: string;
  /** Absolute fs paths of files read/edited this conversation. */
  readonly touchedFiles?: readonly string[];
  /** The user's home directory (`os.homedir()`). */
  readonly home: string;
  /** File reader (injected so the collector is testable without a real fs). */
  readonly read: FileReader;
}

/** Expand a leading `~` / `~/…` (or `~\…`) to the home directory. */
export function expandTilde(p: string, home: string): string {
  if (p === '~') {
    return home;
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(home, p.slice(2));
  }
  return p;
}

/**
 * Extract `@path` import references from memory-file content. An import is `@` at
 * line start or after whitespace; references inside fenced (``` / ~~~) code
 * blocks or inline `code spans` are skipped, and a leading backslash (`\@`)
 * escapes it. Order-preserving and de-duplicated.
 */
export function extractImports(content: string): string[] {
  const imports: string[] = [];
  const seen = new Set<string>();
  let inFence = false;
  for (const rawLine of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const line = rawLine.replace(/`[^`]*`/g, ' '); // drop inline code spans
    const rx = /(^|\s)(\\?)@([^\s]+)/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(line)) !== null) {
      if (m[2] === '\\') {
        continue; // escaped \@ is not an import
      }
      // Trailing sentence punctuation isn't part of the path (`@a.md,` / `@a.md.`).
      const p = m[3].replace(/[),.;:!?\]}]+$/, '');
      if (p && !seen.has(p)) {
        seen.add(p);
        imports.push(p);
      }
    }
  }
  return imports;
}

/** Case-fold a normalized path on case-insensitive filesystems (Windows). */
function pathKey(p: string): string {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(path.normalize(parent), path.normalize(child));
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Read one memory file and inline its imports recursively. `seen` guards against
 * cycles and double-inclusion (shared across the whole collection). Returns
 * undefined when the file is missing, empty, or already included.
 */
async function resolveFile(
  absPath: string,
  read: FileReader,
  home: string,
  depth: number,
  seen: Set<string>
): Promise<string | undefined> {
  const key = pathKey(absPath);
  if (seen.has(key)) {
    return undefined;
  }
  seen.add(key);
  const raw = await read(path.normalize(absPath));
  if (raw === undefined || !raw.trim()) {
    return undefined;
  }
  let out = raw.trim().slice(0, MAX_MEMORY_FILE_CHARS);
  if (depth < MAX_IMPORT_DEPTH) {
    const baseDir = path.dirname(path.normalize(absPath));
    for (const imp of extractImports(raw)) {
      const expanded = expandTilde(imp, home);
      const target = path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
      const importedText = await resolveFile(target, read, home, depth + 1, seen);
      if (importedText) {
        out += `\n\n<!-- imported from ${imp} -->\n${importedText}`;
      }
    }
  }
  return out;
}

/** Ordered list of candidate memory-file paths for one spec (general → specific). */
function candidatePaths(input: AgentMemoryInput, spec: MemorySpec): string[] {
  const { workspaceFolders, home } = input;
  const candidates: string[] = [];

  // 1. Global user memory.
  candidates.push(path.join(home, spec.globalSubdir, spec.fileName));

  // 2. Project hierarchy: each root walking UP to the home dir (topmost first).
  for (const folder of workspaceFolders) {
    const chain: string[] = [];
    let dir = path.normalize(folder);
    for (let i = 0; i < 40; i += 1) {
      chain.push(path.join(dir, spec.fileName));
      if (samePath(dir, home)) {
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break; // filesystem root
      }
      dir = parent;
    }
    chain.reverse(); // topmost ancestor first, the root itself last
    candidates.push(...chain);
  }

  // 3. Subtree memory: from just under each root down to touched/opened files
  //    (deeper = more specific, so added last).
  const files = [input.activeFile, ...(input.touchedFiles ?? [])].filter(
    (f): f is string => typeof f === 'string' && f.length > 0
  );
  for (const file of files) {
    const root = workspaceFolders.find((f) => isUnder(file, f));
    if (!root) {
      continue;
    }
    const chain: string[] = [];
    let dir = path.dirname(path.normalize(file));
    for (let i = 0; i < 40 && !samePath(dir, root) && isUnder(dir, root); i += 1) {
      chain.push(path.join(dir, spec.fileName));
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    chain.reverse(); // shallower first, deepest (most specific) last
    candidates.push(...chain);
  }

  return candidates;
}

/**
 * Gather all applicable agent memory across the given specs (CLAUDE.md + GEMINI.md
 * by default), imports inlined, deduped, and capped for injection. Returns
 * undefined when nothing is found.
 */
export async function collectAgentMemory(
  input: AgentMemoryInput,
  specs: readonly MemorySpec[] = AGENT_MEMORY_SPECS
): Promise<string | undefined> {
  const seen = new Set<string>(); // dedups shared imports across specs too
  const sections: string[] = [];
  for (const spec of specs) {
    for (const candidate of candidatePaths(input, spec)) {
      const text = await resolveFile(candidate, input.read, input.home, 0, seen);
      if (text && text.trim()) {
        sections.push(text.trim());
      }
    }
  }
  const combined = sections.join('\n\n').trim();
  return combined ? combined.slice(0, MAX_MEMORY_CHARS) : undefined;
}
