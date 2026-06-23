/**
 * Pure parsing of whole-file rewrite blocks from a model response: a `File:`/`Path:`
 * label followed by a fenced code block holding the complete updated file contents.
 *
 * Kept free of any `vscode` import so it is directly unit-testable and reusable by both
 * the change extractor and the chat panel's inline Apply cards.
 */
export function parseFileCodeBlocks(response: string): Array<{ rawPath: string; code: string }> {
  const blocks: Array<{ rawPath: string; code: string }> = [];
  const pattern = /(?:^|\n)(?:#{1,6}\s*)?(?:File|Path):\s*`?([^\n`]+?)`?\s*\n+```[\w.+-]*\n([\s\S]*?)```/g;
  for (const match of response.matchAll(pattern)) {
    const rawPath = match[1]?.trim();
    const code = match[2];
    if (!rawPath || code === undefined) {
      continue;
    }
    blocks.push({ rawPath, code });
  }
  return blocks;
}
