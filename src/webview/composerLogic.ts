/**
 * Pure, DOM-free logic for the chat webview (media/chat.js), extracted so it is
 * unit-testable. chat.js imports these and esbuild bundles them into dist/webview.js;
 * the tests import the same module. Keep this file free of DOM / vscode / node APIs.
 */

export interface ContextToggleState {
  readonly includeSelection?: boolean;
  readonly includeCurrentFile?: boolean;
  readonly includeOpenEditors?: boolean;
  readonly includeDiagnostics?: boolean;
}

const CONTEXT_LABELS: ReadonlyArray<readonly [keyof ContextToggleState, string]> = [
  ['includeSelection', 'Selection'],
  ['includeCurrentFile', 'File'],
  ['includeOpenEditors', 'Open editors'],
  ['includeDiagnostics', 'Diagnostics']
];

/** Collapsed-state Context summary, e.g. `" — Selection, Diagnostics"` (or `" — none"`). */
export function contextSummary(state: ContextToggleState): string {
  const on = CONTEXT_LABELS.filter(([key]) => state[key]).map(([, label]) => label);
  return ' — ' + (on.length ? on.join(', ') : 'none');
}

export interface KeyEventLike {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

/**
 * Map a keydown to a pending-edit review action, or null if it isn't a review
 * shortcut. Ctrl/Cmd+Enter = apply (+Shift = apply all); Ctrl/Cmd+Backspace =
 * reject (+Shift = reject all). Plain Enter (send) is intentionally not matched.
 */
export function mapReviewKey(e: KeyEventLike): { applying: boolean; all: boolean } | null {
  if (!(e.ctrlKey || e.metaKey)) {
    return null;
  }
  if (e.key === 'Enter') {
    return { applying: true, all: !!e.shiftKey };
  }
  if (e.key === 'Backspace') {
    return { applying: false, all: !!e.shiftKey };
  }
  return null;
}
