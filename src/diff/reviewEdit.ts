import * as vscode from 'vscode';
import { applyHunks, computeHunks, type Hunk } from './lineDiff';

function hunkLabel(hunk: Hunk): string {
  const sample = (hunk.added[0] ?? hunk.removed[0] ?? '').trim().slice(0, 60);
  return `+${hunk.added.length} −${hunk.removed.length}  ${sample}`;
}

/**
 * Ask the user to review a proposed file edit. For multi-hunk changes, offers
 * Apply All / Choose… (per-hunk multi-select) / Reject. Returns the final text to
 * write, or `undefined` if the user rejected/cancelled.
 */
export async function reviewProposedEdit(label: string, original: string, proposedText: string): Promise<string | undefined> {
  const originalLines = original.split('\n');
  const hunks = computeHunks(originalLines, proposedText.split('\n'));

  if (hunks.length <= 1) {
    const answer = await vscode.window.showInformationMessage(
      `Parley wants to ${original ? 'edit' : 'create'} ${label}. Apply?`,
      { modal: true },
      'Apply',
      'Reject'
    );
    return answer === 'Apply' ? proposedText : undefined;
  }

  const answer = await vscode.window.showInformationMessage(
    `Parley wants to edit ${label} (${hunks.length} changes).`,
    { modal: true },
    'Apply All',
    'Choose…',
    'Reject'
  );
  if (answer === 'Apply All') {
    return proposedText;
  }
  if (answer !== 'Choose…') {
    return undefined;
  }

  const picks = await vscode.window.showQuickPick(
    hunks.map((hunk, index) => ({ label: hunkLabel(hunk), description: `line ${hunk.origStart + 1}`, picked: true, index })),
    { canPickMany: true, title: `Select changes to apply to ${label}`, placeHolder: 'Checked changes will be applied' }
  );
  if (!picks) {
    return undefined;
  }
  const accepted = hunks.map((_, index) => picks.some((pick) => pick.index === index));
  if (!accepted.some(Boolean)) {
    return undefined;
  }
  return applyHunks(originalLines, hunks, accepted).join('\n');
}
