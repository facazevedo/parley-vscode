/** Pure parsing + prompt building for next-edit prediction — no vscode, unit-testable. */

export interface Prediction {
  readonly find?: string;
  readonly replace?: string;
  readonly why?: string;
  readonly none?: boolean;
}

const MAX_FILE_CHARS = 16000;

/** Build the next-edit prediction prompt (shared by the diff command and the ghost flow). */
export function buildNextEditPrompt(
  relPath: string,
  languageId: string,
  fileText: string,
  recentSummary: string
): string {
  const capped =
    fileText.length > MAX_FILE_CHARS ? `${fileText.slice(0, MAX_FILE_CHARS)}\n/* …truncated… */` : fileText;
  return (
    "You predict a developer's NEXT edit. Given their recent edits and the current file, predict the single most " +
    'likely next change that continues the intent — e.g. update a sibling case/branch, a related call site, a type, ' +
    'an import, or a matching test.\n\n' +
    'Reply with EXACTLY one fenced ```json block and nothing else:\n' +
    '{"find":"<exact snippet copied verbatim from the current file — must occur exactly once>","replace":"<replacement text>","why":"<one short line>"}\n' +
    'or {"none":true} if there is no confident next edit.\n\n' +
    `Recent edits:\n${recentSummary}\n\n` +
    `Current file — ${relPath} (${languageId}):\n\`\`\`\n${capped}\n\`\`\``
  );
}

/** Pull the JSON prediction out of the reply (a fenced ```json block preferred, else the
 *  first {...}). Returns undefined when nothing parses. */
export function parsePrediction(text: string): Prediction | undefined {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const braces = text.match(/\{[\s\S]*\}/);
  const raw = fenced ? fenced[1] : braces ? braces[0] : text;
  try {
    return JSON.parse(raw) as Prediction;
  } catch {
    return undefined;
  }
}
