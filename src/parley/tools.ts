import * as dns from 'dns';
import * as fs from 'fs';
import * as https from 'https';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import * as zlib from 'zlib';
import { execFile, type ExecFileException } from 'child_process';
import { isSensitiveFile, sensitiveExcludeGlobs } from '../context/sensitiveFileFilter';
import { decodeText } from '../diff/fileFormat';
import { wrapUntrusted } from './untrusted';
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
      name: 'multi_edit',
      description:
        "Apply SEVERAL precise edits to ONE existing file in a single atomic operation — all succeed together or none are applied (one review/diff/checkpoint). Each edit replaces a unique old_text with new_text, applied top-to-bottom against the running file. Prefer this over multiple edit_file calls when changing several parts of the same file. A later edit's old_text must NOT overlap text an earlier edit inserted (keep edits independent).",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path of the existing file.' },
          edits: {
            type: 'array',
            description: 'Ordered edits to apply to the file.',
            items: {
              type: 'object',
              properties: {
                old_text: {
                  type: 'string',
                  description: 'Exact existing snippet to replace (must appear exactly once at apply time).'
                },
                new_text: { type: 'string', description: 'Replacement text.' }
              },
              required: ['old_text', 'new_text']
            }
          }
        },
        required: ['path', 'edits']
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
      name: 'run_tests',
      description:
        "Run the project's test suite and report whether it PASSED or FAILED plus the failing-test output. The command is auto-detected (package.json test script, pyproject/pytest, Cargo, go.mod, Maven, Gradle) unless overridden by the parley.testCommand setting or the optional command argument. Approved once like run_command. Use this to verify a fix and iterate until tests pass.",
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'Optional explicit test command (e.g. "npm test -- some.test.ts", "pytest tests/x.py"). Omit to auto-detect the project default.'
          }
        }
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
      name: 'find_symbol',
      description:
        'Find where a symbol (class, function, method, variable…) is DEFINED, using the language server\'s workspace index. Faster and more precise than grep for "where is X defined". Returns kind, name, and path:line.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Symbol name (or prefix) to look up, e.g. "CheckpointStore".' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'document_symbols',
      description:
        "Outline of a file from the language server: its classes, functions, and methods with line ranges. Use to understand a file's structure without reading all of it.",
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_definition',
      description:
        'Jump from a symbol OCCURRENCE to its DEFINITION via the language server. Point at the occurrence: give the file, the 1-based line, and the symbol text on that line; returns the definition site(s) as path:line.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file containing an occurrence.' },
          line: { type: 'number', description: '1-based line number of that occurrence.' },
          symbol: { type: 'string', description: 'The symbol text as it appears on that line.' }
        },
        required: ['path', 'line', 'symbol']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_references',
      description:
        'Find every reference to a symbol across the workspace via the language server. Point at one occurrence: give the file, the 1-based line, and the symbol text on that line.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file containing an occurrence.' },
          line: { type: 'number', description: '1-based line number of that occurrence.' },
          symbol: { type: 'string', description: 'The symbol text as it appears on that line.' }
        },
        required: ['path', 'line', 'symbol']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description:
        'Fetch a public web page over HTTPS and return its text content (HTML stripped, truncated). This is a RAW fetch with no JavaScript — for JS-rendered pages, localhost apps, console errors, or interaction, use the browser_* tools instead.',
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
      name: 'browser_navigate',
      description:
        "Open a URL in a real local browser (Chromium) that runs JavaScript — use for localhost dev servers, single-page apps, or anything fetch_url can't render. Returns the page title and rendered visible text. First use installs the browser runtime (one-time).",
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'http:// or https:// URL (localhost is fine).' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_read',
      description:
        'Return the rendered visible text of the current browser page, or of a CSS selector within it. Call browser_navigate first.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Optional CSS selector to read (defaults to the whole page body).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_console',
      description:
        'Return the current page\'s console output. Set errors_only to see just errors and warnings — ideal for "check the console for errors".',
      parameters: {
        type: 'object',
        properties: { errors_only: { type: 'boolean', description: 'Only errors/warnings. Default false.' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description:
        'Click an element on the current page by CSS selector (or Playwright text= selector). Call browser_navigate first.',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string', description: 'CSS or text= selector to click.' } },
        required: ['selector']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Fill a form field on the current page with text, by CSS selector. Call browser_navigate first.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the input/textarea.' },
          text: { type: 'string', description: 'Text to fill in.' }
        },
        required: ['selector', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description:
        'Save a full-page PNG screenshot of the current browser page and return its file path. Call browser_navigate first.',
      parameters: { type: 'object', properties: {} }
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
      name: 'run_subagent',
      description:
        'Delegate a scoped READ-ONLY investigation to a subagent: a nested agent with a FRESH context that cannot see this conversation. It explores with the read-only tools (read/search/grep/symbols/fetch) and returns only its final report, keeping this conversation lean. Use it for broad reconnaissance — mapping how a subsystem works, finding every place that does X, comparing several files — especially when the intermediate reading would flood your context. The task must be SELF-CONTAINED: include all relevant paths, names, and background, and say exactly what the report should answer. Subagents cannot edit files, run commands, or spawn further subagents.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description:
              'The complete, self-contained investigation brief: background, where to look, and what the report must answer.'
          }
        },
        required: ['task']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_subagents',
      description:
        'Like run_subagent, but launches SEVERAL scoped read-only investigations CONCURRENTLY and returns all their reports together — use it when you have multiple INDEPENDENT things to investigate at once (e.g. "how does auth work", "where are the API routes", "what does the build config do"), to cut deep-reconnaissance time. Each task must be fully self-contained. Runs up to 5 in parallel. Do not use it for dependent steps where one investigation needs another\'s result.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: 'Independent investigation briefs to run in parallel (max 5).',
            items: {
              type: 'object',
              properties: {
                task: {
                  type: 'string',
                  description: 'A complete, self-contained investigation brief.'
                },
                agent: {
                  type: 'string',
                  description: 'Optional custom agent type (see run_subagent). Omit for the default investigator.'
                }
              },
              required: ['task']
            }
          }
        },
        required: ['tasks']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description:
        'Load the full instructions for one of the available skills (see the "Available skills" list in the system prompt). Call this the moment a task matches a skill — it returns that skill\'s complete step-by-step instructions and the path to its bundled files, which you then follow (reading/running its files with the other tools as directed).',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'The skill name to load (from the Available skills list).' }
        },
        required: ['skill']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'capture_screen',
      description:
        "Capture a screenshot of the user's screen and show it inline in the chat. Use this when the user asks you to take/grab/paste a screenshot of their screen or monitor, or to look at what's on their screen. You CAN do this — do not refuse. The captured screenshot is automatically added to the conversation as an image, so on your NEXT turn you will actually see it and can analyze/describe it. After calling this, continue and address what the user asked about the screen.",
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description:
        "Generate an image / figure / illustration from a text description and show it inline in the chat. Use this whenever the user asks you to CREATE a picture, illustration, logo, mockup, icon, or visual figure. Best for illustrative/visual imagery — for precise technical diagrams with exact text (flowcharts, architecture, ER), prefer a Mermaid code block instead. The image is produced by the gateway's image model regardless of which chat model you are.",
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'A detailed description of the image to generate.'
          },
          size: {
            type: 'string',
            enum: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
            description: 'Output size (default 1024x1024). Use a wide/tall size for landscape/portrait figures.'
          }
        },
        required: ['prompt']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        "Save one durable, non-obvious fact about this project to persistent memory (`.parley/memory.md`), so future conversations start knowing it. Use it when you learn something that took effort to discover and will matter again: build/test quirks ('integration tests need Docker running'), key file locations, project conventions, environment requirements, or explicit user preferences about how to work in this repo. Do NOT store things that are obvious from the code, one-off details for the current task, or anything secret (keys, tokens, passwords). One concise sentence per call.",
      parameters: {
        type: 'object',
        properties: {
          fact: {
            type: 'string',
            description: 'The fact to remember — one concise, self-contained sentence.'
          }
        },
        required: ['fact']
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

// Excluded from Plan mode: writes/commands, plus browser tools (which run JS, hit the
// network, and can trigger a one-time runtime install — not "read-only exploration").
const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
  'run_command',
  'run_tests',
  'browser_navigate',
  'browser_read',
  'browser_console',
  'browser_click',
  'browser_type',
  'browser_screenshot',
  'generate_image',
  'capture_screen'
]);

