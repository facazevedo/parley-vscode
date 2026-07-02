import { createHash } from 'crypto';
import { exec } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChatMode, ParleySettings } from '../config/settings';
import type { CommandDependencies } from '../commands/common';
import { isSensitiveFile } from '../context/sensitiveFileFilter';
import type { CheckpointStore } from '../diff/checkpoints';
import { applySnippetEdit } from '../diff/editMatch';
import { formatUnifiedDiff } from '../diff/lineDiff';
import { reviewProposedEdit } from '../diff/reviewEdit';
import { showProposedDiff } from '../diff/showDiff';
import { dbg } from '../debug/debug';
import type { BrowserManager } from '../browser/browserManager';
import { runHookEvent } from '../hooks/hooks';
import type { McpManager } from '../mcp/McpManager';
import { clampMiddle } from '../parley/clampText';
import { isMcpTool } from '../mcp/naming';
import { resolveAcrossRoots, runAgentTool } from '../parley/tools';
import type { ToolCall } from '../parley/types';
import { webSearch } from '../web/webSearch';
import type { TranscriptRecorder } from './transcriptRecorder';

/** Everything the tool executor needs from its hosting chat panel. */
export interface ToolExecutorHost {
  readonly checkpoints: CheckpointStore;
  readonly mcp: McpManager;
  readonly browser: BrowserManager;
  readonly state: vscode.Memento;
  readonly recorder: TranscriptRecorder;
  readonly diffProvider: CommandDependencies['diffProvider'];
  getSettings(): ParleySettings;
  getMode(): ChatMode;
  getAbortSignal(): AbortSignal | undefined;
  post(message: Record<string, unknown>): void;
}

/**
 * Executes the agent's tool calls — file edits (with staleness guard, tiered
 * matching, review cards, checkpoints, post-edit diagnostics), shell commands
 * (with the allowlist), plan updates, web search, and MCP passthrough.
 * Decomposition 3/4: extracted from ChatPanel; the panel delegates to `run()`.
 */
export class ToolExecutor {
  // Proposed file changes from a chat-mode reply, awaiting an inline Apply click.
  private readonly pendingChanges = new Map<
    string,
    { uri: vscode.Uri; rel: string; original: string; proposedText: string }
  >();
  private changeSeq = 0;
  // Ask-mode approvals: proposed-change cards whose tool call awaits an Apply/Reject click.
  private approvalSeq = 0;
  private readonly pendingApprovals = new Map<
    string,
    { resolve: (finalText: string | undefined) => void; rel: string; original: string; proposedText: string }
  >();
  // Content hashes of files the agent has read this conversation — staleness detection
  // for write_file (don't clobber unseen changes) and better edit_file errors.
  private readonly fileReadHashes = new Map<string, string>();
  private commandChannel?: vscode.OutputChannel;

  public constructor(private readonly host: ToolExecutorHost) {}

  /** Ids of interactive cards (chat-mode Apply cards + ask-mode approvals) still pending. */
  public pendingIds(): string[] {
    return [...this.pendingChanges.keys(), ...this.pendingApprovals.keys()];
  }

  /** Clear per-conversation state on new/opened/forked conversations. */
  public resetConversationState(): void {
    this.pendingChanges.clear();
    this.fileReadHashes.clear();
  }

  /** Absolute paths of files the agent has read/edited this conversation (for glob-scoped rules). */
  public touchedFiles(): string[] {
    return [...this.fileReadHashes.keys()];
  }

  /** Tool runner for agent mode: read tools delegate to the read-only runner; writes/commands need UI + checkpoints. */
  public async run(call: ToolCall): Promise<string> {
    // Lifecycle hooks (parley.hooks): PreToolUse may block; PostToolUse may append feedback.
    const hooks = this.host.getSettings().hooks;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const pre = await runHookEvent(
      hooks,
      'PreToolUse',
      { tool: call.name, arguments: safeParseArgs(call.arguments) },
      { cwd, log: (m) => dbg('hooks', m) }
    );
    if (pre.blocked) {
      return `Error: blocked by a PreToolUse hook${pre.feedback ? ` — ${pre.feedback}` : ''}. Adjust your approach accordingly.`;
    }
    const result = await this.dispatch(call);
    const post = await runHookEvent(
      hooks,
      'PostToolUse',
      { tool: call.name, arguments: safeParseArgs(call.arguments), result: result.slice(0, 4000) },
      { cwd, log: (m) => dbg('hooks', m) }
    );
    return post.feedback ? `${result}\n\n[PostToolUse hook feedback — address this]\n${post.feedback}` : result;
  }

