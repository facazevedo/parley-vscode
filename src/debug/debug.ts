import { promises as fsp } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Lightweight, globally-gated debug tracing.
 *
 * Flip {@link DEBUG} to `false` to silence every `dbg()` call in the codebase.
 * When enabled, each call is written to the "Parley Debug" output channel and
 * appended to `debug/parley-debug.log` (in the open workspace if there is one,
 * otherwise the extension's global storage). Secrets (the API key / auth header)
 * are never logged — only request shapes, response metadata, and control flow.
 */
export const DEBUG = true;

let channel: vscode.OutputChannel | undefined;
let logFile: string | undefined;
let writeQueue: Promise<void> = Promise.resolve();

/** Initialize debug sinks. Safe to call once on activation; a no-op when DEBUG is false. */
export function initDebug(context: vscode.ExtensionContext): void {
  if (!DEBUG) {
    return;
  }
  channel = vscode.window.createOutputChannel('Parley Debug');
  context.subscriptions.push(channel);
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  const dir = ws ? path.join(ws.fsPath, 'debug') : path.join(context.globalStorageUri.fsPath, 'debug');
  logFile = path.join(dir, 'parley-debug.log');
  dbg('init', `Debug logging ON. Log file: ${logFile}`);
}

/** The folder where the debug log lives, or undefined if debug is off / uninitialized. */
export function debugLogPath(): string | undefined {
  return logFile;
}

function stamp(): string {
  return new Date().toISOString();
}

function stringify(data: unknown): string {
  let s: string;
  try {
    s = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    s = String(data);
  }
  return s.length > 4000 ? `${s.slice(0, 4000)}…(+${s.length - 4000} chars)` : s;
}

/** Emit a debug line for `area` (e.g. "client", "turn", "stream"). No-op when DEBUG is false. */
export function dbg(area: string, message: string, data?: unknown): void {
  if (!DEBUG) {
    return;
  }
  const line = `[${stamp()}] [${area}] ${message}${data !== undefined ? ` ${stringify(data)}` : ''}`;
  channel?.appendLine(line);
  if (logFile) {
    const file = logFile;
    writeQueue = writeQueue
      .then(async () => {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.appendFile(file, line + '\n', 'utf8');
      })
      .catch(() => undefined);
  }
}
