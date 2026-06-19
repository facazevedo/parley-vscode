export interface FilePatch {
  readonly oldPath: string;
  readonly newPath: string;
  readonly hunks: readonly PatchHunk[];
}

export interface PatchHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatch(patch: string): FilePatch[] {
  const lines = patch.split(/\r?\n/);
  const files: FilePatch[] = [];
  let current: { oldPath: string; newPath: string; hunks: PatchHunk[] } | undefined;
  let currentHunk: PatchHunk | undefined;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) {
        files.push(current);
      }
      current = { oldPath: '', newPath: '', hunks: [] };
      currentHunk = undefined;
      continue;
    }

    if (!current && (line.startsWith('--- ') || line.startsWith('+++ '))) {
      current = { oldPath: '', newPath: '', hunks: [] };
    }

    if (!current) {
      continue;
    }

    if (line.startsWith('--- ')) {
      current.oldPath = cleanPatchPath(line.slice(4));
      continue;
    }

    if (line.startsWith('+++ ')) {
      current.newPath = cleanPatchPath(line.slice(4));
      continue;
    }

    const match = hunkHeader.exec(line);
    if (match) {
      currentHunk = {
        oldStart: Number(match[1]),
        oldLines: Number(match[2] ?? '1'),
        newStart: Number(match[3]),
        newLines: Number(match[4] ?? '1'),
        lines: []
      };
      current.hunks.push(currentHunk);
      continue;
    }

    if (currentHunk && /^[ +\-\\]/.test(line)) {
      (currentHunk.lines as string[]).push(line);
    }
  }

  if (current) {
    files.push(current);
  }

  return files.filter((file) => file.oldPath.length > 0 || file.newPath.length > 0);
}

function cleanPatchPath(input: string): string {
  const withoutTimestamp = input.split('\t')[0]?.trim() ?? input.trim();
  return withoutTimestamp.replace(/^a\//, '').replace(/^b\//, '');
}
