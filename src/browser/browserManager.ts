import { spawn } from 'child_process';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as vscode from 'vscode';
import type { Logger } from '../logging/logger';
import { dbg } from '../debug/debug';
import { browserError, clampText } from './browserText';

/**
 * Local browser automation for the agent's `browser_*` tools and the `@browser`
 * mention — real JavaScript execution, rendered DOM, console, and interaction
 * via Playwright (Chromium). Like the semantic-index runtime, Playwright is
 * large and platform-specific, so it is NOT shipped in the VSIX: it is installed
 * on demand into the extension's global storage the first time a browser tool is
 * used (needs `npm` on PATH). Every path is defensive — if install/launch fails,
 * the tools return a clear error and the rest of Parley keeps working.
 *
 * This is distinct from Claude Code's `@browser`, which drives your real Chrome
 * via a companion extension; Parley drives its own local Chromium instead.
 */

const PLAYWRIGHT_VERSION = '1.49.1';
const CONSOLE_RING = 200;
const MAX_TEXT_CHARS = 12000;

export { browserError, clampText } from './browserText';

interface PlaywrightModule {
  chromium: {
    launch(opts: { headless: boolean; executablePath?: string }): Promise<PwBrowser>;
  };
}
interface PwBrowser {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwPage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  innerText(selector: string): Promise<string>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, opts?: { timeout?: number }): Promise<void>;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<unknown>;
  on(event: 'console', handler: (msg: { type(): string; text(): string }) => void): void;
  on(event: 'pageerror', handler: (err: Error) => void): void;
}

interface ConsoleLine {
  readonly kind: string;
  readonly text: string;
}

export class BrowserManager {
  private browser?: PwBrowser;
  private page?: PwPage;
  private launching?: Promise<PwPage>; // in-flight launch, shared so concurrent navigate() can't double-launch
  private readonly consoleLog: ConsoleLine[] = [];

  public constructor(
    private readonly globalStorageUri: vscode.Uri,
    private readonly logger: Logger
  ) {}

  private get runtimeDir(): string {
    return vscode.Uri.joinPath(this.globalStorageUri, 'browser-runtime').fsPath;
  }

  private async isInstalled(): Promise<boolean> {
    try {
      await fsp.access(path.join(this.runtimeDir, 'node_modules', 'playwright', 'package.json'));
      return true;
    } catch {
      return false;
    }
  }