/** The subset of tools that never modify the workspace — used by Plan mode. */
export const READ_ONLY_TOOLS: readonly ToolDefinition[] = AGENT_TOOLS.filter(
  (tool) => !WRITE_TOOLS.has(tool.function.name)
);

/**
 * What a subagent may call: the read-only set minus run_subagent (depth 1 only —
 * no recursive spawning), update_plan (the plan checklist belongs to the parent),
 * and remember (project memory is curated by the parent agent, not side quests).
 */
export const SUBAGENT_TOOLS: readonly ToolDefinition[] = READ_ONLY_TOOLS.filter(
  (tool) =>
    tool.function.name !== 'run_subagent' &&
    tool.function.name !== 'run_subagents' &&
    tool.function.name !== 'update_plan' &&
    tool.function.name !== 'remember' &&
    tool.function.name !== 'load_skill'
);

/**
 * Enumerate the available skills in `load_skill`'s description, or DROP the tool
 * entirely when there are none (so it doesn't clutter the toolset). The always-on
 * roster in the system prompt is what tells the model a skill exists; this makes
 * the tool self-documenting for the model that chooses to call it.
 */
export function withSkills(
  tools: readonly ToolDefinition[],
  skills: readonly { id: string; description: string }[]
): readonly ToolDefinition[] {
  if (skills.length === 0) {
    return tools.filter((t) => t.function.name !== 'load_skill');
  }
  const roster = skills.map((s) => `"${s.id}" — ${s.description}`).join('; ');
  return tools.map((tool) =>
    tool.function.name !== 'load_skill'
      ? tool
      : {
          ...tool,
          function: {
            ...tool.function,
            description: `${tool.function.description} Available skills: ${roster}.`
          }
        }
  );
}

