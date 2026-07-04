import { handleResponse, reportProviderError, type CommandDependencies } from '../commands/common';
import type { ParleySettings } from '../config/settings';
import type { CheckpointStore } from '../diff/checkpoints';
import { dbg } from '../debug/debug';
import { runHookEvent } from '../hooks/hooks';
import type { Logger } from '../logging/logger';
import type { ParleyProvider } from '../parley/ParleyProvider';
import { estimateCostUsd } from '../parley/pricing';
import { resolveThinking, type ThinkingLevel } from '../parley/thinking';
import { decideTurnStep } from '../parley/turnPolicy';
import type {
  AudioAttachment,
  ChatMessage,
  ContextAttachment,
  DocumentAttachment,
  ImageAttachment,
  ToolDefinition
} from '../parley/types';
import type { ToolExecutor } from './toolExecutor';
import type { TranscriptRecorder } from './transcriptRecorder';

/** Everything the turn runner needs from its hosting chat panel. */
export interface TurnRunnerHost {
  readonly history: ChatMessage[];
  readonly recorder: TranscriptRecorder;
  readonly executor: ToolExecutor;
  readonly checkpoints: CheckpointStore;
  readonly commandDeps: CommandDependencies;
  readonly logger: Logger;
  post(message: Record<string, unknown>): void;
  postState(): Promise<void>;
  /** Add a round's usage to the session counters; returns the new totals for the live display. */
  applyUsage(totalTokens: number, costUsd: number): { sessionTokens: number; sessionCostUsd: number };
  getSessionTokens(): number;
  /** Run a queued steering message as a fresh turn once this one finishes. */
  runFollowUp(prompt: string): void;
  /** Record the end-of-turn changed-files summary (files written since checkpoint `cpStart`). */
  recordChangesSummary(cpStart: number): Promise<void>;
}

/** A fully-prepared turn: the panel assembles context/attachments; the runner drives the loop. */
export interface TurnRequest {
  readonly prompt: string;
  readonly context: readonly ContextAttachment[];
  readonly images: readonly ImageAttachment[];
  readonly documents: readonly DocumentAttachment[];
  readonly audios: readonly AudioAttachment[];
  readonly responseFormat?: Record<string, unknown>;
  readonly systemExtra?: string;
  readonly agentId: string;
  readonly thinking: ThinkingLevel;
  readonly speed: 'standard' | 'fast';
  readonly settings: ParleySettings;
  readonly provider: ParleyProvider;
  readonly toolsEnabled: boolean;
  readonly canAutoContinue: boolean;
  readonly useStream: boolean;
  readonly turnTools?: readonly ToolDefinition[];
}

/**
 * Drives one agent turn: the streaming request, the auto-continue loop (policy
 * in the pure decideTurnStep), tool routing to the ToolExecutor, live steering
 * injection, and the busy/abort lifecycle. Decomposition 4/4: extracted from
 * ChatPanel, which now only assembles the request and renders state.
 */
export class AgentTurnRunner {
  public busy = false;
  // True from the moment a turn is claimed until execute() takes over — the window
  // (hooks, context collection, mention resolution) during which busy was still
  // false, letting a second send start a concurrent turn. Callers treat it as busy.
  public starting = false;
  private abortController?: AbortController;
  private queuedSteering: string[] = [];
  private lastToolAction = ''; // pairs a tool's ⏺ action with its ⎿ result for the transcript

  public constructor(private readonly host: TurnRunnerHost) {}

  public get abortSignal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  public abort(): void {
    this.abortController?.abort();
  }

  /**
   * Claim the turn synchronously (before any await in the caller's pre-execute
   * phase) and arm an abort controller so Stop works even during context gathering.
   */
  public begin(): void {
    this.starting = true;
    this.abortController ??= new AbortController();
  }

  /** Release a claim made by begin() when the caller bails before calling execute(). */
  public cancelStart(): void {
    this.starting = false;
    this.abortController = undefined;
  }

