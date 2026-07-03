import * as vscode from 'vscode';
import { formatSnapshot, pushEntry, stripAnsi, type TerminalEntry } from './terminalText';

/**
 * Captures recent integrated-terminal command output via the shell-integration
 * API, so `@terminal` in the composer can attach it as context. Keeps a small
 * ring buffer of the last commands; requires shells with VS Code shell
 * integration (the default on modern setups). Feature-detected: on older VS
 * Code the listener simply never registers and `@terminal` reports that. The
 * ANSI-strip / ring / formatting live in the pure terminalText module.
 */

const MAX_ENTRIES = 10;
const MAX_OUTPUT_CHARS = 8000;

const entries: TerminalEntry[] = [];
let registered = false;

export interface FailedCommand {
  readonly command: string;
  readonly exitCode: number;
  readonly terminal: string;
  readonly at: string;
}

let lastFailure: FailedCommand | undefined;
let failureListener: ((failure: FailedCommand) => void) | undefined;

/** Subscribe to non-zero command exits (one listener; used for the "Fix with Parley" hint). */
export function onCommandFailed(listener: (failure: FailedCommand) => void): void {
  failureListener = listener;
}

/** The most recent failed command, with its captured output looked up at call time. */
export function lastFailedCommand(): (FailedCommand & { output: string }) | undefined {
  if (!lastFailure) {
    return undefined;
  }
  // The output stream is recorded by the start-listener's read loop, which finishes
  // independently of the end event — resolve it lazily so it has had time to land.
  const match = [...entries].reverse().find((e) => e.command === lastFailure!.command);
  return { ...lastFailure, output: match?.output ?? '' };
}

/** Register the shell-integration listeners (no-op when the API is unavailable). */
export function activateTerminalLog(context: vscode.ExtensionContext): void {
  const win = vscode.window as unknown as {
    onDidStartTerminalShellExecution?: (
      listener: (e: {
        terminal: vscode.Terminal;
        execution: { commandLine: { value: string }; read(): AsyncIterable<string> };
      }) => void
    ) => vscode.Disposable;
    onDidEndTerminalShellExecution?: (
      listener: (e: {
        terminal: vscode.Terminal;
        execution: { commandLine: { value: string } };
        exitCode: number | undefined;
      }) => void
    ) => vscode.Disposable;
  };
  if (registered || typeof win.onDidStartTerminalShellExecution !== 'function') {
    return;
  }
  registered = true;
  context.subscriptions.push(
    win.onDidStartTerminalShellExecution((e) => {
      void (async () => {
        let output = '';
        try {
          for await (const chunk of e.execution.read()) {
            if (output.length < MAX_OUTPUT_CHARS) {
              output += chunk;
            }
          }
        } catch {
          // Stream ended abnormally — keep what we have.
        }
        pushEntry(
          entries,
          {
            terminal: e.terminal.name,
            command: e.execution.commandLine?.value ?? '',
            output: stripAnsi(output).slice(0, MAX_OUTPUT_CHARS),
            at: new Date().toISOString()
          },
          MAX_ENTRIES
        );
      })();
    })
  );
  if (typeof win.onDidEndTerminalShellExecution === 'function') {
    context.subscriptions.push(
      win.onDidEndTerminalShellExecution((e) => {
        // 130/SIGINT is the user cancelling, not a failure worth flagging.
        if (e.exitCode === undefined || e.exitCode === 0 || e.exitCode === 130) {
          return;
        }
        const command = e.execution.commandLine?.value ?? '';
        if (!command.trim()) {
          return;
        }
        lastFailure = { command, exitCode: e.exitCode, terminal: e.terminal.name, at: new Date().toISOString() };
        failureListener?.(lastFailure);
      })
    );
  }
}

/** Formatted recent terminal activity for the `@terminal` mention (most recent last). */
export function terminalSnapshot(): string {
  if (!registered) {
    return 'Terminal capture is unavailable (requires VS Code shell integration).';
  }
  if (entries.length === 0) {
    return 'No terminal commands captured yet this session (shell integration active — run a command first).';
  }
  return formatSnapshot(entries);
}
