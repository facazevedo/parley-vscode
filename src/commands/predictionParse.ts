/** Pure parsing for the next-edit prediction reply — no vscode, so it's unit-testable. */

export interface Prediction {
  readonly find?: string;
  readonly replace?: string;
  readonly why?: string;
  readonly none?: boolean;
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