  /** Install Playwright + Chromium into global storage (one-time; browsers land under the runtime dir). */
  private async install(): Promise<void> {
    await fsp.mkdir(this.runtimeDir, { recursive: true });
    await fsp.writeFile(
      path.join(this.runtimeDir, 'package.json'),
      JSON.stringify({ name: 'parley-browser-runtime', private: true, version: '1.0.0' }),
      'utf8'
    );
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Parley: installing the local browser runtime (one-time, downloads Chromium — a few minutes)…',
        cancellable: false
      },
      () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            'npm',
            ['install', `playwright@${PLAYWRIGHT_VERSION}`, '--no-audit', '--no-fund', '--loglevel=error'],
            {
              cwd: this.runtimeDir,
              shell: true,
              // Keep the downloaded browsers inside the runtime dir so they're self-contained.
              env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(this.runtimeDir, 'browsers') }
            }
          );
          let stderr = '';
          child.stderr?.on('data', (d) => (stderr += d.toString()));
          child.on('error', (err) => reject(new Error(`Could not run npm (is it on your PATH?): ${err.message}`)));
          child.on('close', (code) =>
            code === 0 ? resolve() : reject(new Error(`npm install exited with code ${code}. ${stderr.slice(-400)}`))
          );
        })
    );
  }

  private async loadPlaywright(): Promise<PlaywrightModule> {
    const shim = path.join(this.runtimeDir, 'load-playwright.mjs');
    await fsp.writeFile(shim, "export * from 'playwright';\n", 'utf8');
    // A real runtime dynamic import, built lazily so merely importing this module
    // (e.g. in unit tests) never evaluates `import()` in a non-module context.
    const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>;
    return (await dynamicImport(pathToFileURL(shim).href)) as PlaywrightModule;
  }

  /**
   * Ensure a live page exists, installing/launching on first use. Concurrent
   * callers share a single in-flight launch (so two navigate() calls can't spin
   * up two Chromium processes). Throws with an actionable message on failure.
   */
  private async ensurePage(): Promise<PwPage> {
    if (this.page) {
      return this.page;
    }
    if (!this.launching) {
      this.launching = this.launch();
    }
    try {
      return await this.launching;
    } finally {
      this.launching = undefined; // cleared so a failed launch can be retried
    }
  }

  private async launch(): Promise<PwPage> {
    if (!(await this.isInstalled())) {
      await this.install();
    }
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(this.runtimeDir, 'browsers');
    const pw = await this.loadPlaywright();
    this.browser = await pw.chromium.launch({ headless: true });
    const page = await this.browser.newPage();
    page.on('console', (msg) => this.pushConsole(msg.type(), msg.text()));
    page.on('pageerror', (err) => this.pushConsole('error', err.message));
    this.page = page;
    dbg('browser', 'launched Chromium');
    return page;
  }

  private pushConsole(kind: string, text: string): void {
    this.consoleLog.push({ kind, text });
    if (this.consoleLog.length > CONSOLE_RING) {
      this.consoleLog.splice(0, this.consoleLog.length - CONSOLE_RING);
    }
  }

  /** Navigate to a URL and return the page title + a rendered-text summary. */
  public async navigate(url: string): Promise<string> {
    if (!/^https?:\/\//i.test(url)) {
      return 'Error: only http:// or https:// URLs are allowed (localhost is fine, e.g. http://localhost:3000).';
    }
    try {
      const page = await this.ensurePage();
      this.consoleLog.length = 0; // fresh console per navigation
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      const title = await page.title();
      const text = clampText(await safeInnerText(page));
      return `Navigated to ${page.url()}\nTitle: ${title}\n\n${text}`;
    } catch (error) {
      return browserError(error);
    }
  }

  /** Rendered visible text of the current page (or a selector within it). */
  public async read(selector?: string): Promise<string> {
    if (!this.page) {
      return 'Error: no page open — call browser_navigate first.';
    }
    try {
      return clampText(await safeInnerText(this.page, selector));
    } catch (error) {
      return browserError(error);
    }
  }

  /** Recent console output, optionally only errors/warnings. */
  public consoleOutput(errorsOnly: boolean): string {
    if (!this.page) {
      return 'Error: no page open — call browser_navigate first.';
    }
    const lines = this.consoleLog.filter((l) => !errorsOnly || l.kind === 'error' || l.kind === 'warning');
    if (lines.length === 0) {
      return errorsOnly ? '[no console errors or warnings]' : '[no console output]';
    }
    return lines
      .map((l) => `[${l.kind}] ${l.text}`)
      .join('\n')
      .slice(0, MAX_TEXT_CHARS);
  }

  public async click(selector: string): Promise<string> {
    if (!this.page) {
      return 'Error: no page open — call browser_navigate first.';
    }
    try {
      await this.page.click(selector, { timeout: 10000 });
      return `Clicked ${selector}. Now at ${this.page.url()}.`;
    } catch (error) {
      return browserError(error);
    }
  }

  public async type(selector: string, text: string): Promise<string> {
    if (!this.page) {
      return 'Error: no page open — call browser_navigate first.';
    }
    try {
      await this.page.fill(selector, text, { timeout: 10000 });
      return `Typed into ${selector}.`;
    } catch (error) {
      return browserError(error);
    }
  }

  /** Screenshot the current page to a PNG and return its path (agent/user can open it). */
  public async screenshot(): Promise<string> {
    if (!this.page) {
      return 'Error: no page open — call browser_navigate first.';
    }
    try {
      const dir = vscode.Uri.joinPath(this.globalStorageUri, 'screenshots').fsPath;
      await fsp.mkdir(dir, { recursive: true });
      const file = path.join(dir, `page-${screenshotStamp()}.png`);
      await this.page.screenshot({ path: file, fullPage: true });
      return `Saved a full-page screenshot to ${file}`;
    } catch (error) {
      return browserError(error);
    }
  }

  public async close(): Promise<boolean> {
    const had = Boolean(this.browser);
    try {
      await this.browser?.close();
    } catch {
      // Already gone.
    }
    this.browser = undefined;
    this.page = undefined;
    this.consoleLog.length = 0;
    return had;
  }

  public dispose(): void {
    void this.close();
  }
}

async function safeInnerText(page: PwPage, selector?: string): Promise<string> {
  return page.innerText(selector && selector.trim() ? selector : 'body');
}

/** Timestamp for screenshot filenames without Date.now (kept deterministic-friendly). */
function screenshotStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

// One shared browser per VS Code window (tabs and the sidebar drive the same instance).
let shared: BrowserManager | undefined;

/** The shared browser manager, created on first use. */
export function getBrowserManager(globalStorageUri: vscode.Uri, logger: Logger): BrowserManager {
  if (!shared) {
    shared = new BrowserManager(globalStorageUri, logger);
  }
  return shared;
}

/** Close and forget the shared browser (the "Parley: Close Browser" command). */
export async function closeSharedBrowser(): Promise<boolean> {
  if (!shared) {
    return false;
  }
  const had = await shared.close();
  return had;
}
