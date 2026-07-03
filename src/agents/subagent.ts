import type { ParleyProvider, SendMessageOptions } from '../parley/ParleyProvider';
import type { ThinkingConfig } from '../parley/thinking';
import type { ToolCall, ToolDefinition } from '../parley/types';

/**
 * Local subagents: a nested agent loop with a FRESH context that runs a scoped
 * read-only investigation and returns only its final report to the parent turn.
 * The parent's conversation stays lean — dozens of nested tool results never
 * enter it, only the distilled report. Everything runs through the same
 * ParleyClient loop (retries, tool-call reassembly, result clamping); there is
 * no server-side or background infrastructure involved, and none is faked.
 *
 * This module is deliberately `vscode`-free (type-only imports) so the whole
 * orchestration is unit-testable; the ToolExecutor supplies the live pieces.
 */

/** One shot, bounded: a subagent gets a single loop, no auto-continue. */
const SUBAGENT_MAX_ROUNDS = 15;

export const SUBAGENT_SYSTEM = [
  '# Subagent role',
  'You are a READ-ONLY investigation subagent inside Parley. A parent agent delegated ONE scoped task to you.',
  'You have a fresh context: you cannot see the parent conversation, and ONLY your final message is returned to it.',
  '',
  '- Investigate with the read-only tools (read_file, grep, search_text, find_symbol, find_references, document_symbols, list_directory, find_files, fetch_url, web_search).',
  '- You cannot edit files, run commands, or ask the user anything — never propose changes or wait for confirmation.',
  '- Work until you can answer confidently, then END with your report. Do not narrate a plan first; investigate, then report.',
  '- The report must STAND ALONE: concise Markdown with findings as `path:line` references, short verbatim quotes of the key code, and explicit notes for anything not found or uncertain. Never assume the parent can see your tool results — quote what matters.'
].join('\n');

export interface SubagentOptions {
  /** Self-contained task description (the subagent sees nothing else). */
  readonly task: string;
  readonly provider: Pick<ParleyProvider, 'sendMessage'>;
  readonly agentId: string;
  readonly thinking?: ThinkingConfig;
  readonly speed: 'standard' | 'fast';
  /** The subagent's toolset (read-only, no run_subagent/update_plan). */
  readonly tools: readonly ToolDefinition[];
  readonly runTool: (call: ToolCall) => Promise<string>;
  readonly signal?: AbortSignal;
  readonly maxToolRounds?: number;
  /** Custom agent type: its prompt is appended to the invariant read-only preamble. */
  readonly role?: { readonly id: string; readonly prompt: string };
  /** One short line per nested tool call, for live progress display. */
  readonly onStep?: (action: string) => void;
  readonly onUsage?: SendMessageOptions['onUsage'];
}

/** Run one subagent task to completion and return its final report text. */
export async function runSubagentTask(options: SubagentOptions): Promise<string> {
  const task = options.task.trim();
  if (!task) {
    return 'Error: task is required — describe the investigation in a self-contained way.';
  }
  try {
    const response = await options.provider.sendMessage(
      {
        prompt: task,
        messages: [{ role: 'user', content: task, createdAt: new Date().toISOString() }],
        context: [],
        agentId: options.agentId,
        thinking: options.thinking,
        speed: options.speed,
        systemExtra: options.role
          ? `${SUBAGENT_SYSTEM}\n\n# Custom role — "${options.role.id}"\n${options.role.prompt}`
          : SUBAGENT_SYSTEM
      },
      {
        tools: options.tools,
        runTool: options.runTool,
        onToolEvent: options.onStep
          ? (event) => options.onStep!(describeSubagentStep(event.name, event.args))
          : undefined,
        signal: options.signal,
        onUsage: options.onUsage,
        maxToolRounds: options.maxToolRounds ?? SUBAGENT_MAX_ROUNDS
        // Deliberately NO onToken/onThinking (nothing streams into the parent's bubble)
        // and NO getQueuedUserMessages (steering belongs to the parent conversation).
      }
    );
    const report = response.message.content.trim();
    if (!report) {
      return 'The subagent returned no report (it may have run out of tool rounds mid-investigation). Try a narrower task.';
    }
    return report;
  } catch (error) {
    if (options.signal?.aborted) {
      return 'Error: the subagent was stopped along with the turn.';
    }
    const message = error instanceof Error ? error.message : String(error);
    return `Error: subagent failed — ${message.split('\n')[0].slice(0, 300)}`;
  }
}

/** Short human-readable line for one nested tool call (pure — exported for tests). */
export function describeSubagentStep(name: string, argsJson: string): string {
  let a: { path?: string; glob?: string; query?: string; pattern?: string; symbol?: string; url?: string } = {};
  try {
    a = JSON.parse(argsJson || '{}');
  } catch {
    // keep defaults
  }
  const target = a.path ?? a.pattern ?? a.query ?? a.symbol ?? a.glob ?? a.url ?? '';
  const verb =
    name === 'read_file'
      ? 'reading'
      : name === 'grep' || name === 'search_text'
        ? 'searching'
        : name === 'fetch_url' || name === 'web_search'
          ? 'fetching'
          : name === 'list_directory' || name === 'find_files'
            ? 'listing'
            : name.startsWith('find_') || name === 'document_symbols'
              ? 'inspecting'
              : name;
  return `${verb} ${String(target).slice(0, 80)}`.trim();
}
