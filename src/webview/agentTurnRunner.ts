import { handleResponse, reportProviderError, type CommandDependencies } from '../commands/common';
import type { ParleySettings } from '../config/settings';
import type { CheckpointStore } from '../diff/checkpoints';
import { dbg } from '../debug/debug';
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

  // ---------- steering queue (messages typed while the agent works) ----------

  public queueSteering(text: string): void {
    this.queuedSteering.push(text);
    this.host.post({ type: 'queued', items: [...this.queuedSteering] });
  }

  public removeQueued(index: number): void {
    this.queuedSteering = this.queuedSteering.filter((_, i) => i !== index);
    this.host.post({ type: 'queued', items: [...this.queuedSteering] });
  }

  public clearSteering(): void {
    this.queuedSteering = [];
    this.host.post({ type: 'queued', items: [] });
  }

  /** Execute a prepared turn. The caller has already pushed the user message. */
  public async execute(req: TurnRequest): Promise<void> {
    this.busy = true;
    this.abortController = new AbortController();
    await this.host.postState();

    const { settings, agentId, useStream, toolsEnabled, canAutoContinue } = req;
    let turnTokens = 0;
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
      for (;;) {
        const stepActions: string[] = []; // tool activity for this step (persisted if the model doesn't narrate)
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
            images: isCont || req.images.length === 0 ? undefined : req.images,
            documents: isCont || req.documents.length === 0 ? undefined : req.documents,
            audios: isCont || req.audios.length === 0 ? undefined : req.audios,
            thinking: resolveThinking(req.thinking),
            speed: req.speed,
            responseFormat: req.responseFormat,
            systemExtra: req.systemExtra
          },
          {
            signal: this.abortController.signal,
            onToken: useStream ? (delta) => this.host.post({ type: 'streamDelta', delta }) : undefined,
            onThinking: useStream ? (delta) => this.host.post({ type: 'thinkingDelta', delta }) : undefined,
            tools: req.turnTools,
            runTool: toolsEnabled ? (call) => this.host.executor.run(call) : undefined,
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
                  if (name !== 'write_file' && name !== 'edit_file') {
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
              this.host.post({ type: 'queued', items: [] });
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

      const changed = this.host.checkpoints.changedSince(cpStart);
      if (changed.length > 0) {
        const note = `✏️ Changed ${changed.length} file${changed.length === 1 ? '' : 's'}: ${changed.join(', ')}\n_Run "Parley: Revert Last Edit" or "Parley: Revert All Edits" to undo._`;
        this.host.history.push({ role: 'assistant', content: note, createdAt: new Date().toISOString() });
        this.host.recorder.append({ kind: 'note', text: note, at: new Date().toISOString() });
      }
      this.busy = false;
      this.abortController = undefined;
      await this.host.postState();
      await this.host.recorder.autosave();
      // Steering queued after the last round boundary (or during a plain chat turn)
      // runs as an immediate follow-up turn instead of being forgotten.
      const followUp = this.queuedSteering.shift();
      if (followUp) {
        this.host.post({ type: 'queued', items: [...this.queuedSteering] });
        this.host.runFollowUp(followUp);
      }
    } catch (error) {
      this.busy = false;
      this.abortController = undefined;
      this.host.post({ type: 'streamEnd' });
      await this.host.postState();
      if ((error as { name?: string })?.name === 'AbortError') {
        this.host.logger.info('Parley reply was stopped by the user.');
        return;
      }
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
    command?: string;
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
    case 'find_references':
      return `Refs of ${a.symbol ?? ''}`.trim();
    case 'write_file':
      return `Write ${a.path ?? ''}`.trim();
    case 'edit_file':
      return `Edit ${a.path ?? ''}`.trim();
    case 'run_command':
      return `Run: ${a.command ?? ''}`.trim();
    case 'fetch_url':
      return `Fetch ${a.url ?? ''}`.trim();
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
    default:
      return clip(firstLine);
  }
}