/**
 * Fold the available custom subagent types into `run_subagent`'s schema: the
 * description enumerates them and an optional `agent` parameter selects one.
 * No-op (same array back) when no types are defined.
 */
export function withSubagentTypes(
  tools: readonly ToolDefinition[],
  types: readonly { id: string; description: string }[]
): readonly ToolDefinition[] {
  if (types.length === 0) {
    return tools;
  }
  return tools.map((tool) => {
    if (tool.function.name !== 'run_subagent') {
      return tool;
    }
    const roster = types.map((t) => `"${t.id}" — ${t.description}`).join('; ');
    return {
      ...tool,
      function: {
        ...tool.function,
        description:
          tool.function.description +
          ` Agent types available via the optional "agent" parameter: ${roster}. Omit "agent" for the default general investigator.`,
        parameters: {
          ...tool.function.parameters,
          properties: {
            ...(tool.function.parameters.properties as Record<string, unknown>),
            agent: {
              type: 'string',
              description:
                'Optional agent type (see the tool description for the list). Omit for the default investigator.'
            }
          }
        }
      }
    };
  });
}

const MAX_FETCH_CHARS = 12000;
const MAX_FETCH_REDIRECTS = 5;
const MAX_FETCH_BYTES = 5 * 1024 * 1024; // hard cap on bytes downloaded per hop
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
    case 'find_symbol':
      return findSymbol(root, String(args.query ?? ''));
    case 'document_symbols':
      return documentSymbols(root, String(args.path ?? ''));
    case 'find_definition':
      return findDefinition(String(args.path ?? ''), toNum(args.line), String(args.symbol ?? ''));
    case 'find_references':
      return findReferences(root, String(args.path ?? ''), toNum(args.line), String(args.symbol ?? ''));
    case 'fetch_url':
      return fetchUrl(String(args.url ?? ''));
    default:
      return `Error: unknown tool "${call.name}".`;
  }
}

