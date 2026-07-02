/**
 * Pure decision logic for one step of the agent's auto-continue loop — extracted
 * from the chat panel so the loop's behavior (stall vs thinking-only, the one-shot
 * empty-reply nudge, <DONE>, token/step limits) is unit-testable without vscode.
 */

export interface TurnStepInput {
  /** Raw model content for this step (may contain <DONE>). */
  readonly content: string;
  readonly thinkingChars: number;
  readonly toolActions: number;
  readonly canAutoContinue: boolean;
  /** Whether the one-shot empty-reply nudge was already spent this turn. */
  readonly nudged: boolean;
  readonly aborted: boolean;
  readonly sessionTokens: number;
  /** 0 = unlimited. */
  readonly tokenLimit: number;
  /** Auto-continue steps taken so far this turn. */
  readonly autoSteps: number;
  readonly maxAutoContinue: number;
}

export type TurnStepDecision =
  /** Truly empty step with the nudge still available — retry once. */
  | { readonly kind: 'nudge'; readonly continuation: string }
  /** Truly empty step, nudge spent (or no auto-continue) — stop with a note. */
  | { readonly kind: 'stall'; readonly note: string }
  /** Real progress — render it, then stop or continue per `next`. */
  | {
      readonly kind: 'proceed';
      /** Content with <DONE> stripped. May be empty for tool/thinking-only steps. */
      readonly cleaned: string;
      readonly hadNarration: boolean;
      /** Reasoned but produced no text/tools — preserve the 💭 panel in the transcript. */
      readonly thinkingOnly: boolean;
      readonly next:
        | { readonly kind: 'stop' }
        | { readonly kind: 'stop-token-limit'; readonly note: string }
        | { readonly kind: 'stop-max-auto'; readonly note: string }
        | { readonly kind: 'continue'; readonly continuation: string };
    };

export const CONTINUE_PROMPT = 'Continue. If the task is already fully complete, reply with <DONE>.';
export const NUDGE_PROMPT =
  'Your previous reply was empty. Continue with the task — call a tool or reply with text. If it is already fully complete, reply with <DONE>.';

export function decideTurnStep(input: TurnStepInput): TurnStepDecision {
  const done = /<DONE>/i.test(input.content);
  const cleaned = input.content.replace(/<DONE>/gi, '').trimEnd();
  const hadNarration = cleaned.trim().length > 0;
  const madeProgress = hadNarration || input.toolActions > 0 || input.thinkingChars > 0;

  if (!madeProgress) {
    if (input.canAutoContinue && !input.nudged && !input.aborted) {
      return { kind: 'nudge', continuation: NUDGE_PROMPT };
    }
    return {
      kind: 'stall',
      note: input.canAutoContinue
        ? '⏸ Stopped: the model returned an empty response and took no actions. Try rephrasing, switching models, or another mode.'
        : '_(The model returned an empty response.)_'
    };
  }

  const thinkingOnly = !hadNarration && input.toolActions === 0 && input.thinkingChars > 0;
  const base = { kind: 'proceed' as const, cleaned, hadNarration, thinkingOnly };

  if (!input.canAutoContinue || done || input.aborted) {
    return { ...base, next: { kind: 'stop' } };
  }
  if (input.tokenLimit > 0 && input.sessionTokens >= input.tokenLimit) {
    return {
      ...base,
      next: {
        kind: 'stop-token-limit',
        note: `⏸ Stopped — token limit reached (${input.sessionTokens.toLocaleString()} / ${input.tokenLimit.toLocaleString()}). Raise "parley.tokenLimit" or start a new conversation.`
      }
    };
  }
  if (input.autoSteps >= input.maxAutoContinue) {
    return {
      ...base,
      next: {
        kind: 'stop-max-auto',
        note: `⏸ Paused after ${input.maxAutoContinue} automatic steps to avoid runaway usage. Type "continue" to keep going.`
      }
    };
  }
  return { ...base, next: { kind: 'continue', continuation: CONTINUE_PROMPT } };
}
