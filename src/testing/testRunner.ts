import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface TestRun {
  readonly command: string;
  /** Process exit code; 0 = pass. null when aborted or killed by signal. */
  readonly exitCode: number | null;
  readonly output: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

/**
 * Detect the project's test command: an explicit override wins, then a
 * package.json "test" script (→ `npm test`), then common ecosystem markers.
 * Returns undefined when nothing is detected. Pure filesystem probing.
 */
export function detectTestCommand(rootFsPath: string, override?: string): string | undefined {
  const trimmed = (override ?? '').trim();
  if (trimmed) {
    return trimmed;
  }
  const exists = (f: string): boolean => {
    try {
      return fs.existsSync(path.join(rootFsPath, f));
    } catch {
      return false;
    }
  };
  try {
    const pkgPath = path.join(rootFsPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
      const testScript = pkg?.scripts?.test;
      if (testScript && !/no test specified/i.test(testScript)) {
        return 'npm test';
      }
    }
  } catch {
    // fall through to language markers
  }
  if (exists('pyproject.toml') || exists('pytest.ini') || exists('setup.cfg') || exists('tox.ini')) {
    return 'pytest';
  }
  if (exists('Cargo.toml')) {
    return 'cargo test';
  }
  if (exists('go.mod')) {
    return 'go test ./...';
  }
  if (exists('pom.xml')) {
    return 'mvn test';
  }
  if (exists('build.gradle') || exists('build.gradle.kts')) {
    return 'gradle test';
  }
  return undefined;
}

/**
 * Run a test command and capture the exit code — unlike `runShellCommand`, which
 * swallows it, we need the code to reliably decide pass vs. fail.
 */
export function runTestCommand(
  command: string,
  cwd: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<TestRun> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal },
      (error, stdout, stderr) => {
        const err = error as
          | (Error & { name?: string; killed?: boolean; signal?: string; code?: number | string })
          | null;
        const aborted = !!err && err.name === 'AbortError';
        // Output over maxBuffer also sets killed+SIGTERM, but it's not a timeout.
        const maxBuffered = !!err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        const timedOut = !!err && err.killed === true && !!err.signal && !maxBuffered;
        let out = `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim();
        // A spawn failure (bad cwd, shell missing, etc.) yields an error with no
        // stdout/stderr — surface its message so the agent isn't handed "(no output)".
        // Node's exec already prefixes "Command failed:", so don't double it.
        if (!out && err && !aborted) {
          out = /^Command failed/.test(err.message) ? err.message : `Command failed: ${err.message}`;
        }
        if (maxBuffered) {
          out = `[Test output exceeded 16 MB and was truncated.]${out ? `\n${out}` : ''}`;
        }
        let exitCode: number | null;
        if (aborted || (timedOut && typeof err?.code !== 'number')) {
          exitCode = null;
        } else if (typeof err?.code === 'number') {
          exitCode = err.code;
        } else {
          exitCode = err ? 1 : 0;
        }
        resolve({ command, exitCode, output: out, timedOut, aborted });
      }
    );
  });
}