// ---------- language-server (LSP) tools ----------

const MAX_SYMBOL_RESULTS = 50;
const NO_PROVIDER_HINT = '[no results — the file may be plain text, or its language extension is not active]';

function symbolKindName(kind: vscode.SymbolKind): string {
  return (vscode.SymbolKind[kind] ?? 'symbol').toLowerCase();
}

async function findSymbol(root: vscode.Uri, query: string): Promise<string> {
  if (!query.trim()) {
    return 'Error: query is required.';
  }
  let symbols: vscode.SymbolInformation[] | undefined;
  try {
    symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      query
    );
  } catch (error) {
    return `Error: symbol search failed (${error instanceof Error ? error.message : 'unknown'}).`;
  }
  const rows = (symbols ?? [])
    .filter((s) => s.location?.uri?.scheme === 'file')
    .slice(0, MAX_SYMBOL_RESULTS)
    .map((s) => {
      const rel = toolRelPath(s.location.uri);
      const container = s.containerName ? `${s.containerName}.` : '';
      return `${symbolKindName(s.kind)} ${container}${s.name} — ${rel}:${s.location.range.start.line + 1}`;
    });
  return rows.length > 0 ? rows.join('\n') : NO_PROVIDER_HINT;
}

async function documentSymbols(root: vscode.Uri, relative: string): Promise<string> {
  const uri = await resolveAcrossRoots(relative);
  if (!uri) {
    return 'Error: path is outside the workspace.';
  }
  if (isSensitiveFile(uri.fsPath)) {
    return 'Error: refusing to read a sensitive file.';
  }
  try {
    await vscode.workspace.openTextDocument(uri); // make sure a language server sees it
  } catch (error) {
    return `Error: could not open "${relative}" (${error instanceof Error ? error.message : 'unknown'}).`;
  }
  const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
    'vscode.executeDocumentSymbolProvider',
    uri
  );
  if (!symbols || symbols.length === 0) {
    return NO_PROVIDER_HINT;
  }
  const lines: string[] = [];
  const walk = (items: Array<vscode.DocumentSymbol | vscode.SymbolInformation>, depth: number): void => {
    for (const s of items) {
      if (lines.length >= 200) {
        return;
      }
      const range = 'range' in s ? s.range : s.location.range;
      lines.push(
        `${'  '.repeat(depth)}${symbolKindName(s.kind)} ${s.name} (L${range.start.line + 1}-L${range.end.line + 1})`
      );
      if ('children' in s && s.children?.length) {
        walk(s.children, depth + 1);
      }
    }
  };
  walk(symbols, 0);
  return lines.join('\n');
}

/** Resolve a (path, line, symbol) occurrence to a document + position, shared by the LSP lookups. */
async function locateSymbolOccurrence(
  relative: string,
  line: number | undefined,
  symbol: string
): Promise<{ doc: vscode.TextDocument; position: vscode.Position } | { error: string }> {
  const uri = await resolveAcrossRoots(relative);
  if (!uri) {
    return { error: 'Error: path is outside the workspace.' };
  }
  if (!line || line < 1 || !symbol.trim()) {
    return { error: 'Error: line (1-based) and symbol are required.' };
  }
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (error) {
    return { error: `Error: could not open "${relative}" (${error instanceof Error ? error.message : 'unknown'}).` };
  }
  if (line > doc.lineCount) {
    return { error: `Error: line ${line} is past the end of the file (${doc.lineCount} lines).` };
  }
  const text = doc.lineAt(line - 1).text;
  const col = text.indexOf(symbol);
  if (col === -1) {
    return { error: `Error: "${symbol}" does not appear on line ${line}. That line is:\n${text.trim()}` };
  }
  return { doc, position: new vscode.Position(line - 1, col + Math.floor(symbol.length / 2)) };
}

