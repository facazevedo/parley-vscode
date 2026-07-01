import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { execFile, type ExecFileException } from 'child_process';
import { isSensitiveFile } from '../context/sensitiveFileFilter';
import type { ToolCall, ToolDefinition } from './types';

const MAX_FILE_CHARS = 20000;
const MAX_FIND_RESULTS = 50;
const MAX_DIR_ENTRIES = 200;

/**
 * Read-only tools the model may call in agent mode to gather its own context.
 * There is intentionally no write/execute tool — edits still flow through the
 * `File:` block → diff-review pipeline, and commands are never auto-run.
 */
export const AGENT_TOOLS: readonly ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a UTF-8 text file. For large files pass start_line/end_line (1-based) to read a specific range. Returns line-numbered content plus the total line count so you can page through.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path, e.g. src/app.ts' },
          start_line: { type: 'number', description: 'First line to read (1-based). Optional.' },
          end_line: { type: 'number', description: 'Last line to read (1-based). Optional.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List the entries of a directory in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative directory path. Use "." for the root.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description:
        'Find files by glob pattern, e.g. "**/*.ts" or "src/**/auth*". Returns matching workspace-relative paths.',
      parameters: {
        type: 'object',
        properties: { glob: { type: 'string', description: 'A glob pattern matched against workspace files.' } },
        required: ['glob']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite a workspace file with the given full contents. The user reviews the change in a diff and must accept it before it is applied.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path to write.' },
          content: { type: 'string', description: 'The COMPLETE new file contents.' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Make a precise edit to an EXISTING file by replacing an exact snippet — use this instead of write_file for large files. Provide old_text copied verbatim from the file (must be unique) and new_text. The change is reviewed/applied like write_file and is checkpointed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path.' },
          old_text: { type: 'string', description: 'Exact existing snippet to replace (must appear exactly once).' },
          new_text: { type: 'string', description: 'Replacement text.' }
        },
        required: ['path', 'old_text', 'new_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Request to run a shell command in the workspace root. The user must approve each command before it runs; returns combined stdout/stderr.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The shell command to run.' } },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_text',
      description:
        'Search file CONTENTS across the workspace for a substring (case-insensitive). Returns matching "path:line: text" results. Use this to find where something is defined or used.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to search for in file contents.' },
          glob: {
            type: 'string',
            description: 'Optional glob to limit files, e.g. "src/**/*.ts". Defaults to all files.'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search file CONTENTS with a REGULAR EXPRESSION (ripgrep). More powerful than search_text: full regex syntax, optional case-insensitivity, context lines, and a glob filter. Results are "path:line:text". Respects .gitignore.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regular expression to search for (Rust regex syntax, e.g. "class \\\\w+Provider").'
          },
          glob: { type: 'string', description: 'Optional glob to limit files, e.g. "src/**/*.ts".' },
          case_insensitive: { type: 'boolean', description: 'Case-insensitive matching. Default false.' },
          context_lines: { type: 'number', description: 'Lines of context around each match (0-5). Default 0.' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch a public web page over HTTPS and return its text content (HTML stripped, truncated).',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'An https:// URL to fetch.' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web and return the top results (title, URL, snippet). Use for current information or external docs, then call fetch_url on the most relevant result for full details.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query.' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_plan',
      description:
        'Maintain a short checklist of the high-level steps for the current task (3-8 items). Call it when you begin a multi-step task and again whenever a step changes status, so the user can follow along. Exactly one step should be "in_progress" at a time.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'Ordered list of steps with their current status.',
            items: {
              type: 'object',
              properties: {
                step: { type: 'string', description: 'Short description of the step.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'Current status.' }
              },
              required: ['step', 'status']
            }
          }
        },
        required: ['steps']
      }
    }
  }
];

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'run_command']);

/** The subset of tools that never modify the workspace — used by Plan mode. */
export const READ_ONLY_TOOLS: readonly ToolDefinition[] = AGENT_TOOLS.filter(
  (tool) => !WRITE_TOOLS.has(tool.function.name)
);

const MAX_FETCH_CHARS = 12000;
const MAX_READ_LINES = 500;
const MAX_SEARCH_FILES = 800;
const MAX_SEARCH_RESULTS = 80;
const MAX_LINE_LEN = 220;
const MAX_GREP_LINES = 200;
const GREP_TIMEOUT_MS = 10000;

/** Execute an agent tool call against the workspace and return a string result. */
export async function runAgentTool(call: ToolCall): Promise<string> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    return 'Error: no workspace folder is open.';
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
  } catch {
    return 'Error: arguments were not valid JSON.';
  }

  switch (call.name) {
    case 'read_file':
      return readFile(root, String(args.path ?? ''), toNum(args.start_line), toNum(args.end_line));
    case 'list_directory':
      return listDirectory(root, String(args.path ?? '.'));
    case 'find_files':
      return findFiles(String(args.glob ?? ''));
    case 'search_text':
      return searchText(String(args.query ?? ''), args.glob ? String(args.glob) : undefined);
    case 'grep':
      return grepSearch(root, String(args.pattern ?? ''), {
        glob: args.glob ? String(args.glob) : undefined,
        caseInsensitive: args.case_insensitive === true,
        contextLines: toNum(args.context_lines)
      });
    case 'fetch_url':
      return fetchUrl(String(args.url ?? ''));
    default:
      return `Error: unknown tool "${call.name}".`;
  }
}

