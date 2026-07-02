/**
 * Outbound secret scanning: detect high-confidence credential patterns in text
 * that is about to leave the machine (attached context, and tool results like a
 * file the agent read or command output), so a token isn't silently shipped to
 * the gateway. Complements the sensitive-*file* denylist (which blocks whole
 * files) by catching secrets embedded inside otherwise-ordinary content.
 *
 * Pure (no vscode/IO) and unit-tested. Patterns are curated from the public
 * gitleaks ruleset — DISTINCTIVE PREFIXES ONLY (no generic entropy heuristics),
 * so false positives are rare. When unsure, it does nothing.
 */

interface SecretPattern {
  readonly name: string;
  readonly re: RegExp;
}

// Each `re` is global so we can count/replace every occurrence. Prefix-anchored,
// high-signal patterns only — assembled to avoid tripping scanners on this file.
const PATTERNS: readonly SecretPattern[] = [
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'GitHub token', re: /\bgh[posru]_[A-Za-z0-9]{36,}\b/g },
  { name: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  // Anthropic first, and the OpenAI/Parley pattern excludes `sk-ant-` so a key is typed once, not twice.
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'OpenAI/Parley key', re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-|parley-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'Stripe secret key', re: /\b[rs]k_live_[A-Za-z0-9]{20,}\b/g },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'private key block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g }
];

export interface SecretFinding {
  readonly type: string;
  readonly count: number;
}

/** Detect secrets without modifying the text. Findings are grouped by type with a count. */
export function scanForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  if (!text) {
    return findings;
  }
  for (const { name, re } of PATTERNS) {
    const matches = text.match(re);
    if (matches && matches.length > 0) {
      findings.push({ type: name, count: matches.length });
    }
  }
  return findings;
}

/** Replace detected secrets with a redaction marker, returning the redacted text + what was found. */
export function redactSecrets(text: string): { text: string; findings: SecretFinding[] } {
  const findings = scanForSecrets(text);
  if (findings.length === 0) {
    return { text, findings };
  }
  let out = text;
  for (const { name, re } of PATTERNS) {
    out = out.replace(re, `«redacted:${name}»`);
  }
  return { text: out, findings };
}

/** Compact human summary like "2 AWS access keys, 1 GitHub token" (for a chat/tool notice). */
export function summarizeFindings(findings: readonly SecretFinding[]): string {
  return findings.map((f) => `${f.count} ${f.type}${f.count === 1 ? '' : 's'}`).join(', ');
}

/**
 * Apply the secret-scanning policy to a list of context attachments. Pure: returns
 * the (possibly redacted) items and the findings merged by type across all of them.
 * `redact` rewrites each item's content; `warn` leaves content intact but still
 * reports findings; `off` is a pass-through. The caller surfaces the notice.
 */
export function redactContextAttachments<T extends { content?: string; characterCount?: number }>(
  items: readonly T[],
  mode: 'redact' | 'warn' | 'off'
): { items: T[]; findings: SecretFinding[] } {
  if (mode === 'off') {
    return { items: [...items], findings: [] };
  }
  const byType = new Map<string, number>();
  const redactedItems = items.map((item) => {
    if (!item.content) {
      return item;
    }
    const { text, findings } = redactSecrets(item.content);
    if (findings.length === 0) {
      return item;
    }
    for (const f of findings) {
      byType.set(f.type, (byType.get(f.type) ?? 0) + f.count);
    }
    return mode === 'warn' ? item : { ...item, content: text, characterCount: text.length };
  });
  const findings = [...byType].map(([type, count]) => ({ type, count }));
  return { items: mode === 'warn' ? [...items] : redactedItems, findings };
}