async function findDefinition(relative: string, line: number | undefined, symbol: string): Promise<string> {
  const located = await locateSymbolOccurrence(relative, line, symbol);
  if ('error' in located) {
    return located.error;
  }
  const results = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
    'vscode.executeDefinitionProvider',
    located.doc.uri,
    located.position
  );
  if (!results || results.length === 0) {
    return NO_PROVIDER_HINT;
  }
  const rows = [
    ...new Set(
      results.map((r) => {
        const uri = 'targetUri' in r ? r.targetUri : r.uri;
        const range = 'targetRange' in r ? r.targetRange : r.range;
        return `${toolRelPath(uri)}:${range.start.line + 1}`;
      })
    )
  ].slice(0, 20);
  return `Definition of "${symbol}":\n${rows.join('\n')}`;
}

async function findReferences(
  root: vscode.Uri,
  relative: string,
  line: number | undefined,
  symbol: string
): Promise<string> {
  const uri = await resolveAcrossRoots(relative);
  if (!uri) {
    return 'Error: path is outside the workspace.';
  }
  if (!line || line < 1 || !symbol.trim()) {
    return 'Error: line (1-based) and symbol are required.';
  }
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (error) {
    return `Error: could not open "${relative}" (${error instanceof Error ? error.message : 'unknown'}).`;
  }
  if (line > doc.lineCount) {
    return `Error: line ${line} is past the end of the file (${doc.lineCount} lines).`;
  }
  const text = doc.lineAt(line - 1).text;
  const col = text.indexOf(symbol);
  if (col === -1) {
    return `Error: "${symbol}" does not appear on line ${line}. That line is:\n${text.trim()}`;
  }
  const position = new vscode.Position(line - 1, col + Math.floor(symbol.length / 2));
  const locations = await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeReferenceProvider',
    uri,
    position
  );
  if (!locations || locations.length === 0) {
    return NO_PROVIDER_HINT;
  }
  const rows = [
    ...new Set(
      locations.filter((l) => l.uri.scheme === 'file').map((l) => `${toolRelPath(l.uri)}:${l.range.start.line + 1}`)
    )
  ].slice(0, 100);
  return `${locations.length} reference(s):\n${rows.join('\n')}`;
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
  // rg honors .gitignore by default; also exclude build output and — via the shared
  // denylist (case-insensitively) — every credential-like file the other tools refuse,
  // so grep can't surface a secret that read_file/search_text would have blocked.
  args.push('--glob-case-insensitive');
  for (const ex of ['!**/node_modules/**', '!**/.git/**', '!**/out/**', '!**/dist/**', ...sensitiveExcludeGlobs()]) {
    args.push('--glob', ex);
  }
  args.push('--regexp', pattern, '--', '.');

  // Multi-root: run per workspace folder, prefixing results with the folder name.
  const folders = vscode.workspace.workspaceFolders ?? [{ uri: root, name: '' }];
  const multi = folders.length > 1;
  return (async () => {
    const all: string[] = [];
    for (const folder of folders) {
      const result = await runRgInFolder(rg, args, folder.uri.fsPath);
      if ('error' in result) {
        return result.error;
      }
      for (const line of result.lines) {
        all.push(multi ? `${folder.name}/${line}` : line);
      }
      if (all.length >= MAX_GREP_LINES) {
        break;
      }
    }
    if (all.length === 0) {
      return '[no matches]';
    }
    const shown = all.slice(0, MAX_GREP_LINES);
    const footer =
      all.length > MAX_GREP_LINES
        ? `\n[showing first ${MAX_GREP_LINES} of ${all.length} lines — narrow the pattern or glob]`
        : '';
    return shown.join('\n') + footer;
  })();
}

