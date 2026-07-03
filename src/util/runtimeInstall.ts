import { spawn } from 'child_process';

/**
 * Shared helper for the two opt-in features that fetch a native runtime on first use
 * (the local `@codebase` embedding index and the browser tools). Locked-down machines
 * are the hard case: `npm` may be absent, or the install may hang forever behind a
 * proxy/firewall with no network. So we (1) preflight that `npm` actually runs, and
 * (2) time-box the install so it fails with an actionable message instead of a
 * progress spinner that never resolves. Package specs are hardcoded constants at the
 * call sites (never user input), so `shell: true` — needed to resolve `npm.cmd` on
 * Windows — introduces no injection surface.
 */

const NPM_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60_000;

let npmAvailable: boolean | undefined;

/** True if `npm --version` runs (i.e. npm is on PATH). Cached after the first success. */
export async function isNpmAvailable(): Promise<boolean> {
  if (npmAvailable) {
    return true; // cache only positives — a machine can gain npm within a session
  }
  npmAvailable = await new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (value: boolean): void => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    try {
      const child = spawn('npm', ['--version'], { shell: true, windowsHide: true });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        finish(false);
      }, NPM_PROBE_TIMEOUT_MS);
      child.on('error', () => {
        clearTimeout(timer);
        finish(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(code === 0);
      });
    } catch {
      finish(false);
    }
  });
  return npmAvailable;
}

export interface NpmInstallOptions {
  /** Working directory (a private folder in global storage) to install into. */
  readonly dir: string;
  /** Args after `npm`, e.g. `['install', 'pkg@1.2.3', '--no-audit', '--no-fund', '--loglevel=error']`. */
  readonly args: readonly string[];
  /** Human name of what's installing, for error messages (e.g. "local embedding runtime"). */
  readonly what: string;
  /** Extra environment for the child (merged over process.env), e.g. PLAYWRIGHT_BROWSERS_PATH. */
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

/**
 * Run a one-time `npm install` with a preflight npm check and a hard timeout.
 * Throws an actionable Error the caller can surface; never hangs indefinitely.
 */
export async function runNpmInstall(opts: NpmInstallOptions): Promise<void> {
  if (!(await isNpmAvailable())) {
    throw new Error(
      `npm was not found on your PATH, so Parley can't install the ${opts.what}. ` +
        `This feature is optional — install Node.js/npm (or launch VS Code from a shell where "npm" works) and retry. ` +
        `Everything else in Parley works without it.`
    );
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    const child = spawn('npm', [...opts.args], {
      cwd: opts.dir,
      shell: true,
      windowsHide: true,
      env: opts.env ? { ...process.env, ...opts.env } : process.env
    });
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      settle(() =>
        reject(
          new Error(
            `Installing the ${opts.what} timed out after ${Math.round(timeoutMs / 1000)}s. ` +
              `Your machine may block network installs or require a proxy. This feature is optional; everything else works.`
          )
        )
      );
    }, timeoutMs);
    child.on('error', (err) =>
      settle(() => {
        clearTimeout(timer);
        reject(new Error(`Could not run npm to install the ${opts.what} (is it on your PATH?): ${err.message}`));
      })
    );
    child.on('close', (code) =>
      settle(() => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`npm install for the ${opts.what} exited with code ${code}. ${stderr.slice(-400)}`));
        }
      })
    );
  });
}