  /**
   * Run a non-turn provider request (e.g. compaction) under the same busy/abort
   * lifecycle, so the Stop button — which calls abort() — actually cancels it.
   */
  public async runExternal<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.busy = true;
    this.abortController = new AbortController();
    await this.host.postState();
    try {
      return await fn(this.abortController.signal);
    } finally {
      this.busy = false;
      this.abortController = undefined;
      await this.host.postState();
    }
  }

  // ---------- queues for messages typed while the agent works ----------
  // Two kinds: STEERING (injected into the current turn at its next round) and
  // FOLLOW-UPS (run as their own turn after the current one fully finishes).
  private queuedFollowUps: string[] = [];

  private postQueued(): void {
    this.host.post({ type: 'queued', steering: [...this.queuedSteering], followUps: [...this.queuedFollowUps] });
  }

  public queueSteering(text: string): void {
    this.queuedSteering.push(text);
    this.postQueued();
  }

  public queueFollowUp(text: string): void {
    this.queuedFollowUps.push(text);
    this.postQueued();
  }

  public removeQueued(kind: 'steer' | 'followUp', index: number): void {
    if (kind === 'followUp') {
      this.queuedFollowUps = this.queuedFollowUps.filter((_, i) => i !== index);
    } else {
      this.queuedSteering = this.queuedSteering.filter((_, i) => i !== index);
    }
    this.postQueued();
  }

  public clearSteering(): void {
    this.queuedSteering = [];
    this.queuedFollowUps = [];
    this.postQueued();
  }

  /** Execute a prepared turn. The caller has already pushed the user message. */
  public async execute(req: TurnRequest): Promise<void> {
    this.busy = true;
    this.starting = false; // execute() now owns the lifecycle
    this.abortController ??= new AbortController(); // reuse begin()'s controller so Stop worked during context gathering
    await this.host.postState();

    const { settings, agentId, useStream, toolsEnabled, canAutoContinue } = req;
    let turnTokens = 0;
    // Partial streamed output for the CURRENT round — persisted if the user hits Stop
    // mid-stream so the reply they were reading isn't lost. Reset each round; completed
    // rounds are already pushed to history/recorder below.
    let streamedText = '';
    let streamedThinking = '';
    let thinkingStartAt = 0; // first thinking delta of the round (for "Thought for Ns")
    let thinkingMs = 0;
    const cpStart = this.host.checkpoints.size;
    this.host.post({ type: 'tokens', total: 0 });
    dbg('turn', 'start', {
      agentId,
      toolsEnabled,
      canAutoContinue,
      stream: useStream,
      thinking: req.thinking,
      speed: req.speed,
      tools: req.turnTools?.length ?? 0
    });

    try {
      let auto = 0;
      let nudged = false; // one free "your reply was empty" retry before declaring a stall
      let continuation: string | null = null; // null = first send (real prompt + context)
      // Screenshots captured by capture_screen this turn — carried into every
      // subsequent auto-continue step so the model keeps seeing them (otherwise it
      // loses the image after one step and wrongly "corrects" itself as hallucinating).
      const turnImages: Array<{ label: string; dataUri: string }> = [];
      for (;;) {
        const stepActions: string[] = []; // tool activity for this step (persisted if the model doesn't narrate)
        streamedText = '';
        streamedThinking = '';
        thinkingStartAt = 0;
        thinkingMs = 0;
        if (useStream) {
          this.host.post({ type: 'streamStart' });
        }
        const isCont = continuation !== null;
        const contText = continuation ?? '';
        const messages = isCont
          ? [...this.host.history, { role: 'user' as const, content: contText, createdAt: new Date().toISOString() }]
          : this.host.history;

        const response = await req.provider.sendMessage(
          {
            prompt: isCont ? contText : req.prompt,
            messages,
            context: isCont ? [] : req.context,
            agentId,
            images: isCont
              ? turnImages.length > 0
                ? turnImages
                : undefined
              : [...req.images, ...turnImages].length === 0
                ? undefined
                : [...req.images, ...turnImages],
            documents: isCont || req.documents.length === 0 ? undefined : req.documents,
            audios: isCont || req.audios.length === 0 ? undefined : req.audios,
            thinking: resolveThinking(req.thinking),
            speed: req.speed,
            responseFormat: req.responseFormat,
            systemExtra: req.systemExtra
          },
          {
            signal: this.abortController.signal,
            onToken: useStream
              ? (delta) => {
                  streamedText += delta;
                  this.host.post({ type: 'streamDelta', delta });
                }
              : undefined,
            onThinking: useStream
              ? (delta) => {
                  if (!thinkingStartAt) {
                    thinkingStartAt = Date.now();
                  }
                  thinkingMs = Date.now() - thinkingStartAt;
                  streamedThinking += delta;
                  this.host.post({ type: 'thinkingDelta', delta });
                }
              : undefined,
            tools: req.turnTools,
            runTool: toolsEnabled ? (call) => this.host.executor.run(call) : undefined,
            // Images a tool produced this round (capture_screen): injected into THIS
            // round's messages (immediate vision) and recorded in turnImages so every
            // later auto-continue step re-supplies them (persistent vision).
            drainToolImages: toolsEnabled
              ? () => {
                  const imgs = this.host.executor.drainImages();
                  for (const dataUri of imgs) {
                    turnImages.push({ label: 'screenshot', dataUri });
                  }
                  return imgs;
                }
              : undefined,
            onToolEvent: toolsEnabled
              ? (event) => {
                  const action = describeToolEvent(event.name, event.args);
                  stepActions.push(action);
                  this.lastToolAction = action;
                  this.host.post({ type: 'toolEvent', name: event.name, args: event.args });
                }
              : undefined,
            onToolResult: toolsEnabled
              ? (name, result) => {
                  // write/edit show a diff card already; others get a Claude-style ⎿ result line.
                  if (name !== 'write_file' && name !== 'edit_file' && name !== 'multi_edit') {
                    const text = summarizeToolResult(name, result);
                    this.host.post({ type: 'toolResult', text });
                    // Record the ⏺ action + ⎿ result together in the persisted transcript.
                    this.host.recorder.append({
                      kind: 'tool',
                      action: this.lastToolAction || name,
                      result: text,
                      at: new Date().toISOString()
                    });
                  }
                }
              : undefined,
            onRetry: (info) => {
              // Transient failure being retried — show it on the status line instead of dying.
              this.host.post({
                type: 'retry',
                text: `${info.reason} — retrying in ${Math.ceil(info.delayMs / 1000)}s (attempt ${info.attempt}/${info.maxAttempts})…`
              });
            },
            getQueuedUserMessages: () => {
              // Steering: drain messages typed while the agent works into the
              // conversation (history + transcript + a live bubble in the chat).
              if (this.queuedSteering.length === 0) {
                return [];
              }
              const items = this.queuedSteering.splice(0);
              for (const text of items) {
                this.host.history.push({ role: 'user', content: text, createdAt: new Date().toISOString() });
                this.host.recorder.append({ kind: 'user', text, at: new Date().toISOString() });
                this.host.post({ type: 'steerInjected', text });
              }
              this.postQueued();
              return items;
            },
            onUsage: (usage) => {
              turnTokens += usage.total;
              const totals = this.host.applyUsage(usage.total, estimateCostUsd(agentId, usage) ?? 0);
              this.host.post({
                type: 'tokens',
                total: turnTokens,
                session: totals.sessionTokens,
                sessionCostUsd: totals.sessionCostUsd
              });
            },
            maxToolRounds: settings.maxToolRounds
          }
        );

        // All loop policy (stall vs thinking-only, one-shot nudge, <DONE>, limits)
        // lives in the pure, unit-tested decideTurnStep.
        const decision = decideTurnStep({
          content: response.message.content,
          thinkingChars: response.message.thinking?.trim().length ?? 0,
          toolActions: stepActions.length,
          canAutoContinue,
          nudged,
          aborted: this.abortController.signal.aborted,
          sessionTokens: this.host.getSessionTokens(),
          tokenLimit: settings.tokenLimit,
          autoSteps: auto,
          maxAutoContinue: settings.maxAutoContinue
        });
        dbg('turn', 'send complete', {
          auto,
          decision: decision.kind,
          next: decision.kind === 'proceed' ? decision.next.kind : undefined,
          aborted: this.abortController.signal.aborted
        });

        if (decision.kind === 'nudge') {
          nudged = true;
          auto += 1;
          continuation = decision.continuation;
          continue;
        }
        if (decision.kind === 'stall') {
          // Empty response with no tool actions: don't render a blank bubble or keep looping.
          this.host.history.push({
            role: 'assistant',
            content: decision.note,
            createdAt: new Date().toISOString(),
            model: agentId
          });
          this.host.recorder.append({ kind: 'note', text: decision.note, at: new Date().toISOString() });
          this.host.post({ type: 'streamEnd' });
          await this.host.postState();
          break;
        }

        // If the model worked through tools but didn't narrate, persist a summary of what it did
        // so the conversation and exports aren't blank (Claude-Code-style activity log).
        const cleaned = decision.cleaned.trim() ? decision.cleaned : stepActions.map((a) => `⏺ ${a}`).join('\n');
        this.host.history.push({ ...response.message, content: cleaned, model: agentId });
        // Record an assistant entry when there was real prose — or when the step was
        // thinking-only, so the streamed 💭 panel survives the post-turn re-render.
        // With tool actions and no narration, the tool/fileEdit entries already
        // represent this step in the transcript (no duplication).
        if (decision.hadNarration || decision.thinkingOnly) {
          this.host.recorder.append({
            kind: 'assistant',
            text: cleaned,
            model: agentId,
            thinking: response.message.thinking,
            thinkingSecs: response.message.thinking ? Math.round(thinkingMs / 1000) : undefined,
            tokens: response.usage?.total,
            at: new Date().toISOString()
          });
        }
        this.host.post({ type: 'streamEnd' });
        await this.host.postState();
        // Chat mode (no file tools): surface any "File:" blocks as inline Apply cards
        // instead of modal popups. Agent modes apply edits through tools, so skip there.
        await handleResponse(this.host.commandDeps, response, { skipMessageDisplay: true, skipProposedChanges: true });
        if (!toolsEnabled) {
          for (const change of response.proposedChanges ?? []) {
            this.host.executor.postProposedChange(change);
          }
        }

        if (decision.next.kind === 'stop') {
          break;
        }
        if (decision.next.kind === 'stop-token-limit' || decision.next.kind === 'stop-max-auto') {
          this.host.history.push({
            role: 'assistant',
            content: decision.next.note,
            createdAt: new Date().toISOString()
          });
          this.host.recorder.append({ kind: 'note', text: decision.next.note, at: new Date().toISOString() });
          await this.host.postState();
          break;
        }
        auto += 1;
        continuation = decision.next.continuation;
      }

      // End-of-turn changed-files summary card (per-file +/- counts + a Review action).
      await this.host.recordChangesSummary(cpStart);
      this.busy = false;
      this.starting = false;
      this.abortController = undefined;
      await this.host.postState();
      await this.host.recorder.autosave();
      // Stop hooks: fire-and-forget notifications that a turn finished (never blocking).
      void runHookEvent(settings.hooks, 'Stop', {}, { log: (m) => this.host.logger.debug(`hooks: ${m}`) });
      // Run the next pending message as its own turn: leftover steering first (it was
      // meant for THIS answer but arrived after the last round), then queued follow-ups.
      // runFollowUp starts a fresh turn whose own end drains the next — chaining the queue.
      const followUp = this.queuedSteering.shift() ?? this.queuedFollowUps.shift();
      if (followUp) {
        this.postQueued();
        this.host.runFollowUp(followUp);
      }
    } catch (error) {
      this.busy = false;
      this.starting = false;
      this.abortController = undefined;
      this.host.post({ type: 'streamEnd' });
      if ((error as { name?: string })?.name === 'AbortError') {
        // Preserve whatever streamed before Stop — otherwise the transcript re-render
        // (which has no assistant entry for this round yet) erases the reply the user
        // was reading. Persist the partial BEFORE postState so the re-render keeps it.
        const partial = streamedText.trim();
        const partialThinking = streamedThinking.trim();
        if (partial || partialThinking) {
          const text = partial || '_(stopped before any text was produced)_';
          this.host.history.push({
            role: 'assistant',
            content: text,
            createdAt: new Date().toISOString(),
            model: agentId
          });
          this.host.recorder.append({
            kind: 'assistant',
            text,
            model: agentId,
            thinking: partialThinking || undefined,
            thinkingSecs: partialThinking ? Math.round(thinkingMs / 1000) : undefined,
            at: new Date().toISOString()
          });
        }
        await this.host.postState();
        this.host.logger.info('Parley reply was stopped by the user.');
        return;
      }
      await this.host.postState();
      await reportProviderError(this.host.commandDeps, error);
    }
  }
}

