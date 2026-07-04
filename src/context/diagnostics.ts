import * as vscode from 'vscode';

// Indexed by vscode.DiagnosticSeverity's numeric value (Error=0, Warning=1,
// Information=2, Hint=3). A plain array avoids referencing the enum at module-load
// time (which breaks when vscode is mocked).
const SEVERITY_LABEL = ['Error', 'Warning', 'Info', 'Hint'];

export interface DiagnosticsOptions {
  /** Only include diagnostics for this file (e.g. the active editor). */
  readonly onlyUri?: vscode.Uri;
  /** Include warnings/info in addition to errors. Default true. */
  readonly includeWarnings?: boolean;
  /** Max number of diagnostic lines to emit. Default 200. */
  readonly maxItems?: number;
}

function codeString(code: vscode.Diagnostic['code']): string {
  if (code === undefined || code === null) {
    return '';
  }
  if (typeof code === 'object') {
    return String(code.value);
  }
  return String(code);
}

/**
 * A compact, human-readable snapshot of the current VS Code diagnostics (the
 * Problems panel): errors first, then warnings, grouped by file with a
 * workspace-relative path and 1-based line:col. Runs in the extension host.
 */
export function diagnosticsSnapshot(options: DiagnosticsOptions = {}): string {
  const includeWarnings = options.includeWarnings !== false;
  const maxItems = options.maxItems ?? 200;

  let all = vscode.languages.getDiagnostics(); // Array<[Uri, Diagnostic[]]>
  if (options.onlyUri) {
    const target = options.onlyUri.toString();
    all = all.filter(([uri]) => uri.toString() === target);
  }

  const rows: Array<{ uri: vscode.Uri; d: vscode.Diagnostic }> = [];
  for (const [uri, diags] of all) {
    for (const d of diags) {
      if (!includeWarnings && d.severity !== vscode.DiagnosticSeverity.Error) {
        continue;
      }
      rows.push({ uri, d });
    }
  }
  if (rows.length === 0) {
    return options.onlyUri ? 'No problems reported for this file.' : 'No problems reported by the language servers.';
  }

  // Errors first (severity Error=0 < Warning=1), then by file, then by line.
  rows.sort((a, b) => {
    if (a.d.severity !== b.d.severity) {
      return a.d.severity - b.d.severity;
    }
    const pa = a.uri.fsPath;
    const pb = b.uri.fsPath;
    if (pa !== pb) {
      return pa < pb ? -1 : 1;
    }
    return a.d.range.start.line - b.d.range.start.line;
  });

  const errorCount = rows.filter((r) => r.d.severity === vscode.DiagnosticSeverity.Error).length;
  const warnCount = rows.length - errorCount;
  const shown = rows.slice(0, maxItems);

  const lines: string[] = [];
  let currentFile = '';
  for (const { uri, d } of shown) {
    const rel = vscode.workspace.asRelativePath(uri, false);
    if (rel !== currentFile) {
      currentFile = rel;
      lines.push('');
      lines.push(rel);
    }
    const sev = SEVERITY_LABEL[d.severity] ?? 'Info';
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    const src = [d.source, codeString(d.code)].filter(Boolean).join(' ');
    const msg = d.message.replace(/\s+/g, ' ').trim();
    lines.push(`  [${sev}] ${line}:${col} ${msg}${src ? ` (${src})` : ''}`);
  }

  const header =
    `${errorCount} error${errorCount === 1 ? '' : 's'}` +
    // Only mention warnings when they're actually included in the snapshot.
    (includeWarnings ? `, ${warnCount} warning${warnCount === 1 ? '' : 's'}` : '') +
    (rows.length > shown.length ? ` (showing first ${shown.length})` : '') +
    ':';
  return `${header}\n${lines.join('\n').trim()}`;
}