  private async dispatch(call: ToolCall): Promise<string> {
    if (isMcpTool(call.name)) {
      return this.host.mcp.callTool(call.name, call.arguments);
    }
    if (call.name === 'read_file') {
      const result = await runAgentTool(call);
      await this.recordReadFromArgs(call.arguments);
      return result;
    }
    if (call.name === 'write_file') {
      return this.toolWriteFile(call);
    }
    if (call.name === 'edit_file') {
      return this.toolEditFile(call);
    }
    if (call.name === 'run_command') {
      return this.toolRunCommand(call);
    }
    if (call.name === 'update_plan') {
      return this.toolUpdatePlan(call);
    }
    if (call.name === 'web_search') {
      return this.toolWebSearch(call);
    }
    if (call.name.startsWith('browser_')) {
      return this.toolBrowser(call);
    }
    return runAgentTool(call);
  }

  /** Route a browser_* call to the shared BrowserManager (local Playwright). */
  private async toolBrowser(call: ToolCall): Promise<string> {
    let a: { url?: string; selector?: string; text?: string; errors_only?: boolean } = {};
    try {
      a = JSON.parse(call.arguments || '{}');
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    const b = this.host.browser;
    switch (call.name) {
      case 'browser_navigate':
        return b.navigate(String(a.url ?? ''));
      case 'browser_read':
        return b.read(a.selector ? String(a.selector) : undefined);
      case 'browser_console':
        return b.consoleOutput(a.errors_only === true);
      case 'browser_click':
        return a.selector ? b.click(String(a.selector)) : 'Error: selector is required.';
      case 'browser_type':
        return a.selector ? b.type(String(a.selector), String(a.text ?? '')) : 'Error: selector is required.';
      case 'browser_screenshot':
        return b.screenshot();
      default:
        return `Error: unknown browser tool "${call.name}".`;
    }
  }

  private async toolWebSearch(call: ToolCall): Promise<string> {
    let query = '';
    try {
      query = String(JSON.parse(call.arguments || '{}').query ?? '');
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    const s = this.host.getSettings();
    return webSearch(query, {
      provider: s.webSearchProvider,
      apiKey: s.webSearchApiKey,
      googleCx: s.webSearchGoogleCx
    });
  }

  /** Render the agent's task checklist in the chat (Claude-Code / Codex style). */
  private toolUpdatePlan(call: ToolCall): string {
    let steps: Array<{ step?: string; status?: string }> = [];
    try {
      steps = (JSON.parse(call.arguments || '{}').steps ?? []) as Array<{ step?: string; status?: string }>;
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    const clean = steps
      .filter((s) => s && typeof s.step === 'string')
      .map((s) => ({
        step: String(s.step).slice(0, 200),
        status: s.status === 'done' || s.status === 'in_progress' ? s.status : 'pending'
      }));
    this.host.post({ type: 'plan', steps: clean });
    this.host.recorder.append({
      kind: 'plan',
      steps: clean.map((s) => ({ text: s.step, status: s.status })),
      at: new Date().toISOString()
    });
    const done = clean.filter((s) => s.status === 'done').length;
    return `Plan updated (${done}/${clean.length} done).`;
  }

  // ---------- file staleness tracking ----------

  private static hashContent(text: string): string {
    return createHash('sha1').update(text).digest('hex');
  }

  /** Remember the on-disk content of a file the agent has just read (or we just wrote). */
  private recordFileState(fsPath: string, content: string): void {
    this.fileReadHashes.set(fsPath, ToolExecutor.hashContent(content));
  }

  /** After a read_file tool call: hash the file so later writes can detect outside changes. */
  private async recordReadFromArgs(argsJson: string): Promise<void> {
    try {
      const rel = String((JSON.parse(argsJson || '{}') as { path?: string }).path ?? '').replace(/^[/\\]+/, '');
      if (!rel) {
        return;
      }
      const uri = await resolveAcrossRoots(rel);
      if (!uri) {
        return;
      }
      const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      this.recordFileState(uri.fsPath, content);
    } catch {
      // Unreadable/absent — nothing to record.
    }
  }

  /** Note appended to edit errors when the file changed on disk after the agent's last read. */
  private staleNote(fsPath: string, currentContent: string): string {
    const recorded = this.fileReadHashes.get(fsPath);
    if (recorded && recorded !== ToolExecutor.hashContent(currentContent)) {
      return ' Note: the file has CHANGED on disk since you last read it (edited by the user or a tool) — trust the content shown below over your memory.';
    }
    return '';
  }

  private async toolWriteFile(call: ToolCall): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      return 'Error: no workspace folder is open.';
    }
    let args: { path?: string; content?: string };
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    const rel = String(args.path ?? '').replace(/^[/\\]+/, '');
    const content = String(args.content ?? '');
    if (!rel) {
      return 'Error: path is required.';
    }
    if (isSensitiveFile(rel)) {
      return 'Error: refusing to write a sensitive file.';
    }

    const uri = (await resolveAcrossRoots(rel)) ?? vscode.Uri.joinPath(root, rel);
    let original = '';
    let fileExists = true;
    try {
      original = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      original = '';
      fileExists = false;
    }
    // Overwriting an existing, non-empty file requires a fresh view of it — otherwise the
    // agent could clobber content it has never seen (e.g. the user edited it mid-conversation).
    // Instead of a bare refusal, the CURRENT content is read into the reply (and its hash
    // recorded), so the model can re-issue the write in ONE round with full knowledge.
    if (fileExists && original.length > 0) {
      const recorded = this.fileReadHashes.get(uri.fsPath);
      if (!recorded || recorded !== ToolExecutor.hashContent(original)) {
        this.recordFileState(uri.fsPath, original);
        const reason = recorded
          ? `${rel} has CHANGED on disk since you last read it (edited by the user or a tool)`
          : `${rel} already exists but you have not read it in this conversation`;
        return (
          `Error: ${reason} — the write was NOT applied to avoid clobbering unseen content.\n` +
          `Here is the CURRENT content (auto-read for you; its state is now recorded, so a corrected re-issue will succeed):\n` +
          `${numberedExcerpt(original)}\n` +
          `Re-issue write_file with the full intended contents based on the above — or use edit_file for a targeted change.`
        );
      }
    }
    const proposedText = content.endsWith('\n') ? content : `${content}\n`;
    return this.applyProposedEdit(uri, rel, original, proposedText);
  }

  /** Surgical edit: replace a unique snippet, then go through the same review/apply flow. */
  private async toolEditFile(call: ToolCall): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      return 'Error: no workspace folder is open.';
    }
    let args: { path?: string; old_text?: string; new_text?: string };
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    const rel = String(args.path ?? '').replace(/^[/\\]+/, '');
    const oldText = String(args.old_text ?? '');
    const newText = String(args.new_text ?? '');
    if (!rel) {
      return 'Error: path is required.';
    }
    if (!oldText) {
      return 'Error: old_text is required.';
    }
    if (isSensitiveFile(rel)) {
      return 'Error: refusing to edit a sensitive file.';
    }