/** Short human label for a tool call, used to persist an activity log when the model doesn't narrate. */
function describeToolEvent(name: string, argsJson: string): string {
  let a: {
    path?: string;
    glob?: string;
    query?: string;
    pattern?: string;
    symbol?: string;
    selector?: string;
    command?: string;
    task?: string;
    action?: string;
    edits?: unknown[];
    url?: string;
  } = {};
  try {
    a = JSON.parse(argsJson || '{}');
  } catch {
    a = {};
  }
  switch (name) {
    case 'read_file':
      return `Read ${a.path ?? ''}`.trim();
    case 'list_directory':
      return `List ${a.path ?? '.'}`;
    case 'find_files':
      return `Find ${a.glob ?? ''}`.trim();
    case 'search_text':
      return `Search "${a.query ?? ''}"`;
    case 'grep':
      return `Grep /${a.pattern ?? ''}/`;
    case 'find_symbol':
      return `Symbol "${a.query ?? ''}"`;
    case 'document_symbols':
      return `Outline ${a.path ?? ''}`.trim();
    case 'find_definition':
      return `Def of ${a.symbol ?? ''}`.trim();
    case 'find_references':
      return `Refs of ${a.symbol ?? ''}`.trim();
    case 'write_file':
      return `Write ${a.path ?? ''}`.trim();
    case 'edit_file':
      return `Edit ${a.path ?? ''}`.trim();
    case 'multi_edit':
      return `Edit ${a.path ?? ''} (${Array.isArray(a.edits) ? a.edits.length : 0} edits)`.trim();
    case 'run_command':
      return `Run: ${a.command ?? ''}`.trim();
    case 'fetch_url':
      return `Fetch ${a.url ?? ''}`.trim();
    case 'browser_navigate':
      return `Browse ${a.url ?? ''}`.trim();
    case 'browser_read':
      return 'Read page';
    case 'browser_console':
      return 'Read console';
    case 'browser_click':
      return `Click ${a.selector ?? ''}`.trim();
    case 'browser_type':
      return `Type into ${a.selector ?? ''}`.trim();
    case 'browser_screenshot':
      return 'Screenshot page';
    case 'run_subagent':
      return `Subagent: ${(a.task ?? '').slice(0, 70)}`.trim();
    case 'subagent_step':
      return `↳ ${a.action ?? ''}`.trim();
    default:
      return name;
  }
}

