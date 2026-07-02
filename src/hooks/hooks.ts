import { exec } from 'child_process';

/**
 * Lifecycle hooks (Claude-Code-compatible shape): shell commands that run at
 * fixed points of the agent's life, configured in `parley.hooks`:
 *
 *   "parley.hooks": {
 *     "PreToolUse":  [{ "matcher": "run_command|write_file", "command": "node guard.js" }],
 *     "PostToolUse": [{ "matcher": "edit_file", "command": "npm run lint --silent" }],
 *     "UserPromptSubmit": [{ "command": "echo extra context for every prompt" }],
 *     "Stop": [{ "command": "notify-send 'Parley finished'" }]
 *   }
 *
 * Each hook receives the event as JSON on stdin. Exit-code semantics follow
 * Claude Code: **exit 2 intervenes** (blocks the tool / prompt, or feeds stderr
 * back to the model); any other non-zero exit is logged and ignored. On
 * UserPromptSubmit, a zero-exit stdout is attached to the prompt as extra context.
 */

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop';

export interface HookDefinition {
  /** Regex matched against the tool name (PreToolUse/PostToolUse). Omit to match every tool. */
  readonly matcher?: string;
  /** Shell command to run; the JSON event arrives on stdin. */
  readonly command: string;
  /** Default 30. */
  readonly timeoutSeconds?: number;
}

export type HooksConfig = Partial<Record<HookEvent, readonly HookDefinition[]>>;

export interface HookOutcome {
  /** PreToolUse/UserPromptSubmit only: a hook exited 2 — do not proceed. */
  readonly blocked: boolean;
  /** The intervening hook's stderr/stdout (block reason, or PostToolUse feedback for the model). */
  readonly feedback?: string;
  /** UserPromptSubmit only: zero-exit stdout to attach as extra context. */
  readonly extraContext?: string;
}

/** Hooks configured for `event` whose matcher matches `toolName` (pure). */
export function selectHooks(config: HooksConfig | undefined, event: HookEvent, toolName?: string): HookDefinition[] {
  const hooks = config?.[event];
  if (!Array.isArray(hooks)) {
    return [];
  }
  return hooks.filter((h) => {
    if (!h || typeof h.command !== 'string' || !h.command.trim()) {
      return false;
    }
    if (!h.matcher || !toolName) {
      return true;
    }
    try {
      return new RegExp(h.matcher).test(toolName);
    } catch {
      return false; // malformed matcher never fires
    }
  });
}

interface HookRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Fold one hook's result into the outcome per the exit-code contract (pure). */
export function interpretHookRun(event: HookEvent, run: HookRun, prior: HookOutcome): HookOutcome {
  const message = (run.stderr.trim() || run.stdout.trim()).slice(0, 2000);
  if (run.exitCode === 2) {
    if (event === 'PreToolUse' || event === 'UserPromptSubmit') {
      return { ...prior, blocked: true, feedback: message || 'blocked by hook' };
    }
    if (event === 'PostToolUse') {
      const feedback = [prior.feedback, message].filter(Boolean).join('\n');
      return { ...prior, feedback: feedback || 'hook requested attention' };
    }
    return prior; // Stop hooks can't intervene
  }
  if (run.exitCode === 0 && event === 'UserPromptSubmit' && run.stdout.trim()) {
    const extra = [prior.extraContext, run.stdout.trim()].filter(Boolean).join('\n');
    return { ...prior, extraContext: extra };
  }
  return prior;
}

export interface HookRunnerOptions {
  readonly cwd?: string;
  readonly log?: (message: string) => void;
}

/** Run every matching hook for an event, sequentially, folding results per the contract. */
export async function runHookEvent(
  config: HooksConfig | undefined,
  event: HookEvent,
  payload: Record<string, unknown>,
  options: HookRunnerOptions = {}
): Promise<HookOutcome> {
  let outcome: HookOutcome = { blocked: false };
  const hooks = selectHooks(config, event, typeof payload.tool === 'string' ? payload.tool : undefined);
  for (const hook of hooks) {
    const run = await execHook(hook, { event, ...payload }, options);
    if (run.exitCode !== 0 && run.exitCode !== 2) {
      options.log?.(`hook "${hook.command}" (${event}) exited ${run.exitCode}: ${run.stderr.trim().slice(0, 200)}`);
    }
    outcome = interpretHookRun(event, run, outcome);
    if (outcome.blocked) {
      break; // first blocking hook wins
    }
  }
  return outcome;
}

function execHook(
  hook: HookDefinition,
  payload: Record<string, unknown>,
  options: HookRunnerOptions
): Promise<HookRun> {
  const timeoutMs = Math.max(1, Math.min(600, Math.floor(hook.timeoutSeconds ?? 30))) * 1000;
  return new Promise((resolve) => {
    const child = exec(
      hook.command,
      { cwd: options.cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const exitCode =
          error && typeof (error as { code?: number }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ exitCode, stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    );
    try {
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    } catch {
      // Hook may not read stdin — fine.
    }
  });
}