    const uri = (await resolveAcrossRoots(rel)) ?? vscode.Uri.joinPath(root, rel);
    let original: string;
    try {
      original = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      return `Error: could not read "${rel}" — does it exist? Use write_file to create new files.`;
    }

    // Tiered matching: exact → trimmed lines → collapsed whitespace; a failed match
    // returns the closest real region so the model can repair old_text in one round.
    const match = applySnippetEdit(original, oldText, newText);
    if (match.kind === 'ambiguous') {
      return (
        `Error: old_text matches ${match.startLines.length} places in ${rel}` +
        ` (starting at lines ${match.startLines.slice(0, 8).join(', ')}).` +
        ' Include more surrounding context so it is unique.'
      );
    }
    if (match.kind === 'notfound') {
      const stale = this.staleNote(uri.fsPath, original);
      if (match.hint) {
        return (
          `Error: old_text was not found in ${rel}.${stale}` +
          ` Closest match is lines ${match.hint.startLine}-${match.hint.endLine}` +
          ` (${Math.round(match.hint.similarity * 100)}% of lines match) — the file actually contains:\n` +
          `${match.hint.excerpt}\n` +
          'Copy old_text EXACTLY from the lines above (watch punctuation and small wording differences), then retry edit_file.'
        );
      }
      return `Error: old_text was not found in ${rel}.${stale} Re-read the file with read_file and copy an exact snippet.`;
    }
    return this.applyProposedEdit(uri, rel, original, match.newText);
  }

  /** Apply a proposed file change: auto in edit/auto/full modes, diff-approval otherwise. Always checkpointed. */
  private async applyProposedEdit(
    uri: vscode.Uri,
    rel: string,
    original: string,
    proposedText: string
  ): Promise<string> {
    const preDiagnostics = ToolExecutor.diagnosticsKeySet(uri);
    const mode = this.host.getMode();
    if (mode === 'edit' || mode === 'auto' || mode === 'full') {
      await this.host.checkpoints.applyWithCheckpoint(uri, proposedText, `edit ${rel}`);
      this.recordFileState(uri.fsPath, proposedText);
      this.postFileEdit(rel, original, proposedText);
      return `Applied edit to ${rel} (auto).${await this.newProblemsAfterEdit(uri, preDiagnostics)}`;
    }

    // Ask mode: open the native diff for full context and render an in-chat approval
    // card (Apply / Choose hunks… / Reject). The tool call awaits the click — no
    // blocking modal, so the rest of the chat (and steering) stays usable.
    await showProposedDiff(
      { filePath: uri.fsPath, originalText: original, proposedText, title: `Agent edit: ${rel}` },
      this.host.diffProvider
    );
    const id = `apr${this.approvalSeq++}`;
    const diff = formatUnifiedDiff(original, proposedText);
    const MAX_ROWS = 500;
    const rows = diff.rows.length > MAX_ROWS ? diff.rows.slice(0, MAX_ROWS) : diff.rows;
    const isNew = original.length === 0;
    this.host.post({
      type: 'proposedChange',
      id,
      path: rel,
      isNew,
      approval: true,
      added: diff.added,
      removed: diff.removed,
      rows,
      truncated: diff.rows.length > MAX_ROWS
    });
    this.host.recorder.append({
      kind: 'fileEdit',
      id,
      path: rel,
      added: diff.added,
      removed: diff.removed,
      rows,
      truncated: diff.rows.length > MAX_ROWS,
      status: 'proposed',
      isNew,
      at: new Date().toISOString()
    });
    this.host.post({ type: 'status', text: `Waiting for your review of ${rel}…` });

    const finalText = await new Promise<string | undefined>((resolve) => {
      this.pendingApprovals.set(id, { resolve, rel, original, proposedText });
      this.host.getAbortSignal()?.addEventListener(
        'abort',
        () => {
          if (this.pendingApprovals.delete(id)) {
            resolve(undefined);
          }
        },
        { once: true }
      );
    });

    if (finalText === undefined) {
      this.host.post({ type: 'changeResolved', id, status: 'dismissed' });
      this.resolveTranscriptChange(id, 'dismissed');
      return `User rejected the edit to ${rel}.`;
    }
    await this.host.checkpoints.applyWithCheckpoint(uri, finalText, `edit ${rel}`);
    this.recordFileState(uri.fsPath, finalText);
    this.host.post({ type: 'changeResolved', id, status: 'applied' });
    this.resolveTranscriptChange(id, 'applied');
    return `Applied edit to ${rel}.${await this.newProblemsAfterEdit(uri, preDiagnostics)}`;
  }

  // ---------- ask-mode approval clicks (routed from the webview via the panel) ----------

  /** Apply click on an approval card. Returns false when the id isn't a pending approval. */
  public approveApproval(id: string): boolean {
    const approval = this.pendingApprovals.get(id);
    if (!approval) {
      return false;
    }
    this.pendingApprovals.delete(id);
    approval.resolve(approval.proposedText);
    return true;
  }

  /** Reject click on an approval card. Returns false when the id isn't a pending approval. */
  public rejectApproval(id: string): boolean {
    const approval = this.pendingApprovals.get(id);
    if (!approval) {
      return false;
    }
    this.pendingApprovals.delete(id);
    approval.resolve(undefined);
    return true;
  }

  /** "Choose hunks…" on an approval card: fall back to the per-hunk review dialog. */
  public async reviewApproval(id: string): Promise<void> {
    const approval = this.pendingApprovals.get(id);
    if (approval) {
      this.pendingApprovals.delete(id);
      const finalText = await reviewProposedEdit(approval.rel, approval.original, approval.proposedText);
      approval.resolve(finalText);
    }
  }

  // ---------- post-edit diagnostics feedback (the editor tells the agent what it broke) ----------

  /** Line-independent keys of a file's current diagnostics (errors + warnings). */
  private static diagnosticsKeySet(uri: vscode.Uri): Set<string> {
    const keys = new Set<string>();
    for (const d of vscode.languages.getDiagnostics(uri)) {
      if (d.severity <= vscode.DiagnosticSeverity.Warning) {
        keys.add(ToolExecutor.diagnosticKey(d));
      }
    }
    return keys;
  }

  /** Keyed by severity+source+message (not line) so pre-existing problems that merely shift lines don't count as new. */
  private static diagnosticKey(d: vscode.Diagnostic): string {
    return `${d.severity}|${d.source ?? ''}|${d.message}`;
  }

  /**
   * After an applied edit, give language servers a moment to re-analyze, then report
   * any NEW errors/warnings back to the model — Claude-Code-style self-correction.
   * Opening the document (without showing it) makes language servers analyze files
   * that aren't open in any editor.
   */
  private async newProblemsAfterEdit(uri: vscode.Uri, before: Set<string>): Promise<string> {
    if (this.host.getAbortSignal()?.aborted) {
      return '';
    }
    try {
      await vscode.workspace.openTextDocument(uri);
    } catch {
      return '';
    }
    await waitMs(1500, this.host.getAbortSignal());
    const fresh = vscode.languages
      .getDiagnostics(uri)
      .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
      .filter((d) => !before.has(ToolExecutor.diagnosticKey(d)));
    if (fresh.length === 0) {
      return '';
    }
    fresh.sort((a, b) => a.severity - b.severity || a.range.start.line - b.range.start.line);
    const label = (d: vscode.Diagnostic): string =>
      d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
    const shown = fresh
      .slice(0, 8)
      .map(
        (d) =>
          `- L${d.range.start.line + 1} ${label(d)}: ${d.message.split('\n')[0].slice(0, 200)}${d.source ? ` [${d.source}]` : ''}`
      );
    const more = fresh.length > 8 ? `\n(+${fresh.length - 8} more)` : '';
    dbg('tool', 'post-edit diagnostics', { file: uri.fsPath, fresh: fresh.length });
    return `\n\n⚠ This edit introduced ${fresh.length} new problem(s) according to the editor's diagnostics:\n${shown.join('\n')}${more}\nFix these before moving on (or explain why they are expected).`;
  }

  /** Show a Claude-Code-style inline diff card in the chat for an applied edit. */
  private postFileEdit(rel: string, original: string, applied: string): void {
    const diff = formatUnifiedDiff(original, applied);
    if (diff.added === 0 && diff.removed === 0) {
      return;
    }
    const MAX_ROWS = 500;
    const rows = diff.rows.length > MAX_ROWS ? diff.rows.slice(0, MAX_ROWS) : diff.rows;
    const truncated = diff.rows.length > MAX_ROWS;
    this.host.post({ type: 'fileEdit', path: rel, added: diff.added, removed: diff.removed, rows, truncated });
    this.host.recorder.append({
      kind: 'fileEdit',
      path: rel,
      added: diff.added,
      removed: diff.removed,
      rows,
      truncated,
      status: 'applied',
      isNew: original.length === 0,
      at: new Date().toISOString()
    });
  }

  /** Render an interactive "Apply" card for a chat-mode proposed file change (Cursor-style). */
  public postProposedChange(change: { filePath: string; originalText: string; proposedText: string }): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const uri = vscode.Uri.file(change.filePath);
    const rel = root ? path.relative(root.fsPath, change.filePath).replace(/\\/g, '/') : change.filePath;
    const id = `chg${this.changeSeq++}`;
    this.pendingChanges.set(id, { uri, rel, original: change.originalText, proposedText: change.proposedText });
    const diff = formatUnifiedDiff(change.originalText, change.proposedText);
    const MAX_ROWS = 500;
    const rows = diff.rows.length > MAX_ROWS ? diff.rows.slice(0, MAX_ROWS) : diff.rows;
    const truncated = diff.rows.length > MAX_ROWS;
    const isNew = change.originalText.length === 0;
    this.host.post({
      type: 'proposedChange',
      id,
      path: rel,
      isNew,
      added: diff.added,
      removed: diff.removed,
      rows,
      truncated
    });
    this.host.recorder.append({
      kind: 'fileEdit',
      id,
      path: rel,
      added: diff.added,
      removed: diff.removed,
      rows,
      truncated,
      status: 'proposed',
      isNew,
      at: new Date().toISOString()
    });
  }

  /** Update a proposed-change transcript entry's status (e.g. after Apply/Dismiss) and re-sync disk. */
  private resolveTranscriptChange(id: string, status: 'applied' | 'dismissed' | 'error'): void {
    const entry = this.host.recorder.entries.find((e) => e.kind === 'fileEdit' && e.id === id);
    if (entry && entry.kind === 'fileEdit') {
      entry.status = status;
      this.host.recorder.syncFile();
    }
  }

  /** Dismiss click on a chat-mode Apply card. */
  public dismissPendingChange(id: string): void {
    this.pendingChanges.delete(id);
    this.host.post({ type: 'changeResolved', id, status: 'dismissed' });
    this.resolveTranscriptChange(id, 'dismissed');
  }

  /** Apply a pending proposed change when the user clicks its inline Apply button. */
  public async applyPendingChange(id: string): Promise<void> {
    const change = this.pendingChanges.get(id);
    if (!change) {
      // No longer pending (already resolved, or the extension reloaded and lost it) —
      // resolve the card anyway so no dead Apply button lingers in the webview.
      this.host.post({ type: 'changeResolved', id, status: 'dismissed' });
      return;
    }
    this.pendingChanges.delete(id);
    if (isSensitiveFile(change.rel)) {
      this.host.post({ type: 'changeResolved', id, status: 'error' });
      this.resolveTranscriptChange(id, 'error');
      await vscode.window.showErrorMessage(`Parley refused to write a sensitive file: ${change.rel}.`);
      return;
    }
    try {
      // The inline Apply click is the confirmation, so apply directly (still checkpointed/revertible).
      // The card already shows the diff, so we just flip it to "Applied" via changeResolved.
      await this.host.checkpoints.applyWithCheckpoint(change.uri, change.proposedText, `edit ${change.rel}`);
      this.recordFileState(change.uri.fsPath, change.proposedText);
      this.host.post({ type: 'changeResolved', id, status: 'applied' });
      this.resolveTranscriptChange(id, 'applied');
      await this.host.recorder.autosave();
    } catch (error) {
      this.host.post({ type: 'changeResolved', id, status: 'error' });
      this.resolveTranscriptChange(id, 'error');
      await vscode.window.showErrorMessage(
        `Parley could not apply ${change.rel}: ${error instanceof Error ? error.message : 'error'}`
      );
    }
  }

  private async toolRunCommand(call: ToolCall): Promise<string> {
    let args: { command?: string };
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      return 'Error: arguments were not valid JSON.';
    }
    const command = String(args.command ?? '').trim();
    if (!command) {
      return 'Error: command is required.';
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    const mode = this.host.getMode();
    // Full-access mode runs commands without prompting; every other mode confirms —
    // unless the command matches a workspace allowlist rule the user approved earlier.
    if (mode !== 'full' && this.isCommandAllowed(command)) {
      dbg('tool', 'run_command auto-approved by allowlist', command.slice(0, 120));
    } else if (mode !== 'full') {
      const ALWAYS = 'Always Allow';
      const answer = await vscode.window.showWarningMessage(
        `Parley agent wants to run a command in ${folder?.name ?? 'the workspace'}:\n\n${command}\n\n` +
          `"${ALWAYS}" also approves future commands that start with this text (this workspace only; ` +
          'review with "Parley: Manage Allowed Commands").',
        { modal: true },
        'Run',
        ALWAYS,
        'Skip'
      );
      if (answer === ALWAYS) {
        const rules = this.allowedCommands();
        if (!rules.includes(command)) {
          await this.host.state.update('parley.allowedCommands', [...rules, command]);
        }
      } else if (answer !== 'Run') {
        return 'User declined to run the command.';
      }
    }
    const output = await runShellCommand(
      command,
      folder?.uri.fsPath,
      this.host.getSettings().commandTimeoutSeconds * 1000,
      this.host.getAbortSignal()
    );
    // Mirror the command + its full output to a visible channel (Claude-Code/Cursor-style),
    // while still returning the captured output to the model.
    const channel = this.agentChannel();
    channel.appendLine(`$ ${command}`);
    channel.appendLine(output);
    channel.appendLine('');
    channel.show(true);
    return output;
  }

  private agentChannel(): vscode.OutputChannel {
    if (!this.commandChannel) {
      this.commandChannel = vscode.window.createOutputChannel('Parley Agent');
    }
    return this.commandChannel;
  }

  // ---------- command allowlist (workspace-scoped) ----------

  private allowedCommands(): string[] {
    const rules = this.host.state.get<string[]>('parley.allowedCommands', []);
    return Array.isArray(rules) ? rules.filter((r) => typeof r === 'string' && r.trim().length > 0) : [];
  }

  /** A rule matches its exact command or any command that extends it with further arguments. */
  private isCommandAllowed(command: string): boolean {
    return this.allowedCommands().some((rule) => command === rule || command.startsWith(`${rule} `));
  }

  /** Review/remove the workspace's approved agent commands ("Parley: Manage Allowed Commands"). */
  public async manageAllowedCommands(): Promise<void> {
    const rules = this.allowedCommands();
    if (rules.length === 0) {
      await vscode.window.showInformationMessage(
        'Parley: no allowed commands yet. Approve one with "Always Allow" when the agent asks to run a command.'
      );
      return;
    }
    const picks = await vscode.window.showQuickPick(
      rules.map((rule) => ({ label: rule, picked: true })),
      {
        canPickMany: true,
        title: 'Parley: allowed agent commands (uncheck to remove)',
        placeHolder:
          'Checked commands (and anything starting with them + more arguments) run without asking in this workspace'
      }
    );
    if (!picks) {
      return;
    }
    const keep = picks.map((p) => p.label);
    await this.host.state.update('parley.allowedCommands', keep);
    const removed = rules.length - keep.length;
    await vscode.window.showInformationMessage(
      removed > 0
        ? `Parley: removed ${removed} allowed command${removed === 1 ? '' : 's'} (${keep.length} kept).`
        : `Parley: keeping all ${keep.length} allowed command${keep.length === 1 ? '' : 's'}.`
    );
  }
}

