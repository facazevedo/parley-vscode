/**
 * Command-safety analysis for the run_command allowlist.
 *
 * The allowlist stores approved command *prefixes*. The danger: a shell command
 * can chain several commands (`a && b`, `a ; b`, `a | b`, `a & b`) or embed
 * command substitution (`$(...)`, backticks, `<(...)`, `>(...)`). A naive
 * "does the whole string start with an approved prefix" check lets a malicious
 * tail ride an approved head — an approved `npm test` would auto-run
 * `npm test && rm -rf /`. So we split a command into its top-level segments and
 * require EVERY segment to match an approved rule, and we refuse to auto-approve
 * anything containing command substitution at all.
 *
 * Deliberately conservative: when unsure it returns "not allowed", which only
 * means Parley asks the user — it never silently runs more than was approved.
 * All functions are pure (no VS Code / IO) so they are unit-testable in isolation.
 */

// $(...) / backticks / <(...) / >(...) — any of these can smuggle a second command.
const SUBSTITUTION_RE = /\$\(|`|<\(|>\(/;

/** True if the command contains shell command/process substitution (never auto-approved). */
export function hasCommandSubstitution(command: string): boolean {
  return SUBSTITUTION_RE.test(command);
}

/**
 * Split a command into its top-level segments on the shell control operators
 * `&&`, `||`, `;`, `|`, `&`, and newlines — while respecting single/double
 * quotes and backslash escapes, and NOT mistaking redirections (`2>&1`, `&>f`)
 * for the background operator. Empty segments are dropped and each is trimmed.
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (quote) {
      current += ch;
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    // Backslash escape (outside quotes): keep both chars literally, never a boundary.
    if (ch === '\\') {
      current += ch;
      if (next !== undefined) {
        current += next;
        i++;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      segments.push(current);
      current = '';
      i++; // consume the second operator char
      continue;
    }

    if (ch === ';' || ch === '\n' || ch === '|') {
      segments.push(current);
      current = '';
      continue;
    }

    if (ch === '&') {
      // Background operator — UNLESS it's part of a redirection (`2>&1`, `>&2`, `&>file`).
      const prev = current.length > 0 ? current[current.length - 1] : '';
      if (prev === '>' || next === '>') {
        current += ch;
        continue;
      }
      segments.push(current);
      current = '';
      continue;
    }

    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Does one segment match an approved rule (exact, or the rule plus more arguments)? */
function segmentMatchesRule(segment: string, rules: readonly string[]): boolean {
  return rules.some((rule) => segment === rule || segment.startsWith(`${rule} `));
}

/**
 * Is this whole command covered by the allowlist? Requires that it contains no
 * command substitution AND every top-level segment matches some approved rule.
 */
export function isCommandAllowed(command: string, rules: readonly string[]): boolean {
  if (rules.length === 0 || hasCommandSubstitution(command)) {
    return false;
  }
  const segments = splitCommandSegments(command);
  if (segments.length === 0) {
    return false;
  }
  return segments.every((segment) => segmentMatchesRule(segment, rules));
}

/**
 * Is this a single, substitution-free command safe to REMEMBER as an allowlist
 * rule? Compound commands must never be stored as a prefix (the prefix would
 * approve an unrelated tail on future commands), so "Always Allow" is only
 * offered for simple commands.
 */
export function isSimpleCommand(command: string): boolean {
  return !hasCommandSubstitution(command) && splitCommandSegments(command).length === 1;
}
