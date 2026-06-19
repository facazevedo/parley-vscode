export function applyFilePatch(originalText: string, hunks: readonly (readonly string[])[]): string {
  const hasTrailingNewline = originalText.endsWith('\n');
  const lines = originalText.replace(/\r\n/g, '\n').split('\n');
  if (hasTrailingNewline) {
    lines.pop();
  }

  const output: string[] = [];
  let sourceIndex = 0;

  for (const hunk of hunks) {
    const context = hunk.filter((line) => line.startsWith(' ') || line.startsWith('-')).map((line) => line.slice(1));
    const hunkIndex = findSubsequence(lines, context, sourceIndex);
    if (hunkIndex < 0) {
      throw new Error('Patch hunk did not match the current file.');
    }

    output.push(...lines.slice(sourceIndex, hunkIndex));
    for (const line of hunk) {
      if (line.startsWith(' ') || line.startsWith('+')) {
        output.push(line.slice(1));
      }
    }
    sourceIndex = hunkIndex + context.length;
  }

  output.push(...lines.slice(sourceIndex));
  return `${output.join('\n')}${hasTrailingNewline ? '\n' : ''}`;
}

function findSubsequence(source: readonly string[], needle: readonly string[], startAt: number): number {
  if (needle.length === 0) {
    return startAt;
  }

  for (let index = startAt; index <= source.length - needle.length; index += 1) {
    if (needle.every((line, offset) => source[index + offset] === line)) {
      return index;
    }
  }

  return -1;
}
