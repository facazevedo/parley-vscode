import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';

/**
 * Quote one token for a Windows `cmd.exe` command line. Double quotes make cmd treat
 * spaces and the metacharacters `& | < > ^ ( )` literally; embedded double quotes are
 * backslash-escaped per the MSVCRT convention that node.exe / npm-cli parse with.
 * Exported for unit testing.
 */
export function quoteForCmd(token: string): string {
  if (token.length === 0) {
    return '""';
  }
  if (!/[ \t"&|<>^()!%]/.test(token)) {
    return token; // no metacharacters → safe to pass bare
  }
  const escaped = token.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * Cross-platform spawn that resolves Windows command shims (`npm.cmd`, `npx.cmd`, …)
 * WITHOUT the `shell: true` + args-array form that triggers Node's DEP0190 deprecation
 * (and the arg-injection surface it warns about — Node concatenates array args into the
 * shell line unescaped). On POSIX the binary is spawned directly with no shell. On
 * Windows we must go through the shell so `.cmd`/`.bat` shims resolve, but we pass a
 * single, explicitly quoted command string and no separate args array, so nothing is
 * concatenated unescaped.
 */
export function spawnResolved(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  if (process.platform === 'win32') {
    const line = [command, ...args].map(quoteForCmd).join(' ');
    return spawn(line, { ...options, shell: true });
  }
  return spawn(command, [...args], { ...options, shell: false });
}