/** Short, Claude-style one-line summary of a tool result for the `⎿` line. */
function summarizeToolResult(name: string, result: string): string {
  const lines = result.split('\n');
  const firstLine = lines.find((l) => l.trim()) ?? '';
  const clip = (s: string): string => (s.length > 100 ? `${s.slice(0, 100)}…` : s);
  switch (name) {
    case 'read_file':
      return `Read ${lines.length} line${lines.length === 1 ? '' : 's'}`;
    case 'list_directory': {
      const n = lines.filter((l) => l.trim()).length;
      return `${n} entr${n === 1 ? 'y' : 'ies'}`;
    }
    case 'find_files': {
      const n = lines.filter((l) => l.trim()).length;
      return `${n} file${n === 1 ? '' : 's'}`;
    }
    case 'search_text':
    case 'grep':
      return /^\[?no\b/i.test(firstLine) ? 'No matches' : `${lines.filter((l) => l.trim()).length} match line(s)`;
    case 'run_command':
      return clip(firstLine || '(no output)');
    case 'fetch_url':
      return `${result.length.toLocaleString()} chars`;
    case 'browser_navigate':
    case 'browser_read':
    case 'browser_console':
      return /^\[?(no|error)/i.test(firstLine) ? clip(firstLine) : `${result.length.toLocaleString()} chars`;
    case 'run_subagent':
      return /^error/i.test(firstLine) ? clip(firstLine) : `report: ${result.length.toLocaleString()} chars`;
    default:
      return clip(firstLine);
  }
}