// ---------- grep (ripgrep) ----------

let cachedRgPath: string | undefined;

/** Locate the ripgrep binary VS Code ships with (fall back to `rg` on PATH). */
function findRipgrep(): string {
  if (cachedRgPath !== undefined) {
    return cachedRgPath;
  }
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const platformDir = `${process.platform}-${process.arch}`; // e.g. win32-x64, darwin-arm64
  const candidates: string[] = [];
  for (const modules of ['node_modules', 'node_modules.asar.unpacked']) {
    // Newer VS Code builds ship per-platform binaries under @vscode/ripgrep-universal.
    candidates.push(path.join(vscode.env.appRoot, modules, '@vscode/ripgrep-universal', 'bin', platformDir, exe));
    candidates.push(path.join(vscode.env.appRoot, modules, '@vscode/ripgrep', 'bin', exe));
    candidates.push(path.join(vscode.env.appRoot, modules, 'vscode-ripgrep', 'bin', exe));
  }
  cachedRgPath = candidates.find((p) => fs.existsSync(p)) ?? 'rg'; // last resort: PATH
  return cachedRgPath;
}

function grepSearch(
  root: vscode.Uri,
  pattern: string,
  opts: { glob?: string; caseInsensitive?: boolean; contextLines?: number }
): Promise<string> {
  if (!pattern.trim()) {
    return Promise.resolve('Error: pattern is required.');
  }
  const rg = findRipgrep();
  const args = [
    '--no-config',
    '--line-number',
    '--no-heading',
    '--color',
    'never',
    '--max-columns',
    '250',
    '--max-columns-preview',
    '--max-filesize',
    '1M',
    '--max-count',
    '25'
  ];
  if (opts.caseInsensitive) {
    args.push('-i');
  }
  const ctx = Math.max(0, Math.min(5, Math.floor(opts.contextLines ?? 0)));
  if (ctx > 0) {
    args.push('-C', String(ctx));
  }
  if (opts.glob) {
    args.push('--glob', opts.glob);
  }
  // rg honors .gitignore by default; also exclude build output and credential-like files.
  for (const ex of [
    '!**/node_modules/**',
    '!**/.git/**',
    '!**/out/**',
    '!**/dist/**',
    '!**/.env*',
    '!**/*.pem',
    '!**/*.key',
    '!**/id_rsa*',
    '!**/.ssh/**',
    '!**/.aws/**'
  ]) {
    args.push('--glob', ex);
  }
  args.push('--regexp', pattern, '--', '.');

  return new Promise((resolve) => {
    execFile(
      rg,
      args,
      { cwd: root.fsPath, timeout: GREP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error && (error as { killed?: boolean }).killed) {
          resolve('Error: grep timed out after 10s — narrow the pattern or add a glob.');
          return;
        }
        // rg exits 1 for "no matches", 2 for a real error (e.g. bad regex).
        if (error && !stdout) {
          const code = (error as { code?: number | string }).code;
          if (code === 1) {
            resolve('[no matches]');
            return;
          }
          const detail = (stderr || error.message || '').trim().split('\n')[0];
          resolve(
            detail && code !== 'ENOENT'
              ? `Error: grep failed — ${detail.slice(0, 300)}`
              : 'Error: ripgrep is not available on this machine — use search_text instead.'
          );
          return;
        }
        const lines = stdout
          .replace(/\r/g, '')
          .split('\n')
          .filter((l) => l.length > 0);
        if (lines.length === 0) {
          resolve('[no matches]');
          return;
        }
        const shown = lines.slice(0, MAX_GREP_LINES).map((l) => l.replace(/^\.[\\/]/, '').replace(/\\/g, '/'));
        const footer =
          lines.length > MAX_GREP_LINES
            ? `\n[showing first ${MAX_GREP_LINES} of ${lines.length} lines — narrow the pattern or glob]`
            : '';
        resolve(shown.join('\n') + footer);
      }
    );
  });
}