/** One ripgrep run in one folder → matched lines, or a user-facing error string. */
function runRgInFolder(rg: string, args: string[], cwd: string): Promise<{ lines: string[] } | { error: string }> {
  return new Promise((resolve) => {
    execFile(
      rg,
      args,
      { cwd, timeout: GREP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error && (error as { killed?: boolean }).killed) {
          resolve({ error: 'Error: grep timed out after 10s — narrow the pattern or add a glob.' });
          return;
        }
        // rg exits 1 for "no matches", 2 for a real error (e.g. bad regex).
        if (error && !stdout) {
          const code = (error as { code?: number | string }).code;
          if (code === 1) {
            resolve({ lines: [] });
            return;
          }
          const detail = (stderr || error.message || '').trim().split('\n')[0];
          resolve({
            error:
              detail && code !== 'ENOENT'
                ? `Error: grep failed — ${detail.slice(0, 300)}`
                : 'Error: ripgrep is not available on this machine — use search_text instead.'
          });
          return;
        }
        const lines = stdout
          .replace(/\r/g, '')
          .split('\n')
          .filter((l) => l.length > 0);
        resolve({ lines: lines.map((l) => l.replace(/^\.[\\/]/, '').replace(/\\/g, '/')) });
      }
    );
  });
}

async function searchText(query: string, glob?: string): Promise<string> {
  if (!query.trim()) {
    return 'Error: query is required.';
  }
  const needle = query.toLowerCase();
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
    const rel = toolRelPath(uri);
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

/**
 * True for addresses fetch_url must never reach: loopback, private (RFC 1918), link-local
 * (cloud metadata), unique-local, and unspecified — the SSRF targets a prompt-injected URL
 * could otherwise read from inside the user's network. Pure so it is unit-testable.
 */
export function isBlockedAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 127 || // loopback 127.0.0.0/8
      a === 10 || // private 10.0.0.0/8
      a === 0 || // unspecified / "this network" (includes 0.0.0.0)
      (a === 172 && b >= 16 && b <= 31) || // private 172.16.0.0/12
      (a === 192 && b === 168) || // private 192.168.0.0/16
      (a === 169 && b === 254) // link-local 169.254.0.0/16 (cloud metadata endpoints)
    );
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
    if (mapped) {
      return isBlockedAddress(mapped[1]); // IPv4-mapped — judge the embedded IPv4 address
    }
    if (lower === '::1' || lower === '::') {
      return true; // loopback / unspecified
    }
    const first = parseInt(lower.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // fc00::/7 ULA, fe80::/10 link-local
  }
  return false;
}

/**
 * SSRF pre-check for fetch_url: false when the URL's host is a blocked literal IP, or
 * when any address it resolves to is blocked. This is the ONLY guard for literal-IP
 * hosts (those skip the connect-time DNS lookup); hostnames are additionally vetted at
 * connect time by `vettingLookup`, which closes the resolve-then-connect race.
 * DNS/parse failures propagate to the caller's catch.
 */
async function isAllowedFetchDestination(target: string): Promise<boolean> {
  const host = new URL(target).hostname.replace(/^\[|\]$/g, ''); // URL keeps IPv6 literals bracketed
  if (net.isIP(host) !== 0) {
    return !isBlockedAddress(host);
  }
  const addresses = await dns.promises.lookup(host, { all: true });
  return addresses.every((a) => !isBlockedAddress(a.address));
}

/**
 * A DNS lookup for the fetch connection that resolves the host, refuses if ANY resolved
 * address is blocked, and returns only a vetted address — so the socket connects to
 * exactly what was vetted. This closes the DNS-rebinding TOCTOU: a rebinding server
 * cannot answer the pre-check with a public IP and the connection with an internal one,
 * because the address used to connect is the one this function just validated. Literal-IP
 * hosts never reach here (the stack skips lookup for them); they are vetted up front.
 */
function vettingLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
): void {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 0);
      return;
    }
    if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
      callback(new Error('refusing to connect to a private, loopback, or link-local address'), '', 0);
      return;
    }
    // Node's happy-eyeballs (autoSelectFamily) calls lookup with `all` and expects the
    // full address list back; otherwise return a single vetted address.
    if (options && options.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0].address, addresses[0].family);
    }
  });
}

interface HttpResult {
  readonly status: number;
  readonly location: string | null;
  readonly body: string;
}

/** One HTTPS GET that connects only to a `vettingLookup`-approved address, follows no
 *  redirects itself (the caller re-vets each hop), decompresses gzip/deflate/br, and
 *  caps the downloaded bytes. */
function httpsGet(target: string, signal: AbortSignal): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    let settled = false;
    const finish = (r: HttpResult): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const fail = (e: Error): void => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    };
    let u: URL;
    try {
      u = new URL(target);
    } catch {
      fail(new Error('invalid URL'));
      return;
    }
    const req = https.get(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        headers: {
          Accept: 'text/html,text/plain',
          'Accept-Encoding': 'gzip, deflate, br',
          'User-Agent': 'parley-vscode'
        },
        lookup: vettingLookup,
        signal
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const locationHeader = res.headers.location;
        const location = Array.isArray(locationHeader) ? (locationHeader[0] ?? null) : (locationHeader ?? null);
        if (status >= 300 && status < 400 && location) {
          res.resume(); // discard the redirect body
          finish({ status, location, body: '' });
          return;
        }
        const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
        let stream: NodeJS.ReadableStream = res;
        if (encoding === 'gzip') {
          stream = res.pipe(zlib.createGunzip());
        } else if (encoding === 'deflate') {
          stream = res.pipe(zlib.createInflate());
        } else if (encoding === 'br') {
          stream = res.pipe(zlib.createBrotliDecompress());
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        stream.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes <= MAX_FETCH_BYTES) {
            chunks.push(chunk);
          } else {
            req.destroy(); // stop downloading an over-large response
            finish({ status, location: null, body: Buffer.concat(chunks).toString('utf8') });
          }
        });
        stream.on('end', () => finish({ status, location: null, body: Buffer.concat(chunks).toString('utf8') }));
        stream.on('error', fail);
      }
    );
    req.on('error', fail);
  });
}

async function fetchUrl(url: string): Promise<string> {
  if (!/^https:\/\//i.test(url)) {
    return 'Error: only https:// URLs are allowed.';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // Follow redirects manually (bounded), re-vetting every hop — a public URL could
    // otherwise 302 to 169.254.169.254/localhost and return internal content to the model.
    let current = url;
    for (let hop = 0; hop <= MAX_FETCH_REDIRECTS; hop += 1) {
      if (!(await isAllowedFetchDestination(current))) {
        return 'Error: refusing to fetch a private, loopback, or link-local address.';
      }
      const response = await httpsGet(current, controller.signal);
      if (response.status >= 300 && response.status < 400 && response.location) {
        current = new URL(response.location, current).toString();
        if (!/^https:\/\//i.test(current)) {
          return 'Error: only https:// URLs are allowed.';
        }
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        return `Error: HTTP ${response.status} fetching ${url}.`;
      }
      const text = response.body
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const body = text.length > MAX_FETCH_CHARS ? `${text.slice(0, MAX_FETCH_CHARS)}\n\n[truncated]` : text;
      return wrapUntrusted(`web page (${url})`, body);
    }
    return `Error: too many redirects fetching ${url}.`;
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

/**
 * Multi-root path resolution for tools. Order: an explicit "folderName/…" prefix
 * wins; then the first root where the path exists; then the first root (so new
 * files land there). Single-root workspaces behave exactly as before.
 */
export async function resolveAcrossRoots(relative: string): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return undefined;
  }
  const normalized = relative.replace(/^[/\\]+/, '');
  if (folders.length > 1) {
    const first = normalized.split(/[/\\]/)[0];
    const named = folders.find((f) => f.name === first);
    if (named) {
      const rest = normalized.slice(first.length).replace(/^[/\\]+/, '');
      return resolveInWorkspace(named.uri, rest || '.');
    }
    for (const folder of folders) {
      const candidate = resolveInWorkspace(folder.uri, normalized);
      if (candidate) {
        try {
          await vscode.workspace.fs.stat(candidate);
          return candidate;
        } catch {
          // Not here — try the next root.
        }
      }
    }
  }
  return resolveInWorkspace(folders[0].uri, normalized);
}

