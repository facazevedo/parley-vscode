import * as vscode from 'vscode';

/**
 * Captures recent integrated-terminal command output via the shell-integration
 * API, so `@terminal` in the composer can attach it as context. Keeps a small
 * ring buffer of the last commands; requires shells with VS Code shell
 * integration (the default on modern setups). Feature-detected: on older VS
 * Code the listener simply never registers and `@terminal` reports that.
 */

interface TerminalEntry {
  readonly terminal: string;
  readonly command: string;
  readonly output: string;
  readonly at: string;
}

const MAX_ENTRIES = 10;
const MAX_OUTPUT_CHARS = 8000;

const entries: TerminalEntry[] = [];
let registered = false;

/** Register the shell-integration listener (no-op when the API is unavailable). */
export function activateTerminalLog(context: vscode.ExtensionContext): void {
  const win = vscode.window as unknown as {
    onDidStartTerminalShellExecution?: (
      listener: (e: {
        terminal: vscode.Terminal;
        execution: { commandLine: { value: string }; read(): AsyncIterable<string> };
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
        entries.push({
          terminal: e.terminal.name,
          command: e.execution.commandLine?.value ?? '',
          output: stripAnsi(output).slice(0, MAX_OUTPUT_CHARS),
          at: new Date().toISOString()
        });
        if (entries.length > MAX_ENTRIES) {
          entries.splice(0, entries.length - MAX_ENTRIES);
        }
      })();
    })
  );
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- ANSI escape sequences are control chars by definition
  return text.replace(/\[[0-9;?]*[a-zA-Z]/g, '').replace(/\][^]*/g, '');
}

/** Formatted recent terminal activity for the `@terminal` mention (most recent last). */
export function terminalSnapshot(): string {
  if (!registered) {
    return 'Terminal capture is unavailable (requires VS Code shell integration).';
  }
  if (entries.length === 0) {
    return 'No terminal commands captured yet this session (shell integration active — run a command first).';
  }
  return entries.map((e) => `[${e.terminal}] $ ${e.command}\n${e.output.trim() || '(no output)'}`).join('\n\n---\n\n');
}