async function searchText(query: string, glob?: string): Promise<string> {
  if (!query.trim()) {
    return 'Error: query is required.';
  }
  const needle = query.toLowerCase();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  let files: vscode.Uri[];
  try {
    files = await vscode.workspace.findFiles(
      glob || '**/*',
      '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}',
      MAX_SEARCH_FILES
    );
  } catch (error) {
    return `Error: search failed (${error instanceof Error ? error.message : 'unknown'}).`;
  }

  const results: string[] = [];
  for (const uri of files) {
    if (results.length >= MAX_SEARCH_RESULTS) {
      break;
    }
    const rel = path.relative(root, uri.fsPath).replace(/\\/g, '/');
    if (isSensitiveFile(rel)) {
      continue;
    }
    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.includes(0)) {
        continue; // skip binary files
      }
      text = Buffer.from(bytes).toString('utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && results.length < MAX_SEARCH_RESULTS; i += 1) {
      if (lines[i].toLowerCase().includes(needle)) {
        const trimmed = lines[i].trim().slice(0, MAX_LINE_LEN);
        results.push(`${rel}:${i + 1}: ${trimmed}`);
      }
    }
  }

  if (results.length === 0) {
    return '[no matches]';
  }
  const header = results.length >= MAX_SEARCH_RESULTS ? `[showing first ${MAX_SEARCH_RESULTS} matches]\n` : '';
  return header + results.join('\n');
}

async function fetchUrl(url: string): Promise<string> {
  if (!/^https:\/\//i.test(url)) {
    return 'Error: only https:// URLs are allowed.';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/html,text/plain' } });
    if (!response.ok) {
      return `Error: HTTP ${response.status} fetching ${url}.`;
    }
    const raw = await response.text();
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > MAX_FETCH_CHARS ? `${text.slice(0, MAX_FETCH_CHARS)}\n\n[truncated]` : text;
  } catch (error) {
    return `Error: could not fetch ${url} (${error instanceof Error ? error.message : 'unknown'}).`;
  } finally {
    clearTimeout(timer);
  }
}

function resolveInWorkspace(root: vscode.Uri, relative: string): vscode.Uri | undefined {
  const normalized = relative.replace(/^[/\\]+/, '');
  const target = vscode.Uri.joinPath(root, normalized);
  // Keep the model inside the workspace root.
  const rootPath = root.fsPath.replace(/\\/g, '/');
  const targetPath = target.fsPath.replace(/\\/g, '/');
  if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}/`)) {
    return undefined;
  }
  return target;
}

function toNum(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

async function readFile(root: vscode.Uri, relative: string, startLine?: number, endLine?: number): Promise<string> {
  const uri = resolveInWorkspace(root, relative);
  if (!uri) {
    return 'Error: path is outside the workspace.';
  }
  if (isSensitiveFile(uri.fsPath)) {
    return 'Error: refusing to read a sensitive file (looks like credentials).';
  }

  let text: string;
  try {
    text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch (error) {
    return `Error: could not read "${relative}" (${error instanceof Error ? error.message : 'unknown'}).`;
  }
  if (text.length === 0) {
    return '[file is empty]';
  }

  const lines = text.split('\n');
  const total = lines.length;
  const start = startLine && startLine > 0 ? Math.floor(startLine) : 1;
  if (start > total) {
    return `Error: start_line ${start} is past end of file (${total} lines).`;
  }
  let end = endLine && endLine > 0 ? Math.min(Math.floor(endLine), total) : total;
  if (end < start) {
    end = start;
  }
  if (end - start + 1 > MAX_READ_LINES) {
    end = start + MAX_READ_LINES - 1;
  }

  const width = String(end).length;
  let body = lines
    .slice(start - 1, end)
    .map((line, i) => `${String(start + i).padStart(width)} | ${line}`)
    .join('\n');
  if (body.length > MAX_FILE_CHARS) {
    body = `${body.slice(0, MAX_FILE_CHARS)}\n[truncated — request a narrower line range]`;
  }

  const header = `${relative} (lines ${start}-${end} of ${total}):\n`;
  const footer =
    end < total ? `\n[${total - end} more lines — call read_file with start_line=${end + 1} to continue]` : '';
  return header + body + footer;
}

async function listDirectory(root: vscode.Uri, relative: string): Promise<string> {
  const uri = resolveInWorkspace(root, relative === '' ? '.' : relative);
  if (!uri) {
    return 'Error: path is outside the workspace.';
  }
  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    if (entries.length === 0) {
      return '[empty directory]';
    }
    return entries
      .slice(0, MAX_DIR_ENTRIES)
      .map(([name, type]) => (type === vscode.FileType.Directory ? `${name}/` : name))
      .join('\n');
  } catch (error) {
    return `Error: could not list "${relative}" (${error instanceof Error ? error.message : 'unknown'}).`;
  }
}

async function findFiles(glob: string): Promise<string> {
  if (!glob.trim()) {
    return 'Error: glob pattern is required.';
  }
  try {
    const matches = await vscode.workspace.findFiles(glob, '**/node_modules/**', MAX_FIND_RESULTS);
    if (matches.length === 0) {
      return '[no matches]';
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    return matches
      .map((uri) => path.relative(root, uri.fsPath).replace(/\\/g, '/'))
      .filter((rel) => !isSensitiveFile(rel))
      .join('\n');
  } catch (error) {
    return `Error: search failed (${error instanceof Error ? error.message : 'unknown'}).`;
  }
}
