import * as fs from 'fs/promises';
import * as path from 'path';

export interface IgnoreMatcher {
  readonly patterns: readonly string[];
  ignores(filePath: string): boolean;
}

export async function loadIgnoreMatcher(workspaceFolder: string, respectGitignore: boolean): Promise<IgnoreMatcher> {
  const files = respectGitignore ? ['.gitignore', '.parleyignore'] : ['.parleyignore'];
  const patterns: string[] = [];

  for (const file of files) {
    const fullPath = path.join(workspaceFolder, file);
    try {
      const content = await fs.readFile(fullPath, 'utf8');
      patterns.push(...parseIgnoreFile(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return {
    patterns,
    ignores(filePath: string): boolean {
      const relative = path.relative(workspaceFolder, filePath).replace(/\\/g, '/');
      return patterns.some((pattern) => matchesPattern(relative, pattern));
    }
  };
}

export function parseIgnoreFile(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('!'));
}

export function matchesPattern(relativePath: string, pattern: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const cleanPattern = pattern.replace(/\\/g, '/').replace(/^\//, '');

  if (cleanPattern.endsWith('/')) {
    const directory = cleanPattern.slice(0, -1);
    return normalized === directory || normalized.startsWith(`${directory}/`) || normalized.includes(`/${directory}/`);
  }

  if (!cleanPattern.includes('*')) {
    return normalized === cleanPattern || normalized.endsWith(`/${cleanPattern}`);
  }

  const escaped = cleanPattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`(^|/)${escaped}$`).test(normalized);
}