/**
 * True only when the CANONICAL (symlink-resolved) path of `uri` stays under the canonical
 * workspace root. resolveInWorkspace's lexical check cannot see a symlink/junction INSIDE
 * the workspace that points outside it (e.g. docs/system -> /etc), so read-side tools call
 * this before touching the disk. Targets that do not exist yet are checked via the nearest
 * existing ancestor directory. Non-file schemes pass (realpath does not apply to them).
 */
export async function assertInsideWorkspace(uri: vscode.Uri, root: vscode.Uri): Promise<boolean> {
  if (uri.scheme !== 'file') {
    return true;
  }
  let realRoot: string;
  try {
    realRoot = await fs.promises.realpath(root.fsPath);
  } catch {
    return false;
  }
  let candidate = uri.fsPath;
  let realTarget: string | undefined;
  while (realTarget === undefined) {
    try {
      realTarget = await fs.promises.realpath(candidate);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        return false; // nothing on the path exists — cannot verify containment
      }
      candidate = parent; // target doesn't exist yet (e.g. a new file) — check its ancestor
    }
  }
  const target = realTarget.replace(/\\/g, '/');
  const rootPath = realRoot.replace(/\\/g, '/');
  return target === rootPath || target.startsWith(`${rootPath}/`);
}

/** The workspace folder that owns `uri`, falling back to the first root. */
function owningRoot(uri: vscode.Uri): vscode.Uri | undefined {
  // Optional-call: the real API always has getWorkspaceFolder; the test double does not.
  return vscode.workspace.getWorkspaceFolder?.(uri)?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** Workspace-relative label for results — prefixed with the folder name in multi-root workspaces. */
export function toolRelPath(uri: vscode.Uri): string {
  const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  return vscode.workspace.asRelativePath(uri, multi).replace(/\\/g, '/');
}

function toNum(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

async function readFile(root: vscode.Uri, relative: string, startLine?: number, endLine?: number): Promise<string> {
  const uri = await resolveAcrossRoots(relative);
  if (!uri) {
    return 'Error: path is outside the workspace.';
  }
  const owner = owningRoot(uri);
  if (owner && !(await assertInsideWorkspace(uri, owner))) {
    return 'Error: path is outside the workspace.'; // symlink/junction escaping the root
  }
  if (isSensitiveFile(uri.fsPath)) {
    return 'Error: refusing to read a sensitive file (looks like credentials).';
  }

  let text: string;
  try {
    text = decodeText(await vscode.workspace.fs.readFile(uri)).text; // honor UTF-8/UTF-16LE + BOM
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
  const folders = vscode.workspace.workspaceFolders ?? [];
  if ((relative === '' || relative === '.') && folders.length > 1) {
    // Multi-root: "." lists the roots themselves; use "folderName/…" to descend.
    return folders.map((f) => `${f.name}/  (workspace root)`).join('\n');
  }
  const uri = await resolveAcrossRoots(relative === '' ? '.' : relative);
  if (!uri) {
    return 'Error: path is outside the workspace.';
  }
  const owner = owningRoot(uri);
  if (owner && !(await assertInsideWorkspace(uri, owner))) {
    return 'Error: path is outside the workspace.'; // symlink/junction escaping the root
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
    return matches
      .map((uri) => toolRelPath(uri))
      .filter((rel) => !isSensitiveFile(rel))
      .join('\n');
  } catch (error) {
    return `Error: search failed (${error instanceof Error ? error.message : 'unknown'}).`;
  }
}
