/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A `vscode` test double backed by the REAL filesystem (a temp dir), installed via
 * the Module._load hook (same technique as gatewayLoop.test.ts). It lets the
 * checkpoint store and tool executor run their genuine write/revert/edit paths
 * against real files, so tests catch data-loss / corruption bugs the pure-module
 * tests can't. Import this module BEFORE `require()`-ing the code under test.
 *
 * Not named `*.test.ts`, so the runner (`out/test/*.test.js`) never executes it.
 */
import { promises as fsp } from 'fs';
import * as path from 'path';
import Module from 'node:module';

let root = process.cwd();
export function setWorkspaceRoot(p: string): void {
  root = p;
}

const diagnostics = new Map<string, any[]>();
export function setDiagnostics(fsPath: string, diags: any[]): void {
  diagnostics.set(fsPath, diags);
}

function mkUri(p: string): any {
  return { fsPath: p, path: p.replace(/\\/g, '/'), scheme: 'file', toString: () => `file://${p}` };
}

/** A `{a,b,c}` brace list → its members; a plain glob → a single-member list; undefined → none. */
function splitBrace(glob: string | undefined): string[] {
  if (!glob) {
    return [];
  }
  const m = /^\{(.*)\}$/.exec(glob);
  return m ? m[1].split(',') : [glob];
}

/** Minimal VS Code-style glob → anchored RegExp (enough for the tool tests). */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export const fakeVscode: any = {
  Uri: {
    file: (p: string) => mkUri(p),
    joinPath: (base: any, ...segs: string[]) => mkUri(path.join(base.fsPath, ...segs)),
    parse: (s: string) => ({ toString: () => s, fsPath: s, scheme: s.split(':')[0] })
  },
  workspace: {
    get workspaceFolders() {
      return [{ uri: mkUri(root), name: 'root', index: 0 }];
    },
    fs: {
      readFile: async (uri: any) => new Uint8Array(await fsp.readFile(uri.fsPath)),
      writeFile: async (uri: any, bytes: Uint8Array) => {
        await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
        await fsp.writeFile(uri.fsPath, Buffer.from(bytes));
      },
      delete: async (uri: any) => {
        await fsp.rm(uri.fsPath, { recursive: true, force: true });
      },
      createDirectory: async (uri: any) => {
        await fsp.mkdir(uri.fsPath, { recursive: true });
      },
      stat: async (uri: any) => {
        const s = await fsp.stat(uri.fsPath);
        return { type: s.isDirectory() ? 2 : 1, size: s.size, ctime: 0, mtime: s.mtimeMs };
      },
      readDirectory: async (uri: any) => {
        const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
        return entries.map((d) => [d.name, d.isDirectory() ? 2 : 1]);
      }
    },
    // Reject so ToolExecutor.newProblemsAfterEdit bails immediately (no 1.5s LS wait in tests).
    openTextDocument: async () => {
      throw new Error('no language server in tests');
    },
    asRelativePath: (uri: any) => path.relative(root, uri.fsPath).replace(/\\/g, '/'),
    // Real glob walk over the workspace root — backs search_text / find_files.
    findFiles: async (include: string, exclude?: string, max?: number) => {
      const includeRe = globToRegExp(include);
      const excludeRes = splitBrace(exclude).map(globToRegExp);
      const out: any[] = [];
      const walk = async (dir: string): Promise<void> => {
        let entries: import('fs').Dirent[];
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (max !== undefined && out.length >= max) {
            return;
          }
          const full = path.join(dir, e.name);
          const rel = path.relative(root, full).replace(/\\/g, '/');
          if (excludeRes.some((re) => re.test(rel))) {
            continue;
          }
          if (e.isDirectory()) {
            await walk(full);
          } else if (includeRe.test(rel)) {
            out.push(mkUri(full));
          }
        }
      };
      await walk(root);
      return out;
    }
  },
  window: {
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async () => undefined,
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, clear() {}, dispose() {} })
  },
  languages: {
    getDiagnostics: (uri: any) => diagnostics.get(uri.fsPath) ?? []
  },
  commands: { executeCommand: async () => undefined },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ViewColumn: { Beside: -2 },
  EventEmitter: class {
    public event = (): any => ({ dispose() {} });
    public fire(): void {}
    public dispose(): void {}
  }
};

const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, ...rest: unknown[]): unknown {
  return request === 'vscode' ? fakeVscode : originalLoad.apply(this, [request, ...rest] as never);
};

/** A minimal in-memory Memento (VS Code workspaceState). */
export function makeMemento(): any {
  const store = new Map<string, unknown>();
  return {
    get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d),
    update: async (k: string, v: unknown) => {
      store.set(k, v);
    },
    keys: () => [...store.keys()]
  };
}

/** A recorder double capturing appended transcript entries (matches TranscriptRecorder's used surface). */
export function makeRecorder(): { entries: any[]; append(e: any): void; syncFile(): void; autosave(): Promise<void> } {
  const entries: any[] = [];
  return {
    entries,
    append: (e: any) => entries.push(e),
    syncFile() {},
    autosave: async () => {}
  };
}
