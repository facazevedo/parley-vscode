/**
 * Directory-based project rules (Cursor-compatible): each file in `.parley/rules/`
 * or `.cursor/rules/` is one rule, optionally scoped by frontmatter:
 *
 *   ---
 *   description: React component conventions
 *   globs: src/components/**, *.tsx
 *   alwaysApply: false
 *   ---
 *   body sent to the model when the rule applies…
 *
 * A rule applies when `alwaysApply: true`, when it has no globs at all, or when
 * one of its globs matches the active file. Pure — unit-testable.
 */

export interface RuleFile {
  readonly description?: string;
  readonly globs: readonly string[];
  readonly alwaysApply: boolean;
  readonly body: string;
}

/** Parse an .md/.mdc rule file with optional YAML-ish frontmatter. */
export function parseRuleFile(text: string): RuleFile {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) {
    return { globs: [], alwaysApply: false, body: text.trim() };
  }
  const body = text.slice(m[0].length).trim();
  let description: string | undefined;
  let alwaysApply = false;
  const globs: string[] = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) {
      continue;
    }
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (key === 'description') {
      description = value;
    } else if (key === 'alwaysapply') {
      alwaysApply = /^true$/i.test(value);
    } else if (key === 'globs') {
      globs.push(
        ...value
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((g) => g.trim().replace(/^["']|["']$/g, ''))
          .filter((g) => g.length > 0)
      );
    }
  }
  return { description, globs, alwaysApply, body };
}

/** Minimal glob matcher: `**` crosses directories, `*` stays within one, `?` is one char. */
export function globMatches(glob: string, relPath: string): boolean {
  const path = relPath.replace(/\\/g, '/').replace(/^\.?\//, '');
  let pattern = glob.replace(/\\/g, '/').replace(/^\.?\//, '');
  // A bare-name pattern like "*.tsx" should match at any depth (Cursor behavior).
  if (!pattern.includes('/')) {
    pattern = `**/${pattern}`;
  }
  // Single pass — chained string replaces would reprocess earlier output.
  let rx = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          rx += '(?:.*/)?'; // '**/'-prefix: zero or more directories
          i += 2;
        } else {
          rx += '.*'; // bare '**': anything, across directories
          i += 1;
        }
      } else {
        rx += '[^/]*';
      }
    } else if (ch === '?') {
      rx += '[^/]';
    } else if ('.+^${}()|[]'.includes(ch)) {
      rx += `\\${ch}`;
    } else {
      rx += ch;
    }
  }
  return new RegExp(`^${rx}$`).test(path);
}

/** Whether a rule should attach for the given active file (undefined = no file open). */
export function ruleApplies(rule: RuleFile, activeRelPath: string | undefined): boolean {
  if (rule.alwaysApply || rule.globs.length === 0) {
    return true;
  }
  if (!activeRelPath) {
    return false;
  }
  return rule.globs.some((g) => globMatches(g, activeRelPath));
}