/** Best-effort parse of tool-call JSON args for hook payloads. */
function safeParseArgs(argsJson: string): unknown {
  try {
    return JSON.parse(argsJson || '{}');
  } catch {
    return argsJson;
  }
}

/** Line-numbered excerpt of a file for auto-informed staleness replies (capped to stay compact). */
function numberedExcerpt(text: string, maxLines = 200, maxChars = 8000): string {
  const lines = text.split('\n');
  const shown = lines.slice(0, maxLines);
  const width = String(shown.length).length;
  let body = shown.map((line, i) => `${String(i + 1).padStart(width)} | ${line}`).join('\n');
  if (body.length > maxChars) {
    body = `${body.slice(0, maxChars)}\n[… excerpt truncated — call read_file for the rest]`;
  } else if (lines.length > maxLines) {
    body += `\n[… ${lines.length - maxLines} more lines — call read_file with start_line=${maxLines + 1} for the rest]`;
  }
  return body;
}

/** Abort-aware pause that RESOLVES (never rejects) when the signal fires — for best-effort waits. */
function waitMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Run a shell command in cwd, returning combined stdout/stderr (clamped head+tail). User-approved per call.
 *  Passing the turn's AbortSignal lets Stop actually kill the child process. */
export function runShellCommand(
  command: string,
  cwd: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal },
      (error, stdout, stderr) => {
        if (error && (error as { name?: string }).name === 'AbortError') {
          resolve('Command was stopped by the user.');
          return;
        }
        const out = `${stdout ?? ''}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim();
        // Keep head + tail with an explicit marker — for command output the tail
        // (the actual error) matters most, so never cut it off silently.
        const body = clampMiddle(out, 16000);
        // exec kills on timeout with SIGTERM and sets error.killed — tell the model so it can retry/split.
        if (error && (error as { killed?: boolean }).killed && (error as { signal?: string }).signal) {
          const secs = Math.round(timeoutMs / 1000);
          resolve(
            `[Command exceeded the ${secs}s timeout and was terminated. If it legitimately needs longer (e.g. a big install/build), raise "parley.commandTimeoutSeconds" or split it into smaller steps.]` +
              (body ? `\n\nPartial output:\n${body}` : '')
          );
          return;
        }
        if (error && !out) {
          resolve(`Command failed: ${error.message}`);
        } else {
          resolve(body || '(no output)');
        }
      }
    );
  });
}
